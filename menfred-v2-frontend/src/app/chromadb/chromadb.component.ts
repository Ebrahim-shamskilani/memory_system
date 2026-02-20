import { Component } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ChromadbService, QueryResponse } from '../chromadb.service';

@Component({
  selector: 'app-chromadb',
  imports: [FormsModule, DecimalPipe],
  templateUrl: './chromadb.component.html',
  styleUrl: './chromadb.component.css',
})
export class ChromadbComponent {
  queryRows: Array<{ id: string; document: string; distance?: number; score?: number }> = [];
  queryInfo: string | null = null;

  // Add section
  addDocument = '';
  addMetadataKeyInput = '';
  addMetadataValueInput = '';
  addMetadataPairs: Array<{ key: string; value: string }> = [];
  addGeneratedIds: string[] = [];
  addResult: string | null = null;
  addError: string | null = null;
  addLoading = false;

  // Query section
  queryText = '';
  queryFilterKeyInput = '';
  queryFilterValueInput = '';
  queryFilterPairs: Array<{ key: string; value: string }> = [];
  queryNResults = 5;
  queryResult: QueryResponse | null = null;
  queryError: string | null = null;
  queryLoading = false;

  constructor(private chromadbService: ChromadbService) {}

  addMetadataPair() {
    const key = this.addMetadataKeyInput.trim();
    const value = this.addMetadataValueInput.trim();
    if (!key || !value) return;
    this.addMetadataPairs = this.addMetadataPairs
      .filter((pair) => pair.key !== key)
      .concat({ key, value });
    this.addMetadataKeyInput = '';
    this.addMetadataValueInput = '';
  }

  removeAddMetadataPair(key: string) {
    this.addMetadataPairs = this.addMetadataPairs.filter((pair) => pair.key !== key);
  }

  addQueryFilterPair() {
    const key = this.queryFilterKeyInput.trim();
    const value = this.queryFilterValueInput.trim();
    if (!key || !value) return;
    this.queryFilterPairs = this.queryFilterPairs
      .filter((pair) => pair.key !== key)
      .concat({ key, value });
    this.queryFilterKeyInput = '';
    this.queryFilterValueInput = '';
  }

  removeQueryFilterPair(key: string) {
    this.queryFilterPairs = this.queryFilterPairs.filter((pair) => pair.key !== key);
  }

  addToChroma() {
    const document = this.addDocument.trim();
    if (!document) {
      this.addError = 'Document is required.';
      return;
    }

    this.addLoading = true;
    this.addResult = null;
    this.addError = null;
    this.addGeneratedIds = [];

    const metadata =
      this.addMetadataPairs.length > 0
        ? Object.fromEntries(this.addMetadataPairs.map((pair) => [pair.key, pair.value]))
        : undefined;

    this.chromadbService.add(
      document,
      undefined,
      metadata,
    ).subscribe({
      next: (res) => {
        this.addGeneratedIds = res.ids ?? [];
        this.addResult = res.success
          ? `Added ${res.count} document(s) successfully with backend-generated UUIDs.`
          : res.message ?? 'Unknown response';
        this.addLoading = false;
      },
      error: (err) => {
        this.addError =
          err?.error?.message ??
          err?.message ??
          'Failed to add. Is the backend and Ollama running?';
        this.addLoading = false;
      },
    });
  }

  onQueryInput() {
    this.queryResult = null;
    this.queryError = null;
    this.queryRows = [];
    this.queryInfo = null;
  }

  queryChroma() {
    if (!this.queryText.trim()) return;

    this.queryLoading = true;
    this.queryResult = null;
    this.queryError = null;

    const requestedResults = Math.max(1, Number(this.queryNResults) || 5);
    const filters =
      this.queryFilterPairs.length > 0
        ? Object.fromEntries(this.queryFilterPairs.map((pair) => [pair.key, pair.value]))
        : undefined;

    this.chromadbService
      .query(
        this.queryText,
        requestedResults,
        undefined,
        filters,
      )
      .subscribe({
        next: (res) => {
          this.queryResult = res;
          const ids = res.ids?.[0] ?? [];
          const docs = res.documents?.[0] ?? [];
          const distances = res.distances?.[0] ?? [];
          this.queryRows = ids
            .map((id, index) => {
              const distance = distances[index];
              // Chroma distance: lower is better. Convert to a 0-100 similarity score for UI.
              const score = distance === undefined ? undefined : Math.max(0, Math.min(100, (1 - distance) * 100));
              return {
                id,
                document: docs[index] ?? '(no document stored)',
                distance,
                score,
              };
            })
            .sort((a, b) => (a.distance ?? Infinity) - (b.distance ?? Infinity));
          this.queryInfo =
            this.queryRows.length <= 1
              ? 'Only one match was returned. Add more records or try a broader query.'
              : `Showing ${this.queryRows.length} similar records`;
          this.queryLoading = false;
        },
        error: (err) => {
          this.queryError =
            err?.error?.message ?? err?.message ?? 'Failed to query.';
          this.queryRows = [];
          this.queryInfo = null;
          this.queryLoading = false;
        },
      });
  }
}
