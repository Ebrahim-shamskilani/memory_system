import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { GraphDbService } from '../../graph-db/graph-db.service';
import {
  ChromadbService,
  COLLECTION_BELIEFS,
} from '../../chromadb/chromadb.service';
import { CreateBeliefDto, BeliefNode } from '../types/belief.types';
import { DualWriteResult } from '../types/memory.types';

@Injectable()
export class BeliefStoreService {
  private readonly logger = new Logger(BeliefStoreService.name);

  constructor(
    private readonly graphDb: GraphDbService,
    private readonly chromaDb: ChromadbService,
  ) {}

  async createBelief(dto: CreateBeliefDto): Promise<DualWriteResult> {
    const chromaId = randomUUID();
    const now = new Date().toISOString();

    // Write Neo4j first
    try {
      await this.graphDb.runQuery(
        `CREATE (b:Belief {
          chromaId: $chromaId,
          content: $content,
          confidence: $confidence,
          source: $source,
          monologueId: $monologueId,
          createdAt: datetime($createdAt),
          updatedAt: datetime($updatedAt),
          invalidatedAt: null
        }) RETURN b.chromaId AS chromaId`,
        {
          chromaId,
          content: dto.content,
          confidence: dto.confidence ?? 0.5,
          source: dto.source,
          monologueId: dto.monologueId,
          createdAt: now,
          updatedAt: now,
        },
      );
    } catch (error) {
      this.logger.error(`Neo4j belief creation failed: ${(error as Error).message}`);
      return { neo4jSuccess: false, chromaSuccess: false, chromaId };
    }

    // Write ChromaDB (with retry)
    try {
      await this.upsertWithRetry(COLLECTION_BELIEFS, chromaId, dto.content, {
        neo4j_label: 'Belief',
        source: dto.source,
        confidence: dto.confidence ?? 0.5,
        monologue_id: dto.monologueId,
        created_at: now,
      });
      return { neo4jSuccess: true, chromaSuccess: true, chromaId };
    } catch (error) {
      this.logger.error(`ChromaDB belief write failed (keeping Neo4j record ${chromaId}): ${(error as Error).message}`);
      return { neo4jSuccess: true, chromaSuccess: false, chromaId };
    }
  }

  async linkEntityToBelief(
    entityChromaId: string,
    beliefChromaId: string,
    description: string,
  ): Promise<void> {
    const linkChromaId = randomUUID();
    await this.graphDb.runQuery(
      `MATCH (e:Entity {chromaId: $entityChromaId})
       MATCH (b:Belief {chromaId: $beliefChromaId})
       CREATE (e)-[:HAS_BELIEF {chromaId: $linkChromaId, description: $description}]->(b)`,
      { entityChromaId, beliefChromaId, linkChromaId, description },
    );
  }

  async linkBeliefSupersedes(
    newBeliefChromaId: string,
    oldBeliefChromaIds: string[],
  ): Promise<void> {
    for (const oldId of oldBeliefChromaIds) {
      await this.graphDb.runQuery(
        `MATCH (newBelief:Belief {chromaId: $newBeliefChromaId})
         MATCH (oldBelief:Belief {chromaId: $oldId})
         SET oldBelief.invalidatedAt = datetime()
         CREATE (newBelief)-[:SUPERSEDES]->(oldBelief)`,
        { newBeliefChromaId, oldId },
      );
    }
  }

  async getEntityBeliefs(
    entityChromaId: string,
  ): Promise<{ chromaId: string; content: string }[]> {
    const result = await this.graphDb.runQuery(
      `MATCH (e:Entity {chromaId: $chromaId})-[:HAS_BELIEF]->(b:Belief)
       WHERE b.invalidatedAt IS NULL
       RETURN b.chromaId AS chromaId, b.content AS content
       ORDER BY b.createdAt ASC`,
      { chromaId: entityChromaId },
    );
    return result.records as any[];
  }

  async invalidateBelief(beliefChromaId: string): Promise<void> {
    await this.graphDb.runQuery(
      `MATCH (b:Belief {chromaId: $chromaId})
       SET b.invalidatedAt = datetime()`,
      { chromaId: beliefChromaId },
    );
  }

  async findByChromaId(chromaId: string): Promise<BeliefNode | null> {
    const result = await this.graphDb.runQuery(
      `MATCH (b:Belief {chromaId: $chromaId}) RETURN b`,
      { chromaId },
    );
    if (result.records.length === 0) return null;
    const record = result.records[0] as { b: { properties: BeliefNode } };
    return record.b.properties;
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
