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

    // Write ChromaDB (with retry)
    try {
      await this.upsertWithRetry(
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
      this.logger.error(`ChromaDB relationship write failed (keeping Neo4j record ${chromaId}): ${(error as Error).message}`);
      return { neo4jSuccess: true, chromaSuccess: false, chromaId };
    }
  }

  async invalidateRelationship(chromaId: string): Promise<void> {
    // Set invalidatedAt on the Neo4j edge
    try {
      await this.graphDb.runQuery(
        `MATCH ()-[r:RELATES_TO {chromaId: $chromaId}]-()
         SET r.invalidatedAt = datetime()
         RETURN r.chromaId AS chromaId`,
        { chromaId },
      );
    } catch (error) {
      this.logger.error(`Failed to invalidate relationship in Neo4j: ${(error as Error).message}`);
    }

    // Delete from ChromaDB so vector search won't return it
    try {
      await this.chromaDb.deleteDocument(COLLECTION_RELATIONSHIPS, chromaId);
    } catch (error) {
      this.logger.error(`Failed to delete relationship from ChromaDB: ${(error as Error).message}`);
    }
  }

  async getRelationshipsWithContentForEntity(
    entityChromaId: string,
  ): Promise<{ chromaId: string; description: string }[]> {
    const result = await this.graphDb.runQuery(
      `MATCH (source:Entity {chromaId: $entityChromaId})-[r:RELATES_TO]-()
       WHERE r.invalidatedAt IS NULL
       RETURN r.chromaId AS chromaId, r.description AS description`,
      { entityChromaId },
    );
    return result.records.map((rec: any) => ({
      chromaId: rec.chromaId,
      description: rec.description,
    }));
  }

  async findBetweenEntities(
    entityId1: string,
    entityId2: string,
  ): Promise<{ chromaId: string; relationType: string }[]> {
    const result = await this.graphDb.runQuery(
      `MATCH (a:Entity {chromaId: $id1})-[r:RELATES_TO]-(b:Entity {chromaId: $id2})
       WHERE r.invalidatedAt IS NULL
       RETURN r.chromaId AS chromaId, r.relationType AS relationType`,
      { id1: entityId1, id2: entityId2 },
    );
    return result.records.map((rec: any) => ({
      chromaId: rec.chromaId,
      relationType: rec.relationType,
    }));
  }

  async getRelationshipsForEntity(
    entityChromaId: string,
  ): Promise<{ relationship: RelationshipData; sourceChromaId: string; targetChromaId: string }[]> {
    const result = await this.graphDb.runQuery(
      `MATCH (source:Entity)-[r:RELATES_TO]-(target:Entity)
       WHERE source.chromaId = $entityChromaId
         AND r.invalidatedAt IS NULL
       RETURN r, source.chromaId AS sourceChromaId, target.chromaId AS targetChromaId`,
      { entityChromaId },
    );

    return result.records.map((record: any) => ({
      relationship: record.r.properties as RelationshipData,
      sourceChromaId: record.sourceChromaId,
      targetChromaId: record.targetChromaId,
    }));
  }

  private async upsertWithRetry(
    collection: string,
    id: string,
    document: string,
    metadata: Record<string, string | number | boolean>,
    retries = 2,
  ): Promise<void> {
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        await this.chromaDb.upsertDocument(collection, id, document, metadata);
        return;
      } catch (error) {
        if (attempt === retries) throw error;
        this.logger.warn(`ChromaDB upsert retry ${attempt + 1}/${retries} for ${id}`);
        await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
      }
    }
  }
}
