import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { GraphDbService } from '../../graph-db/graph-db.service';
import {
  ChromadbService,
  COLLECTION_ENTITIES,
  COLLECTION_RELATIONSHIPS,
  COLLECTION_EPISODES,
  COLLECTION_BELIEFS,
} from '../../chromadb/chromadb.service';
import { EntityStoreService } from './entity-store.service';

@Injectable()
export class StoreIntegrityService implements OnModuleInit {
  private readonly logger = new Logger(StoreIntegrityService.name);

  constructor(
    private readonly graphDb: GraphDbService,
    private readonly chromaDb: ChromadbService,
    private readonly entityStore: EntityStoreService,
  ) {}

  async onModuleInit() {
    try {
      const result = await this.syncAll();
      if (result.totalSynced === 0 && result.totalOrphansRemoved === 0) {
        this.logger.log('Store integrity check: all stores in sync');
      } else {
        this.logger.warn(
          `Store integrity check: ${result.totalSynced} items synced to ChromaDB, ${result.totalOrphansRemoved} orphans removed`,
        );
      }
    } catch (error) {
      this.logger.error(`Store integrity check failed: ${(error as Error).message}`);
    }
  }

  async syncAll(): Promise<{ totalSynced: number; totalOrphansRemoved: number; details: Record<string, { synced: number; orphansRemoved: number }> }> {
    const details: Record<string, { synced: number; orphansRemoved: number }> = {};

    details.entities = await this.syncEntities();
    details.relationships = await this.syncRelationships();
    details.episodes = await this.syncEpisodes();
    details.facts = await this.syncFacts();
    details.beliefs = await this.syncBeliefs();

    const totalSynced = Object.values(details).reduce((sum, d) => sum + d.synced, 0);
    const totalOrphansRemoved = Object.values(details).reduce((sum, d) => sum + d.orphansRemoved, 0);

    return { totalSynced, totalOrphansRemoved, details };
  }

  private async getChromaIds(collectionName: string): Promise<Set<string>> {
    const col = await this.chromaDb.getCollection(collectionName);
    const result = await col.get({ include: [] });
    return new Set(result.ids);
  }

  private async syncEntities(): Promise<{ synced: number; orphansRemoved: number }> {
    let synced = 0;
    let orphansRemoved = 0;

    // Get all entities from Neo4j
    const neo4jResult = await this.graphDb.runQuery(
      `MATCH (e:Entity)
       RETURN e.chromaId AS chromaId, e.canonicalName AS canonicalName,
              e.aliases AS aliases, e.entityType AS entityType,
              e.description AS description, e.origin AS origin,
              toString(e.createdAt) AS createdAt`,
    );

    const neo4jIds = new Set<string>();
    const neo4jEntities = neo4jResult.records as any[];
    for (const e of neo4jEntities) {
      neo4jIds.add(e.chromaId);
    }

    // Get all IDs from ChromaDB
    const chromaIds = await this.getChromaIds(COLLECTION_ENTITIES);

    // Upsert missing into ChromaDB
    for (const entity of neo4jEntities) {
      if (!chromaIds.has(entity.chromaId)) {
        try {
          const aliases = entity.aliases ?? [];
          const document = this.entityStore.buildEntityDocument(
            entity.canonicalName, aliases, entity.entityType, entity.description,
          );
          await this.chromaDb.upsertDocument(COLLECTION_ENTITIES, entity.chromaId, document, {
            neo4j_label: 'Entity',
            entity_type: entity.entityType,
            canonical_name: entity.canonicalName,
            aliases: aliases.join(', '),
            origin: entity.origin ?? 'stated',
            created_at: entity.createdAt,
          });
          synced++;
          this.logger.log(`Synced entity ${entity.canonicalName} (${entity.chromaId})`);
        } catch (error) {
          this.logger.error(`Failed to sync entity ${entity.chromaId}: ${(error as Error).message}`);
        }
      }
    }

    // Remove orphans from ChromaDB
    for (const id of chromaIds) {
      if (!neo4jIds.has(id)) {
        try {
          await this.chromaDb.deleteDocument(COLLECTION_ENTITIES, id);
          orphansRemoved++;
          this.logger.log(`Removed orphaned entity from ChromaDB: ${id}`);
        } catch (error) {
          this.logger.error(`Failed to remove orphan entity ${id}: ${(error as Error).message}`);
        }
      }
    }

    return { synced, orphansRemoved };
  }

  private async syncRelationships(): Promise<{ synced: number; orphansRemoved: number }> {
    let synced = 0;
    let orphansRemoved = 0;

    const neo4jResult = await this.graphDb.runQuery(
      `MATCH (s:Entity)-[r:RELATES_TO]->(t:Entity)
       RETURN r.chromaId AS chromaId, r.description AS description,
              r.relationType AS relationType,
              s.chromaId AS sourceChromaId, t.chromaId AS targetChromaId,
              toString(r.createdAt) AS createdAt`,
    );

    const neo4jIds = new Set<string>();
    const neo4jRels = neo4jResult.records as any[];
    for (const r of neo4jRels) {
      neo4jIds.add(r.chromaId);
    }

    const chromaIds = await this.getChromaIds(COLLECTION_RELATIONSHIPS);

    for (const rel of neo4jRels) {
      if (!chromaIds.has(rel.chromaId)) {
        try {
          await this.chromaDb.upsertDocument(COLLECTION_RELATIONSHIPS, rel.chromaId, rel.description, {
            neo4j_rel_type: 'RELATES_TO',
            relation_type: rel.relationType,
            source_chroma_id: rel.sourceChromaId,
            target_chroma_id: rel.targetChromaId,
            created_at: rel.createdAt,
          });
          synced++;
          this.logger.log(`Synced relationship ${rel.chromaId}`);
        } catch (error) {
          this.logger.error(`Failed to sync relationship ${rel.chromaId}: ${(error as Error).message}`);
        }
      }
    }

    for (const id of chromaIds) {
      if (!neo4jIds.has(id)) {
        try {
          await this.chromaDb.deleteDocument(COLLECTION_RELATIONSHIPS, id);
          orphansRemoved++;
          this.logger.log(`Removed orphaned relationship from ChromaDB: ${id}`);
        } catch (error) {
          this.logger.error(`Failed to remove orphan relationship ${id}: ${(error as Error).message}`);
        }
      }
    }

    return { synced, orphansRemoved };
  }

  private async syncEpisodes(): Promise<{ synced: number; orphansRemoved: number }> {
    let synced = 0;
    let orphansRemoved = 0;

    const neo4jResult = await this.graphDb.runQuery(
      `MATCH (ep:Episode)
       RETURN ep.chromaId AS chromaId, ep.description AS description,
              ep.level AS level, toString(ep.timestamp) AS timestamp,
              ep.conversationId AS conversationId, ep.source AS source,
              ep.role AS role, toString(ep.createdAt) AS createdAt`,
    );

    const neo4jIds = new Set<string>();
    const neo4jEpisodes = neo4jResult.records as any[];
    for (const ep of neo4jEpisodes) {
      neo4jIds.add(ep.chromaId);
    }

    const chromaIds = await this.getChromaIds(COLLECTION_EPISODES);

    for (const ep of neo4jEpisodes) {
      if (!chromaIds.has(ep.chromaId)) {
        try {
          await this.chromaDb.upsertDocument(COLLECTION_EPISODES, ep.chromaId, ep.description, {
            neo4j_label: 'Episode',
            level: ep.level,
            timestamp: ep.timestamp,
            conversation_id: ep.conversationId,
            source: ep.source,
            role: ep.role ?? 'user',
            created_at: ep.createdAt,
          });
          synced++;
          this.logger.log(`Synced episode ${ep.chromaId}`);
        } catch (error) {
          this.logger.error(`Failed to sync episode ${ep.chromaId}: ${(error as Error).message}`);
        }
      }
    }

    // Don't remove orphans from episodes collection yet — facts also live here
    // Orphan removal is done after both episodes and facts are collected

    return { synced, orphansRemoved };
  }

  private async syncFacts(): Promise<{ synced: number; orphansRemoved: number }> {
    let synced = 0;
    let orphansRemoved = 0;

    const neo4jResult = await this.graphDb.runQuery(
      `MATCH (f:Fact)
       RETURN f.chromaId AS chromaId, f.content AS content,
              f.source AS source, toString(f.createdAt) AS createdAt`,
    );

    const neo4jFactIds = new Set<string>();
    const neo4jFacts = neo4jResult.records as any[];
    for (const f of neo4jFacts) {
      neo4jFactIds.add(f.chromaId);
    }

    // Also get all episode IDs from Neo4j (since they share the episodes collection)
    const episodeResult = await this.graphDb.runQuery(
      `MATCH (ep:Episode) RETURN ep.chromaId AS chromaId`,
    );
    const neo4jEpisodeIds = new Set<string>();
    for (const ep of episodeResult.records as any[]) {
      neo4jEpisodeIds.add(ep.chromaId);
    }

    const chromaIds = await this.getChromaIds(COLLECTION_EPISODES);

    for (const fact of neo4jFacts) {
      if (!chromaIds.has(fact.chromaId)) {
        try {
          await this.chromaDb.upsertDocument(COLLECTION_EPISODES, fact.chromaId, fact.content, {
            neo4j_label: 'Fact',
            level: 0,
            timestamp: fact.createdAt,
            conversation_id: '',
            source: fact.source,
            created_at: fact.createdAt,
          });
          synced++;
          this.logger.log(`Synced fact ${fact.chromaId}`);
        } catch (error) {
          this.logger.error(`Failed to sync fact ${fact.chromaId}: ${(error as Error).message}`);
        }
      }
    }

    // Now remove orphans: IDs in ChromaDB episodes collection that are neither episodes nor facts in Neo4j
    const allNeo4jEpisodeCollectionIds = new Set([...neo4jEpisodeIds, ...neo4jFactIds]);
    for (const id of chromaIds) {
      if (!allNeo4jEpisodeCollectionIds.has(id)) {
        try {
          await this.chromaDb.deleteDocument(COLLECTION_EPISODES, id);
          orphansRemoved++;
          this.logger.log(`Removed orphaned episode/fact from ChromaDB: ${id}`);
        } catch (error) {
          this.logger.error(`Failed to remove orphan episode/fact ${id}: ${(error as Error).message}`);
        }
      }
    }

    return { synced, orphansRemoved };
  }

  private async syncBeliefs(): Promise<{ synced: number; orphansRemoved: number }> {
    let synced = 0;
    let orphansRemoved = 0;

    const neo4jResult = await this.graphDb.runQuery(
      `MATCH (b:Belief)
       RETURN b.chromaId AS chromaId, b.content AS content,
              b.source AS source, b.confidence AS confidence,
              b.monologueId AS monologueId,
              toString(b.createdAt) AS createdAt`,
    );

    const neo4jIds = new Set<string>();
    const neo4jBeliefs = neo4jResult.records as any[];
    for (const b of neo4jBeliefs) {
      neo4jIds.add(b.chromaId);
    }

    const chromaIds = await this.getChromaIds(COLLECTION_BELIEFS);

    for (const belief of neo4jBeliefs) {
      if (!chromaIds.has(belief.chromaId)) {
        try {
          await this.chromaDb.upsertDocument(COLLECTION_BELIEFS, belief.chromaId, belief.content, {
            neo4j_label: 'Belief',
            source: belief.source,
            confidence: belief.confidence ?? 0.5,
            monologue_id: belief.monologueId ?? '',
            created_at: belief.createdAt,
          });
          synced++;
          this.logger.log(`Synced belief ${belief.chromaId}`);
        } catch (error) {
          this.logger.error(`Failed to sync belief ${belief.chromaId}: ${(error as Error).message}`);
        }
      }
    }

    for (const id of chromaIds) {
      if (!neo4jIds.has(id)) {
        try {
          await this.chromaDb.deleteDocument(COLLECTION_BELIEFS, id);
          orphansRemoved++;
          this.logger.log(`Removed orphaned belief from ChromaDB: ${id}`);
        } catch (error) {
          this.logger.error(`Failed to remove orphan belief ${id}: ${(error as Error).message}`);
        }
      }
    }

    return { synced, orphansRemoved };
  }
}
