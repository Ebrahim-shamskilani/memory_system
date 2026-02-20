import { Component } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { UserMessageComponent } from './user-message/user-message.component';
import { DirectPromptLlmComponent } from './direct-prompt-llm/direct-prompt-llm.component';
import { ChromadbComponent } from './chromadb/chromadb.component';
import { GraphDbComponent } from './graph-db/graph-db.component';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, UserMessageComponent, DirectPromptLlmComponent, ChromadbComponent, GraphDbComponent],
  templateUrl: './app.component.html',
  styleUrl: './app.component.css',
})
export class AppComponent {
  title = 'menfred-v2-frontend';
}
