import { Injectable, Logger } from '@nestjs/common';
import { UnifiedStoreService } from './store/unified-store.service';
import { RetrievalAgentService } from './retrieve/retrieval-agent.service';
import { FactCollectorService } from './retrieve/fact-collector.service';
import { MessageIngestorService, IngestionResult } from './ingest/message-ingestor.service';
import { ConsolidationService } from './consolidate/consolidation.service';
import { ConversationService } from '../conversation/conversation.service';
import { GraphDbService } from '../graph-db/graph-db.service';
import {
  ChromadbService,
  COLLECTION_ENTITIES,
  COLLECTION_RELATIONSHIPS,
  COLLECTION_EPISODES,
  COLLECTION_BELIEFS,
} from '../chromadb/chromadb.service';
import { MemoryRecallResult, EraseResult } from './types/memory.types';
import { CognitionEvent } from './types/cognition.types';
import { RetrievalContext } from './types/retrieval.types';
import { CognitionService } from './cognition/cognition.service';
import { MonologueService } from './cognition/monologue.service';
import { ConsolidationRun } from './types/consolidation.types';
import { CreateEntityDto, CreateRelationshipDto } from './types/entity.types';
import { CreateEpisodeDto, CreateFactDto } from './types/episode.types';
import { DualWriteResult } from './types/memory.types';

@Injectable()
export class UnifiedMemoryService {
  private readonly logger = new Logger(UnifiedMemoryService.name);

  constructor(
    private readonly store: UnifiedStoreService,
    private readonly retrievalAgent: RetrievalAgentService,
    private readonly factCollector: FactCollectorService,
    private readonly ingestor: MessageIngestorService,
    private readonly consolidation: ConsolidationService,
    private readonly conversation: ConversationService,
    private readonly graphDb: GraphDbService,
    private readonly chromaDb: ChromadbService,
    private readonly cognition: CognitionService,
    private readonly monologue: MonologueService,
  ) {}

  /**
   * Main entry point: process a user message.
   * Pre-classifies intent: only ingests if 'store_information' is detected.
   */
  async processMessage(message: string): Promise<MemoryRecallResult & { ingestion: IngestionResult }> {
    this.monologue.pause();
    try {
      return await this._processMessage(message);
    } finally {
      this.monologue.resume();
    }
  }

  private async _processMessage(message: string): Promise<MemoryRecallResult & { ingestion: IngestionResult }> {
    this.logger.log(`Processing message: "${message.substring(0, 80)}..."`);

    // Route through the cognition pipeline (which handles retrieval, ingestion via <STORE>, and voice)
    const emptyIngestion: IngestionResult = {
      entitiesCreated: 0,
      entitiesResolved: 0,
      factsCreated: 0,
      factsSkippedDuplicate: 0,
      relationshipsCreated: 0,
      relationshipsSkippedDuplicate: 0,
      episodeCreated: false,
      eventsCreated: 0,
    };

    let finalEvent: CognitionEvent | null = null;
    for await (const event of this.cognition.process(message)) {
      if (event.type === 'done') finalEvent = event;
    }

    const answer = finalEvent?.answer ?? '';
    const sources = finalEvent?.sources ?? { entities: [], relationships: [], episodes: [], facts: [], beliefs: [] };
    const ingestion = (finalEvent?.ingestion as unknown as IngestionResult) ?? emptyIngestion;
    const iterations = finalEvent?.cogIterations ?? 0;

    this.logger.log(
      `Processing complete: ${iterations} cog iterations, ${sources.entities.length} entities`,
    );

    return { answer, sources, iterations, ingestion };
  }

  /**
   * Streaming cognition pipeline: think → ingest → speak.
   * Pauses monologue during reactive processing.
   */
  async *processMessageStream(message: string): AsyncGenerator<CognitionEvent> {
    this.monologue.pause();
    try {
      yield* this.cognition.process(message);
    } finally {
      this.monologue.resume();
    }
  }

  /**
   * Recall-only (no ingestion). Returns raw collected facts without LLM synthesis.
   */
  async recall(message: string): Promise<MemoryRecallResult> {
    this.logger.log(`Recalling memories for: "${message.substring(0, 80)}..."`);

    this.conversation.addTurn('user', message);

    const context = await this.retrievalAgent.retrieve(message);
    const facts = this.factCollector.collectFacts(context);

    this.logger.log(
      `Recall complete: ${context.iterations} iterations, ${facts.length} facts`,
    );

    return {
      answer: facts.length > 0 ? facts.join('\n') : 'No memories found.',
      sources: this.extractSources(context),
      iterations: context.iterations,
    };
  }

  private extractSources(context: RetrievalContext): MemoryRecallResult['sources'] {
    const entities: string[] = [];
    const relationships: string[] = [];
    const episodes: string[] = [];
    const facts: string[] = [];
    const beliefs: string[] = [];

    for (const node of context.graphResults.nodes) {
      if (node.labels.includes('Entity')) {
        entities.push(node.chromaId);
      } else if (node.labels.includes('Episode')) {
        episodes.push(node.chromaId);
      } else if (node.labels.includes('Belief')) {
        beliefs.push(node.chromaId);
      } else if (node.labels.includes('Fact')) {
        facts.push(node.chromaId);
      }
    }

    for (const rel of context.graphResults.relationships) {
      relationships.push(rel.chromaId);
    }

    return { entities, relationships, episodes, facts, beliefs };
  }

  /**
   * Ingest-only (no recall). For storing information without generating a response.
   */
  async ingest(message: string): Promise<IngestionResult> {
    this.conversation.addTurn('user', message);
    return this.ingestor.ingest(message);
  }

  /**
   * Manually trigger consolidation.
   */
  async triggerConsolidation(): Promise<ConsolidationRun> {
    return this.consolidation.consolidate('manual');
  }

  /**
   * End the current conversation, start a new one, and trigger consolidation.
   */
  async endConversation(): Promise<{ newConversationId: string; consolidation: ConsolidationRun }> {
    const newConversationId = this.conversation.startNewConversation();
    const consolidationRun = await this.consolidation.consolidate('conversation_end');
    return { newConversationId, consolidation: consolidationRun };
  }

  /**
   * Erase all stored memory: Neo4j nodes, ChromaDB documents, and conversation buffers.
   * This is irreversible.
   */
  async eraseAllMemory(): Promise<EraseResult> {
    this.logger.warn('Erasing ALL memory — this is irreversible');

    const result: EraseResult = {
      neo4jNodesDeleted: 0,
      chromaCollectionsCleared: [],
      conversationBufferCleared: false,
    };

    // 1. Delete all Neo4j nodes and relationships
    try {
      const deleteResult = await this.graphDb.runQuery(
        `MATCH (n) DETACH DELETE n RETURN count(n) AS deleted`,
      );
      const record = deleteResult.records[0] as any;
      result.neo4jNodesDeleted = record?.deleted ?? 0;
      this.logger.log(`Neo4j: deleted ${result.neo4jNodesDeleted} nodes`);
    } catch (error) {
      this.logger.error(`Neo4j erase failed: ${(error as Error).message}`);
    }

    // 2. Clear all ChromaDB collections
    const collections = [COLLECTION_ENTITIES, COLLECTION_RELATIONSHIPS, COLLECTION_EPISODES, COLLECTION_BELIEFS];
    for (const collectionName of collections) {
      try {
        const col = await this.chromaDb.getCollection(collectionName);
        const existing = await col.get({ limit: 1 });
        if (existing.ids.length > 0) {
          // Get all IDs and delete them
          const all = await col.get();
          if (all.ids.length > 0) {
            await col.delete({ ids: all.ids });
          }
        }
        result.chromaCollectionsCleared.push(collectionName);
        this.logger.log(`ChromaDB: cleared collection "${collectionName}"`);
      } catch (error) {
        this.logger.error(`ChromaDB erase failed for "${collectionName}": ${(error as Error).message}`);
      }
    }

    // 3. Clear conversation buffer
    try {
      this.conversation.clearAll();
      result.conversationBufferCleared = true;
      this.logger.log('Conversation buffer cleared');
    } catch (error) {
      this.logger.error(`Conversation buffer clear failed: ${(error as Error).message}`);
    }

    this.logger.warn(
      `Erase complete: ${result.neo4jNodesDeleted} Neo4j nodes, ` +
      `${result.chromaCollectionsCleared.length} ChromaDB collections, ` +
      `conversation buffer ${result.conversationBufferCleared ? 'cleared' : 'failed'}`,
    );

    return result;
  }

  // --- Store delegation methods ---

  async createEntity(dto: CreateEntityDto): Promise<DualWriteResult> {
    return this.store.createEntity(dto);
  }

  async createRelationship(dto: CreateRelationshipDto): Promise<DualWriteResult> {
    return this.store.createRelationship(dto);
  }

  async createEpisode(dto: CreateEpisodeDto): Promise<DualWriteResult> {
    return this.store.createEpisode(dto);
  }

  async createFact(dto: CreateFactDto): Promise<DualWriteResult> {
    return this.store.createFact(dto);
  }

  async linkEntityToFact(
    entityChromaId: string,
    factChromaId: string,
    description: string,
  ): Promise<void> {
    return this.store.linkEntityToFact(entityChromaId, factChromaId, description);
  }

  async linkEntityToEpisode(
    entityChromaId: string,
    episodeChromaId: string,
    role: string,
    description: string,
  ): Promise<void> {
    return this.store.linkEntityToEpisode(entityChromaId, episodeChromaId, role, description);
  }

  getStore(): UnifiedStoreService {
    return this.store;
  }
}
