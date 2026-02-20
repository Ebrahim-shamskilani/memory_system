import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ChromaClient } from 'chromadb';
import { spawn, type ChildProcess } from 'node:child_process';
import * as path from 'node:path';

const CHROMA_PORT = 8000;
const CHROMA_HOST = 'localhost';

@Injectable()
export class ChromadbService implements OnModuleInit, OnModuleDestroy {
  private client: ChromaClient;
  private serverProcess: ChildProcess | null = null;
  private dataPath: string;

  constructor() {
    this.dataPath =
      process.env.CHROMA_DATA_PATH ??
      path.join(process.cwd(), 'chroma_data');
    this.client = new ChromaClient({
      host: process.env.CHROMA_HOST ?? CHROMA_HOST,
      port: parseInt(process.env.CHROMA_PORT ?? String(CHROMA_PORT), 10),
    });
  }

  async onModuleInit() {
    const manageServer = process.env.CHROMA_MANAGED !== 'false';
    if (manageServer) {
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
      [chromaCliPath, 'run', '--path', this.dataPath, '--port', String(CHROMA_PORT)],
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
}
