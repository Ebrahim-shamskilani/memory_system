export interface MonologueEntry {
  id: string;              // UUID
  seed: string;            // topic that triggered this monologue
  thinking: string;        // concatenated reasoning text
  voicedOutput: string;    // final voiced monologue (shown in frontend)
  nextSeed: string;        // self-chained seed for next cycle
  timestamp: string;       // ISO 8601
  factsUsed: string[];     // facts retrieved (capped at 20)
  durationMs: number;
}

export type MonologueEventType =
  | 'monologue_thinking_title'
  | 'monologue_thinking_token'
  | 'monologue_thinking_done'
  | 'monologue_voice_token'
  | 'monologue_done'
  | 'monologue_error';

export interface MonologueEvent {
  type: MonologueEventType;
  title?: string;
  token?: string;
  voicedOutput?: string;
  thinking?: string;
  seed?: string;
  nextSeed?: string;
  monologueId?: string;
  timestamp?: string;
  message?: string;       // for errors
}
