import { Global, Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { UserMessageModule } from './user-message/user-message.module';
import { LlmModule } from './llm/llm.module';
import { ChromadbModule } from './chromadb/chromadb.module';
import { GraphDbModule } from './graph-db/graph-db.module';
import { ConversationModule } from './conversation/conversation.module';
import { UnifiedMemoryModule } from './unified-memory/unified-memory.module';
import { MENFRED_MEMORY_CONFIG } from './sdk/menfred-memory.config';

/**
 * Provides a global undefined default for the SDK config token.
 * When running standalone, services fall back to env vars.
 * When used as SDK via MenfredMemoryModule.forRoot(config), that module
 * provides the real value and this module is not loaded.
 */
@Global()
@Module({
  providers: [{ provide: MENFRED_MEMORY_CONFIG, useValue: undefined }],
  exports: [MENFRED_MEMORY_CONFIG],
})
class DefaultConfigModule {}

@Module({
  imports: [
    DefaultConfigModule,
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
