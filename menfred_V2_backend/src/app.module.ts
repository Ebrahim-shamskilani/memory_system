import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { UserMessageModule } from './user-message/user-message.module';
import { LlmModule } from './llm/llm.module';
import { ChromadbModule } from './chromadb/chromadb.module';
import { GraphDbModule } from './graph-db/graph-db.module';
import { MemoryManagerModule } from './memory-manager/memory-manager.module';

@Module({
  imports: [UserMessageModule, LlmModule, ChromadbModule, GraphDbModule, MemoryManagerModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
