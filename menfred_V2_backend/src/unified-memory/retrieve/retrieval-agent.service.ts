import { Injectable, Logger } from '@nestjs/common';
import { ConversationService } from '../../conversation/conversation.service';
import { EntityResolverService } from './entity-resolver.service';
import { VectorLookupService } from './vector-lookup.service';
import { GraphTraversalService } from './graph-traversal.service';
import { SufficiencyEvaluatorService } from './sufficiency-evaluator.service';
import {
  EntityResolutionResult,
  RetrievalContext,
  VectorSearchResult,
  TraversalResult,
} from '../types/retrieval.types';

const MAX_ITERATIONS = 3;

@Injectable()
export class RetrievalAgentService {
  private readonly logger = new Logger(RetrievalAgentService.name);

  constructor(
    private readonly conversationService: ConversationService,
    private readonly entityResolver: EntityResolverService,
    private readonly vectorLookup: VectorLookupService,
    private readonly graphTraversal: GraphTraversalService,
    private readonly sufficiencyEvaluator: SufficiencyEvaluatorService,
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

    // Step 2: Entity resolution + intent classification (skip if pre-computed)
    const resolution = precomputedResolution ?? await this.entityResolver.resolve(message, conversationContext);
    this.logger.log(
      `Resolved entities: ${resolution.entities.map((e) => e.name).join(', ')} | Intents: ${resolution.intents.join(', ')}`,
    );

    // Initialize retrieval context
    const context: RetrievalContext = {
      query: resolution.resolvedQuery,
      resolvedEntities: resolution.entities,
      intents: resolution.intents,
      vectorResults: [],
      graphResults: { nodes: [], relationships: [] },
      facts: [],
      iterations: 0,
    };

    // For recall_conversation intent: inject conversation buffer as facts
    if (resolution.intents.includes('recall_conversation') && conversationContext) {
      const turns = this.conversationService.getRecentTurns();
      for (const turn of turns) {
        context.facts.push(`[${turn.timestamp}] [conversation turn] ${turn.role}: ${turn.content}`);
      }
      this.logger.log(`Injected ${turns.length} conversation turns as facts for recall_conversation`);
    }

    // Iterative retrieval loop
    let currentQuery = resolution.resolvedQuery;

    for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
      context.iterations = iteration + 1;

      // Step 3: Vector-first lookup
      const vectorResults = await this.vectorLookup.search(
        currentQuery,
        resolution.intents,
      );
      context.vectorResults.push(...vectorResults);

      // Step 4: Semantic graph traversal
      const seedIds = this.extractSeedIds(vectorResults);
      if (seedIds.length > 0) {
        const traversalResult = await this.graphTraversal.traverse(
          seedIds,
          currentQuery,
        );
        this.mergeTraversalResults(context.graphResults, traversalResult);

        // Collect rich facts from seed entities
        for (const seedId of seedIds) {
          const richFacts = await this.graphTraversal.getEntityFactsRich(seedId);
          for (const rf of richFacts) {
            const prefix = rf.isSuperseded ? '[SUPERSEDED] ' : '';
            const meta = `[${rf.createdAt}] [confidence: ${rf.confidence}] [source: ${rf.source}]`;
            context.facts.push(`${prefix}${meta} ${rf.content}`);
          }
        }
      }

      // Collect all retrieved information as fact strings
      const allFacts = this.collectFacts(context);

      // Step 5: Sufficiency check
      const sufficiency = await this.sufficiencyEvaluator.evaluate(
        message,
        allFacts,
      );

      this.logger.log(
        `Iteration ${iteration + 1}: ${allFacts.length} facts, sufficient: ${sufficiency.hasEnough} (confidence: ${sufficiency.confidence})`,
      );

      if (sufficiency.hasEnough || !sufficiency.nextSearch) {
        break;
      }

      // Use the suggested next search for the next iteration
      currentQuery = sufficiency.nextSearch;
    }

    return context;
  }

  private extractSeedIds(vectorResults: VectorSearchResult[]): string[] {
    const seen = new Set<string>();
    const seeds: string[] = [];

    for (const result of vectorResults) {
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

  private collectFacts(context: RetrievalContext): string[] {
    const facts = new Set<string>();

    // Facts from graph traversal
    for (const fact of context.facts) {
      facts.add(fact);
    }

    // Node descriptions
    for (const node of context.graphResults.nodes) {
      const desc = node.properties.description ?? node.properties.content ?? node.properties.canonicalName;
      if (desc) facts.add(String(desc));
    }

    // Relationship descriptions
    for (const rel of context.graphResults.relationships) {
      const desc = rel.properties.description;
      if (desc) facts.add(String(desc));
    }

    // Vector document text
    for (const vr of context.vectorResults) {
      if (vr.document && vr.distance < 0.5) {
        facts.add(vr.document);
      }
    }

    return Array.from(facts);
  }
}
