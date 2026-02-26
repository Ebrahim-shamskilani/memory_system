import { Module } from '@nestjs/common';
import { GraphDbModule } from '../graph-db/graph-db.module';
import { UnifiedMemoryService } from './unified-memory.service';
import { UnifiedStoreService } from './store/unified-store.service';
import { EntityStoreService } from './store/entity-store.service';
import { RelationshipStoreService } from './store/relationship-store.service';
import { EpisodeStoreService } from './store/episode-store.service';
import { BeliefStoreService } from './store/belief-store.service';
import { RetrievalAgentService } from './retrieve/retrieval-agent.service';
import { EntityResolverService } from './retrieve/entity-resolver.service';
import { VectorLookupService } from './retrieve/vector-lookup.service';
import { GraphTraversalService } from './retrieve/graph-traversal.service';
import { SufficiencyEvaluatorService } from './retrieve/sufficiency-evaluator.service';
import { EmbeddingService } from './retrieve/embedding.service';
import { SynthesisService } from './synthesize/synthesis.service';
import { MessageIngestorService } from './ingest/message-ingestor.service';
import { BeliefIngestorService } from './ingest/belief-ingestor.service';
import { ConsolidationService } from './consolidate/consolidation.service';
import { CognitionService } from './cognition/cognition.service';
import { MonologueBufferService } from './cognition/monologue-buffer.service';
import { MonologueService } from './cognition/monologue.service';
import { UnconsciousService } from './unconscious/unconscious.service';

@Module({
  imports: [GraphDbModule],
  providers: [
    // Store layer
    EntityStoreService,
    RelationshipStoreService,
    EpisodeStoreService,
    BeliefStoreService,
    UnifiedStoreService,
    // Retrieval layer
    EmbeddingService,
    EntityResolverService,
    VectorLookupService,
    GraphTraversalService,
    SufficiencyEvaluatorService,
    RetrievalAgentService,
    // Unconscious layer
    UnconsciousService,
    // Ingestion layer
    MessageIngestorService,
    BeliefIngestorService,
    // Consolidation layer
    ConsolidationService,
    // Synthesis layer
    SynthesisService,
    // Cognition layer
    CognitionService,
    MonologueBufferService,
    MonologueService,
    // Top-level orchestrator
    UnifiedMemoryService,
  ],
  exports: [UnifiedMemoryService, UnifiedStoreService, EmbeddingService, CognitionService, MonologueService, MonologueBufferService],
})
export class UnifiedMemoryModule {}
