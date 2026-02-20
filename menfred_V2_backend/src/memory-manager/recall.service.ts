import { Injectable } from '@nestjs/common';
import { DecomposeService } from './decompose.service';
import { Neo4jMemoryService } from './neo4j-memory.service';
import { ChromaMemoryService } from './chroma-memory.service';
import { DecomposedQuery, MemoryChunk } from './types/memory.types';
import { SynthesisService } from './synthesis.service';

@Injectable()
export class RecallService {
  constructor(
    private readonly decompose: DecomposeService,
    private readonly neo4j: Neo4jMemoryService,
    private readonly chroma: ChromaMemoryService,
    private readonly synthesis: SynthesisService,
  ) {}

  async recall(message: string): Promise<string> {
    const questions = await this.decompose.decompose(message);

    const chunks = await Promise.all(questions.map((q) => this.route(q)));

    const memories = this.deduplicate(chunks.flat());

    const response = await this.synthesis.synthesize(message, memories);
    return response;
  }

  private async route(q: DecomposedQuery): Promise<MemoryChunk[]> {
    switch (q.type) {
      case 'entity':
      case 'relation':
        return this.neo4j.query(q);

      case 'event':
      case 'context':
        return this.chroma.search(q);

      default:
        const [neo4jResults, chromaResults] = await Promise.all([
          this.neo4j.query(q),
          this.chroma.search(q),
        ]);
        return [...neo4jResults, ...chromaResults];
    }
  }

  private deduplicate(chunks: MemoryChunk[]): MemoryChunk[] {
    const seen = new Set<string>();
    return chunks.filter((c) => {
      const key = c.content.trim().toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  private format(memories: MemoryChunk[]): string {
    if (!memories.length) return 'No relevant memories found.';
    return memories.map((m, i) => `${i + 1}. [${m.source}] ${m.content}`).join('\n');
  }
}
