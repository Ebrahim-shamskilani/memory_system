import { Controller, Get, Logger, OnModuleDestroy, Res } from '@nestjs/common';
import { Response } from 'express';
import { MonologueService } from '../unified-memory/cognition/monologue.service';
import { MonologueEvent } from '../unified-memory/types/monologue.types';

@Controller('monologue')
export class MonologueController implements OnModuleDestroy {
  private readonly logger = new Logger(MonologueController.name);

  constructor(private readonly monologue: MonologueService) {}

  @Get('stream')
  stream(@Res() res: Response): void {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    this.monologue.clientConnected();

    const listener = (event: MonologueEvent) => {
      res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    };

    this.monologue.events.on('monologue', listener);

    // Heartbeat every 15s to keep connection alive
    const heartbeat = setInterval(() => {
      res.write(`: heartbeat\n\n`);
    }, 15_000);

    res.on('close', () => {
      this.monologue.events.off('monologue', listener);
      clearInterval(heartbeat);
      this.monologue.clientDisconnected();
      this.logger.log('SSE client disconnected');
    });
  }

  @Get('buffer')
  getBuffer() {
    return {
      monologues: this.monologue.getBuffer().getAll(),
      isPaused: this.monologue.isPaused(),
    };
  }

  onModuleDestroy(): void {
    this.monologue.pauseDisconnect();
  }
}
