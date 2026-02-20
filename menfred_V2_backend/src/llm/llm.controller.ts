import { Body, Controller, Post } from '@nestjs/common';
import { LlmService } from './llm.service';

@Controller('llm')
export class LlmController {
  constructor(private readonly llmService: LlmService) {}

  @Post()
  async sendMessage(@Body() body: { message?: string; model?: string }) {
    const message = body?.message ?? '';
    const response = await this.llmService.sendMessage(message, body?.model);
    return { response };
  }
}
