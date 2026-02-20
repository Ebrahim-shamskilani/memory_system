import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { GraphDbService } from '../../graph-db/graph-db.service';
import {
  ChromadbService,
  COLLECTION_RELATIONSHIPS,
} from '../../chromadb/chromadb.service';
import { CreateRelationshipDto, RelationshipData } from '../types/entity.types';
import { DualWriteResult } from '../types/memory.types';

@Injectable()
export class RelationshipStoreService {
  private readonly logger = new Logger(RelationshipStoreService.name);

  constructor(
    private readonly graphDb: GraphDbService,
    private readonly chromaDb: ChromadbService,
  ) {}

  async create(dto: CreateRelationshipDto): Promise<DualWriteResult> {
    const chromaId = randomUUID();
    const now = new Date().toISOString();

    // Write Neo4j first
    try {
      await this.graphDb.runQuery(
        `MATCH (source:Entity {chromaId: $sourceChromaId})
         MATCH (target:Entity {chromaId: $targetChromaId})
         CREATE (source)-[r:RELATES_TO {
           chromaId: $chromaId,
           relationType: $relationType,
           description: $description,
           confidence: $confidence,
           createdAt: datetime($createdAt),
           updatedAt: datetime($updatedAt)
         }]->(target)
         RETURN r.chromaId AS chromaId`,
        {
          sourceChromaId: dto.sourceChromaId,
          targetChromaId: dto.targetChromaId,
          chromaId,
          relationType: dto.relationType,
          description: dto.description,
          confidence: dto.confidence ?? 1.0,
          createdAt: now,
          updatedAt: now,
        },
      );
    } catch (error) {
      this.logger.error(`Neo4j relationship creation failed: ${(error as Error).message}`);
      return { neo4jSuccess: false, chromaSuccess: false, chromaId };
    }

    // Write ChromaDB
    try {
      await this.chromaDb.upsertDocument(
        COLLECTION_RELATIONSHIPS,
        chromaId,
        dto.description,
        {
          neo4j_rel_type: 'RELATES_TO',
          relation_type: dto.relationType,
          source_chroma_id: dto.sourceChromaId,
          target_chroma_id: dto.targetChromaId,
          created_at: now,
        },
      );
      return { neo4jSuccess: true, chromaSuccess: true, chromaId };
    } catch (error) {
      this.logger.error(`ChromaDB relationship write failed, rolling back: ${(error as Error).message}`);
      await this.rollbackNeo4jRelationship(chromaId);
      return { neo4jSuccess: true, chromaSuccess: false, chromaId, rolledBack: true };
    }
  }

  async getRelationshipsForEntity(
    entityChromaId: string,
  ): Promise<{ relationship: RelationshipData; sourceChromaId: string; targetChromaId: string }[]> {
    const result = await this.graphDb.runQuery(
      `MATCH (source:Entity)-[r:RELATES_TO]-(target:Entity)
       WHERE source.chromaId = $entityChromaId
       RETURN r, source.chromaId AS sourceChromaId, target.chromaId AS targetChromaId`,
      { entityChromaId },
    );

    return result.records.map((record: any) => ({
      relationship: record.r.properties as RelationshipData,
      sourceChromaId: record.sourceChromaId,
      targetChromaId: record.targetChromaId,
    }));
  }

  private async rollbackNeo4jRelationship(chromaId: string): Promise<void> {
    try {
      await this.graphDb.runQuery(
        `MATCH ()-[r:RELATES_TO {chromaId: $chromaId}]-() DELETE r`,
        { chromaId },
      );
    } catch (error) {
      this.logger.error(`Rollback failed for relationship ${chromaId}: ${(error as Error).message}`);
    }
  }
}
