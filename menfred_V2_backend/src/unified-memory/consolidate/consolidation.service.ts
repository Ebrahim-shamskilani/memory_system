import { Injectable, Logger, Inject, Optional } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { LlmService } from '../../llm/llm.service';
import { UnifiedStoreService } from '../store/unified-store.service';
import { GraphDbService } from '../../graph-db/graph-db.service';
import { ChromadbService, COLLECTION_ENTITIES } from '../../chromadb/chromadb.service';
import { ConsolidationStats, ConsolidationRun } from '../types/consolidation.types';
import { MENFRED_MEMORY_CONFIG, MenfredMemoryConfig } from '../../sdk/menfred-memory.config';

const CONSOLIDATION_MESSAGE_THRESHOLD = 10;

const SUMMARIZATION_PROMPT = `You are a memory consolidation engine. Given a sequence of conversation turns (Level 3 raw messages), segment them by TOPIC and summarize each topic.

A multi-topic conversation (e.g., work + family + hobbies) should produce separate summaries per topic.

Rules:
- Each turn can belong to only one topic segment
- Summaries should capture the key information, not just repeat messages
- Write summaries in the same language as the original messages
- Include key facts, entities, and events mentioned

Respond ONLY with valid JSON:
{
  "segments": [
    {
      "topic": "short topic label",
      "turn_indexes": [0, 1, 3],
      "summary": "concise summary of this topic segment"
    }
  ]
}`;

const PATTERN_DETECTION_PROMPT = `You are a memory pattern detection engine. Given a set of Level 2 episode summaries, identify recurring patterns, habits, or themes across them.

Rules:
- Only report patterns that appear in 2+ episodes
- Describe the pattern clearly and concisely
- Reference which episodes support each pattern by their index
- Write patterns in the same language as the summaries

Respond ONLY with valid JSON:
{
  "patterns": [
    {
      "description": "clear description of the recurring pattern",
      "source_indexes": [0, 2, 5],
      "confidence": 0.8
    }
  ]
}`;

const CONTRADICTION_PROMPT = `You are a memory contradiction resolution engine. Given a list of facts about an entity (with timestamps), identify contradictions where later information corrects or updates earlier information.

Rules:
- A contradiction is when two facts assert conflicting information about the same topic
- Corrections ("actually X, not Y") are explicit contradictions
- Create a consolidated fact that represents the current truth
- Reference which old facts are being superseded by index
- Set higher confidence for consolidated facts
- Write in the same language as the original facts

Respond ONLY with valid JSON:
{
  "contradictions": [
    {
      "consolidated_content": "the corrected/consolidated fact",
      "supersedes_indexes": [0, 2],
      "confidence": 0.95,
      "reasoning": "brief explanation of the contradiction"
    }
  ]
}`;

const FACT_PROMOTION_PROMPT = `You are a memory fact promotion engine. Given a pattern description, decide whether it is stable enough to become a standalone fact.

Rules:
- A pattern is stable if it represents a genuine habit, preference, or characteristic
- Speculative or single-occurrence patterns should NOT be promoted
- Promoted facts should be stated clearly as general truths
- Write in the same language as the pattern

Respond ONLY with valid JSON:
{
  "promote": true/false,
  "fact_content": "clear statement of the fact (if promote=true)",
  "confidence": 0.85,
  "reasoning": "why this pattern is/isn't stable enough"
}`;

// DEDUPLICATION_PROMPT is now built dynamically via buildDeduplicationPrompt() to interpolate config values

@Injectable()
export class ConsolidationService {
  private readonly logger = new Logger(ConsolidationService.name);
  private messageCounter = 0;
  private readonly userName: string;

  constructor(
    private readonly llm: LlmService,
    private readonly store: UnifiedStoreService,
    private readonly graphDb: GraphDbService,
    private readonly chromaDb: ChromadbService,
    @Inject(MENFRED_MEMORY_CONFIG) @Optional() config?: MenfredMemoryConfig,
  ) {
    this.userName = config?.user?.name ?? 'ابراهیم';
  }

  private buildDeduplicationPrompt(): string {
    return `You are a memory deduplication engine. Given a list of facts about an entity, identify groups of facts that say the same thing (duplicates or near-duplicates).

Rules:
- Two facts are duplicates if they convey the same information, even if worded slightly differently
- "I have a car" and "${this.userName} has a car" and "من ماشین دارم" are all duplicates
- Do NOT merge facts that are genuinely different (e.g., "has a car" vs "has a bike")
- For each group of duplicates, pick the best-worded version as the canonical content
- Reference duplicates by their index
- Only report groups with 2+ facts

Respond ONLY with valid JSON:
{
  "duplicate_groups": [
    {
      "canonical_content": "the best version of this fact",
      "duplicate_indexes": [0, 3, 5],
      "confidence": 0.95
    }
  ]
}`;
  }

  incrementMessageCounter(): void {
    this.messageCounter++;
  }

  shouldConsolidate(): boolean {
    return this.messageCounter >= CONSOLIDATION_MESSAGE_THRESHOLD;
  }

  async consolidate(
    trigger: ConsolidationRun['trigger'],
  ): Promise<ConsolidationRun> {
    const run: ConsolidationRun = {
      runId: randomUUID(),
      startedAt: new Date().toISOString(),
      trigger,
      stats: {
        level3Processed: 0,
        level2Created: 0,
        level1Created: 0,
        factsConsolidated: 0,
        contradictionsFound: 0,
        duplicatesMerged: 0,
        entitiesMerged: 0,
      },
    };

    this.logger.log(`Consolidation run ${run.runId} started (trigger: ${trigger})`);

    try {
      // Phase A: Level 3 → Level 2 Summarization
      await this.phaseA_Summarize(run.stats);

      // Phase B: Level 2 → Level 1 Pattern Detection
      await this.phaseB_PatternDetect(run.stats);

      // Phase C: Contradiction Resolution
      await this.phaseC_ContradictionResolve(run.stats);

      // Phase D: Fact Promotion from Patterns
      await this.phaseD_FactPromotion(run.stats);

      // Phase E: Duplicate Fact Merging
      await this.phaseE_DeduplicateFacts(run.stats);

      // Phase F: Entity Deduplication
      await this.phaseF_DeduplicateEntities(run.stats);
    } catch (error) {
      this.logger.error(`Consolidation run ${run.runId} failed: ${(error as Error).message}`);
    }

    run.completedAt = new Date().toISOString();
    this.messageCounter = 0;

    this.logger.log(
      `Consolidation run ${run.runId} complete: ` +
      `${run.stats.level3Processed} L3 processed, ${run.stats.level2Created} L2 created, ` +
      `${run.stats.level1Created} L1 created, ${run.stats.factsConsolidated} facts consolidated, ` +
      `${run.stats.contradictionsFound} contradictions, ${run.stats.duplicatesMerged} duplicates merged, ` +
      `${run.stats.entitiesMerged} entities merged`,
    );

    return run;
  }

  // ── Phase A: Level 3 → Level 2 Summarization (topic-aware) ──

  private async phaseA_Summarize(stats: ConsolidationStats): Promise<void> {
    const unconsolidated = await this.store.getUnconsolidatedLevel3Episodes();
    if (unconsolidated.length === 0) return;

    // Group by conversationId
    const byConversation = new Map<string, typeof unconsolidated>();
    for (const ep of unconsolidated) {
      const convId = ep.conversationId;
      if (!byConversation.has(convId)) byConversation.set(convId, []);
      byConversation.get(convId)!.push(ep);
    }

    for (const [conversationId, episodes] of byConversation) {
      stats.level3Processed += episodes.length;

      // Build turn list for LLM
      const turnsText = episodes
        .map((ep, i) => `[${i}] ${ep.description}`)
        .join('\n');

      const prompt = `${SUMMARIZATION_PROMPT}

Conversation turns:
${turnsText}

JSON response:`;

      try {
        const result = await this.llm.generateJson<{
          segments: { topic: string; turn_indexes: number[]; summary: string }[];
        }>({ model: this.llm.getDefaultModel(), prompt, options: { temperature: 0.2, num_predict: 2048 } });

        for (const segment of result.segments ?? []) {
          if (!segment.summary || !segment.turn_indexes?.length) continue;

          // Create Level 2 summary episode
          const summaryResult = await this.store.createEpisode({
            title: `Summary: ${segment.topic}`,
            description: segment.summary,
            level: 2,
            source: 'consolidation',
            conversationId,
          });

          if (summaryResult.neo4jSuccess && summaryResult.chromaSuccess) {
            stats.level2Created++;

            // Link source Level 3 episodes → Level 2 summary via SUMMARIZED_BY
            const sourceChromaIds = segment.turn_indexes
              .filter((i) => i >= 0 && i < episodes.length)
              .map((i) => episodes[i].chromaId);

            await this.store.linkEpisodeSummarizedBy(
              summaryResult.chromaId,
              sourceChromaIds,
            );
          }
        }
      } catch (error) {
        this.logger.warn(
          `Phase A failed for conversation ${conversationId}: ${(error as Error).message}`,
        );
      }
    }
  }

  // ── Phase B: Level 2 → Level 1 Pattern Detection ──

  private async phaseB_PatternDetect(stats: ConsolidationStats): Promise<void> {
    const unpatterned = await this.store.getUnpatternedLevel2Episodes();
    if (unpatterned.length < 2) return; // Need at least 2 to find patterns

    const episodesText = unpatterned
      .map((ep, i) => `[${i}] ${ep.description}`)
      .join('\n');

    const prompt = `${PATTERN_DETECTION_PROMPT}

Level 2 episode summaries:
${episodesText}

JSON response:`;

    try {
      const result = await this.llm.generateJson<{
        patterns: { description: string; source_indexes: number[]; confidence: number }[];
      }>({ model: this.llm.getDefaultModel(), prompt, options: { temperature: 0.2, num_predict: 1500 } });

      for (const pattern of result.patterns ?? []) {
        if (!pattern.description || !pattern.source_indexes?.length) continue;

        // Create Level 1 pattern episode
        const patternResult = await this.store.createEpisode({
          title: `Pattern: ${pattern.description.substring(0, 60)}`,
          description: pattern.description,
          level: 1,
          source: 'consolidation',
          conversationId: '', // patterns span conversations
        });

        if (patternResult.neo4jSuccess && patternResult.chromaSuccess) {
          stats.level1Created++;

          // Link source Level 2 episodes → Level 1 pattern via PATTERN_OF
          const sourceChromaIds = pattern.source_indexes
            .filter((i) => i >= 0 && i < unpatterned.length)
            .map((i) => unpatterned[i].chromaId);

          await this.store.linkEpisodePatternOf(
            patternResult.chromaId,
            sourceChromaIds,
          );
        }
      }
    } catch (error) {
      this.logger.warn(`Phase B failed: ${(error as Error).message}`);
    }
  }

  // ── Phase C: Contradiction Resolution ──

  private async phaseC_ContradictionResolve(stats: ConsolidationStats): Promise<void> {
    // Get all entities that have facts
    const entityResult = await this.graphDb.runQuery(
      `MATCH (e:Entity)-[:HAS_FACT]->(f:Fact)
       WITH e, count(f) AS factCount
       WHERE factCount >= 2
       RETURN e.chromaId AS chromaId, e.canonicalName AS name`,
    );

    for (const entity of entityResult.records as any[]) {
      const facts = await this.store.getEntityFactsWithTimestamps(entity.chromaId);
      if (facts.length < 2) continue;

      const factsText = facts
        .map((f, i) => `[${i}] [${f.createdAt}] [confidence: ${f.confidence}] [source: ${f.source}] ${f.content}`)
        .join('\n');

      const prompt = `${CONTRADICTION_PROMPT}

Entity: "${entity.name}"

Facts:
${factsText}

JSON response:`;

      try {
        const result = await this.llm.generateJson<{
          contradictions: {
            consolidated_content: string;
            supersedes_indexes: number[];
            confidence: number;
            reasoning: string;
          }[];
        }>({ model: this.llm.getDefaultModel(), prompt, options: { temperature: 0.1, num_predict: 1500 } });

        for (const contradiction of result.contradictions ?? []) {
          if (!contradiction.consolidated_content || !contradiction.supersedes_indexes?.length) continue;

          stats.contradictionsFound++;

          // Create new consolidated fact (append-only!)
          const newFactResult = await this.store.createFact({
            content: contradiction.consolidated_content,
            source: 'consolidated',
            confidence: contradiction.confidence ?? 0.95,
          });

          if (newFactResult.neo4jSuccess && newFactResult.chromaSuccess) {
            stats.factsConsolidated++;

            // Link entity → new fact
            await this.store.linkEntityToFact(
              entity.chromaId,
              newFactResult.chromaId,
              contradiction.consolidated_content,
            );

            // Link new fact SUPERSEDES old facts
            const oldFactChromaIds = contradiction.supersedes_indexes
              .filter((i) => i >= 0 && i < facts.length)
              .map((i) => facts[i].chromaId);

            await this.store.linkFactSupersedes(
              newFactResult.chromaId,
              oldFactChromaIds,
            );
          }
        }
      } catch (error) {
        this.logger.warn(
          `Phase C failed for entity "${entity.name}": ${(error as Error).message}`,
        );
      }
    }
  }

  // ── Phase D: Fact Promotion from Patterns ──

  private async phaseD_FactPromotion(stats: ConsolidationStats): Promise<void> {
    // Get Level 1 patterns that haven't yielded facts
    const patternsResult = await this.graphDb.runQuery(
      `MATCH (ep:Episode)
       WHERE ep.level = 1
         AND NOT (ep)-[:YIELDED]->()
       RETURN ep.chromaId AS chromaId, ep.description AS description
       LIMIT 50`,
    );

    for (const pattern of patternsResult.records as any[]) {
      const prompt = `${FACT_PROMOTION_PROMPT}

Pattern: "${pattern.description}"

JSON response:`;

      try {
        const result = await this.llm.generateJson<{
          promote: boolean;
          fact_content: string;
          confidence: number;
          reasoning: string;
        }>({ model: this.llm.getDefaultModel(), prompt, options: { temperature: 0.1, num_predict: 512 } });

        if (!result.promote || !result.fact_content) continue;

        // Create new fact from pattern
        const factResult = await this.store.createFact({
          content: result.fact_content,
          source: 'consolidated',
          confidence: result.confidence ?? 0.8,
        });

        if (factResult.neo4jSuccess && factResult.chromaSuccess) {
          stats.factsConsolidated++;

          // Link pattern → fact via YIELDED
          await this.store.linkFactYieldedBy(
            factResult.chromaId,
            pattern.chromaId,
          );

          // Try to link the fact to relevant entities mentioned in the pattern
          await this.linkFactToPatternEntities(pattern.chromaId, factResult.chromaId, result.fact_content);
        }
      } catch (error) {
        this.logger.warn(`Phase D failed for pattern: ${(error as Error).message}`);
      }
    }
  }

  // ── Phase E: Duplicate Fact Merging ──

  private async phaseE_DeduplicateFacts(stats: ConsolidationStats): Promise<void> {
    // Get all entities that have 2+ facts (potential duplicates)
    const entityResult = await this.graphDb.runQuery(
      `MATCH (e:Entity)-[:HAS_FACT]->(f:Fact)
       WHERE NOT (f)<-[:SUPERSEDES]-()
       WITH e, count(f) AS factCount
       WHERE factCount >= 2
       RETURN e.chromaId AS chromaId, e.canonicalName AS name`,
    );

    for (const entity of entityResult.records as any[]) {
      // Only get non-superseded facts for dedup
      const facts = await this.store.getEntityFactsWithTimestamps(entity.chromaId);
      // Filter to only non-superseded (no incoming SUPERSEDES)
      const activeFactIds = facts.map((f) => f.chromaId);
      const supersededResult = await this.graphDb.runQuery(
        `UNWIND $ids AS id
         MATCH (newer:Fact)-[:SUPERSEDES]->(f:Fact {chromaId: id})
         RETURN f.chromaId AS chromaId`,
        { ids: activeFactIds },
      );
      const supersededSet = new Set(
        (supersededResult.records as any[]).map((r) => r.chromaId),
      );
      const activeFacts = facts.filter((f) => !supersededSet.has(f.chromaId));

      if (activeFacts.length < 2) continue;

      const factsText = activeFacts
        .map((f, i) => `[${i}] [${f.createdAt}] [source: ${f.source}] ${f.content}`)
        .join('\n');

      const prompt = `${this.buildDeduplicationPrompt()}

Entity: "${entity.name}"

Facts:
${factsText}

JSON response:`;

      try {
        const result = await this.llm.generateJson<{
          duplicate_groups: {
            canonical_content: string;
            duplicate_indexes: number[];
            confidence: number;
          }[];
        }>({ model: this.llm.getDefaultModel(), prompt, options: { temperature: 0.1, num_predict: 1500 } });

        for (const group of result.duplicate_groups ?? []) {
          if (!group.canonical_content || !group.duplicate_indexes?.length || group.duplicate_indexes.length < 2) continue;

          stats.duplicatesMerged += group.duplicate_indexes.length;

          // Create a single consolidated fact
          const newFactResult = await this.store.createFact({
            content: group.canonical_content,
            source: 'consolidated',
            confidence: group.confidence ?? 0.95,
          });

          if (newFactResult.neo4jSuccess && newFactResult.chromaSuccess) {
            // Link entity → new merged fact
            await this.store.linkEntityToFact(
              entity.chromaId,
              newFactResult.chromaId,
              group.canonical_content,
            );

            // SUPERSEDES all the duplicates
            const oldFactChromaIds = group.duplicate_indexes
              .filter((i) => i >= 0 && i < activeFacts.length)
              .map((i) => activeFacts[i].chromaId);

            await this.store.linkFactSupersedes(
              newFactResult.chromaId,
              oldFactChromaIds,
            );
          }
        }
      } catch (error) {
        this.logger.warn(
          `Phase E failed for entity "${entity.name}": ${(error as Error).message}`,
        );
      }
    }
  }

  // ── Phase F: Entity Deduplication ──

  private async phaseF_DeduplicateEntities(stats: ConsolidationStats): Promise<void> {
    // Find entity groups with duplicate canonicalNames (case-insensitive)
    const duplicateGroups = await this.graphDb.runQuery(
      `MATCH (e:Entity)
       WITH toLower(e.canonicalName) AS lowerName, collect(e) AS entities
       WHERE size(entities) >= 2
       RETURN lowerName, [ent IN entities | {
         chromaId: ent.chromaId,
         canonicalName: ent.canonicalName,
         aliases: ent.aliases,
         createdAt: ent.createdAt
       }] AS entities`,
    );

    if (duplicateGroups.records.length === 0) return;

    this.logger.log(`Phase F: Found ${duplicateGroups.records.length} entity name groups with duplicates`);

    for (const group of duplicateGroups.records as any[]) {
      const entities = group.entities as {
        chromaId: string;
        canonicalName: string;
        aliases: string[];
        createdAt: string;
      }[];

      // Pick the oldest entity as canonical (first created)
      entities.sort((a, b) => {
        const dateA = a.createdAt ? new Date(a.createdAt).getTime() : 0;
        const dateB = b.createdAt ? new Date(b.createdAt).getTime() : 0;
        return dateA - dateB;
      });

      const canonical = entities[0];
      const duplicates = entities.slice(1);

      // Merge aliases from duplicates into canonical
      const allAliases = new Set<string>(canonical.aliases ?? []);
      for (const dup of duplicates) {
        if (dup.canonicalName !== canonical.canonicalName) {
          allAliases.add(dup.canonicalName);
        }
        for (const alias of dup.aliases ?? []) {
          allAliases.add(alias);
        }
      }

      // Update canonical entity's aliases in Neo4j
      await this.graphDb.runQuery(
        `MATCH (e:Entity {chromaId: $chromaId})
         SET e.aliases = $aliases, e.updatedAt = datetime()`,
        { chromaId: canonical.chromaId, aliases: Array.from(allAliases) },
      );

      for (const dup of duplicates) {
        // Re-link all relationships from duplicate → canonical
        await this.graphDb.runQuery(
          `MATCH (dup:Entity {chromaId: $dupId})-[r:RELATES_TO]->(target)
           MERGE (canon:Entity {chromaId: $canonId})-[:RELATES_TO {
             chromaId: r.chromaId,
             relationType: r.relationType,
             description: r.description,
             confidence: r.confidence
           }]->(target)
           DELETE r`,
          { dupId: dup.chromaId, canonId: canonical.chromaId },
        );

        await this.graphDb.runQuery(
          `MATCH (source)-[r:RELATES_TO]->(dup:Entity {chromaId: $dupId})
           MERGE (source)-[:RELATES_TO {
             chromaId: r.chromaId,
             relationType: r.relationType,
             description: r.description,
             confidence: r.confidence
           }]->(canon:Entity {chromaId: $canonId})
           DELETE r`,
          { dupId: dup.chromaId, canonId: canonical.chromaId },
        );

        // Re-link facts
        await this.graphDb.runQuery(
          `MATCH (dup:Entity {chromaId: $dupId})-[r:HAS_FACT]->(f:Fact)
           MERGE (canon:Entity {chromaId: $canonId})-[:HAS_FACT {description: r.description}]->(f)
           DELETE r`,
          { dupId: dup.chromaId, canonId: canonical.chromaId },
        );

        // Re-link episode participations
        await this.graphDb.runQuery(
          `MATCH (dup:Entity {chromaId: $dupId})-[r:PARTICIPATED_IN]->(ep:Episode)
           MERGE (canon:Entity {chromaId: $canonId})-[:PARTICIPATED_IN {role: r.role, description: r.description}]->(ep)
           DELETE r`,
          { dupId: dup.chromaId, canonId: canonical.chromaId },
        );

        // Delete duplicate Entity node from Neo4j
        await this.graphDb.runQuery(
          `MATCH (e:Entity {chromaId: $chromaId}) DETACH DELETE e`,
          { chromaId: dup.chromaId },
        );

        // Delete duplicate document from ChromaDB
        try {
          await this.chromaDb.deleteDocument(COLLECTION_ENTITIES, dup.chromaId);
        } catch (e) {
          this.logger.warn(`Failed to delete ChromaDB entity ${dup.chromaId}: ${(e as Error).message}`);
        }

        stats.entitiesMerged++;
      }

      this.logger.log(
        `Phase F: Merged ${duplicates.length} duplicate(s) of "${canonical.canonicalName}" into ${canonical.chromaId}`,
      );
    }
  }

  private async linkFactToPatternEntities(
    patternChromaId: string,
    factChromaId: string,
    factContent: string,
  ): Promise<void> {
    // Find entities connected to the source Level 2 episodes of this pattern
    const entityResult = await this.graphDb.runQuery(
      `MATCH (l2:Episode)-[:PATTERN_OF]->(pattern:Episode {chromaId: $patternChromaId})
       MATCH (e:Entity)-[:PARTICIPATED_IN]->(l2)
       RETURN DISTINCT e.chromaId AS chromaId`,
      { patternChromaId },
    );

    for (const entity of entityResult.records as any[]) {
      try {
        await this.store.linkEntityToFact(entity.chromaId, factChromaId, factContent);
      } catch {
        // Best-effort linking
      }
    }
  }
}
