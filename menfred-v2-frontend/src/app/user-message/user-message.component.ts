import { Component, ElementRef, NgZone, ViewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { CommonModule } from '@angular/common';
import {
  UserMessageService,
  CognitionEvent,
  IngestionStats,
  MemorySources,
} from './user-message.service';

interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: string;
  thinking?: string;
  sources?: MemorySources;
  ingestion?: IngestionStats;
  iterations?: number;
  cogIterations?: number;
  error?: boolean;
  thinkingExpanded?: boolean;
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

  // Streaming state
  thinkingTitle = '';
  thinkingText = '';
  answerText = '';
  isThinking = false;
  isSpeaking = false;

  @ViewChild('chatBody') private chatBody!: ElementRef;

  constructor(
    private userMessageService: UserMessageService,
    private zone: NgZone,
  ) {}

  sendMessage() {
    const text = this.message.trim();
    if (!text) return;

    this.messages.push({
      role: 'user',
      content: text,
      timestamp: new Date().toISOString(),
    });

    this.message = '';
    this.loading = true;
    this.isThinking = false;
    this.isSpeaking = false;
    this.thinkingTitle = '';
    this.thinkingText = '';
    this.answerText = '';
    this.scrollToBottom();

    this.userMessageService.sendMessageStream(text, (event: CognitionEvent) => {
      this.zone.run(() => this.handleEvent(event));
    }).then(() => {
      this.zone.run(() => {
        // Stream ended without a 'done' event — finalize if we have an answer
        if (this.isSpeaking && this.answerText && !this.loading) return;
        if (this.answerText && this.loading) {
          this.finishStream();
        }
      });
    }).catch((err) => {
      this.zone.run(() => {
        this.messages.push({
          role: 'assistant',
          content: err?.message || 'Failed to reach the backend.',
          timestamp: new Date().toISOString(),
          error: true,
        });
        this.loading = false;
        this.isThinking = false;
        this.isSpeaking = false;
        this.scrollToBottom();
      });
    });
  }

  private handleEvent(event: CognitionEvent) {
    switch (event.type) {
      case 'thinking_title':
        this.isThinking = true;
        this.thinkingTitle = event.title ?? '';
        this.scrollToBottom();
        break;

      case 'thinking_token':
        this.isThinking = true;
        this.thinkingText += event.token ?? '';
        this.scrollToBottom();
        break;

      case 'thinking_done':
        this.isThinking = false;
        break;

      case 'answer_token':
        this.isSpeaking = true;
        this.answerText += event.token ?? '';
        this.scrollToBottom();
        break;

      case 'done':
        this.messages.push({
          role: 'assistant',
          content: event.answer ?? this.answerText,
          thinking: event.thinking ?? this.thinkingText,
          timestamp: new Date().toISOString(),
          sources: event.sources,
          ingestion: event.ingestion as IngestionStats | undefined,
          cogIterations: event.cogIterations,
          thinkingExpanded: false,
        });
        this.loading = false;
        this.isThinking = false;
        this.isSpeaking = false;
        this.thinkingTitle = '';
        this.thinkingText = '';
        this.answerText = '';
        this.scrollToBottom();
        break;

      case 'error':
        this.messages.push({
          role: 'assistant',
          content: event.message ?? 'An error occurred.',
          timestamp: new Date().toISOString(),
          error: true,
        });
        this.loading = false;
        this.isThinking = false;
        this.isSpeaking = false;
        this.scrollToBottom();
        break;
    }
  }

  private finishStream() {
    this.messages.push({
      role: 'assistant',
      content: this.answerText,
      thinking: this.thinkingText,
      timestamp: new Date().toISOString(),
      thinkingExpanded: false,
    });
    this.loading = false;
    this.isThinking = false;
    this.isSpeaking = false;
    this.thinkingTitle = '';
    this.thinkingText = '';
    this.answerText = '';
    this.scrollToBottom();
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

  toggleThinking(index: number) {
    this.messages[index].thinkingExpanded = !this.messages[index].thinkingExpanded;
  }

  hasDetails(msg: ChatMessage): boolean {
    return (
      msg.role === 'assistant' &&
      !msg.error &&
      (!!msg.sources || !!msg.ingestion || msg.cogIterations !== undefined)
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
