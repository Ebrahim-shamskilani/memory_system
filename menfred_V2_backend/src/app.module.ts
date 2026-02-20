import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { UserMessageModule } from './user-message/user-message.module';
import { LlmModule } from './llm/llm.module';
import { ChromadbModule } from './chromadb/chromadb.module';
import { GraphDbModule } from './graph-db/graph-db.module';
import { ConversationModule } from './conversation/conversation.module';
import { UnifiedMemoryModule } from './unified-memory/unified-memory.module';

@Module({
  imports: [
    LlmModule,
    ChromadbModule,
    GraphDbModule,
    ConversationModule,
    UnifiedMemoryModule,
    UserMessageModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
