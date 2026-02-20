import {
  Body,
  Controller,
  Get,
  HttpException,
  HttpStatus,
  Post,
} from '@nestjs/common';
import { GraphDbService } from './graph-db.service';

@Controller('graph-db')
export class GraphDbController {
  constructor(private readonly graphDbService: GraphDbService) {}

  @Get()
  getStatus() {
    return { status: 'ok', module: 'graph-db' };
  }

  @Post('add')
  async add(
    @Body()
    body: {
      cypher: string;
      params?: Record<string, unknown>;
    },
  ) {
    const { cypher, params = {} } = body;

    if (!cypher?.trim()) {
      throw new HttpException(
        { success: false, message: 'cypher is required' },
        HttpStatus.BAD_REQUEST,
      );
    }

    try {
      const result = await this.graphDbService.add(cypher.trim(), params);
      return { success: true, ...result };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Failed to add to Neo4j';
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
      cypher: string;
      params?: Record<string, unknown>;
    },
  ) {
    const { cypher, params = {} } = body;

    if (!cypher?.trim()) {
      throw new HttpException(
        { success: false, message: 'cypher is required' },
        HttpStatus.BAD_REQUEST,
      );
    }

    try {
      const result = await this.graphDbService.query(cypher.trim(), params);
      return { success: true, ...result };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Failed to query Neo4j';
      throw new HttpException(
        { success: false, message },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Post('update')
  async update(
    @Body()
    body: {
      cypher: string;
      params?: Record<string, unknown>;
    },
  ) {
    const { cypher, params = {} } = body;

    if (!cypher?.trim()) {
      throw new HttpException(
        { success: false, message: 'cypher is required' },
        HttpStatus.BAD_REQUEST,
      );
    }

    try {
      const result = await this.graphDbService.update(cypher.trim(), params);
      return { success: true, ...result };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Failed to update Neo4j';
      throw new HttpException(
        { success: false, message },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
}
