export interface MemoryStoreResult {
  chromaId: string;
  success: boolean;
}

export interface DualWriteResult {
  neo4jSuccess: boolean;
  chromaSuccess: boolean;
  chromaId: string;
  rolledBack?: boolean;
}

export interface ConversationTurn {
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
  conversationId: string;
}

export interface ConversationBuffer {
  turns: ConversationTurn[];
  conversationId: string;
}

export interface MemoryRecallResult {
  answer: string;
  sources: {
    entities: string[];
    relationships: string[];
    episodes: string[];
    facts: string[];
  };
  iterations: number;
}

export interface EraseResult {
  neo4jNodesDeleted: number;
  chromaCollectionsCleared: string[];
  conversationBufferCleared: boolean;
}
