import { Injectable, Logger } from '@nestjs/common';
import { ScoredItem, EntropyEvaluation } from '../types/retrieval.types';

const BETA = 3.0;
const MAX_ITERATIONS = 3;
const MAX_NODES = 50;
const HIGH_SIM_THRESHOLD = 0.65;
const ENTROPY_THRESHOLD = 1.5;
const DELTA_ENTROPY_THRESHOLD = 0.05;

@Injectable()
export class EntropyEvaluatorService {
  private readonly logger = new Logger(EntropyEvaluatorService.name);

  evaluate(
    allScored: ScoredItem[],
    previousEntropy: number,
    iteration: number,
  ): EntropyEvaluation {
    if (allScored.length === 0) {
      return {
        shouldStop: false,
        entropy: 0,
        maxSimilarity: 0,
        deltaEntropy: 0,
        totalNodes: 0,
        reason: 'no_results',
      };
    }

    const similarities = allScored.map((s) => s.similarity);
    const maxSimilarity = Math.max(...similarities);
    const entropy = this.shannonEntropy(similarities);
    const deltaEntropy = Math.abs(entropy - previousEntropy);
    const totalNodes = allScored.length;

    this.logger.log(
      `Entropy eval: H=${entropy.toFixed(3)}, maxSim=${maxSimilarity.toFixed(3)}, ` +
      `deltaH=${deltaEntropy.toFixed(3)}, nodes=${totalNodes}, iter=${iteration}`,
    );

    // Rule 3: hard cap
    if (iteration >= MAX_ITERATIONS - 1 || totalNodes >= MAX_NODES) {
      return { shouldStop: true, entropy, maxSimilarity, deltaEntropy, totalNodes, reason: 'hard_cap' };
    }

    // Rule 1: confident — high similarity + low entropy
    if (maxSimilarity >= HIGH_SIM_THRESHOLD && entropy <= ENTROPY_THRESHOLD) {
      return { shouldStop: true, entropy, maxSimilarity, deltaEntropy, totalNodes, reason: 'confident' };
    }

    // Rule 2: diminishing returns — after first iteration, entropy barely changed
    if (iteration > 0 && deltaEntropy <= DELTA_ENTROPY_THRESHOLD) {
      return { shouldStop: true, entropy, maxSimilarity, deltaEntropy, totalNodes, reason: 'diminishing_returns' };
    }

    return { shouldStop: false, entropy, maxSimilarity, deltaEntropy, totalNodes, reason: 'continue' };
  }

  private shannonEntropy(similarities: number[]): number {
    // Build softmax probability distribution
    const expValues = similarities.map((s) => Math.exp(BETA * s));
    const sumExp = expValues.reduce((a, b) => a + b, 0);

    if (sumExp === 0) return 0;

    const probabilities = expValues.map((e) => e / sumExp);

    // Shannon entropy: H = -sum(p * log(p))
    let h = 0;
    for (const p of probabilities) {
      if (p > 0) {
        h -= p * Math.log(p);
      }
    }

    return h;
  }
}
