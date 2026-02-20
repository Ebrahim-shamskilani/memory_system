export type IntentType =
  | 'find_entity'
  | 'find_relationship'
  | 'find_event'
  | 'find_pattern'
  | 'recall_conversation';

export interface ResolvedEntity {
  name: string;
  chromaId?: string;
  confidence: number;
}

export interface EntityResolutionResult {
  entities: ResolvedEntity[];
  intents: IntentType[];
  resolvedQuery: string;
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

export interface TraversalResult {
  nodes: GraphNode[];
  relationships: GraphRelationship[];
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
  vectorResults: VectorSearchResult[];
  graphResults: TraversalResult;
  facts: string[];
  iterations: number;
}
