import { Injectable, Logger } from '@nestjs/common';
import { LlmService } from '../../llm/llm.service';
import { EntityResolutionResult, IntentType, TimeConstraints } from '../types/retrieval.types';

const ENTITY_RESOLUTION_PROMPT = `You are an entity resolution engine for a multilingual personal memory system.
Given a user message and recent conversation context, extract:
1. All entities mentioned (people, places, things, concepts, organizations)
2. Resolve cross-language variants (e.g., "Arezoo" → "آرزو", "Delara" → "دلارا")
3. Resolve pronouns from context (e.g., "she" → the person mentioned earlier)
4. Classify the intent: find_entity, find_relationship, find_event, find_pattern, recall_conversation, store_information
5. Extract any time constraints from the message:
   - Absolute dates: "on January 5th" → {"after": "2026-01-05T00:00:00Z", "before": "2026-01-06T00:00:00Z"}
   - Relative references: "yesterday", "last week", "recently", "a month ago"
   - Resolve relative dates using today's date (provided below)
   - If no time reference, return null

Respond ONLY with valid JSON in this exact format:
{
  "entities": [
    {"name": "canonical name", "confidence": 0.9}
  ],
  "intents": ["find_entity"],
  "resolvedQuery": "the query with pronouns resolved",
  "timeConstraints": {"after": "ISO 8601 string", "before": "ISO 8601 string"} or null
}

Rules:
- For Persian/Farsi names, keep the original script as canonical
- Include transliterated variants as the name if that's all you have
- confidence should be 0.0-1.0
- intents can have multiple values
- timeConstraints.after and timeConstraints.before must be ISO 8601 strings (e.g., "2026-01-05T00:00:00Z") or omitted
- Use "recall_conversation" when the user asks about what was discussed, what topics were covered, or asks to summarize the conversation (e.g., "what did we talk about?", "چه موضوعاتی صحبت کردیم؟", "summarize our chat")
- Use "store_information" when the message provides new facts, relationships, or information to remember (e.g., "آرزو همسرم هست", "I live in Berlin", "my sister's name is Sara")`;

@Injectable()
export class EntityResolverService {
  private readonly logger = new Logger(EntityResolverService.name);

  constructor(private readonly llm: LlmService) {}

  async resolve(
    message: string,
    conversationContext: string,
  ): Promise<EntityResolutionResult> {
    const today = new Date().toISOString().split('T')[0]; // e.g., "2026-02-23"
    const prompt = `${ENTITY_RESOLUTION_PROMPT}

Today's date: ${today}

Conversation context (last few turns):
${conversationContext || '(no prior context)'}

User message: "${message}"

JSON response:`;

    try {
      const raw = await this.llm.generate({
        model: this.llm.getDefaultModel(),
        prompt,
        options: { temperature: 0.1, num_predict: 256 },
      });

      return this.parseResponse(raw, message);
    } catch (error) {
      this.logger.warn(`Entity resolution failed, using fallback: ${(error as Error).message}`);
      return this.fallback(message);
    }
  }

  private parseResponse(raw: string, originalMessage: string): EntityResolutionResult {
    try {
      // Extract JSON from the response (handle markdown code blocks)
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return this.fallback(originalMessage);

      const parsed = JSON.parse(jsonMatch[0]);

      const entities = (parsed.entities ?? []).map((e: any) => ({
        name: String(e.name ?? ''),
        confidence: Number(e.confidence ?? 0.5),
      }));

      const validIntents: IntentType[] = [
        'find_entity',
        'find_relationship',
        'find_event',
        'find_pattern',
        'recall_conversation',
        'store_information',
      ];
      const intents = (parsed.intents ?? ['find_entity'])
        .filter((i: string) => validIntents.includes(i as IntentType)) as IntentType[];

      // Parse time constraints from LLM output
      let timeConstraints: TimeConstraints | undefined;
      if (parsed.timeConstraints) {
        const tc = parsed.timeConstraints;
        const isValidIso = (s: unknown): s is string =>
          typeof s === 'string' && !isNaN(Date.parse(s));
        if (isValidIso(tc.after) || isValidIso(tc.before)) {
          timeConstraints = {};
          if (isValidIso(tc.after)) timeConstraints.after = tc.after;
          if (isValidIso(tc.before)) timeConstraints.before = tc.before;
        }
      }

      // Fallback: regex-based time extraction if LLM didn't produce timeConstraints
      if (!timeConstraints) {
        timeConstraints = this.extractTimeFromText(originalMessage);
        if (timeConstraints) {
          this.logger.log(`LLM missed time constraints, regex fallback extracted: ${JSON.stringify(timeConstraints)}`);
        }
      } else {
        this.logger.log(`LLM extracted time constraints: ${JSON.stringify(timeConstraints)}`);
      }

      return {
        entities: entities.filter((e: any) => e.name.length > 0),
        intents: intents.length > 0 ? intents : ['find_entity'],
        resolvedQuery: parsed.resolvedQuery ?? originalMessage,
        timeConstraints,
      };
    } catch {
      return this.fallback(originalMessage);
    }
  }

  private fallback(message: string): EntityResolutionResult {
    return {
      entities: [],
      intents: ['find_entity'],
      resolvedQuery: message,
      timeConstraints: this.extractTimeFromText(message),
    };
  }

  /**
   * Regex-based fallback for extracting time references when the LLM
   * doesn't produce timeConstraints. Handles common patterns in
   * English, Persian/Farsi, and German.
   */
  private extractTimeFromText(text: string): TimeConstraints | undefined {
    const now = new Date();
    const lower = text.toLowerCase();

    // Yesterday / دیروز / gestern
    if (/yesterday|دیروز|gestern/.test(lower)) {
      const yesterday = new Date(now);
      yesterday.setDate(yesterday.getDate() - 1);
      return {
        after: this.startOfDay(yesterday),
        before: this.startOfDay(now),
      };
    }

    // Today / امروز / heute
    if (/\btoday\b|امروز|heute/.test(lower)) {
      const tomorrow = new Date(now);
      tomorrow.setDate(tomorrow.getDate() + 1);
      return {
        after: this.startOfDay(now),
        before: this.startOfDay(tomorrow),
      };
    }

    // Last week / هفته پیش / هفته گذشته / letzte Woche
    if (/last\s+week|هفته\s*(پیش|گذشته)|letzte\s+woche/.test(lower)) {
      const weekAgo = new Date(now);
      weekAgo.setDate(weekAgo.getDate() - 7);
      return {
        after: this.startOfDay(weekAgo),
        before: this.startOfDay(now),
      };
    }

    // Last month / ماه پیش / ماه گذشته / letzten Monat
    if (/last\s+month|ماه\s*(پیش|گذشته)|letzten?\s+monat/.test(lower)) {
      const monthAgo = new Date(now);
      monthAgo.setMonth(monthAgo.getMonth() - 1);
      return {
        after: this.startOfDay(monthAgo),
        before: this.startOfDay(now),
      };
    }

    // N days ago / N روز پیش
    const daysAgoMatch = lower.match(/(\d+)\s*(?:days?\s*ago|روز\s*(?:پیش|قبل))/);
    if (daysAgoMatch) {
      const n = parseInt(daysAgoMatch[1], 10);
      const daysAgo = new Date(now);
      daysAgo.setDate(daysAgo.getDate() - n);
      const dayAfter = new Date(daysAgo);
      dayAfter.setDate(dayAfter.getDate() + 1);
      return {
        after: this.startOfDay(daysAgo),
        before: this.startOfDay(dayAfter),
      };
    }

    // Recently / اخیراً / اخیرا (last 3 days)
    if (/\brecently\b|اخیرا[ًً]?|vor\s+kurzem/.test(lower)) {
      const threeDaysAgo = new Date(now);
      threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);
      return {
        after: this.startOfDay(threeDaysAgo),
      };
    }

    return undefined;
  }

  private startOfDay(d: Date): string {
    // Create local midnight, then convert to UTC ISO string.
    // new Date(y, m, d) uses LOCAL timezone, .toISOString() converts to UTC.
    // e.g. in CET (UTC+1): local midnight Feb 22 → "2026-02-21T23:00:00.000Z"
    const localMidnight = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    return localMidnight.toISOString();
  }
}
