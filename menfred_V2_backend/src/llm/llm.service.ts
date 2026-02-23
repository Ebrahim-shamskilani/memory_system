import { Inject, Injectable, Optional } from '@nestjs/common';
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
  private readonly defaultModel: string;

  constructor(
    @Inject(MENFRED_MEMORY_CONFIG) @Optional() config?: MenfredMemoryConfig,
  ) {
    this.ollamaUrl = config?.ollama?.url ?? process.env.OLLAMA_URL ?? 'http://localhost:11434';
    this.defaultModel = config?.ollama?.model ?? 'gemma3:12b';
  }

  getDefaultModel(): string {
    return this.defaultModel;
  }

  async sendMessage(prompt: string, model?: string): Promise<string> {
    return this.generate({ model: model ?? this.defaultModel, prompt });
  }

  async generate(params: LlmGenerateParams): Promise<string> {
    const { model, prompt, options } = params;

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
    return data.response ?? '';
  }

  async *generateStream(params: LlmGenerateParams): AsyncGenerator<string> {
    const { model, prompt, options } = params;
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
        if (parsed.response) yield parsed.response;
        if (parsed.done) return;
      }
    }
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
