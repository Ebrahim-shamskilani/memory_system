import { Injectable, Logger } from '@nestjs/common';
import { RetrievalContext } from '../types/retrieval.types';

const MAX_FACTS = 40;

// Recency half-lives
const FACT_HALF_LIFE_HOURS = 168; // 7 days for user-stated facts
const BELIEF_HALF_LIFE_HOURS = 72; // 3 days for monologue beliefs

const LAMBDA_FACT = Math.LN2 / FACT_HALF_LIFE_HOURS;
const LAMBDA_BELIEF = Math.LN2 / BELIEF_HALF_LIFE_HOURS;

interface ScoredFact {
  content: string;
  combinedScore: number;
}

@Injectable()
export class FactCollectorService {
  private readonly logger = new Logger(FactCollectorService.name);

  collectFacts(context: RetrievalContext): string[] {
    const now = Date.now();
    const seen = new Set<string>();
    const scoredFacts: ScoredFact[] = [];

    // 1. Collect from context.facts (rich facts with timestamps from graph traversal)
    for (const fact of context.facts) {
      if (seen.has(fact)) continue;
      seen.add(fact);

      const isBelief = fact.startsWith('[belief]') || fact.startsWith('[former belief]');
      const timestamp = this.extractTimestamp(fact);
      const recencyWeight = this.computeRecencyWeight(timestamp, now, isBelief);
      // Facts from graph traversal don't have a similarity score; use 1.0 as base
      scoredFacts.push({ content: fact, combinedScore: 1.0 * recencyWeight });
    }

    // 2. Collect from graph nodes (skip Entity nodes — their descriptions are ingestion artifacts)
    for (const node of context.graphResults.nodes) {
      if (node.labels.includes('Entity')) continue;
      const desc = node.properties.description ?? node.properties.content ?? node.properties.canonicalName;
      if (!desc) continue;
      const content = String(desc);
      if (seen.has(content)) continue;
      seen.add(content);

      const timestamp = node.properties.createdAt as string | undefined;
      const recencyWeight = this.computeRecencyWeight(timestamp, now, false);
      scoredFacts.push({ content, combinedScore: 1.0 * recencyWeight });
    }

    // 3. Collect from graph relationships
    for (const rel of context.graphResults.relationships) {
      const desc = rel.properties.description;
      if (!desc) continue;
      const content = String(desc);
      if (seen.has(content)) continue;
      seen.add(content);

      const timestamp = rel.properties.createdAt as string | undefined;
      const recencyWeight = this.computeRecencyWeight(timestamp, now, false);
      scoredFacts.push({ content, combinedScore: 1.0 * recencyWeight });
    }

    // 4. Collect from vector results
    for (const vr of context.vectorResults) {
      if (!vr.document || vr.distance >= 0.5) continue;

      const isBelief = vr.metadata?.neo4j_label === 'Belief';

      // Skip low-confidence monologue beliefs
      if (isBelief && vr.metadata?.source === 'monologue' && (vr.metadata?.confidence as number) < 0.7) continue;
      const ts = vr.metadata?.timestamp ?? vr.metadata?.created_at;
      const prefix = ts ? `[${ts}] ` : '';
      const beliefTag = isBelief ? '[belief] ' : '';
      const content = `${beliefTag}${prefix}${vr.document}`;

      if (seen.has(content)) continue;
      seen.add(content);

      const similarity = 1 - vr.distance;
      const timestamp = (ts as string) ?? undefined;
      const recencyWeight = this.computeRecencyWeight(timestamp, now, isBelief);
      scoredFacts.push({ content, combinedScore: similarity * recencyWeight });
    }

    // 5. Sort by combined score descending (recent + relevant first)
    scoredFacts.sort((a, b) => b.combinedScore - a.combinedScore);

    // 6. Cap at MAX_FACTS
    const result = scoredFacts.slice(0, MAX_FACTS).map((sf) => sf.content);

    if (scoredFacts.length > MAX_FACTS) {
      this.logger.log(`Fact collector: capped ${scoredFacts.length} facts to ${MAX_FACTS}`);
    }

    return result;
  }

  private computeRecencyWeight(
    timestamp: string | undefined,
    nowMs: number,
    isBelief: boolean,
  ): number {
    if (!timestamp) return 0.5; // unknown age → neutral weight

    const ts = new Date(timestamp).getTime();
    if (isNaN(ts)) return 0.5;

    const ageHours = Math.max(0, (nowMs - ts) / (1000 * 60 * 60));
    const lambda = isBelief ? LAMBDA_BELIEF : LAMBDA_FACT;

    return Math.exp(-lambda * ageHours);
  }

  private extractTimestamp(factString: string): string | undefined {
    // Match ISO-ish timestamps at the start: [2025-01-15T...] or [2025-01-15 ...]
    const match = factString.match(/\[(\d{4}-\d{2}-\d{2}[T ][^\]]*)\]/);
    return match ? match[1] : undefined;
  }
}
