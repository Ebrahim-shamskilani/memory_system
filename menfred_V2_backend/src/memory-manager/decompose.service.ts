import { Injectable, Logger } from '@nestjs/common';
import { DecomposedQuery } from './types/memory.types';
import { LlmService } from '../llm/llm.service';

@Injectable()
export class DecomposeService {
  private readonly logger = new Logger(DecomposeService.name);

  constructor(private readonly llmService: LlmService) { }

  async decompose(message: string): Promise<DecomposedQuery[]> {
    const prompt = this.buildPrompt(message);

    const raw = await this.llmService.generate({
      model: 'gemma3:12b',
      prompt,
      options: {
        temperature: 0.2,
        num_predict: 512,
      },
    });

    return this.parseResponse(raw, message);
  }

  private buildPrompt(message: string): string {
    return `You are a memory retrieval assistant.
Given a message, generate 2-5 specific questions to retrieve relevant memories.

Classify each question as:
- "entity"   → about a specific person, place, or thing
- "event"    → about something that happened  
- "relation" → about connections between people/things
- "context"  → about background, feelings, or situation

Message: "${message}"

Respond ONLY with a valid JSON array. No markdown, no explanation.
[
  { "question": "...", "type": "entity|event|relation|context", "keywords": ["..."] }
]`;
  }

  private parseResponse(raw: string, originalMessage: string): DecomposedQuery[] {
    try {
      const jsonMatch = raw.match(/\[[\s\S]*\]/);
      if (!jsonMatch) throw new Error('No JSON array found');

      const parsed: DecomposedQuery[] = JSON.parse(jsonMatch[0]);

      const validTypes = ['entity', 'event', 'relation', 'context'];
      return parsed.filter(
        (q) =>
          q.question?.trim() &&
          validTypes.includes(q.type) &&
          Array.isArray(q.keywords),
      );
    } catch (err) {
      this.logger.warn(`Decompose parse failed: ${(err as Error).message}`);
      return [
        {
          question: originalMessage,
          type: 'context',
          keywords: [],
        },
      ];
    }
  }
}
