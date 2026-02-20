import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { MENFRED_MEMORY_CONFIG, MenfredMemoryConfig } from '../../sdk/menfred-memory.config';

const CACHE_MAX_SIZE = 500;

@Injectable()
export class EmbeddingService {
  private readonly logger = new Logger(EmbeddingService.name);
  private readonly cache = new Map<string, number[]>();
  private readonly ollamaUrl: string;
  private readonly embeddingModel: string;

  constructor(
    @Inject(MENFRED_MEMORY_CONFIG) @Optional() config?: MenfredMemoryConfig,
  ) {
    this.ollamaUrl = config?.ollama?.url ?? process.env.OLLAMA_URL ?? 'http://localhost:11434';
    this.embeddingModel = config?.ollama?.embeddingModel ?? 'bge-m3';
  }

  async embed(text: string): Promise<number[]> {
    const cached = this.cache.get(text);
    if (cached) return cached;

    const response = await fetch(`${this.ollamaUrl}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: this.embeddingModel, input: text }),
    });

    if (!response.ok) {
      throw new Error(
        `Embedding error: ${response.status} ${response.statusText}`,
      );
    }

    const data = (await response.json()) as { embeddings?: number[][] };
    const embedding = data.embeddings?.[0];
    if (!embedding) {
      throw new Error('No embedding returned from Ollama');
    }

    if (this.cache.size >= CACHE_MAX_SIZE) {
      const firstKey = this.cache.keys().next().value;
      this.cache.delete(firstKey);
    }
    this.cache.set(text, embedding);

    return embedding;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    const results: number[][] = [];
    const uncachedTexts: string[] = [];
    const uncachedIndexes: number[] = [];

    for (let i = 0; i < texts.length; i++) {
      const cached = this.cache.get(texts[i]);
      if (cached) {
        results[i] = cached;
      } else {
        uncachedTexts.push(texts[i]);
        uncachedIndexes.push(i);
      }
    }

    if (uncachedTexts.length > 0) {
      const response = await fetch(`${this.ollamaUrl}/api/embed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: this.embeddingModel, input: uncachedTexts }),
      });

      if (!response.ok) {
        throw new Error(
          `Embedding batch error: ${response.status} ${response.statusText}`,
        );
      }

      const data = (await response.json()) as { embeddings?: number[][] };
      const embeddings = data.embeddings ?? [];

      for (let i = 0; i < uncachedIndexes.length; i++) {
        const embedding = embeddings[i];
        if (embedding) {
          results[uncachedIndexes[i]] = embedding;
          const text = uncachedTexts[i];
          if (this.cache.size >= CACHE_MAX_SIZE) {
            const firstKey = this.cache.keys().next().value;
            this.cache.delete(firstKey);
          }
          this.cache.set(text, embedding);
        }
      }
    }

    return results;
  }

  cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) return 0;
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    const denominator = Math.sqrt(normA) * Math.sqrt(normB);
    return denominator === 0 ? 0 : dotProduct / denominator;
  }
}
