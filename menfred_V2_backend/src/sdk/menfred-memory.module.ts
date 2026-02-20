import { DynamicModule, Module } from '@nestjs/common';
import { MENFRED_MEMORY_CONFIG, MenfredMemoryConfig } from './menfred-memory.config';

// Infrastructure services
import { GraphDbService } from '../graph-db/graph-db.service';
import { ChromadbService } from '../chromadb/chromadb.service';
import { LlmService } from '../llm/llm.service';
import { ConversationService } from '../conversation/conversation.service';

// Store layer
import { EntityStoreService } from '../unified-memory/store/entity-store.service';
import { RelationshipStoreService } from '../unified-memory/store/relationship-store.service';
import { EpisodeStoreService } from '../unified-memory/store/episode-store.service';
import { UnifiedStoreService } from '../unified-memory/store/unified-store.service';

// Retrieval layer
import { EmbeddingService } from '../unified-memory/retrieve/embedding.service';
import { EntityResolverService } from '../unified-memory/retrieve/entity-resolver.service';
import { VectorLookupService } from '../unified-memory/retrieve/vector-lookup.service';
import { GraphTraversalService } from '../unified-memory/retrieve/graph-traversal.service';
import { SufficiencyEvaluatorService } from '../unified-memory/retrieve/sufficiency-evaluator.service';
import { RetrievalAgentService } from '../unified-memory/retrieve/retrieval-agent.service';

// Ingestion layer
import { MessageIngestorService } from '../unified-memory/ingest/message-ingestor.service';

// Consolidation layer
import { ConsolidationService } from '../unified-memory/consolidate/consolidation.service';

// Synthesis layer
import { SynthesisService } from '../unified-memory/synthesize/synthesis.service';

// Top-level orchestrator
import { UnifiedMemoryService } from '../unified-memory/unified-memory.service';

@Module({})
export class MenfredMemoryModule {
  static forRoot(config: MenfredMemoryConfig): DynamicModule {
    const configProvider = {
      provide: MENFRED_MEMORY_CONFIG,
      useValue: config,
    };

    const services = [
      // Infrastructure
      GraphDbService,
      ChromadbService,
      LlmService,
      ConversationService,
      // Store layer
      EntityStoreService,
      RelationshipStoreService,
      EpisodeStoreService,
      UnifiedStoreService,
      // Retrieval layer
      EmbeddingService,
      EntityResolverService,
      VectorLookupService,
      GraphTraversalService,
      SufficiencyEvaluatorService,
      RetrievalAgentService,
      // Ingestion layer
      MessageIngestorService,
      // Consolidation layer
      ConsolidationService,
      // Synthesis layer
      SynthesisService,
      // Top-level orchestrator
      UnifiedMemoryService,
    ];

    return {
      module: MenfredMemoryModule,
      global: true,
      providers: [configProvider, ...services],
      exports: [UnifiedMemoryService],
    };
  }
}
