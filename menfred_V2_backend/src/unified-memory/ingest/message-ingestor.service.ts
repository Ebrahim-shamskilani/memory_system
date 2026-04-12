import { Injectable, Logger, Inject, Optional } from '@nestjs/common';
import { LlmService } from '../../llm/llm.service';
import { UnifiedStoreService } from '../store/unified-store.service';
import { EntityStoreService } from '../store/entity-store.service';
import { RelationshipStoreService } from '../store/relationship-store.service';
import { VectorLookupService } from '../retrieve/vector-lookup.service';
import { EmbeddingService } from '../retrieve/embedding.service';
import { ConversationService } from '../../conversation/conversation.service';
import { EntityType } from '../types/entity.types';
import { ExtractedEvent } from '../types/episode.types';
import { UnconsciousService } from '../unconscious/unconscious.service';
import { MENFRED_MEMORY_CONFIG, MenfredMemoryConfig } from '../../sdk/menfred-memory.config';

const ENTITY_SIMILARITY_THRESHOLD = 0.4; // below this distance = same entity
const FACT_SIMILARITY_THRESHOLD = 0.15;  // below this distance = duplicate fact (tighter than entities)
const CORRECTION_SIMILARITY_THRESHOLD = 0.5; // above this cosine similarity = same topic, potential correction

// EXTRACTION_PROMPT is now built dynamically via buildExtractionPrompt() to interpolate config values

interface ExtractedEntity {
  name: string;
  type: EntityType;
  description: string;
}

interface ExtractedFact {
  content: string;
  about_entities: string[];
}

interface ExtractedRelationship {
  source: string;
  target: string;
  type: string;
  description: string;
}

interface ExtractionResult {
  entities: ExtractedEntity[];
  facts: ExtractedFact[];
  events: ExtractedEvent[];
  relationships: ExtractedRelationship[];
}

export interface IngestionResult {
  entitiesCreated: number;
  entitiesResolved: number;
  factsCreated: number;
  factsSkippedDuplicate: number;
  relationshipsCreated: number;
  relationshipsSkippedDuplicate: number;
  episodeCreated: boolean;
  eventsCreated: number;
}

@Injectable()
export class MessageIngestorService {
  private readonly logger = new Logger(MessageIngestorService.name);
  private readonly lastEpisodeMap = new Map<string, string>(); // conversationId → last Level 3 chromaId
  private readonly userName: string;
  private readonly userNameEnglish: string;
  private readonly brainName: string;

  constructor(
    private readonly llm: LlmService,
    private readonly store: UnifiedStoreService,
    private readonly entityStore: EntityStoreService,
    private readonly relationshipStore: RelationshipStoreService,
    private readonly vectorLookup: VectorLookupService,
    private readonly embeddingService: EmbeddingService,
    private readonly conversation: ConversationService,
    private readonly unconscious: UnconsciousService,
    @Inject(MENFRED_MEMORY_CONFIG) @Optional() config?: MenfredMemoryConfig,
  ) {
    this.userName = config?.user?.name ?? 'ابراهیم';
    this.userNameEnglish = config?.user?.nameEnglish ?? 'Ebrahim';
    this.brainName = config?.brain?.name ?? 'Manfred';
  }

  private buildExtractionPrompt(): string {
    return `You are a memory extraction engine for a personal AI assistant named ${this.brainName}.
Given a user message (may be informal, have typos, no punctuation, mixed languages), extract ALL:

1. **entities**: people, places, things, concepts, organizations mentioned
2. **facts**: stable pieces of knowledge stated or implied
3. **events**: things that happened at a specific time
4. **relationships**: connections between entities

**CRITICAL IDENTITY RULES:**
- The user's name is ${this.userName} (${this.userNameEnglish}).
- The assistant's name is ${this.brainName}.
- ALL first-person references ("من", "I", "me", "my", "مال من", "م") MUST be resolved to "${this.userName}".
- "you/تو/شما/ت" directed at the assistant refers to "${this.brainName}". Example: "تولدته" = "تولد ${this.brainName}", "اسمت" = "اسم ${this.brainName}".
- NEVER use pronouns ("من", "I", "تو", "you") in entity names, fact content, or about_entities. ALWAYS replace with the actual name.
- "${this.userName}" MUST appear in about_entities for ANY fact about the user.
- "${this.brainName}" MUST appear in about_entities for ANY fact about the assistant.

**CRITICAL DATE RULES:**
- Today's date is: {{TODAY_DATE}}
- NEVER use relative time words ("امروز", "today", "دیروز", "yesterday", "فردا", "tomorrow") in fact content.
- ALWAYS resolve them to actual dates. "امروز" → "{{TODAY_DATE}}", "دیروز" → the day before {{TODAY_DATE}}.
- Example: User says "امروز روز تولدته" on {{TODAY_DATE}} → fact: "تاریخ تولد ${this.brainName} {{TODAY_DATE}} است" (NOT "امروز روز تولد ${this.brainName} است")

**Examples of correct extraction:**
- User says: "من تو برلین زندگی می کنم" → fact: "${this.userName} در برلین زندگی می کند", about_entities: ["${this.userName}", "برلین"]
- User says: "دخترم دلاراست" → fact: "دلارا دختر ${this.userName} است", about_entities: ["${this.userName}", "دلارا"], relationship: {source: "${this.userName}", target: "دلارا", type: "father_daughter"}
- User says: "اسم تو ${this.brainName} ه" → fact: "اسم دستیار هوشمند ${this.brainName} است", about_entities: ["${this.brainName}"]
- User says: "امروز روز تولدته" → fact: "تاریخ تولد ${this.brainName} {{TODAY_DATE}} است", about_entities: ["${this.brainName}"]
- User says: "یه خواهر دارم اسمش آرزو" → fact: "آرزو خواهر ${this.userName} است", about_entities: ["${this.userName}", "آرزو"], relationship: {source: "${this.userName}", target: "آرزو", type: "sibling"}

**Distinguishing facts vs events:**
- A **fact** is a general/stable truth: "من تو برلین زندگی می کنم", "دلارا خواهرم هست"
- An **event** happened at a specific time: "دیروز رفتم کوه", "هفته پیش دندون پزشک رفتم"

**CRITICAL: QUESTIONS vs STATEMENTS**
- If the message is a QUESTION asking about existing information (e.g., "آرزو کیه?", "what is X?", "آرزو چه نسبتی با ابراهیم داره?"), return EMPTY arrays for entities, facts, events, and relationships.
- ONLY extract from STATEMENTS that provide NEW information.
- A question does NOT provide new information — do NOT hallucinate or infer answers.

Rules:
- Handle informal Persian (e.g., "تو" instead of "در", "می کنن" instead of "می کنند")
- Handle missing punctuation — split sentences by meaning
- Keep canonical names in their original script (Persian names in Persian)
- For each entity, provide a short description based ONLY on what this message tells us
- For relationships, describe what this message tells us about the connection
- For events, list which entities participated
- If nothing meaningful to extract, return empty arrays

Respond ONLY with valid JSON:
{
  "entities": [
    {"name": "canonical name in original script", "type": "person|place|thing|concept|organization", "description": "what we learn from THIS message"}
  ],
  "facts": [
    {"content": "clear statement using entity names NOT pronouns", "about_entities": ["entity name 1", "entity name 2"]}
  ],
  "events": [
    {"description": "what happened", "participants": ["entity name 1"], "timestampHint": "raw time reference from message", "resolvedTimestamp": "ISO date or null if cannot resolve"}
  ],
  "relationships": [
    {"source": "entity name", "target": "entity name", "type": "short_type", "description": "description of the relationship"}
  ]
}`;
  }

  async ingest(message: string): Promise<IngestionResult> {
    const result: IngestionResult = {
      entitiesCreated: 0,
      entitiesResolved: 0,
      factsCreated: 0,
      factsSkippedDuplicate: 0,
      relationshipsCreated: 0,
      relationshipsSkippedDuplicate: 0,
      episodeCreated: false,
      eventsCreated: 0,
    };

    // Step 1: Store as Level 3 episode (raw conversation turn)
    const conversationId = this.conversation.getActiveConversationId();
    const episodeResult = await this.store.createEpisode({
      title: `User message`,
      description: message,
      level: 3,
      source: 'conversation',
      role: 'user',
      conversationId,
    });
    result.episodeCreated = episodeResult.neo4jSuccess && episodeResult.chromaSuccess;

    // Step 1b: FOLLOWED_BY temporal linking
    if (result.episodeCreated) {
      const previousEpisodeId = this.lastEpisodeMap.get(conversationId);
      if (previousEpisodeId) {
        try {
          await this.store.linkEpisodeTemporally(previousEpisodeId, episodeResult.chromaId);
        } catch (e) {
          this.logger.warn(`Failed to create FOLLOWED_BY link: ${(e as Error).message}`);
        }
      }
      this.lastEpisodeMap.set(conversationId, episodeResult.chromaId);
    }

    // Step 2: Extract entities, facts, events, relationships via LLM
    const extraction = await this.extract(message);
    if (!extraction) return result;

    // Step 2b: Post-process — normalize pronoun references the LLM may have missed
    this.normalizePronouns(extraction);

    this.logger.log(
      `Extracted: ${extraction.entities.length} entities, ${extraction.facts.length} facts, ${extraction.events.length} events, ${extraction.relationships.length} relationships`,
    );

    // Step 3: Resolve or create entities
    // Map: extracted name → chromaId (for linking facts/relationships)
    const entityMap = new Map<string, string>();

    // Always ensure the user entity is in the map
    const userEntity = await this.resolveOrCreateEntity({
      name: this.userName,
      type: 'person',
      description: 'The user of the system',
    });
    if (userEntity) {
      entityMap.set(this.userName, userEntity.chromaId);
      entityMap.set(this.userNameEnglish, userEntity.chromaId);
      if (userEntity.isNew) result.entitiesCreated++;
      else result.entitiesResolved++;
    }

    for (const entity of extraction.entities) {
      // Skip if it's the user themselves
      const lowerName = entity.name.toLowerCase();
      if (lowerName === this.userName.toLowerCase() || lowerName === this.userNameEnglish.toLowerCase()) {
        continue;
      }

      const resolved = await this.resolveOrCreateEntity(entity);
      if (resolved) {
        entityMap.set(entity.name, resolved.chromaId);
        if (resolved.isNew) result.entitiesCreated++;
        else result.entitiesResolved++;
      }
    }

    // Step 3b: Record entity mentions in unconscious (emotional signal)
    for (const [, chromaId] of entityMap) {
      this.unconscious.recordEntityMention(chromaId, message).catch(err =>
        this.logger.warn(`Unconscious entity signal failed: ${(err as Error).message}`),
      );
    }

    // Step 4: Create facts (append-only, with dedup check)
    for (const fact of extraction.facts) {
      // Check if a semantically identical fact already exists
      const isDuplicate = await this.isDuplicateFact(fact.content);
      if (isDuplicate) {
        this.logger.log(`Skipping duplicate fact: "${fact.content.substring(0, 60)}..."`);
        result.factsSkippedDuplicate++;
        continue;
      }

      const factResult = await this.store.createFact({
        content: fact.content,
        source: 'stated',
        confidence: 1.0,
      });

      if (factResult.neo4jSuccess && factResult.chromaSuccess) {
        result.factsCreated++;

        // Link fact to relevant entities
        const linkedEntityChromaIds: string[] = [];
        for (const entityName of fact.about_entities) {
          const chromaId = this.findEntityId(entityName, entityMap);
          if (chromaId) {
            linkedEntityChromaIds.push(chromaId);
            try {
              await this.store.linkEntityToFact(
                chromaId,
                factResult.chromaId,
                fact.content,
              );
            } catch (e) {
              this.logger.warn(`Failed to link fact to ${entityName}: ${(e as Error).message}`);
            }
          }
        }

        // Real-time correction detection: supersede contradicting facts
        if (linkedEntityChromaIds.length > 0) {
          await this.checkAndSupersedeFacts(
            factResult.chromaId,
            fact.content,
            linkedEntityChromaIds,
          );
          await this.invalidateConflictingBeliefs(
            fact.content,
            linkedEntityChromaIds,
          );
          await this.invalidateConflictingRelationships(
            fact.content,
            linkedEntityChromaIds,
          );
        }
      }
    }

    // Step 5: Create relationships (with dedup check)
    for (const rel of extraction.relationships) {
      const sourceId = this.findEntityId(rel.source, entityMap);
      const targetId = this.findEntityId(rel.target, entityMap);

      if (sourceId && targetId) {
        // Dedup check: skip if same relationType already exists between these entities
        const existing = await this.relationshipStore.findBetweenEntities(sourceId, targetId);
        const isDuplicate = existing.some(
          (e) => e.relationType?.toLowerCase() === rel.type.toLowerCase(),
        );
        if (isDuplicate) {
          this.logger.log(
            `Skipping duplicate relationship: "${rel.type}" between ${rel.source} and ${rel.target}`,
          );
          result.relationshipsSkippedDuplicate++;
          continue;
        }

        const relResult = await this.store.createRelationship({
          sourceChromaId: sourceId,
          targetChromaId: targetId,
          relationType: rel.type,
          description: rel.description,
          confidence: 1.0,
        });

        if (relResult.neo4jSuccess && relResult.chromaSuccess) {
          result.relationshipsCreated++;
        }
      } else {
        this.logger.warn(
          `Skipping relationship: could not resolve source="${rel.source}" or target="${rel.target}"`,
        );
      }
    }

    // Step 5.5: Create Level 2 event episodes
    for (const event of extraction.events) {
      const eventTimestamp = event.resolvedTimestamp || new Date().toISOString();
      const eventEpisodeResult = await this.store.createEpisode({
        title: `Event: ${event.description.substring(0, 60)}`,
        description: event.description,
        timestamp: eventTimestamp,
        level: 2,
        source: 'conversation',
        conversationId,
      });

      if (eventEpisodeResult.neo4jSuccess && eventEpisodeResult.chromaSuccess) {
        result.eventsCreated++;

        // Link Level 2 event → Level 3 source via DERIVED_FROM
        try {
          await this.store.linkEpisodeDerived(eventEpisodeResult.chromaId, episodeResult.chromaId);
        } catch (e) {
          this.logger.warn(`Failed to link event DERIVED_FROM: ${(e as Error).message}`);
        }

        // Link participating entities → Level 2 event via PARTICIPATED_IN
        for (const participantName of event.participants) {
          const participantId = this.findEntityId(participantName, entityMap);
          if (participantId) {
            try {
              await this.store.linkEntityToEpisode(
                participantId,
                eventEpisodeResult.chromaId,
                'participant',
                event.description,
              );
            } catch (e) {
              this.logger.warn(`Failed to link participant to event: ${(e as Error).message}`);
            }
          }
        }
      }
    }

    // Step 6: Link the episode to participating entities
    for (const [, chromaId] of entityMap) {
      try {
        await this.store.linkEntityToEpisode(
          chromaId,
          episodeResult.chromaId,
          'mentioned',
          'Entity mentioned in conversation',
        );
      } catch (e) {
        // May fail if entity or episode doesn't exist — that's ok
      }
    }

    this.logger.log(
      `Ingestion complete: ${result.entitiesCreated} new entities, ${result.entitiesResolved} resolved, ${result.factsCreated} facts (${result.factsSkippedDuplicate} dupes skipped), ${result.eventsCreated} events, ${result.relationshipsCreated} relationships (${result.relationshipsSkippedDuplicate} dupes skipped)`,
    );

    return result;
  }

  async storeSelfResponse(response: string): Promise<{ episodeCreated: boolean }> {
    const conversationId = this.conversation.getActiveConversationId();

    // Prefix baked into the document text — travels everywhere, impossible to strip
    const prefixedText = `[self] ${response}`;

    const episodeResult = await this.store.createEpisode({
      title: `${this.brainName} response`,
      description: prefixedText,
      level: 3,
      source: 'conversation',
      role: 'self',
      conversationId,
    });

    const created = episodeResult.neo4jSuccess && episodeResult.chromaSuccess;

    // Maintain FOLLOWED_BY chain (self turn follows user turn)
    if (created) {
      const previousEpisodeId = this.lastEpisodeMap.get(conversationId);
      if (previousEpisodeId) {
        try {
          await this.store.linkEpisodeTemporally(previousEpisodeId, episodeResult.chromaId);
        } catch (e) {
          this.logger.warn(`Failed to create FOLLOWED_BY link for self response: ${(e as Error).message}`);
        }
      }
      this.lastEpisodeMap.set(conversationId, episodeResult.chromaId);
    }

    return { episodeCreated: created };
  }

  private async extract(message: string): Promise<ExtractionResult | null> {
    const context = this.conversation.getContextString();
    const todayDate = new Date().toISOString().split('T')[0];
    const promptWithDate = this.buildExtractionPrompt().replace('{{TODAY_DATE}}', todayDate);

    const prompt = `${promptWithDate}

Recent conversation context:
${context || '(no prior context)'}

User message: "${message}"

JSON response:`;

    try {
      const raw = await this.llm.generate({
        model: this.llm.getDefaultModel(),
        prompt,
        options: { temperature: 0.1, num_predict: 1500 },
      });

      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        this.logger.warn('No JSON found in extraction response');
        return null;
      }

      const parsed = JSON.parse(jsonMatch[0]);

      return {
        entities: (parsed.entities ?? []).map((e: any) => ({
          name: String(e.name ?? ''),
          type: this.normalizeEntityType(e.type),
          description: String(e.description ?? ''),
        })).filter((e: ExtractedEntity) => e.name.length > 0),
        facts: (parsed.facts ?? []).map((f: any) => ({
          content: String(f.content ?? ''),
          about_entities: Array.isArray(f.about_entities) ? f.about_entities.map(String) : [],
        })).filter((f: ExtractedFact) => f.content.length > 0),
        events: (parsed.events ?? []).map((ev: any) => ({
          description: String(ev.description ?? ''),
          participants: Array.isArray(ev.participants) ? ev.participants.map(String) : [],
          timestampHint: String(ev.timestampHint ?? ''),
          resolvedTimestamp: ev.resolvedTimestamp ? String(ev.resolvedTimestamp) : null,
        })).filter((ev: ExtractedEvent) => ev.description.length > 0),
        relationships: (parsed.relationships ?? []).map((r: any) => ({
          source: String(r.source ?? ''),
          target: String(r.target ?? ''),
          type: String(r.type ?? 'related_to'),
          description: String(r.description ?? ''),
        })).filter((r: ExtractedRelationship) => r.source.length > 0 && r.target.length > 0),
      };
    } catch (error) {
      this.logger.error(`Extraction failed: ${(error as Error).message}`);
      return null;
    }
  }

  private async resolveOrCreateEntity(
    entity: ExtractedEntity,
  ): Promise<{ chromaId: string; isNew: boolean } | null> {
    // Phase 1: Neo4j name lookup (exact match on canonicalName or aliases)
    try {
      const nameMatch = await this.entityStore.findByName(entity.name);
      if (nameMatch) {
        this.logger.log(`Resolved "${entity.name}" → existing entity via name lookup`);
        return { chromaId: nameMatch.chromaId, isNew: false };
      }
    } catch (e) {
      this.logger.warn(`Name lookup failed for "${entity.name}": ${(e as Error).message}`);
    }

    // Phase 2: Vector similarity fallback
    const searchResults = await this.vectorLookup.searchEntities(entity.name, 3);

    for (const result of searchResults) {
      if (result.distance < ENTITY_SIMILARITY_THRESHOLD) {
        this.logger.log(
          `Resolved "${entity.name}" → existing entity via vector (distance: ${result.distance.toFixed(3)})`,
        );
        return { chromaId: result.chromaId, isNew: false };
      }
    }

    // No match — create new entity
    this.logger.log(`Creating new entity: "${entity.name}" (${entity.type})`);
    const createResult = await this.store.createEntity({
      canonicalName: entity.name,
      aliases: [],
      entityType: entity.type,
      description: entity.description,
    });

    if (createResult.neo4jSuccess && createResult.chromaSuccess) {
      return { chromaId: createResult.chromaId, isNew: true };
    }

    return null;
  }

  private async isDuplicateFact(factContent: string): Promise<boolean> {
    try {
      const results = await this.vectorLookup.searchFacts(factContent, 1);
      if (results.length > 0 && results[0].distance < FACT_SIMILARITY_THRESHOLD) {
        return true;
      }
    } catch (e) {
      this.logger.warn(`Fact dedup search failed: ${(e as Error).message}`);
    }
    return false;
  }

  private findEntityId(name: string, entityMap: Map<string, string>): string | undefined {
    // Direct match
    const direct = entityMap.get(name);
    if (direct) return direct;

    // Case-insensitive search
    for (const [key, value] of entityMap) {
      if (key.toLowerCase() === name.toLowerCase()) return value;
    }

    return undefined;
  }

  private normalizeEntityType(type: string): EntityType {
    const valid: EntityType[] = ['person', 'place', 'thing', 'concept', 'organization'];
    const normalized = (type ?? '').toLowerCase().trim();
    return valid.includes(normalized as EntityType) ? (normalized as EntityType) : 'thing';
  }

  /**
   * Check whether the new fact contradicts existing facts about the same entities.
   * If similarity > CORRECTION_SIMILARITY_THRESHOLD, the new fact supersedes the old one.
   */
  private async checkAndSupersedeFacts(
    newFactChromaId: string,
    factContent: string,
    entityChromaIds: string[],
  ): Promise<void> {
    try {
      const newFactEmbedding = await this.embeddingService.embed(factContent);
      const seenOldFactIds = new Set<string>();

      for (const entityChromaId of entityChromaIds) {
        const existingFacts = await this.store.getEntityFactsWithTimestamps(entityChromaId);

        for (const oldFact of existingFacts) {
          if (oldFact.chromaId === newFactChromaId) continue;
          if (seenOldFactIds.has(oldFact.chromaId)) continue;
          seenOldFactIds.add(oldFact.chromaId);

          const oldFactEmbedding = await this.embeddingService.embed(oldFact.content);
          const similarity = this.embeddingService.cosineSimilarity(
            newFactEmbedding,
            oldFactEmbedding,
          );

          if (similarity > CORRECTION_SIMILARITY_THRESHOLD) {
            // High similarity = same topic. The newer fact supersedes the older one.
            this.logger.warn(
              `Correction detected (similarity=${similarity.toFixed(3)}): "${factContent}" supersedes "${oldFact.content}"`,
            );
            await this.store.linkFactSupersedes(newFactChromaId, [oldFact.chromaId]);
          }
        }
      }
    } catch (e) {
      this.logger.warn(`Fact correction detection failed: ${(e as Error).message}`);
    }
  }

  /**
   * When a user states a fact, invalidate any beliefs about the same entities
   * that are semantically similar (same topic). Stated facts have higher authority than beliefs.
   */
  private async invalidateConflictingBeliefs(
    factContent: string,
    entityChromaIds: string[],
  ): Promise<void> {
    try {
      const factEmbedding = await this.embeddingService.embed(factContent);
      const beliefStore = this.store.getBeliefStore();
      const seenBeliefIds = new Set<string>();

      for (const entityChromaId of entityChromaIds) {
        const existingBeliefs = await beliefStore.getEntityBeliefs(entityChromaId);

        for (const belief of existingBeliefs) {
          if (seenBeliefIds.has(belief.chromaId)) continue;
          seenBeliefIds.add(belief.chromaId);

          const beliefEmbedding = await this.embeddingService.embed(belief.content);
          const similarity = this.embeddingService.cosineSimilarity(
            factEmbedding,
            beliefEmbedding,
          );

          if (similarity > CORRECTION_SIMILARITY_THRESHOLD) {
            this.logger.warn(
              `Stated fact invalidated belief (similarity=${similarity.toFixed(3)}): "${belief.content}"`,
            );
            await beliefStore.invalidateBelief(belief.chromaId);
          }
        }
      }
    } catch (e) {
      this.logger.warn(`Belief invalidation failed: ${(e as Error).message}`);
    }
  }

  /**
   * When a user states a fact, invalidate any relationships about the same entities
   * that are semantically similar (same topic). This prevents stale relationships
   * (e.g., "sister") from persisting after a correction (e.g., "wife").
   */
  private async invalidateConflictingRelationships(
    factContent: string,
    entityChromaIds: string[],
  ): Promise<void> {
    try {
      const factEmbedding = await this.embeddingService.embed(factContent);
      const seenRelIds = new Set<string>();

      for (const entityChromaId of entityChromaIds) {
        const relationships = await this.relationshipStore.getRelationshipsWithContentForEntity(entityChromaId);

        for (const rel of relationships) {
          if (seenRelIds.has(rel.chromaId)) continue;
          seenRelIds.add(rel.chromaId);

          const relEmbedding = await this.embeddingService.embed(rel.description);
          const similarity = this.embeddingService.cosineSimilarity(
            factEmbedding,
            relEmbedding,
          );

          if (similarity > CORRECTION_SIMILARITY_THRESHOLD) {
            this.logger.warn(
              `Stated fact invalidated relationship (similarity=${similarity.toFixed(3)}): "${rel.description}"`,
            );
            await this.relationshipStore.invalidateRelationship(rel.chromaId);
          }
        }
      }
    } catch (e) {
      this.logger.warn(`Relationship invalidation failed: ${(e as Error).message}`);
    }
  }

  /**
   * Post-process extraction to fix pronoun references the LLM may have missed.
   * Language-agnostic: only matches exact entity names like "I", "me", "you" (English)
   * that LLMs commonly output regardless of input language.
   * All other language-specific pronoun resolution is handled by the LLM prompt.
   */
  private normalizePronouns(extraction: ExtractionResult): void {
    // Only English pronouns — LLMs often fall back to English even for non-English input
    const userPronouns = ['i', 'me', 'my', 'myself'];
    const brainPronouns = ['you', 'your', 'yourself'];

    const isUserPronoun = (name: string) =>
      userPronouns.includes(name.toLowerCase().trim());
    const isBrainPronoun = (name: string) =>
      brainPronouns.includes(name.toLowerCase().trim());

    // Normalize entity names
    for (const entity of extraction.entities) {
      if (isUserPronoun(entity.name)) {
        entity.name = this.userName;
      } else if (isBrainPronoun(entity.name)) {
        entity.name = this.brainName;
      }
    }

    // Normalize fact about_entities
    for (const fact of extraction.facts) {
      fact.about_entities = fact.about_entities.map((name) => {
        if (isUserPronoun(name)) return this.userName;
        if (isBrainPronoun(name)) return this.brainName;
        return name;
      });
    }

    // Normalize relationship source/target
    for (const rel of extraction.relationships) {
      if (isUserPronoun(rel.source)) rel.source = this.userName;
      if (isUserPronoun(rel.target)) rel.target = this.userName;
      if (isBrainPronoun(rel.source)) rel.source = this.brainName;
      if (isBrainPronoun(rel.target)) rel.target = this.brainName;
    }

    // Normalize event participants
    for (const event of extraction.events) {
      event.participants = event.participants.map((name) => {
        if (isUserPronoun(name)) return this.userName;
        if (isBrainPronoun(name)) return this.brainName;
        return name;
      });
    }
  }
}
