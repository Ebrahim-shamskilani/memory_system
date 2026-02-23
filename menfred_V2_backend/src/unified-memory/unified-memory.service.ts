import { Injectable, Logger } from '@nestjs/common';
import { UnifiedStoreService } from './store/unified-store.service';
import { RetrievalAgentService } from './retrieve/retrieval-agent.service';
import { SynthesisService } from './synthesize/synthesis.service';
import { MessageIngestorService, IngestionResult } from './ingest/message-ingestor.service';
import { ConsolidationService } from './consolidate/consolidation.service';
import { ConversationService } from '../conversation/conversation.service';
import { EntityResolverService } from './retrieve/entity-resolver.service';
import { GraphDbService } from '../graph-db/graph-db.service';
import {
  ChromadbService,
  COLLECTION_ENTITIES,
  COLLECTION_RELATIONSHIPS,
  COLLECTION_EPISODES,
} from '../chromadb/chromadb.service';
import { MemoryRecallResult, EraseResult } from './types/memory.types';
import { CognitionEvent } from './types/cognition.types';
import { CognitionService } from './cognition/cognition.service';
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
    private readonly synthesis: SynthesisService,
    private readonly ingestor: MessageIngestorService,
    private readonly consolidation: ConsolidationService,
    private readonly conversation: ConversationService,
    private readonly entityResolver: EntityResolverService,
    private readonly graphDb: GraphDbService,
    private readonly chromaDb: ChromadbService,
    private readonly cognition: CognitionService,
  ) {}

  /**
   * Main entry point: process a user message.
   * Pre-classifies intent: only ingests if 'store_information' is detected.
   */
  async processMessage(message: string): Promise<MemoryRecallResult & { ingestion: IngestionResult }> {
    this.logger.log(`Processing message: "${message.substring(0, 80)}..."`);

    // Add user turn to conversation buffer
    this.conversation.addTurn('user', message);

    // Step 0: Pre-classify intent to decide whether to ingest
    const conversationContext = this.conversation.getContextString();
    const resolution = await this.entityResolver.resolve(message, conversationContext);
    const shouldIngest = resolution.intents.includes('store_information');

    this.logger.log(
      `Intent classification: [${resolution.intents.join(', ')}] → ${shouldIngest ? 'INGEST + RECALL' : 'RECALL only'}`,
    );

    // Steps 1 + 2: Run INGEST and RECALL in parallel.
    // Ingest creates NEW entries; recall searches EXISTING entries — safe to parallelize.
    // This avoids the sequential bottleneck (extraction LLM call blocking recall).
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

    let ingestion: IngestionResult;
    let context: import('./types/retrieval.types').RetrievalContext;

    if (shouldIngest) {
      [ingestion, context] = await Promise.all([
        this.ingestor.ingest(message),
        this.retrievalAgent.retrieve(message, resolution),
      ]);
      this.logger.log(
        `Ingested: ${ingestion.entitiesCreated} new entities, ${ingestion.factsCreated} facts, ${ingestion.relationshipsCreated} relationships`,
      );
    } else {
      this.logger.log('Skipping ingestion — message is a question/query, not new information');
      ingestion = emptyIngestion;
      context = await this.retrievalAgent.retrieve(message, resolution);
    }

    const result = await this.synthesis.synthesize(message, context);

    this.logger.log(
      `Recall complete: ${result.iterations} iterations, ${result.sources.entities.length} entities, ${result.sources.relationships.length} relationships`,
    );

    // Step 3: Consolidation check (async, non-blocking)
    this.consolidation.incrementMessageCounter();
    if (this.consolidation.shouldConsolidate()) {
      this.consolidation.consolidate('message_count').catch((err) => {
        this.logger.error(`Background consolidation failed: ${(err as Error).message}`);
      });
    }

    return { ...result, ingestion };
  }

  /**
   * Streaming cognition pipeline: think → ingest → speak.
   */
  async *processMessageStream(message: string): AsyncGenerator<CognitionEvent> {
    yield* this.cognition.process(message);
  }

  /**
   * Recall-only (no ingestion). For queries that don't carry new information.
   */
  async recall(message: string): Promise<MemoryRecallResult> {
    this.logger.log(`Recalling memories for: "${message.substring(0, 80)}..."`);

    this.conversation.addTurn('user', message);

    const context = await this.retrievalAgent.retrieve(message);
    const result = await this.synthesis.synthesize(message, context);

    this.logger.log(
      `Recall complete: ${result.iterations} iterations, ${result.sources.entities.length} entities, ${result.sources.relationships.length} relationships`,
    );

    return result;
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
    const collections = [COLLECTION_ENTITIES, COLLECTION_RELATIONSHIPS, COLLECTION_EPISODES];
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
