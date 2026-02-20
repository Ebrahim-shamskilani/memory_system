import { Injectable, Logger } from '@nestjs/common';
import { LlmService } from '../../llm/llm.service';
import { SufficiencyResult } from '../types/retrieval.types';

const SUFFICIENCY_PROMPT = `You are evaluating whether retrieved information is sufficient to answer a user's question.

Given the original question and retrieved facts, determine:
1. Do we have enough information to answer the question?
2. If not, what should we search for next?

Respond ONLY with valid JSON:
{
  "has_enough": true/false,
  "next_search": "what to search for next (only if has_enough is false)",
  "confidence": 0.0-1.0
}`;

@Injectable()
export class SufficiencyEvaluatorService {
  private readonly logger = new Logger(SufficiencyEvaluatorService.name);

  constructor(private readonly llm: LlmService) {}

  async evaluate(
    originalQuestion: string,
    retrievedFacts: string[],
  ): Promise<SufficiencyResult> {
    if (retrievedFacts.length === 0) {
      return { hasEnough: false, nextSearch: originalQuestion, confidence: 0 };
    }

    const factsText = retrievedFacts
      .map((f, i) => `${i + 1}. ${f}`)
      .join('\n');

    const prompt = `${SUFFICIENCY_PROMPT}

Original question: "${originalQuestion}"

Retrieved facts:
${factsText}

JSON response:`;

    try {
      const raw = await this.llm.generate({
        model: this.llm.getDefaultModel(),
        prompt,
        options: { temperature: 0.1, num_predict: 128 },
      });

      return this.parseResponse(raw, originalQuestion);
    } catch (error) {
      this.logger.warn(`Sufficiency evaluation failed: ${(error as Error).message}`);
      // If evaluation fails but we have facts, assume we have enough
      return {
        hasEnough: retrievedFacts.length > 0,
        confidence: 0.5,
      };
    }
  }

  private parseResponse(raw: string, originalQuestion: string): SufficiencyResult {
    try {
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        return { hasEnough: true, confidence: 0.5 };
      }

      const parsed = JSON.parse(jsonMatch[0]);
      return {
        hasEnough: Boolean(parsed.has_enough),
        nextSearch: parsed.next_search ?? undefined,
        confidence: Number(parsed.confidence ?? 0.5),
      };
    } catch {
      return { hasEnough: true, confidence: 0.5 };
    }
  }
}
