import { EntropyEvaluatorService } from './entropy-evaluator.service';
import { ScoredItem } from '../types/retrieval.types';

/** `count` candidates all scoring `similarity`. */
const flat = (count: number, similarity: number): ScoredItem[] =>
  Array.from({ length: count }, (_, i) => ({ id: `id-${i}`, similarity }));

/** One dominant candidate followed by a flat tail. */
const dominant = (top: number, tailCount: number, tail: number): ScoredItem[] => [
  { id: 'top', similarity: top },
  ...flat(tailCount, tail).map((s, i) => ({ ...s, id: `tail-${i}` })),
];

describe('EntropyEvaluatorService', () => {
  let service: EntropyEvaluatorService;

  beforeEach(() => {
    service = new EntropyEvaluatorService();
    jest.spyOn(service['logger'], 'log').mockImplementation(() => undefined);
  });

  describe('stop reasons', () => {
    it('reports no_results and keeps going when nothing was found', () => {
      const result = service.evaluate([], 0, 0);

      expect(result.reason).toBe('no_results');
      expect(result.shouldStop).toBe(false);
      expect(result.entropy).toBe(0);
    });

    it('stops as confident when one candidate dominates a strong match', () => {
      const result = service.evaluate(dominant(0.9, 9, 0.4), 0, 0);

      expect(result.reason).toBe('confident');
      expect(result.shouldStop).toBe(true);
      expect(result.entropy).toBeLessThan(0.5);
    });

    it('keeps going when candidates are indistinguishable', () => {
      const result = service.evaluate(flat(10, 0.7), 0, 0);

      expect(result.reason).toBe('continue');
      expect(result.shouldStop).toBe(false);
      expect(result.entropy).toBe(1);
    });

    it('keeps going when the top hit is too weak, however focused', () => {
      const result = service.evaluate(dominant(0.5, 9, 0.1), 0, 0);

      expect(result.entropy).toBeLessThan(0.5);
      expect(result.reason).toBe('continue');
    });

    it('stops on diminishing returns when entropy barely moved', () => {
      const scored = flat(10, 0.7);
      const first = service.evaluate(scored, 0, 0);
      const second = service.evaluate(scored, first.entropy, 1);

      expect(second.deltaEntropy).toBe(0);
      expect(second.reason).toBe('diminishing_returns');
      expect(second.shouldStop).toBe(true);
    });

    it('does not apply diminishing returns on the first iteration', () => {
      const result = service.evaluate(flat(10, 0.7), 1, 0);

      expect(result.deltaEntropy).toBe(0);
      expect(result.reason).toBe('continue');
    });

    it('stops at the final iteration', () => {
      const result = service.evaluate(flat(10, 0.7), 0, 2);

      expect(result.reason).toBe('hard_cap');
      expect(result.shouldStop).toBe(true);
    });

    it('stops once the candidate pool runs away', () => {
      const result = service.evaluate(flat(200, 0.7), 0, 0);

      expect(result.reason).toBe('hard_cap');
      expect(result.totalNodes).toBe(200);
    });
  });

  describe('entropy is a measure of agreement, not of pool size', () => {
    it('scores the same shape identically at 10 and 60 candidates', () => {
      const small = service.evaluate(dominant(0.9, 9, 0.4), 0, 0);
      const large = service.evaluate(dominant(0.9, 59, 0.4), 0, 0);

      expect(large.entropy).toBeCloseTo(small.entropy, 10);
      expect(large.totalNodes).toBe(60);
    });

    it('still recognises a clear winner in a large pool', () => {
      // The pre-normalisation formula grew with ln(N) and could not clear the
      // confidence bar once the pool passed roughly five candidates.
      const result = service.evaluate(dominant(0.9, 99, 0.4), 0, 0);

      expect(result.entropy).toBeLessThan(0.5);
    });

    it('separates a focused result set from a diffuse one', () => {
      const focused = service.evaluate(dominant(0.9, 9, 0.4), 0, 0);
      const diffuse = service.evaluate(
        [0.75, 0.72, 0.7, 0.68, 0.5, 0.48, 0.45, 0.44, 0.42, 0.4].map((similarity, i) => ({
          id: `id-${i}`,
          similarity,
        })),
        0,
        0,
      );

      expect(focused.entropy).toBeLessThan(diffuse.entropy);
      expect(diffuse.reason).toBe('continue');
    });

    it('stays within [0, 1]', () => {
      const cases: ScoredItem[][] = [
        flat(1, 0.9),
        flat(2, 0.5),
        flat(50, 0.3),
        dominant(1, 9, 0),
        dominant(0.9, 9, 0.4),
      ];

      for (const scored of cases) {
        const { entropy } = service.evaluate(scored, 0, 0);
        expect(entropy).toBeGreaterThanOrEqual(0);
        expect(entropy).toBeLessThanOrEqual(1);
      }
    });

    it('treats a lone candidate as fully concentrated', () => {
      expect(service.evaluate(flat(1, 0.9), 0, 0).entropy).toBe(0);
    });
  });
});
