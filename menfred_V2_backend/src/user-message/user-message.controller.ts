import { Body, Controller, Post } from '@nestjs/common';

@Controller('userMessage')
export class UserMessageController {
  @Post()
  receiveMessage(@Body() body: { message?: string }) {
    const message = body?.message ?? JSON.stringify(body);
    console.log('User message:', message);
    return {
      success: true,
      received: message,
      timestamp: new Date().toISOString(),
    };
  }
}
