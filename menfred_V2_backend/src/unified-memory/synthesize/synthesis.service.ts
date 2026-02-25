import { Injectable, Logger, Inject, Optional } from '@nestjs/common';
import { LlmService } from '../../llm/llm.service';
import { RetrievalContext } from '../types/retrieval.types';
import { MemoryRecallResult } from '../types/memory.types';
import { MENFRED_MEMORY_CONFIG, MenfredMemoryConfig } from '../../sdk/menfred-memory.config';

// SYNTHESIS_PROMPT is now built dynamically via buildSynthesisPrompt() to interpolate config values

@Injectable()
export class SynthesisService {
  private readonly logger = new Logger(SynthesisService.name);
  private readonly brainName: string;
  private readonly userName: string;
  private readonly userNameEnglish: string;

  constructor(
    private readonly llm: LlmService,
    @Inject(MENFRED_MEMORY_CONFIG) @Optional() config?: MenfredMemoryConfig,
  ) {
    this.brainName = config?.brain?.name ?? 'Manfred';
    this.userName = config?.user?.name ?? 'ابراهیم';
    this.userNameEnglish = config?.user?.nameEnglish ?? 'Ebrahim';
  }

  private buildSynthesisPrompt(): string {
    return `You are ${this.brainName}, a memory recall system for ${this.userName} (${this.userNameEnglish}).
"${this.userName}" / "${this.userNameEnglish}" in the facts IS the person asking — address them as "you" (تو/شما).

Your ONLY job is to return stored facts. You are NOT a reasoning engine.

STRICT RULES:
- ONLY state facts that exist in the retrieved data — nothing more
- NEVER calculate, compute, count, compare dates, estimate ages, or do any arithmetic
- NEVER answer questions that require reasoning, logic, or inference beyond the stored facts
- NEVER invent, guess, or extrapolate information not present in the data
- If the question requires calculation (e.g., "how many days until X?", "how old is Y?"), just return the relevant raw facts (e.g., the date of birth) without computing the answer
- Be concise (1-4 sentences)
- If facts are in Persian/Farsi, respond in Persian
- Refer to other people by their names, not IDs

Handling contradictions:
- Prefer facts marked with source "consolidated" (most authoritative)
- Prefer later timestamps over earlier ones when two facts conflict
- Ignore [SUPERSEDED] facts unless the user asks about history

Handling beliefs:
- Facts marked [belief] are Manfred's own conclusions — lower confidence than stated facts
- Present beliefs as opinions ("I think...", "It seems...") not as definitive facts
- When a belief contradicts a stated fact, prefer the stated fact
- Facts marked [former belief] are beliefs Manfred no longer holds — mention only if the user asks about past beliefs`;
  }

  async synthesize(
    originalQuestion: string,
    context: RetrievalContext,
  ): Promise<MemoryRecallResult> {
    const facts = this.collectAllFacts(context);

    if (facts.length === 0) {
      return {
        answer: 'I don\'t have any stored memories related to your question.',
        sources: { entities: [], relationships: [], episodes: [], facts: [], beliefs: [] },
        iterations: context.iterations,
      };
    }

    const factsText = facts.map((f, i) => `${i + 1}. ${f}`).join('\n');

    const prompt = `${this.buildSynthesisPrompt()}

Question: "${originalQuestion}"

Retrieved memory facts:
${factsText}

Answer:`;

    try {
      const answer = await this.llm.generate({
        model: this.llm.getDefaultModel(),
        prompt,
        options: { temperature: 0.3, num_predict: 512 },
      });

      return {
        answer: answer.trim(),
        sources: this.extractSources(context),
        iterations: context.iterations,
      };
    } catch (error) {
      this.logger.error(`Synthesis failed: ${(error as Error).message}`);
      // Fallback: return raw facts
      return {
        answer: `Here's what I found:\n${facts.join('\n')}`,
        sources: this.extractSources(context),
        iterations: context.iterations,
      };
    }
  }

  private collectAllFacts(context: RetrievalContext): string[] {
    const facts = new Set<string>();

    for (const fact of context.facts) {
      facts.add(fact);
    }

    for (const node of context.graphResults.nodes) {
      const desc = node.properties.description ?? node.properties.content ?? node.properties.canonicalName;
      if (desc) facts.add(String(desc));
    }

    for (const rel of context.graphResults.relationships) {
      const desc = rel.properties.description;
      if (desc) facts.add(String(desc));
    }

    for (const vr of context.vectorResults) {
      if (vr.document && vr.distance < 0.5) {
        const isBelief = vr.metadata?.neo4j_label === 'Belief';
        const beliefTag = isBelief ? '[belief] ' : '';
        facts.add(`${beliefTag}${vr.document}`);
      }
    }

    return Array.from(facts);
  }

  private extractSources(context: RetrievalContext): MemoryRecallResult['sources'] {
    const entities: string[] = [];
    const relationships: string[] = [];
    const episodes: string[] = [];
    const facts: string[] = [];
    const beliefs: string[] = [];

    for (const node of context.graphResults.nodes) {
      if (node.labels.includes('Entity')) {
        entities.push(node.chromaId);
      } else if (node.labels.includes('Episode')) {
        episodes.push(node.chromaId);
      } else if (node.labels.includes('Belief')) {
        beliefs.push(node.chromaId);
      } else if (node.labels.includes('Fact')) {
        facts.push(node.chromaId);
      }
    }

    for (const rel of context.graphResults.relationships) {
      relationships.push(rel.chromaId);
    }

    return { entities, relationships, episodes, facts, beliefs };
  }
}
