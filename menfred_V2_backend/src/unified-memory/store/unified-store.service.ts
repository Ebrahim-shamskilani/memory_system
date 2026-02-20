import { Injectable, Logger } from '@nestjs/common';
import { EntityStoreService } from './entity-store.service';
import { RelationshipStoreService } from './relationship-store.service';
import { EpisodeStoreService } from './episode-store.service';
import { CreateEntityDto } from '../types/entity.types';
import { CreateRelationshipDto } from '../types/entity.types';
import { CreateEpisodeDto, CreateFactDto } from '../types/episode.types';
import { DualWriteResult } from '../types/memory.types';

@Injectable()
export class UnifiedStoreService {
  private readonly logger = new Logger(UnifiedStoreService.name);

  constructor(
    private readonly entityStore: EntityStoreService,
    private readonly relationshipStore: RelationshipStoreService,
    private readonly episodeStore: EpisodeStoreService,
  ) {}

  async createEntity(dto: CreateEntityDto): Promise<DualWriteResult> {
    this.logger.log(`Creating entity: ${dto.canonicalName}`);
    return this.entityStore.create(dto);
  }

  async createRelationship(dto: CreateRelationshipDto): Promise<DualWriteResult> {
    this.logger.log(`Creating relationship: ${dto.relationType}`);
    return this.relationshipStore.create(dto);
  }

  async createEpisode(dto: CreateEpisodeDto): Promise<DualWriteResult> {
    this.logger.log(`Creating episode: ${dto.title}`);
    return this.episodeStore.createEpisode(dto);
  }

  async createFact(dto: CreateFactDto): Promise<DualWriteResult> {
    this.logger.log(`Creating fact: ${dto.content.substring(0, 50)}...`);
    return this.episodeStore.createFact(dto);
  }

  async linkEntityToFact(
    entityChromaId: string,
    factChromaId: string,
    description: string,
  ): Promise<void> {
    return this.episodeStore.linkEntityToFact(entityChromaId, factChromaId, description);
  }

  async linkEntityToEpisode(
    entityChromaId: string,
    episodeChromaId: string,
    role: string,
    description: string,
  ): Promise<void> {
    return this.episodeStore.linkEntityToEpisode(
      entityChromaId,
      episodeChromaId,
      role,
      description,
    );
  }

  async linkEpisodeTemporally(
    previousChromaId: string,
    nextChromaId: string,
  ): Promise<void> {
    return this.episodeStore.linkEpisodeTemporally(previousChromaId, nextChromaId);
  }

  // ── New episode/fact linking delegations ──

  async linkEpisodeDerived(derivedChromaId: string, sourceChromaId: string): Promise<void> {
    return this.episodeStore.linkEpisodeDerived(derivedChromaId, sourceChromaId);
  }

  async linkEpisodeSummarizedBy(summaryChromaId: string, sourceChromaIds: string[]): Promise<void> {
    return this.episodeStore.linkEpisodeSummarizedBy(summaryChromaId, sourceChromaIds);
  }

  async linkEpisodePatternOf(patternChromaId: string, sourceChromaIds: string[]): Promise<void> {
    return this.episodeStore.linkEpisodePatternOf(patternChromaId, sourceChromaIds);
  }

  async linkFactYieldedBy(factChromaId: string, episodeChromaId: string): Promise<void> {
    return this.episodeStore.linkFactYieldedBy(factChromaId, episodeChromaId);
  }

  async linkFactSupersedes(newFactChromaId: string, oldFactChromaIds: string[]): Promise<void> {
    return this.episodeStore.linkFactSupersedes(newFactChromaId, oldFactChromaIds);
  }

  // ── New query delegations ──

  async getUnconsolidatedLevel3Episodes(limit?: number) {
    return this.episodeStore.getUnconsolidatedLevel3Episodes(limit);
  }

  async getUnpatternedLevel2Episodes(limit?: number) {
    return this.episodeStore.getUnpatternedLevel2Episodes(limit);
  }

  async getEntityFactsWithTimestamps(entityChromaId: string) {
    return this.episodeStore.getEntityFactsWithTimestamps(entityChromaId);
  }

  getEntityStore(): EntityStoreService {
    return this.entityStore;
  }

  getRelationshipStore(): RelationshipStoreService {
    return this.relationshipStore;
  }

  getEpisodeStore(): EpisodeStoreService {
    return this.episodeStore;
  }
}
