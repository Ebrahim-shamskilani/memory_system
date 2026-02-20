import { Module } from '@nestjs/common';
import { MemoryManagerController } from './memory-manager.controller';
import { MemoryManagerService } from './memory-manager.service';
import { DecomposeService } from './decompose.service';
import { RecallService } from './recall.service';
import { Neo4jMemoryService } from './neo4j-memory.service';
import { ChromaMemoryService } from './chroma-memory.service';
import { SynthesisService } from './synthesis.service';
import { LlmModule } from '../llm/llm.module';
import { GraphDbModule } from '../graph-db/graph-db.module';

@Module({
  imports: [LlmModule, GraphDbModule],
  controllers: [MemoryManagerController],
  providers: [
    MemoryManagerService,
    DecomposeService,
    RecallService,
    Neo4jMemoryService,
    ChromaMemoryService,
    SynthesisService,
  ],
})
export class MemoryManagerModule {}
