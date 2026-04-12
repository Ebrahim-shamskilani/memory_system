import { Injectable, Logger } from '@nestjs/common';
import { GraphDbService } from '../../graph-db/graph-db.service';
import { ConversationService } from '../../conversation/conversation.service';
import { EntityResolverService } from './entity-resolver.service';
import { QueryDecomposerService } from './query-decomposer.service';
import { VectorLookupService } from './vector-lookup.service';
import { GraphTraversalService } from './graph-traversal.service';
import { EntropyEvaluatorService } from './entropy-evaluator.service';
import { FactCollectorService } from './fact-collector.service';
import {
  EntityResolutionResult,
  IntentType,
  RetrievalContext,
  ScoredItem,
  TimeConstraints,
  VectorSearchResult,
  TraversalResult,
} from '../types/retrieval.types';

const MAX_ITERATIONS = 3;
const SEED_DISTANCE_THRESHOLD = 0.5;

@Injectable()
export class RetrievalAgentService {
  private readonly logger = new Logger(RetrievalAgentService.name);

  constructor(
    private readonly graphDb: GraphDbService,
    private readonly conversationService: ConversationService,
    private readonly entityResolver: EntityResolverService,
    private readonly queryDecomposer: QueryDecomposerService,
    private readonly vectorLookup: VectorLookupService,
    private readonly graphTraversal: GraphTraversalService,
    private readonly entropyEvaluator: EntropyEvaluatorService,
    private readonly factCollector: FactCollectorService,
  ) {}

  /**
   * Multi-step retrieval pipeline:
   * 1. Get conversation context
   * 2. Entity resolution + intent classification
   * 3. Vector-first lookup
   * 4. Semantic graph traversal
   * 5. Iterative deepening with sufficiency checks
   */
  async retrieve(message: string, precomputedResolution?: EntityResolutionResult): Promise<RetrievalContext> {
    // Step 1: Get conversation context
    const conversationContext = this.conversationService.getContextString();

    // Step 2: Entity resolution + query decomposition (in parallel)
    const [resolution, subQueries] = await Promise.all([
      precomputedResolution
        ? Promise.resolve(precomputedResolution)
        : this.entityResolver.resolve(message, conversationContext),
      this.queryDecomposer.decompose(message, conversationContext),
    ]);
    let timeConstraints: TimeConstraints | undefined = resolution.timeConstraints;
    this.logger.log(
      `Resolved entities: ${resolution.entities.map((e) => e.name).join(', ')} | Intents: ${resolution.intents.join(', ')}` +
      (timeConstraints ? ` | Time: ${timeConstraints.after ?? '*'}..${timeConstraints.before ?? '*'}` : ''),
    );

    // Initialize retrieval context
    const context: RetrievalContext = {
      query: resolution.resolvedQuery,
      resolvedEntities: resolution.entities,
      intents: resolution.intents,
      timeConstraints,
      vectorResults: [],
      graphResults: { nodes: [], relationships: [] },
      facts: [],
      iterations: 0,
    };

    // For recall_conversation intent: inject conversation buffer as facts
    // When time constraints exist, only inject turns within the time window
    if (resolution.intents.includes('recall_conversation') && conversationContext) {
      const turns = this.conversationService.getRecentTurns();
      let injected = 0;
      for (const turn of turns) {
        if (timeConstraints) {
          if (timeConstraints.after && turn.timestamp < timeConstraints.after) continue;
          if (timeConstraints.before && turn.timestamp > timeConstraints.before) continue;
        }
        context.facts.push(`[${turn.timestamp}] [conversation turn] ${turn.role}: ${turn.content}`);
        injected++;
      }
      this.logger.log(`Injected ${injected}/${turns.length} conversation turns as facts for recall_conversation`);
    }

    // Ensure we always search at least entity/relationship collections.
    // If the only intent is 'store_information', getCollectionsForIntents() returns
    // nothing — the user's message still references entities we should look up.
    let searchIntents = resolution.intents;
    const hasSearchableIntent = searchIntents.some(
      (i) => i !== 'store_information',
    );
    if (!hasSearchableIntent) {
      searchIntents = [...searchIntents, 'find_entity'];
    }

    // Iterative retrieval loop with entropy-based stopping
    let currentQuery = resolution.resolvedQuery;
    let previousEntropy = 0;
    const allScoredItems: ScoredItem[] = [];
    const seenVectorIds = new Set<string>();

    for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
      context.iterations = iteration + 1;

      // Step 3: Vector-first lookup
      // On first iteration, search original query + all decomposed sub-queries in parallel.
      // Subsequent iterations only use the original query.
      const queriesToSearch = iteration === 0
        ? [currentQuery, ...subQueries]
        : [currentQuery];

      const allRawResultArrays = await Promise.all(
        queriesToSearch.map((q) =>
          this.vectorLookup.search(q, searchIntents, undefined, timeConstraints),
        ),
      );

      // Merge and deduplicate raw results across all queries
      const rawVectorResults: VectorSearchResult[] = [];
      const rawSeenIds = new Set<string>();
      for (const results of allRawResultArrays) {
        for (const r of results) {
          if (!rawSeenIds.has(r.chromaId)) {
            rawSeenIds.add(r.chromaId);
            rawVectorResults.push(r);
          } else {
            // Keep the one with lower distance (higher similarity)
            const idx = rawVectorResults.findIndex((x) => x.chromaId === r.chromaId);
            if (idx >= 0 && r.distance < rawVectorResults[idx].distance) {
              rawVectorResults[idx] = r;
            }
          }
        }
      }

      if (iteration === 0 && subQueries.length > 0) {
        this.logger.log(
          `Decomposed search: ${queriesToSearch.length} queries → ${rawVectorResults.length} unique results`,
        );
      }

      const vectorResults = await this.filterSuperseded(rawVectorResults);

      // Deduplicate vector results across iterations
      for (const vr of vectorResults) {
        if (!seenVectorIds.has(vr.chromaId)) {
          seenVectorIds.add(vr.chromaId);
          context.vectorResults.push(vr);
        }
      }

      // Build scored items from vector results
      for (const vr of vectorResults) {
        allScoredItems.push({ id: vr.chromaId, similarity: 1 - vr.distance });
      }

      // Step 4: Semantic graph traversal
      const seedIds = this.extractSeedIds(vectorResults);
      if (seedIds.length > 0) {
        const traversalResult = await this.graphTraversal.traverse(
          seedIds,
          currentQuery,
          undefined,
          timeConstraints,
        );
        this.mergeTraversalResults(context.graphResults, traversalResult);

        // Merge scored items from graph traversal
        if (traversalResult.scoredItems) {
          for (const si of traversalResult.scoredItems) {
            allScoredItems.push(si);
          }
        }

        // Collect rich facts from seed entities
        for (const seedId of seedIds) {
          const richFacts = await this.graphTraversal.getEntityFactsRich(seedId, timeConstraints);
          for (const rf of richFacts) {
            const prefix = rf.isSuperseded ? '[SUPERSEDED] ' : '';
            const meta = `[${rf.createdAt}] [confidence: ${rf.confidence}] [source: ${rf.source}]`;
            context.facts.push(`${prefix}${meta} ${rf.content}`);
          }

          // Collect beliefs linked to this entity (skip low-confidence monologue beliefs)
          const richBeliefs = await this.graphTraversal.getEntityBeliefsRich(seedId, timeConstraints);
          for (const rb of richBeliefs) {
            if (rb.source === 'monologue' && rb.confidence < 0.7) continue;
            const beliefPrefix = rb.isSuperseded ? '[former belief] ' : '[belief] ';
            const meta = `[${rb.createdAt}] [confidence: ${rb.confidence}] [source: ${rb.source}]`;
            context.facts.push(`${beliefPrefix}${meta} ${rb.content}`);
          }
        }
      }

      // Deduplicate scored items (keep highest similarity per id)
      const mergedScored = this.mergeScored(allScoredItems);

      // Step 5: Entropy-based stopping check (replaces LLM sufficiency evaluator)
      const entropyEval = this.entropyEvaluator.evaluate(
        mergedScored,
        previousEntropy,
        iteration,
      );
      previousEntropy = entropyEval.entropy;

      const allFacts = this.factCollector.collectFacts(context);
      this.logger.log(
        `Iteration ${iteration + 1}: ${allFacts.length} facts, ` +
        `entropy: H=${entropyEval.entropy.toFixed(3)}, maxSim=${entropyEval.maxSimilarity.toFixed(3)}, ` +
        `reason=${entropyEval.reason}`,
      );

      if (entropyEval.shouldStop) {
        break;
      }

      // Fallback: drop time constraints and retry with the original query
      // when the first time-filtered iteration returned insufficient results
      if (timeConstraints && iteration === 0 && entropyEval.reason === 'no_results') {
        this.logger.log('Time-filtered search insufficient, retrying without time constraints');
        timeConstraints = undefined;
        currentQuery = resolution.resolvedQuery;
        continue;
      }

      // No nextSearch from entropy evaluator — just re-run with original query
      currentQuery = resolution.resolvedQuery;
    }

    return context;
  }

  /**
   * Filter out vector results that have been superseded or invalidated in Neo4j.
   */
  private async filterSuperseded(
    vectorResults: VectorSearchResult[],
  ): Promise<VectorSearchResult[]> {
    if (vectorResults.length === 0) return vectorResults;

    const ids = vectorResults.map((r) => r.chromaId);

    try {
      const result = await this.graphDb.runQuery(
        `UNWIND $ids AS id
         OPTIONAL MATCH (n {chromaId: id})
         WHERE n.invalidatedAt IS NOT NULL OR EXISTS { (newer)-[:SUPERSEDES]->(n) }
         RETURN id, CASE WHEN n IS NOT NULL THEN true ELSE false END AS isInvalid`,
        { ids },
      );

      const invalidIds = new Set<string>();
      for (const record of result.records as any[]) {
        if (record.isInvalid) {
          invalidIds.add(record.id);
        }
      }

      if (invalidIds.size > 0) {
        this.logger.log(`Filtered ${invalidIds.size} superseded/invalidated items from vector results`);
      }

      return vectorResults.filter((r) => !invalidIds.has(r.chromaId));
    } catch (e) {
      this.logger.warn(`Superseded filter failed: ${(e as Error).message}`);
      return vectorResults; // fallback: return unfiltered
    }
  }

  private extractSeedIds(vectorResults: VectorSearchResult[]): string[] {
    const seen = new Set<string>();
    const seeds: string[] = [];

    for (const result of vectorResults) {
      // Skip results that are too distant — they shouldn't seed graph expansion
      if (result.distance >= SEED_DISTANCE_THRESHOLD) continue;

      if (!seen.has(result.chromaId)) {
        seen.add(result.chromaId);
        seeds.push(result.chromaId);
      }
      // Also add source/target chroma IDs from relationship metadata
      const sourceId = result.metadata?.source_chroma_id as string | undefined;
      const targetId = result.metadata?.target_chroma_id as string | undefined;
      if (sourceId && !seen.has(sourceId)) {
        seen.add(sourceId);
        seeds.push(sourceId);
      }
      if (targetId && !seen.has(targetId)) {
        seen.add(targetId);
        seeds.push(targetId);
      }
    }

    return seeds;
  }

  private mergeTraversalResults(
    existing: TraversalResult,
    incoming: TraversalResult,
  ): void {
    const existingNodeIds = new Set(existing.nodes.map((n) => n.chromaId));
    const existingRelIds = new Set(existing.relationships.map((r) => r.chromaId));

    for (const node of incoming.nodes) {
      if (!existingNodeIds.has(node.chromaId)) {
        existing.nodes.push(node);
        existingNodeIds.add(node.chromaId);
      }
    }

    for (const rel of incoming.relationships) {
      if (!existingRelIds.has(rel.chromaId)) {
        existing.relationships.push(rel);
        existingRelIds.add(rel.chromaId);
      }
    }
  }

  /**
   * Lightweight retrieval: single-pass vector search + graph traversal + fact collection.
   * No entity resolution, no iterative loop. Used for <SEARCH> follow-ups.
   * Always searches ALL collections — the original message's intents may not match
   * what the <SEARCH> query needs (e.g., original was store_information but follow-up
   * is a find_entity question).
   */
  async retrieveLight(
    searchQuery: string,
    _intents: IntentType[],
    timeConstraints?: TimeConstraints,
  ): Promise<RetrievalContext> {
    // Always search broadly — <SEARCH> queries are questions/lookups regardless
    // of the original message's intent classification
    const broadIntents: IntentType[] = ['find_entity', 'find_relationship', 'find_event'];

    const context: RetrievalContext = {
      query: searchQuery,
      resolvedEntities: [],
      intents: broadIntents,
      timeConstraints,
      vectorResults: [],
      graphResults: { nodes: [], relationships: [] },
      facts: [],
      iterations: 1,
    };

    // Vector lookup — search all collections
    const rawVectorResults = await this.vectorLookup.search(
      searchQuery,
      broadIntents,
      undefined,
      timeConstraints,
    );
    const vectorResults = await this.filterSuperseded(rawVectorResults);
    context.vectorResults.push(...vectorResults);

    // Graph traversal
    const seedIds = this.extractSeedIds(vectorResults);
    if (seedIds.length > 0) {
      const traversalResult = await this.graphTraversal.traverse(
        seedIds,
        searchQuery,
        undefined,
        timeConstraints,
      );
      this.mergeTraversalResults(context.graphResults, traversalResult);

      for (const seedId of seedIds) {
        const richFacts = await this.graphTraversal.getEntityFactsRich(seedId, timeConstraints);
        for (const rf of richFacts) {
          const prefix = rf.isSuperseded ? '[SUPERSEDED] ' : '';
          const meta = `[${rf.createdAt}] [confidence: ${rf.confidence}] [source: ${rf.source}]`;
          context.facts.push(`${prefix}${meta} ${rf.content}`);
        }

        const richBeliefs = await this.graphTraversal.getEntityBeliefsRich(seedId, timeConstraints);
        for (const rb of richBeliefs) {
          if (rb.source === 'monologue' && rb.confidence < 0.7) continue;
          const beliefPrefix = rb.isSuperseded ? '[former belief] ' : '[belief] ';
          const meta = `[${rb.createdAt}] [confidence: ${rb.confidence}] [source: ${rb.source}]`;
          context.facts.push(`${beliefPrefix}${meta} ${rb.content}`);
        }
      }
    }

    return context;
  }

  private mergeScored(items: ScoredItem[]): ScoredItem[] {
    const best = new Map<string, number>();
    for (const item of items) {
      const existing = best.get(item.id);
      if (existing === undefined || item.similarity > existing) {
        best.set(item.id, item.similarity);
      }
    }
    return Array.from(best.entries()).map(([id, similarity]) => ({ id, similarity }));
  }
}
