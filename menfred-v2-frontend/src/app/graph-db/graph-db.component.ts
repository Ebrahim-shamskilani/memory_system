import { Component } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { JsonPipe } from '@angular/common';
import { GraphDbService, GraphDbResponse } from '../graph-db.service';

@Component({
  selector: 'app-graph-db',
  imports: [FormsModule, JsonPipe],
  templateUrl: './graph-db.component.html',
  styleUrl: './graph-db.component.css',
})
export class GraphDbComponent {
  // Add section
  addCypher = 'CREATE (p:Person {name: $name, age: $age}) RETURN p';
  addParams: Array<{ key: string; value: string }> = [
    { key: 'name', value: 'Alice' },
    { key: 'age', value: '30' },
  ];
  addParamKey = '';
  addParamValue = '';
  addResult: GraphDbResponse | null = null;
  addError: string | null = null;
  addLoading = false;

  // Query section
  queryCypher = 'MATCH (p:Person) RETURN p.name AS name, p.age AS age';
  queryParams: Array<{ key: string; value: string }> = [];
  queryParamKey = '';
  queryParamValue = '';
  queryResult: GraphDbResponse | null = null;
  queryError: string | null = null;
  queryLoading = false;

  // Update section
  updateCypher = 'MATCH (p:Person {name: $name}) SET p.age = $age RETURN p';
  updateParams: Array<{ key: string; value: string }> = [
    { key: 'name', value: 'Alice' },
    { key: 'age', value: '31' },
  ];
  updateParamKey = '';
  updateParamValue = '';
  updateResult: GraphDbResponse | null = null;
  updateError: string | null = null;
  updateLoading = false;

  constructor(private graphDbService: GraphDbService) {}

  private parseParamValue(val: string): unknown {
    const trimmed = val.trim();
    if (trimmed === 'true') return true;
    if (trimmed === 'false') return false;
    if (trimmed === 'null') return null;
    const num = Number(trimmed);
    if (!Number.isNaN(num) && trimmed !== '') return num;
    return trimmed;
  }

  private toParams(pairs: Array<{ key: string; value: string }>): Record<string, unknown> {
    return Object.fromEntries(
      pairs
        .filter((p) => p.key.trim())
        .map((p) => [p.key.trim(), this.parseParamValue(p.value)]),
    );
  }

  addParamPair() {
    const key = this.addParamKey.trim();
    const value = this.addParamValue.trim();
    if (!key || !value) return;
    const idx = this.addParams.findIndex((p) => p.key === key);
    if (idx >= 0) this.addParams[idx] = { key, value };
    else this.addParams.push({ key, value });
    this.addParamKey = '';
    this.addParamValue = '';
  }

  addQueryParamPair() {
    const key = this.queryParamKey.trim();
    const value = this.queryParamValue.trim();
    if (!key || !value) return;
    const idx = this.queryParams.findIndex((p) => p.key === key);
    if (idx >= 0) this.queryParams[idx] = { key, value };
    else this.queryParams.push({ key, value });
    this.queryParamKey = '';
    this.queryParamValue = '';
  }

  addUpdateParamPair() {
    const key = this.updateParamKey.trim();
    const value = this.updateParamValue.trim();
    if (!key || !value) return;
    const idx = this.updateParams.findIndex((p) => p.key === key);
    if (idx >= 0) this.updateParams[idx] = { key, value };
    else this.updateParams.push({ key, value });
    this.updateParamKey = '';
    this.updateParamValue = '';
  }

  removeAddParam(key: string) {
    this.addParams = this.addParams.filter((p) => p.key !== key);
  }

  removeQueryParam(key: string) {
    this.queryParams = this.queryParams.filter((p) => p.key !== key);
  }

  removeUpdateParam(key: string) {
    this.updateParams = this.updateParams.filter((p) => p.key !== key);
  }

  runAdd() {
    if (!this.addCypher.trim()) {
      this.addError = 'Cypher is required.';
      return;
    }
    this.addLoading = true;
    this.addResult = null;
    this.addError = null;
    this.graphDbService.add(this.addCypher.trim(), this.toParams(this.addParams)).subscribe({
      next: (res) => {
        this.addResult = res;
        this.addLoading = false;
      },
      error: (err) => {
        this.addError = err?.error?.message ?? err?.message ?? 'Failed to add. Is Neo4j running?';
        this.addLoading = false;
      },
    });
  }

  runQuery() {
    if (!this.queryCypher.trim()) {
      this.queryError = 'Cypher is required.';
      return;
    }
    this.queryLoading = true;
    this.queryResult = null;
    this.queryError = null;
    this.graphDbService.query(this.queryCypher.trim(), this.toParams(this.queryParams)).subscribe({
      next: (res) => {
        this.queryResult = res;
        this.queryLoading = false;
      },
      error: (err) => {
        this.queryError = err?.error?.message ?? err?.message ?? 'Failed to query.';
        this.queryLoading = false;
      },
    });
  }

  runUpdate() {
    if (!this.updateCypher.trim()) {
      this.updateError = 'Cypher is required.';
      return;
    }
    this.updateLoading = true;
    this.updateResult = null;
    this.updateError = null;
    this.graphDbService.update(this.updateCypher.trim(), this.toParams(this.updateParams)).subscribe({
      next: (res) => {
        this.updateResult = res;
        this.updateLoading = false;
      },
      error: (err) => {
        this.updateError = err?.error?.message ?? err?.message ?? 'Failed to update.';
        this.updateLoading = false;
      },
    });
  }
}
