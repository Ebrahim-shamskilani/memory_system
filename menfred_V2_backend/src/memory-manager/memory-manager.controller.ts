import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { MemoryManagerService } from './memory-manager.service';

@Controller('memory-manager')
export class MemoryManagerController {
  constructor(private readonly memoryManagerService: MemoryManagerService) {}

  @Get()
  getStatus() {
    return { status: 'ok', module: 'memory-manager' };
  }

  @Get('recall')
  async recall(@Query('message') message?: string) {
    if (!message) {
      return { response: 'Message is required' };
    }
    const response = await this.memoryManagerService.recall(message);
    return { response };
  }
}
