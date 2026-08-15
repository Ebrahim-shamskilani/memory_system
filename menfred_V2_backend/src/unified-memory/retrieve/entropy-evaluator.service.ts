import { Injectable, Logger } from '@nestjs/common';
import { ScoredItem, EntropyEvaluation } from '../types/retrieval.types';

const BETA = 3.0;
const MAX_ITERATIONS = 3;
const MAX_NODES = 200;
const TOP_K = 10;
const HIGH_SIM_THRESHOLD = 0.65;
const ENTROPY_THRESHOLD = 0.5;
const DELTA_ENTROPY_THRESHOLD = 0.05;
const STD_EPSILON = 1e-9;

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
    const entropy = this.normalizedEntropy(similarities);
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

  /**
   * Concentration of the top-K candidates, in [0, 1]. 0 means one candidate
   * clearly dominates; 1 means they are indistinguishable.
   *
   * Two normalisations make the value comparable across iterations:
   *
   * - Only the top K are scored, so the ln(K) ceiling on Shannon entropy is a
   *   constant instead of growing with the size of the accumulated pool. The
   *   raw entropy of the full pool tracked candidate *count*, not agreement.
   * - Similarities are standardised before the softmax. Raw similarities sit in
   *   a narrow band (~0.4–0.8), so BETA * s spans about one logit and the
   *   softmax comes out near-uniform however strong the top hit is.
   */
  private normalizedEntropy(similarities: number[]): number {
    const topK = [...similarities].sort((a, b) => b - a).slice(0, TOP_K);
    const k = topK.length;

    // A single candidate is maximally concentrated by definition.
    if (k <= 1) return 0;

    const mean = topK.reduce((a, b) => a + b, 0) / k;
    const variance = topK.reduce((acc, s) => acc + (s - mean) ** 2, 0) / k;
    const std = Math.sqrt(variance);

    // Every candidate scored identically — nothing to choose between them.
    if (std < STD_EPSILON) return 1;

    const expValues = topK.map((s) => Math.exp((BETA * (s - mean)) / std));
    const sumExp = expValues.reduce((a, b) => a + b, 0);

    if (!Number.isFinite(sumExp) || sumExp === 0) return 0;

    const probabilities = expValues.map((e) => e / sumExp);

    // Shannon entropy: H = -sum(p * log(p))
    let h = 0;
    for (const p of probabilities) {
      if (p > 0) {
        h -= p * Math.log(p);
      }
    }

    return h / Math.log(k);
  }
}
