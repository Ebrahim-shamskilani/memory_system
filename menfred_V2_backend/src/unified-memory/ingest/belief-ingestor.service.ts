import { Injectable, Logger, Inject, Optional } from '@nestjs/common';
import { LlmService } from '../../llm/llm.service';
import { UnifiedStoreService } from '../store/unified-store.service';
import { EntityStoreService } from '../store/entity-store.service';
import { VectorLookupService } from '../retrieve/vector-lookup.service';
import { ExtractedBelief, BeliefIngestionResult } from '../types/belief.types';
import { MENFRED_MEMORY_CONFIG, MenfredMemoryConfig } from '../../sdk/menfred-memory.config';

const BELIEF_SIMILARITY_THRESHOLD = 0.2; // looser than facts' 0.15

@Injectable()
export class BeliefIngestorService {
  private readonly logger = new Logger(BeliefIngestorService.name);
  private readonly brainName: string;
  private readonly userName: string;
  private readonly userNameEnglish: string;

  constructor(
    private readonly llm: LlmService,
    private readonly store: UnifiedStoreService,
    private readonly entityStore: EntityStoreService,
    private readonly vectorLookup: VectorLookupService,
    @Inject(MENFRED_MEMORY_CONFIG) @Optional() config?: MenfredMemoryConfig,
  ) {
    this.brainName = config?.brain?.name ?? 'Manfred';
    this.userName = config?.user?.name ?? 'ابراهیم';
    this.userNameEnglish = config?.user?.nameEnglish ?? 'Ebrahim';
  }

  async ingest(
    voicedOutput: string,
    monologueId: string,
    seed: string,
  ): Promise<BeliefIngestionResult> {
    const result: BeliefIngestionResult = {
      beliefsCreated: 0,
      beliefsSkippedDuplicate: 0,
      entitiesResolved: 0,
      entitiesCreated: 0,
    };

    // Step 1: Extract beliefs from monologue voiced output
    const extracted = await this.extractBeliefs(voicedOutput, seed);
    if (!extracted || extracted.length === 0) return result;

    this.logger.log(`Extracted ${extracted.length} beliefs from monologue`);

    // Step 2: Process each belief
    for (const belief of extracted) {
      // Dedup check — search existing beliefs for semantic similarity
      const isDuplicate = await this.isDuplicateBelief(belief.content);
      if (isDuplicate) {
        this.logger.log(`Skipping duplicate belief: "${belief.content.substring(0, 60)}..."`);
        result.beliefsSkippedDuplicate++;
        continue;
      }

      // Create belief
      const beliefResult = await this.store.createBelief({
        content: belief.content,
        confidence: 0.5,
        source: 'monologue',
        monologueId,
      });

      if (!(beliefResult.neo4jSuccess && beliefResult.chromaSuccess)) continue;
      result.beliefsCreated++;

      // Entity resolution + linking — resolve each mentioned entity
      for (const entityName of belief.about_entities) {
        const resolved = await this.resolveOrCreateEntity(entityName);
        if (resolved) {
          if (resolved.isNew) result.entitiesCreated++;
          else result.entitiesResolved++;

          try {
            await this.store.linkEntityToBelief(
              resolved.chromaId,
              beliefResult.chromaId,
              belief.content,
            );
          } catch (e) {
            this.logger.warn(`Failed to link belief to entity ${entityName}: ${(e as Error).message}`);
          }
        }
      }
    }

    return result;
  }

  private async extractBeliefs(voicedOutput: string, seed: string): Promise<ExtractedBelief[] | null> {
    const prompt = `You are a belief extraction engine for ${this.brainName}, a personal AI companion.

Given ${this.brainName}'s inner monologue output, extract ONLY beliefs — conclusions, inferences, or opinions that ${this.brainName} has formed.

CRITICAL RULES:
- A BELIEF is a CONCLUSION or INFERENCE that ${this.brainName} drew from known facts. It is NOT a raw fact restatement.
- If the monologue just restates known facts without drawing any new conclusion → return empty beliefs array.
- Replace ALL pronouns with actual entity names. Never use "he", "she", "I", "they" — use the actual name.
- Keep beliefs in the SAME LANGUAGE as the monologue.
- "${this.userName}" (${this.userNameEnglish}) is the user. "${this.brainName}" is the AI companion.
- First-person references ("من", "I") in the monologue refer to "${this.brainName}".

Examples of what IS a belief:
- Monologue: "ابراهیم هم برلین زندگی می‌کنه و هم فریلنسره... فکر کنم زندگی شلوغی داره"
  → belief: "ابراهیم احتمالاً زندگی شلوغی دارد چون هم در برلین زندگی می‌کند و هم فریلنسر است"
- Monologue: "دلارا و آرزو هر دو خواهرای ابراهیم هستن... انگار خانواده صمیمی هستن"
  → belief: "خانواده ابراهیم احتمالاً صمیمی هستند"

Examples of what is NOT a belief (do NOT extract):
- "ابراهیم در برلین زندگی می‌کند" (this is a known fact, not a conclusion)
- "آرزو خواهر ابراهیم است" (this is a stated fact, not an inference)

Respond ONLY with valid JSON:
{
  "beliefs": [
    {"content": "clear belief statement using entity names NOT pronouns", "about_entities": ["entity name 1", "entity name 2"]}
  ]
}

Seed topic: "${seed}"

${this.brainName}'s monologue output:
"${voicedOutput}"

JSON response:`;

    try {
      const raw = await this.llm.generate({
        model: this.llm.getDefaultModel(),
        prompt,
        options: { temperature: 0.1, num_predict: 800 },
      });

      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        this.logger.warn('No JSON found in belief extraction response');
        return null;
      }

      const parsed = JSON.parse(jsonMatch[0]);

      return (parsed.beliefs ?? [])
        .map((b: any) => ({
          content: String(b.content ?? ''),
          about_entities: Array.isArray(b.about_entities) ? b.about_entities.map(String) : [],
        }))
        .filter((b: ExtractedBelief) => b.content.length > 0);
    } catch (error) {
      this.logger.error(`Belief extraction failed: ${(error as Error).message}`);
      return null;
    }
  }

  private async isDuplicateBelief(beliefContent: string): Promise<boolean> {
    try {
      const results = await this.vectorLookup.searchBeliefs(beliefContent, 1);
      if (results.length > 0 && results[0].distance < BELIEF_SIMILARITY_THRESHOLD) {
        return true;
      }
    } catch (e) {
      this.logger.warn(`Belief dedup search failed: ${(e as Error).message}`);
    }
    return false;
  }

  private async resolveOrCreateEntity(
    entityName: string,
  ): Promise<{ chromaId: string; isNew: boolean } | null> {
    // Phase 1: Neo4j name lookup (exact match)
    try {
      const nameMatch = await this.entityStore.findByName(entityName);
      if (nameMatch) {
        return { chromaId: nameMatch.chromaId, isNew: false };
      }
    } catch (e) {
      this.logger.warn(`Name lookup failed for "${entityName}": ${(e as Error).message}`);
    }

    // Phase 2: Vector similarity fallback
    const searchResults = await this.vectorLookup.searchEntities(entityName, 3);
    for (const result of searchResults) {
      if (result.distance < 0.4) {
        return { chromaId: result.chromaId, isNew: false };
      }
    }

    // No match — create new entity tagged as inferred
    this.logger.log(`Creating inferred entity from belief: "${entityName}"`);
    const createResult = await this.store.createEntity({
      canonicalName: entityName,
      aliases: [],
      entityType: 'concept', // beliefs often reason about concepts
      description: `[inferred] Entity inferred from ${this.brainName}'s beliefs`,
    });

    if (createResult.neo4jSuccess && createResult.chromaSuccess) {
      return { chromaId: createResult.chromaId, isNew: true };
    }

    return null;
  }
}
