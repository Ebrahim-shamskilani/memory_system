import { Body, Controller, Logger, Post } from '@nestjs/common';
import { UnifiedMemoryService } from '../unified-memory/unified-memory.service';
import { ConversationService } from '../conversation/conversation.service';

@Controller('userMessage')
export class UserMessageController {
  private readonly logger = new Logger(UserMessageController.name);

  constructor(
    private readonly unifiedMemory: UnifiedMemoryService,
    private readonly conversation: ConversationService,
  ) {}

  @Post()
  async receiveMessage(@Body() body: { message?: string }) {
    const message = body?.message ?? JSON.stringify(body);
    this.logger.log(`User message: ${message}`);

    try {
      const result = await this.unifiedMemory.processMessage(message);

      // Store assistant response in conversation buffer
      this.conversation.addTurn('assistant', result.answer);

      return {
        success: true,
        received: message,
        answer: result.answer,
        sources: result.sources,
        ingestion: result.ingestion,
        iterations: result.iterations,
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      this.logger.error(`Processing failed: ${(error as Error).message}`);
      return {
        success: false,
        received: message,
        answer: null,
        error: (error as Error).message,
        timestamp: new Date().toISOString(),
      };
    }
  }

  @Post('consolidate')
  async consolidate() {
    this.logger.log('Manual consolidation triggered');

    try {
      const run = await this.unifiedMemory.triggerConsolidation();
      return {
        success: true,
        consolidation: run,
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      this.logger.error(`Consolidation failed: ${(error as Error).message}`);
      return {
        success: false,
        error: (error as Error).message,
        timestamp: new Date().toISOString(),
      };
    }
  }

  @Post('eraseMemory')
  async eraseMemory() {
    this.logger.warn('Erase all memory triggered');

    try {
      const result = await this.unifiedMemory.eraseAllMemory();
      return {
        success: true,
        erased: result,
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      this.logger.error(`Erase memory failed: ${(error as Error).message}`);
      return {
        success: false,
        error: (error as Error).message,
        timestamp: new Date().toISOString(),
      };
    }
  }

  @Post('endConversation')
  async endConversation() {
    this.logger.log('End conversation triggered');

    try {
      const result = await this.unifiedMemory.endConversation();
      return {
        success: true,
        newConversationId: result.newConversationId,
        consolidation: result.consolidation,
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      this.logger.error(`End conversation failed: ${(error as Error).message}`);
      return {
        success: false,
        error: (error as Error).message,
        timestamp: new Date().toISOString(),
      };
    }
  }
}
