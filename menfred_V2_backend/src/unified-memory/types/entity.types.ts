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
}

export interface CreateEntityDto {
  canonicalName: string;
  aliases?: string[];
  entityType: EntityType;
  description: string;
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
