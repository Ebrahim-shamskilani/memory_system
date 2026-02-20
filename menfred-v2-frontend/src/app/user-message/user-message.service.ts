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

  endConversation() {
    return this.http.post<EndConversationResponse>(
      '/api/userMessage/endConversation',
      {},
    );
  }
}
