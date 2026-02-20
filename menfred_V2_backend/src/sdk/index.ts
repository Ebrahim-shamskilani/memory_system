// Module
export { MenfredMemoryModule } from './menfred-memory.module';

// Config
export { MenfredMemoryConfig, MENFRED_MEMORY_CONFIG } from './menfred-memory.config';

// Main service
export { UnifiedMemoryService } from '../unified-memory/unified-memory.service';

// Return types
export { MemoryRecallResult, DualWriteResult, EraseResult } from '../unified-memory/types/memory.types';
export { ConsolidationRun, ConsolidationStats } from '../unified-memory/types/consolidation.types';
export { IngestionResult } from '../unified-memory/ingest/message-ingestor.service';

// DTOs
export { CreateEntityDto, CreateRelationshipDto } from '../unified-memory/types/entity.types';
export { CreateEpisodeDto, CreateFactDto } from '../unified-memory/types/episode.types';
