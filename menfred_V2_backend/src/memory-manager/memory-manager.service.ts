import { Injectable } from '@nestjs/common';
import { RecallService } from './recall.service';

@Injectable()
export class MemoryManagerService {
  constructor(private readonly recallService: RecallService) {}

  async recall(message: string): Promise<string> {
    return this.recallService.recall(message);
  }
}
