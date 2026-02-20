import { Inject, Injectable, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import neo4j, { Driver } from 'neo4j-driver';
import { MENFRED_MEMORY_CONFIG, MenfredMemoryConfig } from '../sdk/menfred-memory.config';

@Injectable()
export class GraphDbService implements OnModuleInit, OnModuleDestroy {
  private driver: Driver;
  private readonly database: string;

  constructor(
    @Inject(MENFRED_MEMORY_CONFIG) @Optional() config?: MenfredMemoryConfig,
  ) {
    const uri = config?.neo4j?.uri ?? process.env.NEO4J_URI ?? 'bolt://localhost:7687';
    const user = config?.neo4j?.user ?? process.env.NEO4J_USER ?? 'neo4j';
    const password = config?.neo4j?.password ?? process.env.NEO4J_PASSWORD ?? 'cognito2026';
    this.database = config?.neo4j?.database ?? process.env.NEO4J_DATABASE ?? 'neo4j';
    this.driver = neo4j.driver(uri, neo4j.auth.basic(user, password), {
      disableLosslessIntegers: true,
    });
  }

  async onModuleInit() {
    await this.driver.verifyConnectivity();
  }

  async onModuleDestroy() {
    await this.driver.close();
  }

  private getDatabase() {
    return this.database;
  }

  private toPlainValue(val: unknown): unknown {
    if (val === null || val === undefined) return val;
    if (typeof val === 'number' || typeof val === 'string' || typeof val === 'boolean') return val;
    if (Array.isArray(val)) return val.map((v) => this.toPlainValue(v));
    if (typeof val === 'object' && val !== null && 'labels' in val && 'properties' in val) {
      const node = val as { labels: string[]; properties: Record<string, unknown>; elementId?: string };
      return { labels: node.labels, properties: this.toPlainValue(node.properties) as Record<string, unknown>, elementId: node.elementId };
    }
    if (typeof val === 'object' && val !== null && 'type' in val && 'properties' in val) {
      const rel = val as { type: string; properties: Record<string, unknown>; elementId?: string };
      return { type: rel.type, properties: this.toPlainValue(rel.properties) as Record<string, unknown>, elementId: rel.elementId };
    }
    if (typeof val === 'object' && val !== null && typeof (val as { toNumber?: () => number }).toNumber === 'function') {
      return (val as { toNumber: () => number }).toNumber();
    }
    if (typeof val === 'object' && val !== null) {
      return Object.fromEntries(
        Object.entries(val).map(([k, v]) => [k, this.toPlainValue(v)]),
      );
    }
    return val;
  }

  async runQuery(
    cypher: string,
    params: Record<string, unknown> = {},
  ): Promise<{ records: unknown[]; summary: Record<string, unknown> }> {
    const result = await this.driver.executeQuery(cypher, params, {
      database: this.getDatabase(),
    });

    const records = result.records.map((r) =>
      r.keys.reduce(
        (acc, key) => ({ ...acc, [key]: this.toPlainValue(r.get(key)) }),
        {} as Record<string, unknown>,
      ),
    );

    return {
      records,
      summary: {
        counters: result.summary.counters,
        resultAvailableAfter: result.summary.resultAvailableAfter?.toString(),
      },
    };
  }

  async add(
    cypher: string,
    params: Record<string, unknown> = {},
  ): Promise<{ records: unknown[]; summary: Record<string, unknown> }> {
    return this.runQuery(cypher, params);
  }

  async query(
    cypher: string,
    params: Record<string, unknown> = {},
  ): Promise<{ records: unknown[]; summary: Record<string, unknown> }> {
    return this.runQuery(cypher, params);
  }

  async update(
    cypher: string,
    params: Record<string, unknown> = {},
  ): Promise<{ records: unknown[]; summary: Record<string, unknown> }> {
    return this.runQuery(cypher, params);
  }
}
