import { Injectable, Logger } from '@nestjs/common';
import { GraphDbService } from '../graph-db/graph-db.service';
import { DecomposedQuery, MemoryChunk } from './types/memory.types';

@Injectable()
export class Neo4jMemoryService {
  private readonly logger = new Logger(Neo4jMemoryService.name);

  constructor(private readonly graphDb: GraphDbService) {}

  async query(q: DecomposedQuery): Promise<MemoryChunk[]> {
    try {
      switch (q.type) {
        case 'entity':
          return await this.queryEntity(q);
        case 'relation':
          return await this.queryRelation(q);
        case 'event':
          return await this.queryEvent(q);
        default:
          // context: هر دو رو بزن
          const [entities, relations] = await Promise.all([
            this.queryEntity(q),
            this.queryRelation(q),
          ]);
          return [...entities, ...relations];
      }
    } catch (err) {
      this.logger.warn(`Neo4j query failed [${q.type}]: ${(err as Error).message}`);
      return [];
    }
  }

  // "حسن کیه؟" → پیدا کردن node هایی که keyword توی propertyشونه
  private async queryEntity(q: DecomposedQuery): Promise<MemoryChunk[]> {
    const keywords = this.effectiveKeywords(q);
    if (!keywords.length) return [];

    const { records } = await this.graphDb.query(
      `UNWIND $keywords AS kw
       MATCH (n)
       WHERE any(k IN keys(n)
             WHERE n[k] IS NOT NULL
               AND toLower(
                 CASE WHEN n[k] IS :: LIST OF ANY
                   THEN reduce(s = '', x IN n[k] | s + toString(x) + ' ')
                   ELSE toString(n[k])
                 END
               ) CONTAINS toLower(kw))
       RETURN labels(n) AS labels, properties(n) AS props
       LIMIT 10`,
      { keywords },
    );

    return records
      .map((r) => this.toChunk(r as Record<string, unknown>))
      .filter((c): c is MemoryChunk => c !== null);
  }

  // "رابطه حسن با بقیه؟" → گره‌هایی که keyword دارن + رابطه‌هاشون
  private async queryRelation(q: DecomposedQuery): Promise<MemoryChunk[]> {
    const keywords = this.effectiveKeywords(q);
    if (!keywords.length) return [];

    const propContains = (alias: string) =>
      `any(k IN keys(${alias}) WHERE ${alias}[k] IS NOT NULL
         AND toLower(CASE WHEN ${alias}[k] IS :: LIST OF ANY
           THEN reduce(s = '', x IN ${alias}[k] | s + toString(x) + ' ')
           ELSE toString(${alias}[k]) END) CONTAINS toLower(kw))`;

    const { records } = await this.graphDb.query(
      `UNWIND $keywords AS kw
       MATCH (a)-[r]-(b)
       WHERE ${propContains('a')} OR ${propContains('b')}
       RETURN properties(a) AS from,
              type(r)        AS relType,
              properties(r)  AS relProps,
              properties(b)  AS to
       LIMIT 10`,
      { keywords },
    );

    return records
      .map((r) => this.relationToChunk(r as Record<string, unknown>))
      .filter((c): c is MemoryChunk => c !== null);
  }

  // "چرا اخراج شد؟" → event node ها
  private async queryEvent(q: DecomposedQuery): Promise<MemoryChunk[]> {
    const keywords = this.effectiveKeywords(q);
    if (!keywords.length) return [];

    const { records } = await this.graphDb.query(
      `UNWIND $keywords AS kw
       MATCH (e:Event)
       WHERE any(k IN keys(e) WHERE e[k] IS NOT NULL
         AND toLower(CASE WHEN e[k] IS :: LIST OF ANY
           THEN reduce(s = '', x IN e[k] | s + toString(x) + ' ')
           ELSE toString(e[k]) END) CONTAINS toLower(kw))
       OPTIONAL MATCH (p:Person)-[:INVOLVED_IN]->(e)
       RETURN properties(e) AS event, collect(p.name) AS people
       LIMIT 10`,
      { keywords },
    );

    return records
      .map((r) => this.eventToChunk(r as Record<string, unknown>))
      .filter((c): c is MemoryChunk => c !== null);
  }

  // keywords خالی باشه، از question استخراج می‌کنیم (fallback)
  private effectiveKeywords(q: DecomposedQuery): string[] {
    if (q.keywords?.length) return q.keywords;

    // ساده‌ترین fallback: کلمات بالای ۲ حرف
    return q.question
      .split(/\s+/)
      .filter((w) => w.length > 2)
      .slice(0, 5);
  }

  private toChunk(record: Record<string, unknown>): MemoryChunk | null {
    const labels = record['labels'] as string[] | undefined;
    const props = record['props'] as Record<string, unknown> | undefined;
    if (!props) return null;

    const label = labels?.join('/') ?? 'Node';
    const summary = Object.entries(props)
      .filter(([, v]) => v != null && String(v).trim())
      .map(([k, v]) => `${k}: ${String(v)}`)
      .join(', ');

    if (!summary) return null;
    return {
      content: `[${label}] ${summary}`,
      source: 'neo4j',
      metadata: props,
    };
  }

  private relationToChunk(record: Record<string, unknown>): MemoryChunk | null {
    const from = record['from'] as Record<string, unknown> | undefined;
    const to = record['to'] as Record<string, unknown> | undefined;
    const relType = record['relType'] as string | undefined;
    if (!from || !to || !relType) return null;

    const fromName = from['name'] ?? from['title'] ?? JSON.stringify(from);
    const toName = to['name'] ?? to['title'] ?? JSON.stringify(to);

    return {
      content: `${fromName} → [${relType}] → ${toName}`,
      source: 'neo4j',
      metadata: record as Record<string, unknown>,
    };
  }

  private eventToChunk(record: Record<string, unknown>): MemoryChunk | null {
    const event = record['event'] as Record<string, unknown> | undefined;
    const people = record['people'] as string[] | undefined;
    if (!event) return null;

    const title = event['title'] ?? event['name'] ?? 'Event';
    const desc = event['description'] ?? '';
    const who = people?.filter(Boolean).join(', ');

    const parts = [`[Event] ${title}`];
    if (desc) parts.push(String(desc));
    if (who) parts.push(`Involved: ${who}`);

    return {
      content: parts.join(' | '),
      source: 'neo4j',
      metadata: event,
    };
  }
}