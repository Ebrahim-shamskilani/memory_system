import { Component } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';

interface ResolvedEntity {
  name: string;
  chromaId?: string;
  confidence: number;
}

interface VectorResult {
  chromaId: string;
  document: string;
  distance: number;
  metadata: Record<string, unknown>;
}

interface RecallResponse {
  success: boolean;
  query: string;
  resolvedEntities: ResolvedEntity[];
  intents: string[];
  timeConstraints?: { after?: string; before?: string };
  iterations: number;
  facts: string[];
  vectorResults: VectorResult[];
  graphNodes: number;
  graphRelationships: number;
  timestamp: string;
  error?: string;
}

@Component({
  selector: 'app-memory-recall',
  standalone: true,
  imports: [FormsModule],
  templateUrl: './memory-recall.component.html',
  styleUrl: './memory-recall.component.css',
})
export class MemoryRecallComponent {
  query = '';
  loading = false;
  result: RecallResponse | null = null;
  expandedFacts = false;
  expandedVectors = false;

  constructor(private http: HttpClient) {}

  recall(): void {
    if (!this.query.trim() || this.loading) return;
    this.loading = true;
    this.result = null;

    this.http
      .post<RecallResponse>('/api/userMessage/recall', { query: this.query })
      .subscribe({
        next: (res) => {
          this.result = res;
          this.loading = false;
        },
        error: (err) => {
          this.result = {
            success: false,
            query: this.query,
            resolvedEntities: [],
            intents: [],
            iterations: 0,
            facts: [],
            vectorResults: [],
            graphNodes: 0,
            graphRelationships: 0,
            timestamp: new Date().toISOString(),
            error: err.message ?? 'Request failed',
          };
          this.loading = false;
        },
      });
  }
}
