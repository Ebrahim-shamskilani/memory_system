export interface ConsolidationStats {
  level3Processed: number;
  level2Created: number;
  level1Created: number;
  factsConsolidated: number;
  contradictionsFound: number;
  duplicatesMerged: number;
}

export interface ConsolidationRun {
  runId: string;
  startedAt: string;
  completedAt?: string;
  trigger: 'message_count' | 'conversation_end' | 'manual';
  stats: ConsolidationStats;
}
