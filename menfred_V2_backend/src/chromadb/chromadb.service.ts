import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { ChromaClient } from 'chromadb';
import { OllamaEmbeddingFunction } from '@chroma-core/ollama';
import { spawn, type ChildProcess } from 'node:child_process';
import * as path from 'node:path';
import { MENFRED_MEMORY_CONFIG, MenfredMemoryConfig } from '../sdk/menfred-memory.config';

const CHROMA_PORT = 8000;
const CHROMA_HOST = 'localhost';

export const COLLECTION_ENTITIES = 'entities';
export const COLLECTION_RELATIONSHIPS = 'relationships';
export const COLLECTION_EPISODES = 'episodes';
export const COLLECTION_BELIEFS = 'beliefs';

@Injectable()
export class ChromadbService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ChromadbService.name);
  private client: ChromaClient;
  private serverProcess: ChildProcess | null = null;
  private dataPath: string;
  private embeddingFunction: OllamaEmbeddingFunction;
  private readonly managed: boolean;
  private readonly chromaPort: number;

  constructor(
    @Inject(MENFRED_MEMORY_CONFIG) @Optional() config?: MenfredMemoryConfig,
  ) {
    const host = config?.chromadb?.host ?? process.env.CHROMA_HOST ?? CHROMA_HOST;
    this.chromaPort = config?.chromadb?.port ?? parseInt(process.env.CHROMA_PORT ?? String(CHROMA_PORT), 10);
    this.managed = config?.chromadb?.managed ?? (process.env.CHROMA_MANAGED !== 'false');
    this.dataPath =
      config?.chromadb?.dataPath ??
      process.env.CHROMA_DATA_PATH ??
      path.join(process.cwd(), 'chroma_data');
    this.client = new ChromaClient({
      host,
      port: this.chromaPort,
    });
    this.embeddingFunction = new OllamaEmbeddingFunction({
      url: config?.ollama?.url ?? process.env.OLLAMA_URL ?? 'http://localhost:11434',
      model: config?.ollama?.embeddingModel ?? 'bge-m3',
    });
  }

  async onModuleInit() {
    if (this.managed) {
      await this.startServer();
    } else {
      await this.waitForServer();
    }
  }

  async onModuleDestroy() {
    await this.stopServer();
  }

  private async startServer(): Promise<void> {
    const chromadbDir = path.join(process.cwd(), 'node_modules', 'chromadb');
    const chromaCliPath = path.join(chromadbDir, 'dist', 'cli.mjs');

    this.serverProcess = spawn(
      process.execPath,
      [chromaCliPath, 'run', '--path', this.dataPath, '--port', String(this.chromaPort)],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: false,
        cwd: chromadbDir,
      },
    );

    let stderr = '';
    this.serverProcess.stderr?.on('data', (data) => {
      stderr += data.toString();
    });

    this.serverProcess.on('error', (err) => {
      throw new Error(`Failed to start ChromaDB: ${err.message}`);
    });

    this.serverProcess.on('exit', (code) => {
      if (code !== null && code !== 0 && this.serverProcess && !this.serverProcess.killed) {
        console.error(`ChromaDB exited with code ${code}: ${stderr}`);
      }
    });

    await this.waitForServer();
  }

  private async waitForServer(maxAttempts = 30): Promise<void> {
    for (let i = 0; i < maxAttempts; i++) {
      try {
        await this.client.heartbeat();
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    throw new Error(
      'ChromaDB failed to start. Ensure chromadb-js-bindings is installed for your platform.',
    );
  }

  private async stopServer(): Promise<void> {
    if (this.serverProcess) {
      this.serverProcess.kill('SIGTERM');
      this.serverProcess = null;
    }
  }

  getClient(): ChromaClient {
    return this.client;
  }

  getEmbeddingFunction(): OllamaEmbeddingFunction {
    return this.embeddingFunction;
  }

  async getCollection(name: string) {
    return this.client.getOrCreateCollection({
      name,
      embeddingFunction: this.embeddingFunction,
    });
  }

  async upsertDocument(
    collectionName: string,
    id: string,
    document: string,
    metadata: Record<string, string | number | boolean>,
  ): Promise<void> {
    const col = await this.getCollection(collectionName);
    await col.upsert({
      ids: [id],
      documents: [document],
      metadatas: [metadata],
    });
  }

  async queryCollection(
    collectionName: string,
    queryText: string,
    nResults = 10,
    where?: any,
  ) {
    const col = await this.getCollection(collectionName);
    return col.query({
      queryTexts: [queryText],
      nResults,
      ...(where ? { where } : {}),
      include: ['documents', 'metadatas', 'distances'],
    });
  }

  async getByIds(collectionName: string, ids: string[]) {
    const col = await this.getCollection(collectionName);
    return col.get({
      ids,
      include: ['documents', 'metadatas'],
    });
  }

  async getByFilter(
    collectionName: string,
    where: any,
    limit?: number,
  ) {
    const col = await this.getCollection(collectionName);
    return col.get({
      where,
      ...(limit ? { limit } : {}),
      include: ['documents', 'metadatas'],
    });
  }

  async deleteDocument(collectionName: string, id: string): Promise<void> {
    const col = await this.getCollection(collectionName);
    await col.delete({ ids: [id] });
  }
}
