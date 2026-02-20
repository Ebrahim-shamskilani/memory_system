import { Component, ElementRef, ViewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { CommonModule } from '@angular/common';
import {
  UserMessageService,
  SendMessageResponse,
  IngestionStats,
  MemorySources,
} from './user-message.service';

interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: string;
  sources?: MemorySources;
  ingestion?: IngestionStats;
  iterations?: number;
  error?: boolean;
}

@Component({
  selector: 'app-user-message',
  imports: [FormsModule, CommonModule],
  templateUrl: './user-message.component.html',
  styleUrl: './user-message.component.css',
})
export class UserMessageComponent {
  message = '';
  messages: ChatMessage[] = [];
  loading = false;
  expandedIndex: number | null = null;

  @ViewChild('chatBody') private chatBody!: ElementRef;

  constructor(private userMessageService: UserMessageService) {}

  sendMessage() {
    const text = this.message.trim();
    if (!text) return;

    // Add user message
    this.messages.push({
      role: 'user',
      content: text,
      timestamp: new Date().toISOString(),
    });

    this.message = '';
    this.loading = true;
    this.scrollToBottom();

    this.userMessageService.sendMessage(text).subscribe({
      next: (response: SendMessageResponse) => {
        if (response.success && response.answer) {
          this.messages.push({
            role: 'assistant',
            content: response.answer,
            timestamp: response.timestamp,
            sources: response.sources,
            ingestion: response.ingestion,
            iterations: response.iterations,
          });
        } else {
          this.messages.push({
            role: 'assistant',
            content: response.error || 'No answer returned.',
            timestamp: response.timestamp,
            error: true,
          });
        }
        this.loading = false;
        this.scrollToBottom();
      },
      error: (err) => {
        this.messages.push({
          role: 'assistant',
          content: err?.error?.message || err?.message || 'Failed to reach the backend.',
          timestamp: new Date().toISOString(),
          error: true,
        });
        this.loading = false;
        this.scrollToBottom();
      },
    });
  }

  endConversation() {
    this.loading = true;
    this.userMessageService.endConversation().subscribe({
      next: (response) => {
        this.messages.push({
          role: 'system',
          content: response.success
            ? 'Conversation ended. Memory consolidated. Starting fresh.'
            : `Failed to end conversation: ${response.error}`,
          timestamp: response.timestamp,
          error: !response.success,
        });
        this.loading = false;
        this.scrollToBottom();
      },
      error: (err) => {
        this.messages.push({
          role: 'system',
          content: err?.message || 'Failed to end conversation.',
          timestamp: new Date().toISOString(),
          error: true,
        });
        this.loading = false;
        this.scrollToBottom();
      },
    });
  }

  toggleDetails(index: number) {
    this.expandedIndex = this.expandedIndex === index ? null : index;
  }

  hasDetails(msg: ChatMessage): boolean {
    return (
      msg.role === 'assistant' &&
      !msg.error &&
      (!!msg.sources || !!msg.ingestion || msg.iterations !== undefined)
    );
  }

  getTotalSources(sources: MemorySources): number {
    return (
      sources.entities.length +
      sources.relationships.length +
      sources.episodes.length +
      sources.facts.length
    );
  }

  private scrollToBottom() {
    setTimeout(() => {
      if (this.chatBody) {
        this.chatBody.nativeElement.scrollTop =
          this.chatBody.nativeElement.scrollHeight;
      }
    }, 50);
  }
}
