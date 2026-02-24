import { Injectable, Logger } from '@nestjs/common';
import { ChromadbService, COLLECTION_ENTITIES, COLLECTION_RELATIONSHIPS, COLLECTION_EPISODES } from '../../chromadb/chromadb.service';
import { IntentType, TimeConstraints, VectorSearchResult } from '../types/retrieval.types';

const DEFAULT_N_RESULTS = 5;

@Injectable()
export class VectorLookupService {
  private readonly logger = new Logger(VectorLookupService.name);

  constructor(private readonly chromaDb: ChromadbService) {}

  async search(
    query: string,
    intents: IntentType[],
    nResults = DEFAULT_N_RESULTS,
    timeConstraints?: TimeConstraints,
  ): Promise<VectorSearchResult[]> {
    const results: VectorSearchResult[] = [];

    const collections = this.getCollectionsForIntents(intents);
    const filters = this.buildWhereFilters(intents, timeConstraints);

    // When time constraints exist, ALWAYS search episodes regardless of intent.
    // Follow-up <SEARCH> queries re-run entity resolution which may classify
    // "yesterday's conversation" as find_entity — missing episodes entirely.
    if (timeConstraints && !collections.includes(COLLECTION_EPISODES)) {
      collections.push(COLLECTION_EPISODES);
    }

    for (const collectionName of collections) {
      try {
        const where = filters[collectionName];

        // When time constraints exist for episodes, use metadata-only fetch.
        // Vector search for "yesterday's conversation" has low similarity to
        // actual content like "discussed Niklas" — the TIME filter is the
        // primary retrieval mechanism, not vector similarity.
        if (timeConstraints && where && collectionName === COLLECTION_EPISODES) {
          const getResult = await this.chromaDb.getByFilter(
            collectionName,
            where,
            nResults * 4, // fetch more since we're not ranking by relevance
          );

          const ids = getResult.ids ?? [];
          const documents = getResult.documents ?? [];
          const metadatas = getResult.metadatas ?? [];

          for (let i = 0; i < ids.length; i++) {
            results.push({
              chromaId: ids[i],
              document: documents[i] ?? '',
              distance: 0, // metadata-only fetch, no distance score
              metadata: (metadatas[i] as Record<string, unknown>) ?? {},
            });
          }

          this.logger.log(
            `Time-filtered metadata fetch for ${collectionName}: ${ids.length} results`,
          );
        } else {
          const queryResult = await this.chromaDb.queryCollection(
            collectionName,
            query,
            nResults,
            where,
          );

          const ids = queryResult.ids?.[0] ?? [];
          const documents = queryResult.documents?.[0] ?? [];
          const distances = queryResult.distances?.[0] ?? [];
          const metadatas = queryResult.metadatas?.[0] ?? [];

          for (let i = 0; i < ids.length; i++) {
            results.push({
              chromaId: ids[i],
              document: documents[i] ?? '',
              distance: distances[i] ?? 1.0,
              metadata: (metadatas[i] as Record<string, unknown>) ?? {},
            });
          }
        }
      } catch (error) {
        this.logger.warn(`Vector search failed for ${collectionName}: ${(error as Error).message}`);
      }
    }

    // Sort by distance (lower = more similar)
    results.sort((a, b) => a.distance - b.distance);

    return results;
  }

  async searchEntities(query: string, nResults = DEFAULT_N_RESULTS): Promise<VectorSearchResult[]> {
    return this.searchCollection(COLLECTION_ENTITIES, query, nResults);
  }

  async searchRelationships(query: string, nResults = DEFAULT_N_RESULTS): Promise<VectorSearchResult[]> {
    return this.searchCollection(COLLECTION_RELATIONSHIPS, query, nResults);
  }

  async searchFacts(query: string, nResults = DEFAULT_N_RESULTS): Promise<VectorSearchResult[]> {
    return this.searchCollection(COLLECTION_EPISODES, query, nResults, {
      neo4j_label: 'Fact',
    } as any);
  }

  async searchEpisodes(
    query: string,
    nResults = DEFAULT_N_RESULTS,
    maxLevel?: number,
  ): Promise<VectorSearchResult[]> {
    const where = maxLevel !== undefined ? { level: { $lte: maxLevel } } : undefined;
    return this.searchCollection(COLLECTION_EPISODES, query, nResults, where);
  }

  private async searchCollection(
    collectionName: string,
    query: string,
    nResults: number,
    where?: Record<string, unknown>,
  ): Promise<VectorSearchResult[]> {
    try {
      const queryResult = await this.chromaDb.queryCollection(
        collectionName,
        query,
        nResults,
        where,
      );

      const ids = queryResult.ids?.[0] ?? [];
      const documents = queryResult.documents?.[0] ?? [];
      const distances = queryResult.distances?.[0] ?? [];
      const metadatas = queryResult.metadatas?.[0] ?? [];

      return ids.map((id, i) => ({
        chromaId: id,
        document: documents[i] ?? '',
        distance: distances[i] ?? 1.0,
        metadata: (metadatas[i] as Record<string, unknown>) ?? {},
      }));
    } catch (error) {
      this.logger.warn(`Search failed for ${collectionName}: ${(error as Error).message}`);
      return [];
    }
  }

  private getCollectionsForIntents(intents: IntentType[]): string[] {
    const collections = new Set<string>();

    for (const intent of intents) {
      switch (intent) {
        case 'find_entity':
          collections.add(COLLECTION_ENTITIES);
          collections.add(COLLECTION_RELATIONSHIPS);
          break;
        case 'find_relationship':
          collections.add(COLLECTION_ENTITIES);
          collections.add(COLLECTION_RELATIONSHIPS);
          break;
        case 'find_event':
          collections.add(COLLECTION_EPISODES);
          break;
        case 'find_pattern':
          collections.add(COLLECTION_EPISODES);
          break;
        case 'recall_conversation':
          collections.add(COLLECTION_EPISODES);
          break;
      }
    }

    return Array.from(collections);
  }

  private buildWhereFilters(
    intents: IntentType[],
    timeConstraints?: TimeConstraints,
  ): Record<string, Record<string, unknown> | undefined> {
    const filters: Record<string, Record<string, unknown> | undefined> = {};

    // Determine level filter for episodes based on intent
    let episodeLevelFilter: Record<string, unknown> | undefined;
    if (intents.includes('recall_conversation')) {
      // No level filter: search all episode levels
    } else if (intents.includes('find_event')) {
      episodeLevelFilter = { level: { $lte: 2 } };
    } else if (intents.includes('find_pattern')) {
      episodeLevelFilter = { level: { $lte: 1 } };
    }

    // Build time filter conditions for episodes (uses 'timestamp' metadata key)
    const episodeTimeConditions: Record<string, unknown>[] = [];
    if (timeConstraints?.after) {
      episodeTimeConditions.push({ timestamp: { $gte: timeConstraints.after } });
    }
    if (timeConstraints?.before) {
      episodeTimeConditions.push({ timestamp: { $lte: timeConstraints.before } });
    }

    // Combine level + time filters for episodes with $and.
    // Always build episode filter when time constraints exist (episodes may be
    // added to collections list even if intent didn't originally include them).
    if (episodeLevelFilter || episodeTimeConditions.length > 0) {
      const allConditions: Record<string, unknown>[] = [];
      if (episodeLevelFilter) allConditions.push(episodeLevelFilter);
      allConditions.push(...episodeTimeConditions);

      if (allConditions.length === 1) {
        filters[COLLECTION_EPISODES] = allConditions[0];
      } else if (allConditions.length > 1) {
        filters[COLLECTION_EPISODES] = { $and: allConditions } as any;
      }
    }

    // NOTE: No time filter on entities collection — entities are permanent
    // objects (e.g., "ابراهیم" created months ago is still relevant for
    // yesterday's recall). Time filtering only applies to episodes/facts.

    return filters;
  }
}
