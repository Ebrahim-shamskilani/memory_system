import { Component } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { UserMessageService, SendMessageResponse } from './user-message.service';

@Component({
  selector: 'app-user-message',
  imports: [FormsModule],
  templateUrl: './user-message.component.html',
  styleUrl: './user-message.component.css',
})
export class UserMessageComponent {
  message = '';
  result: SendMessageResponse | null = null;
  error: string | null = null;
  loading = false;

  constructor(private userMessageService: UserMessageService) {}

  sendMessage() {
    if (!this.message.trim()) return;

    this.loading = true;
    this.result = null;
    this.error = null;

    this.userMessageService.sendMessage(this.message).subscribe({
      next: (response) => {
        this.result = response;
        this.loading = false;
      },
      error: (err) => {
        this.error = err?.message || 'Failed to send message. Is the backend running?';
        this.loading = false;
      },
    });
  }
}
