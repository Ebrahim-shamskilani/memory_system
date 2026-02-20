import { Injectable, Logger } from '@nestjs/common';
import { LlmService } from '../../llm/llm.service';
import { RetrievalContext } from '../types/retrieval.types';
import { MemoryRecallResult } from '../types/memory.types';

const SYNTHESIS_PROMPT = `You are a memory synthesis engine for a personal AI assistant named Menfred.
Given retrieved memory facts about the user's life, synthesize a concise and helpful answer to their question.

Facts may include metadata like [timestamp], [confidence], [source], and [SUPERSEDED] markers.

Rules:
- Use the retrieved facts to answer the question
- Be concise (3-6 sentences max)
- If facts are in Persian/Farsi, you can respond in the same language or translate naturally
- If you don't have enough information, say so honestly
- Never invent facts not present in the retrieved data
- Refer to people by their names, not IDs

Handling contradictions and corrections:
- Facts marked [SUPERSEDED] have been corrected by newer information — prefer the newer version
- Facts with source "consolidated" are the most authoritative (they result from contradiction resolution)
- When two facts conflict, prefer the one with the later timestamp
- When relevant, mention the correction narrative: "initially said X, later corrected to Y"
- Use confidence scores: higher confidence = more reliable
- Ignore [SUPERSEDED] facts unless the user specifically asks about history or changes`;

@Injectable()
export class SynthesisService {
  private readonly logger = new Logger(SynthesisService.name);

  constructor(private readonly llm: LlmService) {}

  async synthesize(
    originalQuestion: string,
    context: RetrievalContext,
  ): Promise<MemoryRecallResult> {
    const facts = this.collectAllFacts(context);

    if (facts.length === 0) {
      return {
        answer: 'I don\'t have any stored memories related to your question.',
        sources: { entities: [], relationships: [], episodes: [], facts: [] },
        iterations: context.iterations,
      };
    }

    const factsText = facts.map((f, i) => `${i + 1}. ${f}`).join('\n');

    const prompt = `${SYNTHESIS_PROMPT}

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
        facts.add(vr.document);
      }
    }

    return Array.from(facts);
  }

  private extractSources(context: RetrievalContext): MemoryRecallResult['sources'] {
    const entities: string[] = [];
    const relationships: string[] = [];
    const episodes: string[] = [];
    const facts: string[] = [];

    for (const node of context.graphResults.nodes) {
      if (node.labels.includes('Entity')) {
        entities.push(node.chromaId);
      } else if (node.labels.includes('Episode')) {
        episodes.push(node.chromaId);
      } else if (node.labels.includes('Fact')) {
        facts.push(node.chromaId);
      }
    }

    for (const rel of context.graphResults.relationships) {
      relationships.push(rel.chromaId);
    }

    return { entities, relationships, episodes, facts };
  }
}
