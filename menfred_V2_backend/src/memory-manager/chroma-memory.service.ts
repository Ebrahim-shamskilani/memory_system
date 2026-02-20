import { Injectable, Logger } from '@nestjs/common';
import { OllamaEmbeddingFunction } from '@chroma-core/ollama';
import { ChromadbService } from '../chromadb/chromadb.service';
import { DecomposedQuery, MemoryChunk } from './types/memory.types';

const DEFAULT_COLLECTION = 'main_docs';
const MAX_RESULTS = 5;
const MAX_DISTANCE = 0.5;

@Injectable()
export class ChromaMemoryService {
  private readonly logger = new Logger(ChromaMemoryService.name);

  private readonly embeddingFunction = new OllamaEmbeddingFunction({
    url: process.env.OLLAMA_URL ?? 'http://localhost:11434',
    model: 'bge-m3',
  });

  constructor(private readonly chromadbService: ChromadbService) {}

  async search(q: DecomposedQuery): Promise<MemoryChunk[]> {
    try {
      const queryText = this.buildQueryText(q);

      const client = this.chromadbService.getClient();
      const col = await client.getOrCreateCollection({
        name: DEFAULT_COLLECTION,
        embeddingFunction: this.embeddingFunction,
      });

      const result = await col.query({
        queryTexts: [queryText],
        nResults: MAX_RESULTS,
        include: ['documents', 'metadatas', 'distances'],
      });

      return this.toChunks(result);
    } catch (err) {
      this.logger.warn(`Chroma search failed [${q.type}]: ${(err as Error).message}`);
      return [];
    }
  }

  private buildQueryText(q: DecomposedQuery): string {
    const keywords = q.keywords.join(' ');

    switch (q.type) {
      case 'event':
        return q.question;

      case 'context':
        return `${q.question} ${keywords}`.trim();

      default:
        return keywords || q.question;
    }
  }

  private toChunks(result: {
    ids?: string[][];
    documents?: (string | null)[][];
    metadatas?: (Record<string, unknown> | null)[][];
    distances?: number[][] | null;
  }): MemoryChunk[] {
    const docs = result.documents?.[0] ?? [];
    const metas = result.metadatas?.[0] ?? [];
    const distances = result.distances?.[0] ?? [];

    const chunks = docs
      .map((doc, i) => {
        if (!doc) return null;

        const distance = distances[i] ?? 1;
        if (distance > MAX_DISTANCE) return null;

        return {
          content: doc,
          source: 'chroma' as const,
          score: 1 - distance,
          metadata: (metas[i] as Record<string, unknown>) ?? {},
        };
      })
      .filter((c): c is NonNullable<typeof c> => c !== null)
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));

    return chunks as MemoryChunk[];
  }
}
