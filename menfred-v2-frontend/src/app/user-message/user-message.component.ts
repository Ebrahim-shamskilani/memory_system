import { Component, ElementRef, NgZone, OnDestroy, OnInit, ViewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { CommonModule } from '@angular/common';
import {
  UserMessageService,
  CognitionEvent,
  MonologueEvent,
  IngestionStats,
  MemorySources,
} from './user-message.service';

interface ChatMessage {
  role: 'user' | 'assistant' | 'system' | 'monologue';
  content: string;
  timestamp: string;
  thinking?: string;
  sources?: MemorySources;
  ingestion?: IngestionStats;
  iterations?: number;
  cogIterations?: number;
  error?: boolean;
  thinkingExpanded?: boolean;
  seed?: string;
}

@Component({
  selector: 'app-user-message',
  imports: [FormsModule, CommonModule],
  templateUrl: './user-message.component.html',
  styleUrl: './user-message.component.css',
})
export class UserMessageComponent implements OnInit, OnDestroy {
  message = '';
  messages: ChatMessage[] = [];
  loading = false;
  expandedIndex: number | null = null;

  // Streaming state (reactive)
  thinkingTitle = '';
  thinkingText = '';
  answerText = '';
  isThinking = false;
  isSpeaking = false;

  // Monologue streaming state
  private monologueSource: EventSource | null = null;
  monologueThinkingTitle = '';
  monologueThinkingText = '';
  monologueVoiceText = '';
  isMonologueThinking = false;
  isMonologueVoicing = false;
  monologueSeed = '';

  @ViewChild('chatBody') private chatBody!: ElementRef;

  constructor(
    private userMessageService: UserMessageService,
    private zone: NgZone,
  ) {}

  ngOnInit(): void {
    this.connectMonologue();
  }

  ngOnDestroy(): void {
    this.disconnectMonologue();
  }

  private connectMonologue(): void {
    this.monologueSource = this.userMessageService.connectMonologueStream(
      (event: MonologueEvent) => {
        this.zone.run(() => this.handleMonologueEvent(event));
      },
    );
  }

  private disconnectMonologue(): void {
    if (this.monologueSource) {
      this.monologueSource.close();
      this.monologueSource = null;
    }
  }

  private handleMonologueEvent(event: MonologueEvent): void {
    switch (event.type) {
      case 'monologue_thinking_title':
        this.isMonologueThinking = true;
        this.monologueThinkingTitle = event.title ?? '';
        this.monologueSeed = event.seed ?? this.monologueSeed;
        this.scrollToBottom();
        break;

      case 'monologue_thinking_token':
        this.isMonologueThinking = true;
        this.monologueThinkingText += event.token ?? '';
        this.scrollToBottom();
        break;

      case 'monologue_thinking_done':
        this.isMonologueThinking = false;
        break;

      case 'monologue_voice_token':
        this.isMonologueVoicing = true;
        this.monologueVoiceText += event.token ?? '';
        this.scrollToBottom();
        break;

      case 'monologue_done':
        this.messages.push({
          role: 'monologue',
          content: event.voicedOutput ?? this.monologueVoiceText,
          thinking: event.thinking ?? this.monologueThinkingText,
          timestamp: event.timestamp ?? new Date().toISOString(),
          seed: event.seed,
          thinkingExpanded: false,
        });
        this.isMonologueThinking = false;
        this.isMonologueVoicing = false;
        this.monologueThinkingTitle = '';
        this.monologueThinkingText = '';
        this.monologueVoiceText = '';
        this.monologueSeed = '';
        this.scrollToBottom();
        break;

      case 'monologue_error':
        this.isMonologueThinking = false;
        this.isMonologueVoicing = false;
        this.monologueThinkingTitle = '';
        this.monologueThinkingText = '';
        this.monologueVoiceText = '';
        this.monologueSeed = '';
        break;
    }
  }

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
