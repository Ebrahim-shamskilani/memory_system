import { Body, Controller, Logger, Post, Res } from '@nestjs/common';
import { Response } from 'express';
import { UnifiedMemoryService } from '../unified-memory/unified-memory.service';
import { ConversationService } from '../conversation/conversation.service';
import { RetrievalAgentService } from '../unified-memory/retrieve/retrieval-agent.service';
import { FactCollectorService } from '../unified-memory/retrieve/fact-collector.service';

@Controller('userMessage')
export class UserMessageController {
  private readonly logger = new Logger(UserMessageController.name);

  constructor(
    private readonly unifiedMemory: UnifiedMemoryService,
    private readonly conversation: ConversationService,
    private readonly retrievalAgent: RetrievalAgentService,
    private readonly factCollector: FactCollectorService,
  ) {}

  @Post('stream')
  async streamMessage(@Body() body: { message?: string }, @Res() res: Response) {
    const message = body?.message ?? JSON.stringify(body);
    this.logger.log(`Stream message: ${message}`);

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    try {
      for await (const event of this.unifiedMemory.processMessageStream(message)) {
        res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      }
    } catch (error) {
      this.logger.error(`Stream processing failed: ${(error as Error).message}`);
      res.write(
        `event: error\ndata: ${JSON.stringify({ type: 'error', message: (error as Error).message })}\n\n`,
      );
    }
    res.end();
  }

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

  @Post('recall')
  async recall(@Body() body: { query?: string }) {
    const query = body?.query ?? '';
    this.logger.log(`Memory recall: ${query}`);

    try {
      const context = await this.retrievalAgent.retrieve(query);
      const facts = this.factCollector.collectFacts(context);

      return {
        success: true,
        query: context.query,
        resolvedEntities: context.resolvedEntities,
        intents: context.intents,
        timeConstraints: context.timeConstraints,
        iterations: context.iterations,
        facts,
        vectorResults: context.vectorResults.map(vr => ({
          chromaId: vr.chromaId,
          document: vr.document,
          distance: vr.distance,
          metadata: vr.metadata,
        })),
        graphNodes: context.graphResults.nodes.length,
        graphRelationships: context.graphResults.relationships.length,
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      this.logger.error(`Recall failed: ${(error as Error).message}`);
      return {
        success: false,
        query,
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
