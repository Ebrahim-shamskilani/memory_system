# @menfred/memory

Brain-inspired memory system for NestJS -- dual-write to Neo4j + ChromaDB with LLM-powered retrieval, ingestion, consolidation, and synthesis.

## Prerequisites

The following services must be running and reachable:

- **Neo4j** (bolt protocol) -- graph store for entities, relationships, episodes, facts
- **ChromaDB** -- vector store for semantic search
- **Ollama** -- local LLM inference (generation + embeddings)

## Installation

From a sibling project (e.g. the brain system):

```bash
npm install ../menfred_V2_backend
```

Or in `package.json`:

```json
{
  "dependencies": {
    "@menfred/memory": "file:../menfred_V2_backend"
  }
}
```

Make sure to build first:

```bash
cd menfred_V2_backend && npm run build
```

## Usage

Import `MenfredMemoryModule.forRoot(config)` in your root module:

```typescript
import { Module } from '@nestjs/common';
import { MenfredMemoryModule } from '@menfred/memory';

@Module({
  imports: [
    MenfredMemoryModule.forRoot({
      neo4j: {
        uri: 'bolt://localhost:7687',
        user: 'neo4j',
        password: 'your-password',
        database: 'neo4j',          // optional, default: 'neo4j'
      },
      ollama: {
        url: 'http://localhost:11434',
        model: 'gemma3:12b',
        embeddingModel: 'bge-m3',   // optional, default: 'bge-m3'
      },
      chromadb: {
        host: 'localhost',
        port: 8000,                  // optional, default: 8000
        managed: false,              // set false when using as SDK
        dataPath: './chroma_data',   // optional
      },
      conversation: {
        maxBufferSize: 10,           // optional, default: 10
      },
    }),
  ],
})
export class AppModule {}
```

Then inject `UnifiedMemoryService` anywhere:

```typescript
import { Injectable } from '@nestjs/common';
import { UnifiedMemoryService } from '@menfred/memory';

@Injectable()
export class BrainService {
  constructor(private readonly memory: UnifiedMemoryService) {}

  async handleMessage(message: string) {
    // Ingest + recall in one call
    const result = await this.memory.processMessage(message);
    console.log(result.answer);
    console.log(result.ingestion);
  }
}
```

## Configuration Reference

| Section | Key | Type | Default | Description |
|---------|-----|------|---------|-------------|
| `neo4j` | `uri` | `string` | -- | Neo4j bolt URI |
| `neo4j` | `user` | `string` | -- | Neo4j username |
| `neo4j` | `password` | `string` | -- | Neo4j password |
| `neo4j` | `database` | `string?` | `'neo4j'` | Neo4j database name |
| `ollama` | `url` | `string` | -- | Ollama base URL |
| `ollama` | `model` | `string` | -- | Default LLM model for generation |
| `ollama` | `embeddingModel` | `string?` | `'bge-m3'` | Embedding model name |
| `chromadb` | `host` | `string` | -- | ChromaDB server host |
| `chromadb` | `port` | `number?` | `8000` | ChromaDB server port |
| `chromadb` | `dataPath` | `string?` | `'./chroma_data'` | ChromaDB data directory |
| `chromadb` | `managed` | `boolean?` | `true` (standalone) | Whether to auto-start ChromaDB. Set `false` for SDK usage. |
| `conversation` | `maxBufferSize` | `number?` | `10` | Max conversation turns to keep in buffer |

## API Reference

### `UnifiedMemoryService`

#### `processMessage(message: string)`

Ingest a user message (extract entities, facts, relationships, episodes) and then recall relevant memories. Returns the synthesized answer plus ingestion stats.

**Returns:** `Promise<MemoryRecallResult & { ingestion: IngestionResult }>`

#### `recall(message: string)`

Recall-only -- retrieve and synthesize relevant memories without ingesting new information.

**Returns:** `Promise<MemoryRecallResult>`

#### `ingest(message: string)`

Ingest-only -- extract and store information without generating a recall response.

**Returns:** `Promise<IngestionResult>`

#### `triggerConsolidation()`

Manually trigger the consolidation pipeline (summarization, pattern detection, contradiction resolution, fact promotion, deduplication).

**Returns:** `Promise<ConsolidationRun>`

#### `endConversation()`

Start a new conversation and trigger consolidation of the previous one.

**Returns:** `Promise<{ newConversationId: string; consolidation: ConsolidationRun }>`

#### Store Delegation Methods

- `createEntity(dto: CreateEntityDto): Promise<DualWriteResult>`
- `createRelationship(dto: CreateRelationshipDto): Promise<DualWriteResult>`
- `createEpisode(dto: CreateEpisodeDto): Promise<DualWriteResult>`
- `createFact(dto: CreateFactDto): Promise<DualWriteResult>`
- `linkEntityToFact(entityChromaId, factChromaId, description): Promise<void>`
- `linkEntityToEpisode(entityChromaId, episodeChromaId, role, description): Promise<void>`
- `getStore(): UnifiedStoreService`

## Return Types

### `MemoryRecallResult`

```typescript
{
  answer: string;
  sources: {
    entities: string[];
    relationships: string[];
    episodes: string[];
    facts: string[];
  };
  iterations: number;
}
```

### `IngestionResult`

```typescript
{
  entitiesCreated: number;
  entitiesResolved: number;
  factsCreated: number;
  factsSkippedDuplicate: number;
  relationshipsCreated: number;
  episodeCreated: boolean;
  eventsCreated: number;
}
```

### `DualWriteResult`

```typescript
{
  neo4jSuccess: boolean;
  chromaSuccess: boolean;
  chromaId: string;
  rolledBack?: boolean;
}
```

### `ConsolidationRun`

```typescript
{
  runId: string;
  startedAt: string;
  completedAt?: string;
  trigger: 'message_count' | 'conversation_end' | 'manual';
  stats: ConsolidationStats;
}
```

## Notes

- When using as an SDK (`MenfredMemoryModule.forRoot()`), set `chromadb.managed: false` -- the consumer is responsible for running ChromaDB externally.
- The standalone app (`npm run start:dev`) continues to work unchanged using environment variables.
- The module is registered as `global: true`, so `UnifiedMemoryService` is available in any module without additional imports.
