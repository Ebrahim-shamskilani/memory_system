import { Inject, Injectable, Optional } from '@nestjs/common';
import { ConversationTurn, ConversationBuffer } from '../unified-memory/types/memory.types';
import { randomUUID } from 'node:crypto';
import { MENFRED_MEMORY_CONFIG, MenfredMemoryConfig } from '../sdk/menfred-memory.config';

@Injectable()
export class ConversationService {
  private buffers = new Map<string, ConversationBuffer>();
  private activeConversationId: string = randomUUID();
  private readonly maxBufferSize: number;

  constructor(
    @Inject(MENFRED_MEMORY_CONFIG) @Optional() config?: MenfredMemoryConfig,
  ) {
    this.maxBufferSize = config?.conversation?.maxBufferSize ?? 10;
  }

  getActiveConversationId(): string {
    return this.activeConversationId;
  }

  startNewConversation(): string {
    this.activeConversationId = randomUUID();
    return this.activeConversationId;
  }

  clearAll(): void {
    this.buffers.clear();
    this.activeConversationId = randomUUID();
  }

  addTurn(
    role: 'user' | 'assistant',
    content: string,
    conversationId?: string,
  ): ConversationTurn {
    const convId = conversationId ?? this.activeConversationId;
    const turn: ConversationTurn = {
      role,
      content,
      timestamp: new Date().toISOString(),
      conversationId: convId,
    };

    let buffer = this.buffers.get(convId);
    if (!buffer) {
      buffer = { turns: [], conversationId: convId };
      this.buffers.set(convId, buffer);
    }

    buffer.turns.push(turn);

    // Keep only the most recent turns
    if (buffer.turns.length > this.maxBufferSize) {
      buffer.turns = buffer.turns.slice(-this.maxBufferSize);
    }

    return turn;
  }

  getRecentTurns(conversationId?: string, count?: number): ConversationTurn[] {
    const convId = conversationId ?? this.activeConversationId;
    const buffer = this.buffers.get(convId);
    if (!buffer) return [];
    const n = count ?? this.maxBufferSize;
    return buffer.turns.slice(-n);
  }

  getContextString(conversationId?: string): string {
    const turns = this.getRecentTurns(conversationId);
    return turns
      .map((t) => `${t.role}: ${t.content}`)
      .join('\n');
  }
}
