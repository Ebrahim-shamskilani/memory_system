import { HttpClient } from '@angular/common/http';
import { Injectable } from '@angular/core';

export interface IngestionStats {
  entitiesCreated: number;
  entitiesResolved: number;
  factsCreated: number;
  factsSkippedDuplicate: number;
  relationshipsCreated: number;
  episodeCreated: boolean;
  eventsCreated: number;
}

export interface MemorySources {
  entities: string[];
  relationships: string[];
  episodes: string[];
  facts: string[];
}

export interface SendMessageResponse {
  success: boolean;
  received: string;
  answer: string | null;
  sources?: MemorySources;
  ingestion?: IngestionStats;
  iterations?: number;
  timestamp: string;
  error?: string;
}

export interface CognitionEvent {
  type: 'thinking_title' | 'thinking_token' | 'thinking_done' | 'answer_token' | 'done' | 'error';
  title?: string;
  token?: string;
  answer?: string;
  thinking?: string;
  sources?: MemorySources;
  ingestion?: IngestionStats;
  cogIterations?: number;
  message?: string;
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
  message?: string;
}

export interface EndConversationResponse {
  success: boolean;
  newConversationId?: string;
  error?: string;
  timestamp: string;
}

@Injectable({ providedIn: 'root' })
export class UserMessageService {
  constructor(private http: HttpClient) {}

  sendMessage(message: string) {
    return this.http.post<SendMessageResponse>('/api/userMessage', {
      message,
    });
  }

  async sendMessageStream(
    message: string,
    onEvent: (event: CognitionEvent) => void,
  ): Promise<void> {
    const response = await fetch('/api/userMessage/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message }),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop()!;

      let currentEventType = '';
      for (const line of lines) {
        if (line.startsWith('event: ')) {
          currentEventType = line.slice(7).trim();
        } else if (line.startsWith('data: ') && currentEventType) {
          try {
            const parsed = JSON.parse(line.slice(6)) as CognitionEvent;
            onEvent(parsed);
          } catch {
            // skip malformed JSON
          }
          currentEventType = '';
        }
      }
    }
  }

  connectMonologueStream(onEvent: (event: MonologueEvent) => void): EventSource {
    const es = new EventSource('/api/monologue/stream');

    const eventTypes: MonologueEventType[] = [
      'monologue_thinking_title',
      'monologue_thinking_token',
      'monologue_thinking_done',
      'monologue_voice_token',
      'monologue_done',
      'monologue_error',
    ];

    for (const eventType of eventTypes) {
      es.addEventListener(eventType, (e: MessageEvent) => {
        try {
          const parsed = JSON.parse(e.data) as MonologueEvent;
          onEvent(parsed);
        } catch {
          // skip malformed JSON
        }
      });
    }

    return es;
  }

  endConversation() {
    return this.http.post<EndConversationResponse>(
      '/api/userMessage/endConversation',
      {},
    );
  }
}
