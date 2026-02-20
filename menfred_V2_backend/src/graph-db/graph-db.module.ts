import { Module } from '@nestjs/common';
import { GraphDbController } from './graph-db.controller';
import { GraphDbService } from './graph-db.service';
import { GraphDbSchemaService } from './graph-db-schema.service';

@Module({
  controllers: [GraphDbController],
  providers: [GraphDbService, GraphDbSchemaService],
  exports: [GraphDbService, GraphDbSchemaService],
})
export class GraphDbModule {}
