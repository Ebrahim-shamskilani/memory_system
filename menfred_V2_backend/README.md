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
      brain: {
        name: 'Manfred',             // optional, default: 'Manfred'
        description: 'a personal AI memory assistant', // optional
      },
      user: {
        name: 'ابراهیم',              // optional, default: 'ابراهیم'
        nameEnglish: 'Ebrahim',      // optional, default: 'Ebrahim'
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
| `brain` | `name` | `string?` | `'Manfred'` | The assistant's name, used in LLM prompts |
| `brain` | `description` | `string?` | `'a personal AI memory assistant'` | Short description of the assistant |
| `user` | `name` | `string?` | `'ابراهیم'` | The user's name (primary script) |
| `user` | `nameEnglish` | `string?` | `'Ebrahim'` | The user's name in English/Latin script |

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

Manually trigger the consolidation pipeline (summarization, pattern detection, contradiction resolution, fact promotion, fact deduplication, entity deduplication).

**Returns:** `Promise<ConsolidationRun>`

#### `endConversation()`

Start a new conversation and trigger consolidation of the previous one.

**Returns:** `Promise<{ newConversationId: string; consolidation: ConsolidationRun }>`

#### `eraseAllMemory()`

Irreversibly delete all stored memory: all Neo4j nodes/relationships, all ChromaDB documents, and the in-memory conversation buffer. Use with caution.

**Returns:** `Promise<EraseResult>`

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

### `ConsolidationStats`

```typescript
{
  level3Processed: number;
  level2Created: number;
  level1Created: number;
  factsConsolidated: number;
  contradictionsFound: number;
  duplicatesMerged: number;
  entitiesMerged: number;
}
```

### `EraseResult`

```typescript
{
  neo4jNodesDeleted: number;
  chromaCollectionsCleared: string[];   // e.g. ['entities', 'relationships', 'episodes']
  conversationBufferCleared: boolean;
}
```

## REST API (Standalone)

When running as the standalone backend (`npm run start:dev`), these endpoints are available:

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/userMessage` | Send a message -- ingests and recalls |
| `POST` | `/userMessage/consolidate` | Manually trigger consolidation |
| `POST` | `/userMessage/endConversation` | End conversation + consolidate |
| `POST` | `/userMessage/eraseMemory` | Erase all stored memory (irreversible) |

## Notes

- When using as an SDK (`MenfredMemoryModule.forRoot()`), set `chromadb.managed: false` -- the consumer is responsible for running ChromaDB externally.
- The standalone app (`npm run start:dev`) continues to work unchanged using environment variables.
- The module is registered as `global: true`, so `UnifiedMemoryService` is available in any module without additional imports.
- Entity ingestion uses two-phase resolution: Neo4j name lookup first, then vector similarity fallback -- preventing duplicates from different descriptions of the same entity.
- Consolidation includes entity deduplication (Phase F) that merges duplicate entities by name, re-linking all relationships, facts, and episode participations to the canonical entity.
- Brain and user identity are configurable via `brain` and `user` config sections. All defaults work out of the box.
