import { Injectable } from '@nestjs/common';

const OLLAMA_URL = process.env.OLLAMA_URL ?? 'http://localhost:11434';
const DEFAULT_MODEL = 'gemma3:12b';

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
  async sendMessage(prompt: string, model = DEFAULT_MODEL): Promise<string> {
    return this.generate({ model, prompt });
  }

  async generate(params: LlmGenerateParams): Promise<string> {
    const { model, prompt, options } = params;

    const response = await fetch(`${OLLAMA_URL}/api/generate`, {
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
}
