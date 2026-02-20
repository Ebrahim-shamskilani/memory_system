import { HttpClient } from '@angular/common/http';
import { Injectable } from '@angular/core';

export interface LlmResponse {
  response: string;
}

@Injectable({ providedIn: 'root' })
export class LlmService {
  constructor(private http: HttpClient) {}

  sendMessage(message: string) {
    return this.http.post<LlmResponse>(`/api/llm`, { message });
  }
}
