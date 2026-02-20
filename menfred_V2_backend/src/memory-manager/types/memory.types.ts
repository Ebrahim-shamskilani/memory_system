// types/memory.types.ts
export type QueryType = 'entity' | 'event' | 'relation' | 'context';

export interface DecomposedQuery {
  question: string;
  type: QueryType;
  keywords: string[];
}

export interface MemoryChunk {
  content: string;
  source: 'neo4j' | 'chroma';
  score?: number;     // similarity score از chroma
  metadata?: Record<string, any>;
}