import { Component } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { LlmService } from '../llm.service';

@Component({
  selector: 'app-direct-prompt-llm',
  imports: [FormsModule],
  templateUrl: './direct-prompt-llm.component.html',
  styleUrl: './direct-prompt-llm.component.css',
})
export class DirectPromptLlmComponent {
  prompt = '';
  response: string | null = null;
  error: string | null = null;
  loading = false;

  constructor(private llmService: LlmService) {}

  sendPrompt() {
    if (!this.prompt.trim()) return;

    this.loading = true;
    this.response = null;
    this.error = null;

    this.llmService.sendMessage(this.prompt).subscribe({
      next: (data) => {
        this.response = data.response;
        this.loading = false;
      },
      error: (err) => {
        this.error = err?.message || 'Failed to get response. Is the backend and Ollama running?';
        this.loading = false;
      },
    });
  }
}
