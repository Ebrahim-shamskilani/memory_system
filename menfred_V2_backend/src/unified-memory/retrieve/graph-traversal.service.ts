import { Injectable, Logger } from '@nestjs/common';
import { GraphDbService } from '../../graph-db/graph-db.service';
import { ChromadbService, COLLECTION_RELATIONSHIPS } from '../../chromadb/chromadb.service';
import { EmbeddingService } from './embedding.service';
import { TraversalResult, GraphNode, GraphRelationship, TimeConstraints } from '../types/retrieval.types';

const TOP_K_RELATIONSHIPS = 5;
const MAX_HOPS = 2;
const SIMILARITY_THRESHOLD = 0.3;

@Injectable()
export class GraphTraversalService {
  private readonly logger = new Logger(GraphTraversalService.name);

  constructor(
    private readonly graphDb: GraphDbService,
    private readonly chromaDb: ChromadbService,
    private readonly embeddingService: EmbeddingService,
  ) {}

  /**
   * Semantic graph traversal: starting from seed chromaIds,
   * fetch relationships, filter by cosine similarity to query,
   * and follow top-K to connected nodes.
   */
  async traverse(
    seedChromaIds: string[],
    queryText: string,
    maxHops = MAX_HOPS,
    timeConstraints?: TimeConstraints,
  ): Promise<TraversalResult> {
    const visitedNodes = new Set<string>();
    const allNodes: GraphNode[] = [];
    const allRelationships: GraphRelationship[] = [];
    let currentSeeds = [...seedChromaIds];

    // Get query embedding once
    const queryEmbedding = await this.embeddingService.embed(queryText);

    for (let hop = 0; hop < maxHops && currentSeeds.length > 0; hop++) {
      const newSeeds: string[] = [];

      for (const seedId of currentSeeds) {
        if (visitedNodes.has(seedId)) continue;
        visitedNodes.add(seedId);

        // Get the seed node
        const nodeResult = await this.graphDb.runQuery(
          `MATCH (n {chromaId: $chromaId})
           RETURN n.chromaId AS chromaId, labels(n) AS labels, properties(n) AS props`,
          { chromaId: seedId },
        );

        for (const record of nodeResult.records as any[]) {
          allNodes.push({
            chromaId: record.chromaId,
            labels: record.labels ?? [],
            properties: record.props ?? {},
          });
        }

        // Get all relationships from this seed (with optional time filtering)
        const relResult = await this.graphDb.runQuery(
          `MATCH (source {chromaId: $chromaId})-[r]-(target)
           WHERE r.chromaId IS NOT NULL
             AND ($after IS NULL OR r.createdAt >= datetime($after))
             AND ($before IS NULL OR r.createdAt <= datetime($before))
           RETURN r.chromaId AS relChromaId, type(r) AS relType,
                  properties(r) AS relProps,
                  source.chromaId AS sourceChromaId,
                  target.chromaId AS targetChromaId`,
          {
            chromaId: seedId,
            after: timeConstraints?.after ?? null,
            before: timeConstraints?.before ?? null,
          },
        );

        const relationships = relResult.records as any[];
        if (relationships.length === 0) continue;

        // Fetch relationship embeddings from ChromaDB in batch
        const relChromaIds = relationships.map((r) => r.relChromaId).filter(Boolean);
        const scored = await this.scoreRelationships(relChromaIds, queryEmbedding);

        // Take top-K most relevant relationships
        const topRelationships = scored
          .filter((s) => s.similarity >= SIMILARITY_THRESHOLD)
          .sort((a, b) => b.similarity - a.similarity)
          .slice(0, TOP_K_RELATIONSHIPS);

        const topRelChromaIds = new Set(topRelationships.map((r) => r.chromaId));

        for (const rel of relationships) {
          if (!topRelChromaIds.has(rel.relChromaId)) continue;

          allRelationships.push({
            chromaId: rel.relChromaId,
            type: rel.relType,
            properties: rel.relProps ?? {},
            sourceChromaId: rel.sourceChromaId,
            targetChromaId: rel.targetChromaId,
          });

          // Queue connected nodes for next hop
          const connectedId = rel.targetChromaId === seedId
            ? rel.sourceChromaId
            : rel.targetChromaId;
          if (connectedId && !visitedNodes.has(connectedId)) {
            newSeeds.push(connectedId);
          }
        }
      }

      currentSeeds = newSeeds;
    }

    return { nodes: allNodes, relationships: allRelationships };
  }

  /**
   * Get facts associated with an entity
   */
  async getEntityFacts(entityChromaId: string): Promise<string[]> {
    const result = await this.graphDb.runQuery(
      `MATCH (e:Entity {chromaId: $chromaId})-[:HAS_FACT]->(f:Fact)
       WHERE f.invalidatedAt IS NULL
       RETURN f.content AS content, f.confidence AS confidence
       ORDER BY f.confidence DESC`,
      { chromaId: entityChromaId },
    );

    return (result.records as any[]).map((r) => r.content);
  }

  /**
   * Get facts with full metadata and supersession info
   */
  async getEntityFactsRich(
    entityChromaId: string,
    timeConstraints?: TimeConstraints,
  ): Promise<
    { content: string; confidence: number; source: string; createdAt: string; isSuperseded: boolean }[]
  > {
    const result = await this.graphDb.runQuery(
      `MATCH (e:Entity {chromaId: $chromaId})-[:HAS_FACT]->(f:Fact)
       WHERE f.invalidatedAt IS NULL
         AND ($after IS NULL OR f.createdAt >= datetime($after))
         AND ($before IS NULL OR f.createdAt <= datetime($before))
       OPTIONAL MATCH (newer:Fact)-[:SUPERSEDES]->(f)
       RETURN f.content AS content,
              f.confidence AS confidence,
              f.source AS source,
              toString(f.createdAt) AS createdAt,
              CASE WHEN newer IS NOT NULL THEN true ELSE false END AS isSuperseded
       ORDER BY f.createdAt ASC`,
      {
        chromaId: entityChromaId,
        after: timeConstraints?.after ?? null,
        before: timeConstraints?.before ?? null,
      },
    );

    return (result.records as any[]).map((r) => ({
      content: r.content,
      confidence: r.confidence,
      source: r.source,
      createdAt: r.createdAt,
      isSuperseded: r.isSuperseded,
    }));
  }

  /**
   * Get beliefs associated with an entity, with supersession info
   */
  async getEntityBeliefsRich(
    entityChromaId: string,
    timeConstraints?: TimeConstraints,
  ): Promise<
    { content: string; confidence: number; source: string; createdAt: string; isSuperseded: boolean }[]
  > {
    const result = await this.graphDb.runQuery(
      `MATCH (e:Entity {chromaId: $chromaId})-[:HAS_BELIEF]->(b:Belief)
       WHERE b.invalidatedAt IS NULL
         AND ($after IS NULL OR b.createdAt >= datetime($after))
         AND ($before IS NULL OR b.createdAt <= datetime($before))
       OPTIONAL MATCH (newer:Belief)-[:SUPERSEDES]->(b)
       RETURN b.content AS content,
              b.confidence AS confidence,
              b.source AS source,
              toString(b.createdAt) AS createdAt,
              CASE WHEN newer IS NOT NULL THEN true ELSE false END AS isSuperseded
       ORDER BY b.createdAt ASC`,
      {
        chromaId: entityChromaId,
        after: timeConstraints?.after ?? null,
        before: timeConstraints?.before ?? null,
      },
    );

    return (result.records as any[]).map((r) => ({
      content: r.content,
      confidence: r.confidence,
      source: r.source,
      createdAt: r.createdAt,
      isSuperseded: r.isSuperseded,
    }));
  }

  private async scoreRelationships(
    relChromaIds: string[],
    queryEmbedding: number[],
  ): Promise<{ chromaId: string; similarity: number }[]> {
    if (relChromaIds.length === 0) return [];

    try {
      // Get relationship documents from ChromaDB
      const chromaResult = await this.chromaDb.getByIds(
        COLLECTION_RELATIONSHIPS,
        relChromaIds,
      );

      const documents = chromaResult.documents ?? [];
      if (documents.length === 0) return [];

      // Get embeddings for the relationship documents
      const docTexts = documents.filter((d): d is string => d !== null);
      const docEmbeddings = await this.embeddingService.embedBatch(docTexts);

      // Score each relationship
      const scored: { chromaId: string; similarity: number }[] = [];
      const ids = chromaResult.ids ?? [];
      let docIndex = 0;

      for (let i = 0; i < ids.length; i++) {
        const doc = documents[i];
        if (doc === null) continue;

        const similarity = this.embeddingService.cosineSimilarity(
          queryEmbedding,
          docEmbeddings[docIndex],
        );
        scored.push({ chromaId: ids[i], similarity });
        docIndex++;
      }

      return scored;
    } catch (error) {
      this.logger.warn(`Relationship scoring failed: ${(error as Error).message}`);
      // Fallback: treat all relationships as equally relevant
      return relChromaIds.map((id) => ({ chromaId: id, similarity: 0.5 }));
    }
  }
}
