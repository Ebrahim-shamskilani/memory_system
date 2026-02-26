import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { GraphDbService } from '../../graph-db/graph-db.service';
import {
  ChromadbService,
  COLLECTION_ENTITIES,
} from '../../chromadb/chromadb.service';
import { CreateEntityDto, EntityNode } from '../types/entity.types';
import { DualWriteResult } from '../types/memory.types';

@Injectable()
export class EntityStoreService {
  private readonly logger = new Logger(EntityStoreService.name);

  constructor(
    private readonly graphDb: GraphDbService,
    private readonly chromaDb: ChromadbService,
  ) {}

  async create(dto: CreateEntityDto): Promise<DualWriteResult> {
    const chromaId = randomUUID();
    const now = new Date().toISOString();

    // Build the sub-label based on entityType
    const subLabel = dto.entityType.charAt(0).toUpperCase() + dto.entityType.slice(1);

    // Write Neo4j first
    try {
      await this.graphDb.runQuery(
        `CREATE (e:Entity:${subLabel} {
          chromaId: $chromaId,
          canonicalName: $canonicalName,
          aliases: $aliases,
          entityType: $entityType,
          description: $description,
          origin: $origin,
          valence: 0.0,
          arousal: 0.5,
          familiarity: 0.0,
          safety: 0.5,
          createdAt: datetime($createdAt),
          updatedAt: datetime($updatedAt)
        }) RETURN e.chromaId AS chromaId`,
        {
          chromaId,
          canonicalName: dto.canonicalName,
          aliases: dto.aliases ?? [],
          entityType: dto.entityType,
          description: dto.description,
          origin: dto.origin ?? 'stated',
          createdAt: now,
          updatedAt: now,
        },
      );
    } catch (error) {
      this.logger.error(`Neo4j entity creation failed: ${(error as Error).message}`);
      return { neo4jSuccess: false, chromaSuccess: false, chromaId };
    }

    // Write ChromaDB
    try {
      const aliases = dto.aliases ?? [];
      const document = this.buildEntityDocument(dto.canonicalName, aliases, dto.entityType, dto.description);
      await this.chromaDb.upsertDocument(COLLECTION_ENTITIES, chromaId, document, {
        neo4j_label: 'Entity',
        entity_type: dto.entityType,
        canonical_name: dto.canonicalName,
        aliases: aliases.join(', '),
        origin: dto.origin ?? 'stated',
        created_at: now,
      });
      return { neo4jSuccess: true, chromaSuccess: true, chromaId };
    } catch (error) {
      this.logger.error(`ChromaDB entity write failed, rolling back Neo4j: ${(error as Error).message}`);
      await this.rollbackNeo4jEntity(chromaId);
      return { neo4jSuccess: true, chromaSuccess: false, chromaId, rolledBack: true };
    }
  }

  async findByChromaId(chromaId: string): Promise<EntityNode | null> {
    const result = await this.graphDb.runQuery(
      `MATCH (e:Entity {chromaId: $chromaId}) RETURN e`,
      { chromaId },
    );
    if (result.records.length === 0) return null;
    const record = result.records[0] as { e: { properties: EntityNode } };
    return record.e.properties;
  }

  async findByCanonicalName(name: string): Promise<EntityNode | null> {
    const result = await this.graphDb.runQuery(
      `MATCH (e:Entity {canonicalName: $name}) RETURN e`,
      { name },
    );
    if (result.records.length === 0) return null;
    const record = result.records[0] as { e: { properties: EntityNode } };
    return record.e.properties;
  }

  async findByName(name: string): Promise<{ chromaId: string } | null> {
    const result = await this.graphDb.runQuery(
      `MATCH (e:Entity)
       WHERE toLower(e.canonicalName) = toLower($name)
          OR any(a IN e.aliases WHERE toLower(a) = toLower($name))
       RETURN e.chromaId AS chromaId
       LIMIT 1`,
      { name },
    );
    if (result.records.length > 0) {
      return { chromaId: (result.records[0] as any).chromaId };
    }
    return null;
  }

  async updateEmotionalProfile(
    chromaId: string,
    profile: { valence: number; arousal: number; familiarity: number; safety: number },
  ): Promise<void> {
    await this.graphDb.runQuery(
      `MATCH (e:Entity {chromaId: $chromaId})
       SET e.valence = $valence, e.arousal = $arousal,
           e.familiarity = $familiarity, e.safety = $safety,
           e.updatedAt = datetime()`,
      { chromaId, ...profile },
    );
  }

  private buildEntityDocument(
    canonicalName: string,
    aliases: string[],
    entityType: string,
    description: string,
  ): string {
    const aliasText = aliases.length > 0 ? ` (${aliases.join(', ')})` : '';
    return `${canonicalName}${aliasText} -- ${description}, ${entityType}`;
  }

  private async rollbackNeo4jEntity(chromaId: string): Promise<void> {
    try {
      await this.graphDb.runQuery(
        `MATCH (e:Entity {chromaId: $chromaId}) DETACH DELETE e`,
        { chromaId },
      );
    } catch (error) {
      this.logger.error(`Rollback failed for entity ${chromaId}: ${(error as Error).message}`);
    }
  }
}
