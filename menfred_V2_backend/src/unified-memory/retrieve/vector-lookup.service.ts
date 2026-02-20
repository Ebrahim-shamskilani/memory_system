import { Injectable, Logger } from '@nestjs/common';
import { ChromadbService, COLLECTION_ENTITIES, COLLECTION_RELATIONSHIPS, COLLECTION_EPISODES } from '../../chromadb/chromadb.service';
import { IntentType, VectorSearchResult } from '../types/retrieval.types';

const DEFAULT_N_RESULTS = 5;

@Injectable()
export class VectorLookupService {
  private readonly logger = new Logger(VectorLookupService.name);

  constructor(private readonly chromaDb: ChromadbService) {}

  async search(
    query: string,
    intents: IntentType[],
    nResults = DEFAULT_N_RESULTS,
  ): Promise<VectorSearchResult[]> {
    const results: VectorSearchResult[] = [];

    const collections = this.getCollectionsForIntents(intents);
    const filters = this.getFiltersForIntents(intents);

    for (const collectionName of collections) {
      try {
        const where = filters[collectionName];
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

  private getFiltersForIntents(intents: IntentType[]): Record<string, Record<string, unknown> | undefined> {
    const filters: Record<string, Record<string, unknown> | undefined> = {};

    // recall_conversation: no level filter — include Level 3 raw turns
    if (intents.includes('recall_conversation')) {
      // No filter: search all episode levels
    } else if (intents.includes('find_event')) {
      filters[COLLECTION_EPISODES] = { level: { $lte: 2 } };
    } else if (intents.includes('find_pattern')) {
      filters[COLLECTION_EPISODES] = { level: { $lte: 1 } };
    }

    return filters;
  }
}
