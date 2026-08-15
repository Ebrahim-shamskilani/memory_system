export type IntentType =
  | 'find_entity'
  | 'find_relationship'
  | 'find_event'
  | 'find_pattern'
  | 'recall_conversation'
  | 'store_information';

export interface TimeConstraints {
  after?: string;   // ISO 8601 string — only results after this date
  before?: string;  // ISO 8601 string — only results before this date
}

export interface ResolvedEntity {
  name: string;
  chromaId?: string;
  confidence: number;
}

export interface EntityResolutionResult {
  entities: ResolvedEntity[];
  intents: IntentType[];
  resolvedQuery: string;
  timeConstraints?: TimeConstraints;
}

export interface VectorSearchResult {
  chromaId: string;
  document: string;
  distance: number;
  metadata: Record<string, unknown>;
}

export interface GraphNode {
  chromaId: string;
  labels: string[];
  properties: Record<string, unknown>;
}

export interface GraphRelationship {
  chromaId: string;
  type: string;
  properties: Record<string, unknown>;
  sourceChromaId: string;
  targetChromaId: string;
}

export interface ScoredItem {
  id: string;
  similarity: number;
}

export interface TraversalResult {
  nodes: GraphNode[];
  relationships: GraphRelationship[];
  scoredItems?: ScoredItem[];
}

export interface EntropyEvaluation {
  shouldStop: boolean;
  entropy: number;          // normalized to [0, 1]: 0 = one clear winner, 1 = indistinguishable
  maxSimilarity: number;
  deltaEntropy: number;
  totalNodes: number;
  reason: 'confident' | 'diminishing_returns' | 'hard_cap' | 'no_results' | 'continue';
}

export interface SufficiencyResult {
  hasEnough: boolean;
  nextSearch?: string;
  confidence: number;
}

export interface RetrievalContext {
  query: string;
  resolvedEntities: ResolvedEntity[];
  intents: IntentType[];
  timeConstraints?: TimeConstraints;
  vectorResults: VectorSearchResult[];
  graphResults: TraversalResult;
  facts: string[];
  iterations: number;
}
