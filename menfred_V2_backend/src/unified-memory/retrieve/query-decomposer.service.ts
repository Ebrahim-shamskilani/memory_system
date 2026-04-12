import { Injectable, Logger } from '@nestjs/common';
import { LlmService } from '../../llm/llm.service';

@Injectable()
export class QueryDecomposerService {
  private readonly logger = new Logger(QueryDecomposerService.name);

  constructor(private readonly llm: LlmService) {}

  /**
   * Decomposes a user message into 3-6 sub-queries that capture
   * the implicit information needs beyond the literal question.
   *
   * One LLM call → returns parallel-searchable sub-queries.
   */
  async decompose(message: string, conversationContext: string): Promise<string[]> {
    const prompt = `You are a query decomposer for a personal memory system. A user has sent a message, and you need to figure out what information from their personal memory would be needed to give a complete, personalized response.

Think about what the user is IMPLICITLY asking for — not just the literal question, but all the background context that would help answer it well.

Example 1: "Teach me some new German words"
Sub-queries: ["آخرین باری که کلمات آلمانی یاد گرفتم کی بود؟", "چه کلمات آلمانی قبلاً یاد گرفتم؟", "سطح زبان آلمانی من چقدره؟", "الان کجا زندگی میکنم؟"]

Example 2: "How is Arezoo doing?"
Sub-queries: ["آرزو کیه و چه رابطه‌ای با من داره؟", "آخرین اطلاعاتی که از آرزو دارم چیه؟", "اخیراً درباره آرزو چی صحبت کردیم؟"]

Example 3: "Hello!"
Sub-queries: []

User message: "${message}"

Recent conversation:
${conversationContext || '(no prior context)'}

Generate 3-6 search queries that would retrieve all the relevant personal information needed from memory.

Rules:
- Write queries as NATURAL LANGUAGE questions/statements (NOT keywords)
- Use Persian/Farsi (the language of the memory)
- Each query targets a DIFFERENT aspect of what's needed (people, history, preferences, location, events, relationships)
- If the message is a simple greeting, general knowledge question, riddle, or doesn't need personal memory — return an EMPTY array []
- Focus on what can actually be FOUND in a personal memory store (facts, events, relationships, past conversations)

Respond ONLY with a valid JSON array of strings:`;

    try {
      const raw = await this.llm.generate({
        model: this.llm.getDefaultModel(),
        prompt,
        options: { temperature: 0.3, num_predict: 300 },
      });

      const subQueries = this.parseResponse(raw);
      if (subQueries.length > 0) {
        this.logger.log(`Decomposed into ${subQueries.length} sub-queries: ${subQueries.join(' | ')}`);
      } else {
        this.logger.log('No decomposition needed for this message');
      }
      return subQueries;
    } catch (error) {
      this.logger.warn(`Query decomposition failed: ${(error as Error).message}`);
      return [];
    }
  }

  private parseResponse(raw: string): string[] {
    try {
      const match = raw.match(/\[[\s\S]*?\]/);
      if (!match) return [];

      const parsed = JSON.parse(match[0]);
      if (!Array.isArray(parsed)) return [];

      return parsed
        .filter((q: unknown): q is string => typeof q === 'string' && q.length > 0)
        .slice(0, 6);
    } catch {
      return [];
    }
  }
}
