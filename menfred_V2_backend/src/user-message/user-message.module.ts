import { Module } from '@nestjs/common';
import { UserMessageController } from './user-message.controller';
import { MonologueController } from './monologue.controller';
import { UnifiedMemoryModule } from '../unified-memory/unified-memory.module';

@Module({
  imports: [UnifiedMemoryModule],
  controllers: [UserMessageController, MonologueController],
})
export class UserMessageModule {}
