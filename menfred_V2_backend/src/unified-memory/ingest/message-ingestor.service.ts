import { Injectable, Logger, Inject, Optional } from '@nestjs/common';
import { LlmService } from '../../llm/llm.service';
import { UnifiedStoreService } from '../store/unified-store.service';
import { EntityStoreService } from '../store/entity-store.service';
import { VectorLookupService } from '../retrieve/vector-lookup.service';
import { ConversationService } from '../../conversation/conversation.service';
import { EntityType } from '../types/entity.types';
import { ExtractedEvent } from '../types/episode.types';
import { MENFRED_MEMORY_CONFIG, MenfredMemoryConfig } from '../../sdk/menfred-memory.config';

const ENTITY_SIMILARITY_THRESHOLD = 0.4; // below this distance = same entity
const FACT_SIMILARITY_THRESHOLD = 0.15;  // below this distance = duplicate fact (tighter than entities)

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
    private readonly vectorLookup: VectorLookupService,
    private readonly conversation: ConversationService,
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
- ALL first-person references ("من", "I", "me", "my", "مال من", "م") MUST be resolved to "${this.userName}".
- "you/تو/شما" directed at the assistant refers to "${this.brainName}".
- NEVER use "من" or "I" in entity names, fact content, or about_entities. ALWAYS replace with "${this.userName}".
- "${this.userName}" MUST appear in about_entities for ANY fact about the user.

**Examples of correct pronoun resolution:**
- User says: "من تو برلین زندگی می کنم" → fact: "${this.userName} در برلین زندگی می کند", about_entities: ["${this.userName}", "برلین"]
- User says: "دخترم دلاراست" → fact: "دلارا دختر ${this.userName} است", about_entities: ["${this.userName}", "دلارا"], relationship: {source: "${this.userName}", target: "دلارا", type: "father_daughter"}
- User says: "اسم تو ${this.brainName} ه" → fact: "اسم دستیار هوشمند ${this.brainName} است", about_entities: ["${this.brainName}"]
- User says: "یه خواهر دارم اسمش آرزو" → fact: "آرزو خواهر ${this.userName} است", about_entities: ["${this.userName}", "آرزو"], relationship: {source: "${this.userName}", target: "آرزو", type: "sibling"}

**Distinguishing facts vs events:**
- A **fact** is a general/stable truth (no time anchor): "من تو برلین زندگی می کنم", "دلارا خواهرم هست"
- An **event** happened at a specific time: "دیروز رفتم کوه", "هفته پیش دندون پزشک رفتم"

Today's date is: {{TODAY_DATE}}
Use this to resolve relative time references (e.g., "yesterday" → actual date).

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

    // Step 2b: Post-process — normalize first-person references the LLM may have missed
    this.normalizeFirstPerson(extraction);

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
        for (const entityName of fact.about_entities) {
          const chromaId = this.findEntityId(entityName, entityMap);
          if (chromaId) {
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
      }
    }

    // Step 5: Create relationships (append-only)
    for (const rel of extraction.relationships) {
      const sourceId = this.findEntityId(rel.source, entityMap);
      const targetId = this.findEntityId(rel.target, entityMap);

      if (sourceId && targetId) {
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
      `Ingestion complete: ${result.entitiesCreated} new entities, ${result.entitiesResolved} resolved, ${result.factsCreated} facts (${result.factsSkippedDuplicate} dupes skipped), ${result.eventsCreated} events, ${result.relationshipsCreated} relationships`,
    );

    return result;
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
   * Post-process extraction to fix first-person pronoun references the LLM may have missed.
   * Replaces "من", "I", "me" with the user's name in entities, facts, relationships, and events.
   */
  private normalizeFirstPerson(extraction: ExtractionResult): void {
    const firstPersonPatterns = ['من', 'i', 'me', 'my', 'myself'];
    const brainPatterns = ['تو', 'you', 'your'];

    const isFirstPerson = (name: string) =>
      firstPersonPatterns.includes(name.toLowerCase().trim());
    const isBrainRef = (name: string) =>
      brainPatterns.includes(name.toLowerCase().trim());

    // Normalize entity names
    for (const entity of extraction.entities) {
      if (isFirstPerson(entity.name)) {
        entity.name = this.userName;
      } else if (isBrainRef(entity.name)) {
        entity.name = this.brainName;
      }
    }

    // Normalize fact content and about_entities
    for (const fact of extraction.facts) {
      // Replace first-person in about_entities
      fact.about_entities = fact.about_entities.map((name) => {
        if (isFirstPerson(name)) return this.userName;
        if (isBrainRef(name)) return this.brainName;
        return name;
      });

      // If fact content contains first-person patterns but user is not in about_entities, add them
      const contentLower = fact.content.toLowerCase();
      const mentionsFirstPerson = firstPersonPatterns.some((p) =>
        contentLower.includes(p),
      );
      const hasUser = fact.about_entities.some(
        (name) =>
          name.toLowerCase() === this.userName.toLowerCase() ||
          name.toLowerCase() === this.userNameEnglish.toLowerCase(),
      );
      if (mentionsFirstPerson && !hasUser) {
        fact.about_entities.push(this.userName);
      }
    }

    // Normalize relationship source/target
    for (const rel of extraction.relationships) {
      if (isFirstPerson(rel.source)) rel.source = this.userName;
      if (isFirstPerson(rel.target)) rel.target = this.userName;
      if (isBrainRef(rel.source)) rel.source = this.brainName;
      if (isBrainRef(rel.target)) rel.target = this.brainName;
    }

    // Normalize event participants
    for (const event of extraction.events) {
      event.participants = event.participants.map((name) => {
        if (isFirstPerson(name)) return this.userName;
        if (isBrainRef(name)) return this.brainName;
        return name;
      });
    }
  }
}
