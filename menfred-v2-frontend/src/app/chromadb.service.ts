import { HttpClient } from '@angular/common/http';
import { Injectable } from '@angular/core';

export interface AddResponse {
  success: boolean;
  count?: number;
  ids?: string[];
  message?: string;
}

export interface QueryResponse {
  ids: string[][];
  documents: string[][];
  metadatas: unknown[][];
  distances: number[][];
  message?: string;
}

const DEFAULT_COLLECTION = 'main_docs';

@Injectable({ providedIn: 'root' })
export class ChromadbService {
  constructor(private http: HttpClient) {}

  add(
    document: string,
    collection = DEFAULT_COLLECTION,
    metadata?: Record<string, string>,
  ) {
    return this.http.post<AddResponse>(`/api/chromadb/add`, {
      collection,
      document,
      metadata,
    });
  }

  query(
    query: string,
    nResults = 10,
    collection = DEFAULT_COLLECTION,
    filters?: Record<string, string>,
  ) {
    return this.http.post<QueryResponse>(`/api/chromadb/query`, {
      query,
      collection,
      nResults,
      filters,
    });
  }
}
