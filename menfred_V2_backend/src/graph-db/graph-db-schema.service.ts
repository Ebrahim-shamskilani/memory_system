import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { GraphDbService } from './graph-db.service';

@Injectable()
export class GraphDbSchemaService implements OnModuleInit {
  private readonly logger = new Logger(GraphDbSchemaService.name);

  constructor(private readonly graphDb: GraphDbService) {}

  async onModuleInit() {
    await this.ensureSchema();
  }

  private async ensureSchema() {
    const constraints = [
      'CREATE CONSTRAINT entity_chroma_id IF NOT EXISTS FOR (e:Entity) REQUIRE e.chromaId IS UNIQUE',
      'CREATE CONSTRAINT episode_chroma_id IF NOT EXISTS FOR (ep:Episode) REQUIRE ep.chromaId IS UNIQUE',
      'CREATE CONSTRAINT fact_chroma_id IF NOT EXISTS FOR (f:Fact) REQUIRE f.chromaId IS UNIQUE',
    ];

    const indexes = [
      'CREATE INDEX entity_canonical_name IF NOT EXISTS FOR (e:Entity) ON (e.canonicalName)',
      'CREATE INDEX entity_type IF NOT EXISTS FOR (e:Entity) ON (e.entityType)',
      'CREATE INDEX episode_timestamp IF NOT EXISTS FOR (ep:Episode) ON (ep.timestamp)',
      'CREATE INDEX episode_level IF NOT EXISTS FOR (ep:Episode) ON (ep.level)',
      'CREATE INDEX episode_conversation IF NOT EXISTS FOR (ep:Episode) ON (ep.conversationId)',
      'CREATE INDEX fact_source IF NOT EXISTS FOR (f:Fact) ON (f.source)',
      'CREATE INDEX fact_confidence IF NOT EXISTS FOR (f:Fact) ON (f.confidence)',
      'CREATE INDEX episode_source IF NOT EXISTS FOR (ep:Episode) ON (ep.source)',
    ];

    for (const cypher of [...constraints, ...indexes]) {
      try {
        await this.graphDb.runQuery(cypher);
      } catch (error) {
        this.logger.warn(
          `Schema statement skipped (may already exist): ${(error as Error).message}`,
        );
      }
    }

    this.logger.log('Neo4j schema constraints and indexes ensured');
  }
}
