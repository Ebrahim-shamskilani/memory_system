import { Injectable } from '@nestjs/common';
import { MonologueEntry } from '../types/monologue.types';

const MAX_BUFFER_SIZE = 10;

@Injectable()
export class MonologueBufferService {
  private readonly buffer: MonologueEntry[] = [];

  push(entry: MonologueEntry): void {
    this.buffer.push(entry);
    if (this.buffer.length > MAX_BUFFER_SIZE) {
      this.buffer.shift();
    }
  }

  getAll(): readonly MonologueEntry[] {
    return this.buffer;
  }

  getRecent(n: number): MonologueEntry[] {
    return this.buffer.slice(-n);
  }

  getContextString(): string {
    if (this.buffer.length === 0) return '';
    return this.buffer
      .map((e) => `[${e.timestamp}] (inner thought about "${e.seed}"): ${e.voicedOutput}`)
      .join('\n');
  }

  getLastSeed(): string | null {
    if (this.buffer.length === 0) return null;
    const last = this.buffer[this.buffer.length - 1];
    return last.nextSeed || null;
  }

  clear(): void {
    this.buffer.length = 0;
  }
}
