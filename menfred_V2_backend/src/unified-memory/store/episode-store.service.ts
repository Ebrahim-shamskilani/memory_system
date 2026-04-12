import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { GraphDbService } from '../../graph-db/graph-db.service';
import {
  ChromadbService,
  COLLECTION_EPISODES,
} from '../../chromadb/chromadb.service';
import {
  CreateEpisodeDto,
  CreateFactDto,
  EpisodeNode,
  FactNode,
} from '../types/episode.types';
import { DualWriteResult } from '../types/memory.types';

@Injectable()
export class EpisodeStoreService {
  private readonly logger = new Logger(EpisodeStoreService.name);

  constructor(
    private readonly graphDb: GraphDbService,
    private readonly chromaDb: ChromadbService,
  ) {}

  async createEpisode(dto: CreateEpisodeDto): Promise<DualWriteResult> {
    const chromaId = randomUUID();
    const now = new Date().toISOString();
    const timestamp = dto.timestamp ?? now;

    const role = dto.role ?? 'user';

    // Write Neo4j first
    try {
      await this.graphDb.runQuery(
        `CREATE (ep:Episode {
          chromaId: $chromaId,
          title: $title,
          description: $description,
          timestamp: datetime($timestamp),
          level: $level,
          source: $source,
          role: $role,
          conversationId: $conversationId,
          createdAt: datetime($createdAt),
          updatedAt: datetime($updatedAt)
        }) RETURN ep.chromaId AS chromaId`,
        {
          chromaId,
          title: dto.title,
          description: dto.description,
          timestamp,
          level: dto.level,
          source: dto.source,
          role,
          conversationId: dto.conversationId,
          createdAt: now,
          updatedAt: now,
        },
      );
    } catch (error) {
      this.logger.error(`Neo4j episode creation failed: ${(error as Error).message}`);
      return { neo4jSuccess: false, chromaSuccess: false, chromaId };
    }

    // Write ChromaDB (with retry)
    try {
      await this.upsertWithRetry(COLLECTION_EPISODES, chromaId, dto.description, {
        neo4j_label: 'Episode',
        level: dto.level,
        timestamp,
        conversation_id: dto.conversationId,
        source: dto.source,
        role,
        created_at: now,
      });
      return { neo4jSuccess: true, chromaSuccess: true, chromaId };
    } catch (error) {
      this.logger.error(`ChromaDB episode write failed (keeping Neo4j record ${chromaId}): ${(error as Error).message}`);
      return { neo4jSuccess: true, chromaSuccess: false, chromaId };
    }
  }

  async createFact(dto: CreateFactDto): Promise<DualWriteResult> {
    const chromaId = randomUUID();
    const now = new Date().toISOString();

    // Write Neo4j first
    try {
      await this.graphDb.runQuery(
        `CREATE (f:Fact {
          chromaId: $chromaId,
          content: $content,
          confidence: $confidence,
          source: $source,
          level: 0,
          createdAt: datetime($createdAt),
          updatedAt: datetime($updatedAt),
          invalidatedAt: null
        }) RETURN f.chromaId AS chromaId`,
        {
          chromaId,
          content: dto.content,
          confidence: dto.confidence ?? 1.0,
          source: dto.source,
          createdAt: now,
          updatedAt: now,
        },
      );
    } catch (error) {
      this.logger.error(`Neo4j fact creation failed: ${(error as Error).message}`);
      return { neo4jSuccess: false, chromaSuccess: false, chromaId };
    }

    // Write ChromaDB (with retry)
    try {
      await this.upsertWithRetry(COLLECTION_EPISODES, chromaId, dto.content, {
        neo4j_label: 'Fact',
        level: 0,
        timestamp: now,
        conversation_id: '',
        source: dto.source,
        created_at: now,
      });
      return { neo4jSuccess: true, chromaSuccess: true, chromaId };
    } catch (error) {
      this.logger.error(`ChromaDB fact write failed (keeping Neo4j record ${chromaId}): ${(error as Error).message}`);
      return { neo4jSuccess: true, chromaSuccess: false, chromaId };
    }
  }

  async linkEntityToFact(
    entityChromaId: string,
    factChromaId: string,
    description: string,
  ): Promise<void> {
    const linkChromaId = randomUUID();
    await this.graphDb.runQuery(
      `MATCH (e:Entity {chromaId: $entityChromaId})
       MATCH (f:Fact {chromaId: $factChromaId})
       CREATE (e)-[:HAS_FACT {chromaId: $linkChromaId, description: $description}]->(f)`,
      { entityChromaId, factChromaId, linkChromaId, description },
    );
  }

  async linkEntityToEpisode(
    entityChromaId: string,
    episodeChromaId: string,
    role: string,
    description: string,
  ): Promise<void> {
    const linkChromaId = randomUUID();
    await this.graphDb.runQuery(
      `MATCH (e:Entity {chromaId: $entityChromaId})
       MATCH (ep:Episode {chromaId: $episodeChromaId})
       CREATE (e)-[:PARTICIPATED_IN {chromaId: $linkChromaId, role: $role, description: $description}]->(ep)`,
      { entityChromaId, episodeChromaId, linkChromaId, role, description },
    );
  }

  async linkEpisodeTemporally(
    previousChromaId: string,
    nextChromaId: string,
  ): Promise<void> {
    await this.graphDb.runQuery(
      `MATCH (prev:Episode {chromaId: $previousChromaId})
       MATCH (next:Episode {chromaId: $nextChromaId})
       CREATE (prev)-[:FOLLOWED_BY]->(next)`,
      { previousChromaId, nextChromaId },
    );
  }

  async findEpisodeByChromaId(chromaId: string): Promise<EpisodeNode | null> {
    const result = await this.graphDb.runQuery(
      `MATCH (ep:Episode {chromaId: $chromaId}) RETURN ep`,
      { chromaId },
    );
    if (result.records.length === 0) return null;
    const record = result.records[0] as { ep: { properties: EpisodeNode } };
    return record.ep.properties;
  }

  async findFactByChromaId(chromaId: string): Promise<FactNode | null> {
    const result = await this.graphDb.runQuery(
      `MATCH (f:Fact {chromaId: $chromaId}) RETURN f`,
      { chromaId },
    );
    if (result.records.length === 0) return null;
    const record = result.records[0] as { f: { properties: FactNode } };
    return record.f.properties;
  }

  // ── New linking methods ──

  async linkEpisodeDerived(
    derivedChromaId: string,
    sourceChromaId: string,
  ): Promise<void> {
    await this.graphDb.runQuery(
      `MATCH (derived:Episode {chromaId: $derivedChromaId})
       MATCH (source:Episode {chromaId: $sourceChromaId})
       CREATE (derived)-[:DERIVED_FROM]->(source)`,
      { derivedChromaId, sourceChromaId },
    );
  }

  async linkEpisodeSummarizedBy(
    summaryChromaId: string,
    sourceChromaIds: string[],
  ): Promise<void> {
    for (const sourceId of sourceChromaIds) {
      await this.graphDb.runQuery(
        `MATCH (source:Episode {chromaId: $sourceId})
         MATCH (summary:Episode {chromaId: $summaryChromaId})
         CREATE (source)-[:SUMMARIZED_BY]->(summary)`,
        { sourceId, summaryChromaId },
      );
    }
  }

  async linkEpisodePatternOf(
    patternChromaId: string,
    sourceChromaIds: string[],
  ): Promise<void> {
    for (const sourceId of sourceChromaIds) {
      await this.graphDb.runQuery(
        `MATCH (source:Episode {chromaId: $sourceId})
         MATCH (pattern:Episode {chromaId: $patternChromaId})
         CREATE (source)-[:PATTERN_OF]->(pattern)`,
        { sourceId, patternChromaId },
      );
    }
  }

  async linkFactYieldedBy(
    factChromaId: string,
    episodeChromaId: string,
  ): Promise<void> {
    await this.graphDb.runQuery(
      `MATCH (ep:Episode {chromaId: $episodeChromaId})
       MATCH (f:Fact {chromaId: $factChromaId})
       CREATE (ep)-[:YIELDED]->(f)`,
      { episodeChromaId, factChromaId },
    );
  }

  async linkFactSupersedes(
    newFactChromaId: string,
    oldFactChromaIds: string[],
  ): Promise<void> {
    for (const oldId of oldFactChromaIds) {
      await this.graphDb.runQuery(
        `MATCH (newFact:Fact {chromaId: $newFactChromaId})
         MATCH (oldFact:Fact {chromaId: $oldId})
         SET oldFact.invalidatedAt = datetime()
         CREATE (newFact)-[:SUPERSEDES]->(oldFact)`,
        { newFactChromaId, oldId },
      );
    }
  }

  // ── New query methods ──

  async getUnconsolidatedLevel3Episodes(limit = 100): Promise<
    { chromaId: string; description: string; conversationId: string; timestamp: string }[]
  > {
    const result = await this.graphDb.runQuery(
      `MATCH (ep:Episode)
       WHERE ep.level = 3
         AND NOT (ep)-[:SUMMARIZED_BY]->()
       RETURN ep.chromaId AS chromaId,
              ep.description AS description,
              ep.conversationId AS conversationId,
              toString(ep.timestamp) AS timestamp
       ORDER BY ep.timestamp ASC
       LIMIT $limit`,
      { limit },
    );
    return result.records as any[];
  }

  async getUnpatternedLevel2Episodes(limit = 100): Promise<
    { chromaId: string; description: string; conversationId: string; timestamp: string }[]
  > {
    const result = await this.graphDb.runQuery(
      `MATCH (ep:Episode)
       WHERE ep.level = 2
         AND NOT (ep)-[:PATTERN_OF]->()
       RETURN ep.chromaId AS chromaId,
              ep.description AS description,
              ep.conversationId AS conversationId,
              toString(ep.timestamp) AS timestamp
       ORDER BY ep.timestamp ASC
       LIMIT $limit`,
      { limit },
    );
    return result.records as any[];
  }

  async getEntityFactsWithTimestamps(entityChromaId: string): Promise<
    { chromaId: string; content: string; confidence: number; source: string; createdAt: string }[]
  > {
    const result = await this.graphDb.runQuery(
      `MATCH (e:Entity {chromaId: $entityChromaId})-[:HAS_FACT]->(f:Fact)
       RETURN f.chromaId AS chromaId,
              f.content AS content,
              f.confidence AS confidence,
              f.source AS source,
              toString(f.createdAt) AS createdAt
       ORDER BY f.createdAt ASC`,
      { entityChromaId },
    );
    return result.records as any[];
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
