import { Injectable, Logger } from '@nestjs/common';
import { LlmService } from '../../llm/llm.service';
import { EntityResolutionResult, IntentType } from '../types/retrieval.types';

const ENTITY_RESOLUTION_PROMPT = `You are an entity resolution engine for a multilingual personal memory system.
Given a user message and recent conversation context, extract:
1. All entities mentioned (people, places, things, concepts, organizations)
2. Resolve cross-language variants (e.g., "Arezoo" → "آرزو", "Delara" → "دلارا")
3. Resolve pronouns from context (e.g., "she" → the person mentioned earlier)
4. Classify the intent: find_entity, find_relationship, find_event, find_pattern, recall_conversation

Respond ONLY with valid JSON in this exact format:
{
  "entities": [
    {"name": "canonical name", "confidence": 0.9}
  ],
  "intents": ["find_entity"],
  "resolvedQuery": "the query with pronouns resolved"
}

Rules:
- For Persian/Farsi names, keep the original script as canonical
- Include transliterated variants as the name if that's all you have
- confidence should be 0.0-1.0
- intents can have multiple values
- Use "recall_conversation" when the user asks about what was discussed, what topics were covered, or asks to summarize the conversation (e.g., "what did we talk about?", "چه موضوعاتی صحبت کردیم؟", "summarize our chat")`;

@Injectable()
export class EntityResolverService {
  private readonly logger = new Logger(EntityResolverService.name);

  constructor(private readonly llm: LlmService) {}

  async resolve(
    message: string,
    conversationContext: string,
  ): Promise<EntityResolutionResult> {
    const prompt = `${ENTITY_RESOLUTION_PROMPT}

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
      ];
      const intents = (parsed.intents ?? ['find_entity'])
        .filter((i: string) => validIntents.includes(i as IntentType)) as IntentType[];

      return {
        entities: entities.filter((e: any) => e.name.length > 0),
        intents: intents.length > 0 ? intents : ['find_entity'],
        resolvedQuery: parsed.resolvedQuery ?? originalMessage,
      };
    } catch {
      return this.fallback(originalMessage);
    }
  }

  private fallback(message: string): EntityResolutionResult {
    // Simple fallback: treat the whole message as a query
    return {
      entities: [],
      intents: ['find_entity'],
      resolvedQuery: message,
    };
  }
}
