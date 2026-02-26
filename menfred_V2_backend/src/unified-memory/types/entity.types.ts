export type EntityType =
  | 'person'
  | 'place'
  | 'thing'
  | 'concept'
  | 'organization';

export interface EntityNode {
  chromaId: string;
  canonicalName: string;
  aliases: string[];
  entityType: EntityType;
  description: string;
  createdAt: string;
  updatedAt: string;
  valence?: number;
  arousal?: number;
  familiarity?: number;
  safety?: number;
}

export interface CreateEntityDto {
  canonicalName: string;
  aliases?: string[];
  entityType: EntityType;
  description: string;
  origin?: 'stated' | 'inferred';
}

export interface RelationshipData {
  chromaId: string;
  relationType: string;
  description: string;
  confidence: number;
  createdAt: string;
  updatedAt: string;
}

export interface CreateRelationshipDto {
  sourceChromaId: string;
  targetChromaId: string;
  relationType: string;
  description: string;
  confidence?: number;
}

export interface ParticipationData {
  chromaId: string;
  role: string;
  description: string;
}
