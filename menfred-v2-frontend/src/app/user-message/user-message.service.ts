import { HttpClient } from '@angular/common/http';
import { Injectable } from '@angular/core';



export interface SendMessageResponse {
  success: boolean;
  received: string;
  timestamp: string;
}

@Injectable({ providedIn: 'root' })
export class UserMessageService {
  constructor(private http: HttpClient) {}

  sendMessage(message: string) {
    return this.http.post<SendMessageResponse>(`/api/userMessage`, {
      message,
    });
  }
}
