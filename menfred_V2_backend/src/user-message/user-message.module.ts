import { Module } from '@nestjs/common';
import { UserMessageController } from './user-message.controller';

@Module({
  controllers: [UserMessageController],
})
export class UserMessageModule {}
