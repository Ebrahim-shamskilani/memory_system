export const MENFRED_MEMORY_CONFIG = Symbol('MENFRED_MEMORY_CONFIG');

export interface MenfredMemoryConfig {
  neo4j: {
    uri: string;
    user: string;
    password: string;
    database?: string;       // default: 'neo4j'
  };
  ollama: {
    url: string;              // e.g. 'http://localhost:11434'
    model: string;            // e.g. 'gemma3:12b'
    embeddingModel?: string;  // default: 'bge-m3'
  };
  chromadb: {
    host: string;
    port?: number;            // default: 8000
    dataPath?: string;        // default: './chroma_data'
    managed?: boolean;        // default: true (standalone), false for SDK
  };
  openrouter?: {
    apiKey: string;
    model: string;
    url?: string;             // default: 'https://openrouter.ai/api/v1'
  };
  llmProvider?: 'ollama' | 'openrouter';  // default: 'ollama'
  conversation?: {
    maxBufferSize?: number;   // default: 10
  };
  brain?: {
    name?: string;            // default: 'Manfred'
    description?: string;     // default: 'a personal AI memory assistant'
  };
  user?: {
    name?: string;            // default: 'ابراهیم'
    nameEnglish?: string;     // default: 'Ebrahim'
  };
}
