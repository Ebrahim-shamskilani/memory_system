import { Module } from '@nestjs/common';
import { GraphDbController } from './graph-db.controller';
import { GraphDbService } from './graph-db.service';

@Module({
  controllers: [GraphDbController],
  providers: [GraphDbService],
  exports: [GraphDbService],
})
export class GraphDbModule {}
