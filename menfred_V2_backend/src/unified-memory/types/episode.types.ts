export type EpisodeSource = 'conversation' | 'observation' | 'consolidation';
export type FactSource = 'stated' | 'inferred' | 'consolidated';

export interface EpisodeNode {
  chromaId: string;
  title: string;
  description: string;
  timestamp: string;
  level: number; // 3=detail, 2=event summary, 1=pattern
  source: EpisodeSource;
  conversationId: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateEpisodeDto {
  title: string;
  description: string;
  timestamp?: string;
  level: number;
  source: EpisodeSource;
  conversationId: string;
}

export interface FactNode {
  chromaId: string;
  content: string;
  confidence: number;
  source: FactSource;
  level: number; // always 0
  createdAt: string;
  updatedAt: string;
  invalidatedAt: string | null;
}

export interface CreateFactDto {
  content: string;
  confidence?: number;
  source: FactSource;
}

export interface ExtractedEvent {
  description: string;
  participants: string[];
  timestampHint: string;      // raw: "دیروز", "yesterday"
  resolvedTimestamp: string | null; // ISO date resolved by LLM
}
