export type BeliefSource = 'monologue' | 'inferred';

export interface BeliefNode {
  chromaId: string;
  content: string;
  confidence: number;         // default 0.5 (facts have 1.0)
  source: BeliefSource;
  monologueId: string;        // UUID of the monologue that produced this
  createdAt: string;
  updatedAt: string;
  invalidatedAt: string | null;
}

export interface CreateBeliefDto {
  content: string;
  confidence?: number;        // defaults to 0.5
  source: BeliefSource;
  monologueId: string;
}

export interface ExtractedBelief {
  content: string;
  about_entities: string[];
}

export interface BeliefIngestionResult {
  beliefsCreated: number;
  beliefsSkippedDuplicate: number;
  entitiesResolved: number;
  entitiesCreated: number;
}
