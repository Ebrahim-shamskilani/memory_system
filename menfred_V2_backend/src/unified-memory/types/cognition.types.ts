export type CognitionEventType =
  | 'thinking_title'
  | 'thinking_token'
  | 'thinking_done'
  | 'answer_token'
  | 'done'
  | 'error';

export interface CognitionEvent {
  type: CognitionEventType;
  title?: string;
  token?: string;
  answer?: string;
  thinking?: string;
  sources?: { entities: string[]; relationships: string[]; episodes: string[]; facts: string[] };
  ingestion?: Record<string, unknown>;
  cogIterations?: number;
  message?: string;
}
