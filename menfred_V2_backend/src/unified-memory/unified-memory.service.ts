import { Injectable, Logger } from '@nestjs/common';
import { UnifiedStoreService } from './store/unified-store.service';
import { RetrievalAgentService } from './retrieve/retrieval-agent.service';
import { SynthesisService } from './synthesize/synthesis.service';
import { MessageIngestorService, IngestionResult } from './ingest/message-ingestor.service';
import { ConsolidationService } from './consolidate/consolidation.service';
import { ConversationService } from '../conversation/conversation.service';
import { MemoryRecallResult } from './types/memory.types';
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
  ) {}

  /**
   * Main entry point: process a user message.
   * Always ingests first (append-only), then recalls.
   */
  async processMessage(message: string): Promise<MemoryRecallResult & { ingestion: IngestionResult }> {
    this.logger.log(`Processing message: "${message.substring(0, 80)}..."`);

    // Add user turn to conversation buffer
    this.conversation.addTurn('user', message);

    // Step 1: INGEST — extract and store entities, facts, relationships, episode
    const ingestion = await this.ingestor.ingest(message);
    this.logger.log(
      `Ingested: ${ingestion.entitiesCreated} new entities, ${ingestion.factsCreated} facts, ${ingestion.relationshipsCreated} relationships`,
    );

    // Step 2: RECALL — retrieve relevant memories and synthesize answer
    const context = await this.retrievalAgent.retrieve(message);
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
