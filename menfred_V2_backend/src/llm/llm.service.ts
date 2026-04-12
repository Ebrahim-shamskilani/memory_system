import { Inject, Injectable, Optional } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { MENFRED_MEMORY_CONFIG, MenfredMemoryConfig } from '../sdk/menfred-memory.config';

export interface LlmGenerateOptions {
  temperature?: number;
  num_predict?: number;
  [key: string]: unknown;
}

export interface LlmGenerateParams {
  model: string;
  prompt: string;
  options?: LlmGenerateOptions;
}

@Injectable()
export class LlmService {
  private readonly ollamaUrl: string;
  private readonly ollamaModel: string;
  private readonly provider: 'ollama' | 'openrouter';
  private readonly openrouterApiKey: string;
  private readonly openrouterModel: string;
  private readonly openrouterUrl: string;
  private readonly logFilePath: string;

  constructor(
    @Inject(MENFRED_MEMORY_CONFIG) @Optional() config?: MenfredMemoryConfig,
  ) {
    this.ollamaUrl = config?.ollama?.url ?? process.env.OLLAMA_URL ?? 'http://localhost:11434';
    this.ollamaModel = config?.ollama?.model ?? process.env.OLLAMA_MODEL ?? 'gemma3:12b';

    const providerEnv = config?.llmProvider ?? process.env.LLM_PROVIDER ?? 'ollama';
    this.provider = providerEnv === 'openrouter' ? 'openrouter' : 'ollama';

    this.openrouterApiKey = config?.openrouter?.apiKey ?? process.env.OPENROUTER_API_KEY ?? '';
    this.openrouterModel = config?.openrouter?.model ?? process.env.OPENROUTER_MODEL ?? '';
    this.openrouterUrl = config?.openrouter?.url ?? process.env.OPENROUTER_URL ?? 'https://openrouter.ai/api/v1';

    // Resolve logs/ dir relative to project root (dist/src/llm/ -> ../../../logs/)
    const logsDir = path.resolve(__dirname, '..', '..', '..', 'logs');
    fs.mkdirSync(logsDir, { recursive: true });
    this.logFilePath = path.join(logsDir, 'llm-calls.log');
  }

  private logCall(
    method: string,
    model: string,
    temp: number | undefined,
    prompt: string,
    response: string,
    durationMs: number,
  ): void {
    const separator = '='.repeat(80);
    const timestamp = new Date().toISOString();
    const tempStr = temp != null ? String(temp) : 'default';
    const providerTag = this.provider === 'openrouter' ? ' [openrouter]' : ' [ollama]';
    const entry = [
      separator,
      `[${timestamp}] ${method}${providerTag} | model: ${model} | temp: ${tempStr} | duration: ${durationMs}ms`,
      '--- PROMPT ---',
      prompt,
      '--- RESPONSE ---',
      response,
      separator,
      '', // trailing newline
    ].join('\n');

    try {
      fs.appendFileSync(this.logFilePath, entry + '\n');
    } catch {
      // Silently ignore write errors to avoid disrupting LLM calls
    }
  }

  getDefaultModel(): string {
    return this.provider === 'openrouter' ? this.openrouterModel : this.ollamaModel;
  }

  async sendMessage(prompt: string, model?: string): Promise<string> {
    return this.generate({ model: model ?? this.getDefaultModel(), prompt });
  }

  // ── OpenRouter generate ──────────────────────────────────────────────

  private async generateOpenRouter(params: LlmGenerateParams): Promise<string> {
    const { model, prompt, options } = params;
    const start = Date.now();

    const response = await fetch(`${this.openrouterUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.openrouterApiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        temperature: options?.temperature,
        max_tokens: options?.num_predict,
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`OpenRouter error: ${response.status} ${response.statusText} — ${body}`);
    }

    const data = (await response.json()) as { choices?: { message?: { content?: string } }[] };
    const result = data.choices?.[0]?.message?.content ?? '';
    this.logCall('generate', model, options?.temperature as number | undefined, prompt, result, Date.now() - start);
    return result;
  }

  // ── OpenRouter streaming generate ────────────────────────────────────

  private async *generateStreamOpenRouter(params: LlmGenerateParams): AsyncGenerator<string> {
    const { model, prompt, options } = params;
    const start = Date.now();
    const chunks: string[] = [];

    const response = await fetch(`${this.openrouterUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.openrouterApiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        temperature: options?.temperature,
        max_tokens: options?.num_predict,
        stream: true,
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`OpenRouter error: ${response.status} ${response.statusText} — ${body}`);
    }

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop()!;
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data: ')) continue;
        const payload = trimmed.slice(6);
        if (payload === '[DONE]') {
          this.logCall('generateStream', model, options?.temperature as number | undefined, prompt, chunks.join(''), Date.now() - start);
          return;
        }
        const parsed = JSON.parse(payload) as { choices?: { delta?: { content?: string } }[] };
        const content = parsed.choices?.[0]?.delta?.content;
        if (content) {
          chunks.push(content);
          yield content;
        }
      }
    }

    this.logCall('generateStream', model, options?.temperature as number | undefined, prompt, chunks.join(''), Date.now() - start);
  }

  // ── Public generate (dispatches by provider) ─────────────────────────

  async generate(params: LlmGenerateParams): Promise<string> {
    if (this.provider === 'openrouter') {
      return this.generateOpenRouter(params);
    }

    const { model, prompt, options } = params;
    const start = Date.now();

    const response = await fetch(`${this.ollamaUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        prompt,
        stream: false,
        options: options ?? {},
      }),
    });

    if (!response.ok) {
      throw new Error(`Ollama error: ${response.status} ${response.statusText}`);
    }

    const data = (await response.json()) as { response?: string };
    const result = data.response ?? '';
    this.logCall('generate', model, options?.temperature as number | undefined, prompt, result, Date.now() - start);
    return result;
  }

  async *generateStream(params: LlmGenerateParams): AsyncGenerator<string> {
    if (this.provider === 'openrouter') {
      yield* this.generateStreamOpenRouter(params);
      return;
    }

    const { model, prompt, options } = params;
    const start = Date.now();
    const chunks: string[] = [];

    const response = await fetch(`${this.ollamaUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, prompt, stream: true, options: options ?? {} }),
    });

    if (!response.ok) {
      throw new Error(`Ollama error: ${response.status} ${response.statusText}`);
    }

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop()!;
      for (const line of lines) {
        if (!line.trim()) continue;
        const parsed = JSON.parse(line);
        if (parsed.response) {
          chunks.push(parsed.response);
          yield parsed.response;
        }
        if (parsed.done) {
          this.logCall('generateStream', model, options?.temperature as number | undefined, prompt, chunks.join(''), Date.now() - start);
          return;
        }
      }
    }

    this.logCall('generateStream', model, options?.temperature as number | undefined, prompt, chunks.join(''), Date.now() - start);
  }

  async generateJson<T = unknown>(
    params: LlmGenerateParams,
    maxRetries = 2,
  ): Promise<T> {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const raw = await this.generate(params);

      try {
        const jsonMatch = raw.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          return JSON.parse(jsonMatch[0]) as T;
        }

        const arrayMatch = raw.match(/\[[\s\S]*\]/);
        if (arrayMatch) {
          return JSON.parse(arrayMatch[0]) as T;
        }
      } catch {
        if (attempt === maxRetries) {
          throw new Error(`Failed to parse JSON after ${maxRetries + 1} attempts. Raw: ${raw.substring(0, 200)}`);
        }
      }
    }

    throw new Error('generateJson: unreachable');
  }
}
