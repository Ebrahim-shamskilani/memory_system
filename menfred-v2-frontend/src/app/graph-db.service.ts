import { HttpClient } from '@angular/common/http';
import { Injectable } from '@angular/core';

export interface GraphDbResponse {
  success: boolean;
  records?: unknown[];
  summary?: Record<string, unknown>;
  message?: string;
}

@Injectable({ providedIn: 'root' })
export class GraphDbService {
  constructor(private http: HttpClient) {}

  add(cypher: string, params?: Record<string, unknown>) {
    return this.http.post<GraphDbResponse>(`/api/graph-db/add`, {
      cypher,
      params: params ?? {},
    });
  }

  query(cypher: string, params?: Record<string, unknown>) {
    return this.http.post<GraphDbResponse>(`/api/graph-db/query`, {
      cypher,
      params: params ?? {},
    });
  }

  update(cypher: string, params?: Record<string, unknown>) {
    return this.http.post<GraphDbResponse>(`/api/graph-db/update`, {
      cypher,
      params: params ?? {},
    });
  }
}
