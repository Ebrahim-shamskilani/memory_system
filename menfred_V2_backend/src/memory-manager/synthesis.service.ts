import { Injectable, Logger } from '@nestjs/common';
import { LlmService } from '../llm/llm.service';
import { MemoryChunk } from './types/memory.types';

@Injectable()
export class SynthesisService {
  private readonly logger = new Logger(SynthesisService.name);

  constructor(private readonly llmService: LlmService) {}

  async synthesize(originalMessage: string, chunks: MemoryChunk[]): Promise<string> {

    // chunks رو بر اساس score فیلتر کن (فقط برای chroma مهمه)
  const relevant = chunks.filter(
    (c) => c.source === 'neo4j' || (c.score ?? 0) >= 0.4
  );

  if (!relevant.length) {
    return 'No relevant memories found for this message.';
  }

    const prompt = this.buildPrompt(originalMessage, relevant);

    try {
      return await this.llmService.generate({
        model: 'gemma3:12b',
        prompt,
        options: {
          temperature: 0.3,
          num_predict: 1024,
        },
      });
    } catch (err) {
      this.logger.warn(`Synthesis failed: ${(err as Error).message}`);
      return this.fallbackFormat(chunks);
    }
  }

  private buildPrompt(message: string, chunks: MemoryChunk[]): string {
    const neo4jChunks = chunks.filter((c) => c.source === 'neo4j');
    const chromaChunks = chunks.filter((c) => c.source === 'chroma');

    const formatChunks = (items: MemoryChunk[]) =>
      items.map((c, i) => `  ${i + 1}. ${c.content}`).join('\n');

    const memorySections: string[] = [];

    if (neo4jChunks.length) {
      memorySections.push(`[Structured Knowledge - Graph]\n${formatChunks(neo4jChunks)}`);
    }
    if (chromaChunks.length) {
      memorySections.push(`[Semantic Memories - Vector]\n${formatChunks(chromaChunks)}`);
    }

    return `You are a memory assistant. Based on the retrieved memories below, write a concise report about the given message.

Rules:
- Write 3-6 sentences maximum
- Only use information from the retrieved memories
- Memories may be in Persian (Farsi) or other languages — translate and understand them
- If memories are contradictory, mention it
- If memories are insufficient, say so clearly
- Do NOT make up information
- Be direct and factual

Message: "${message}"

Retrieved Memories:
${memorySections.join('\n\n')}

Report:`;
  }

  private fallbackFormat(chunks: MemoryChunk[]): string {
    return chunks
      .map((c, i) => `${i + 1}. [${c.source}] ${c.content}`)
      .join('\n');
  }
}
