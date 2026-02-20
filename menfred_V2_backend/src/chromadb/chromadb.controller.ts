import {
  Body,
  Controller,
  HttpException,
  HttpStatus,
  Post,
} from '@nestjs/common';
import { OllamaEmbeddingFunction } from '@chroma-core/ollama';
import { randomUUID } from 'node:crypto';
import { ChromadbService } from './chromadb.service';

const DEFAULT_COLLECTION = 'main_docs';

@Controller('chromadb')
export class ChromadbController {
  private readonly embeddingFunction = new OllamaEmbeddingFunction({
    url: process.env.OLLAMA_URL ?? 'http://localhost:11434',
    model: 'bge-m3',
  });

  constructor(private readonly chromadbService: ChromadbService) {}

  @Post('add')
  async add(
    @Body()
    body: {
      collection?: string;
      document: string;
      metadata?: Record<string, string | number | boolean>;
    },
  ) {
    const { collection = DEFAULT_COLLECTION, document, metadata } = body;

    if (!document?.trim()) {
      return { success: false, message: 'document is required' };
    }

    try {
      const id = randomUUID();
      const hasMetadata = Boolean(metadata) && Object.keys(metadata).length > 0;
      const documents = [document.trim()];
      const ids = [id];
      const metadatas = hasMetadata ? [metadata!] : undefined;

      const client = this.chromadbService.getClient();
      const col = await client.getOrCreateCollection({
        name: collection,
        embeddingFunction: this.embeddingFunction,
      });

      await col.add(
        metadatas ? { ids, documents, metadatas } : { ids, documents },
      );
      return { success: true, count: 1, ids };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Failed to add to ChromaDB';
      throw new HttpException(
        { success: false, message },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Post('query')
  async query(
    @Body()
    body: {
      query: string;
      collection?: string;
      nResults?: number;
      filters?: Record<string, string | number | boolean>;
    },
  ) {
    const {
      query,
      collection = DEFAULT_COLLECTION,
      nResults = 10,
      filters,
    } = body;

    if (!query?.trim()) {
      return {
        ids: [],
        documents: [],
        metadatas: [],
        distances: [],
        message: 'Query is required',
      };
    }

    try {
      const where =
        filters && Object.keys(filters).length > 0 ? filters : undefined;

      const client = this.chromadbService.getClient();
      const col = await client.getOrCreateCollection({
        name: collection,
        embeddingFunction: this.embeddingFunction,
      });

      const result = await col.query({
        queryTexts: [query.trim()],
        nResults,
        where,
        include: ['documents', 'metadatas', 'distances'],
      });

      return {
        ids: result.ids,
        documents: result.documents,
        metadatas: result.metadatas,
        distances: result.distances,
      };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Failed to query ChromaDB';
      throw new HttpException(
        { message },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
}
