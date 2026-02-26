import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { GraphDbService } from '../../graph-db/graph-db.service';
import { EmbeddingService } from '../retrieve/embedding.service';
import { EntityStoreService } from '../store/entity-store.service';
import {
  EmotionalProfile,
  CoreDrives,
  GutFeeling,
  UnconsciousSnapshot,
} from '../types/unconscious.types';

const EMA_ALPHA = 0.15;
const DRIVE_DECAY_RATE = 0.05;
const DRIVE_BASELINE = 0.5;
const FAMILIARITY_SIGNAL = 0.3;

const POSITIVE_ANCHOR_TEXT = 'good happy love enjoy beautiful pleasant warm kind helpful';
const NEGATIVE_ANCHOR_TEXT = 'bad sad hate suffer ugly unpleasant cold cruel harmful';

const DEFAULT_PROFILE: EmotionalProfile = {
  valence: 0,
  arousal: 0.5,
  familiarity: 0,
  safety: 0.5,
};

@Injectable()
export class UnconsciousService implements OnModuleInit {
  private readonly logger = new Logger(UnconsciousService.name);

  private positiveAnchor: number[] | null = null;
  private negativeAnchor: number[] | null = null;

  constructor(
    private readonly graphDb: GraphDbService,
    private readonly embedding: EmbeddingService,
    private readonly entityStore: EntityStoreService,
  ) {}

  async onModuleInit() {
    try {
      const [pos, neg] = await this.embedding.embedBatch([
        POSITIVE_ANCHOR_TEXT,
        NEGATIVE_ANCHOR_TEXT,
      ]);
      this.positiveAnchor = pos;
      this.negativeAnchor = neg;
      this.logger.log('Anchor embeddings computed (positive/negative)');
    } catch (err) {
      this.logger.error(`Failed to compute anchor embeddings: ${(err as Error).message}`);
    }

    await this.ensureDrivesNode();
  }

  // --- Public methods ---

  async recordEntityMention(entityChromaId: string, contextText: string): Promise<void> {
    const current = await this.getEntityFeeling(entityChromaId);
    const profile = current ?? { ...DEFAULT_PROFILE };

    // Familiarity: always bumps up
    profile.familiarity = this.ema(profile.familiarity, FAMILIARITY_SIGNAL, EMA_ALPHA);

    // Valence: embedding-based sentiment signal
    const valenceSignal = await this.computeValenceSignal(contextText);
    profile.valence = this.ema(profile.valence, valenceSignal, EMA_ALPHA);

    // Arousal: based on how different this context is from what we'd expect
    // Higher familiarity + novel context = higher arousal signal
    const arousalSignal = this.clamp(1.0 - profile.familiarity, 0, 1);
    profile.arousal = this.ema(profile.arousal, arousalSignal, EMA_ALPHA);

    // Clamp all values
    profile.valence = this.clamp(profile.valence, -1, 1);
    profile.arousal = this.clamp(profile.arousal, 0, 1);
    profile.familiarity = this.clamp(profile.familiarity, 0, 1);
    profile.safety = this.clamp(profile.safety, 0, 1);

    await this.entityStore.updateEmotionalProfile(entityChromaId, profile);
  }

  async recordInteraction(entityChromaIds: string[], isPositive: boolean): Promise<void> {
    const valenceNudge = isPositive ? 0.2 : -0.2;

    for (const chromaId of entityChromaIds) {
      const current = await this.getEntityFeeling(chromaId);
      const profile = current ?? { ...DEFAULT_PROFILE };

      profile.valence = this.ema(profile.valence, valenceNudge, EMA_ALPHA);
      profile.valence = this.clamp(profile.valence, -1, 1);

      await this.entityStore.updateEmotionalProfile(chromaId, profile);
    }
  }

  async tickDrives(): Promise<void> {
    const drives = await this.getDrives();

    drives.novelty += DRIVE_DECAY_RATE * (DRIVE_BASELINE - drives.novelty);
    drives.comfort += DRIVE_DECAY_RATE * (DRIVE_BASELINE - drives.comfort);
    drives.connection += DRIVE_DECAY_RATE * (DRIVE_BASELINE - drives.connection);
    drives.significance += DRIVE_DECAY_RATE * (DRIVE_BASELINE - drives.significance);

    drives.novelty = this.clamp(drives.novelty, 0, 1);
    drives.comfort = this.clamp(drives.comfort, 0, 1);
    drives.connection = this.clamp(drives.connection, 0, 1);
    drives.significance = this.clamp(drives.significance, 0, 1);

    await this.graphDb.runQuery(
      `MATCH (d:UnconsciousDrives {id: 'singleton'})
       SET d.novelty = $novelty, d.comfort = $comfort,
           d.connection = $connection, d.significance = $significance,
           d.updatedAt = datetime()`,
      { ...drives },
    );
  }

  async satisfyDrive(drive: keyof CoreDrives, amount: number): Promise<void> {
    const drives = await this.getDrives();
    drives[drive] = this.clamp(drives[drive] - amount, 0, 1);

    await this.graphDb.runQuery(
      `MATCH (d:UnconsciousDrives {id: 'singleton'})
       SET d.${drive} = $value, d.updatedAt = datetime()`,
      { value: drives[drive] },
    );
  }

  async getEntityFeeling(entityChromaId: string): Promise<EmotionalProfile | null> {
    const result = await this.graphDb.runQuery(
      `MATCH (e:Entity {chromaId: $chromaId})
       RETURN e.valence AS valence, e.arousal AS arousal,
              e.familiarity AS familiarity, e.safety AS safety`,
      { chromaId: entityChromaId },
    );

    if (result.records.length === 0) return null;

    const rec = result.records[0] as any;
    // If emotional data hasn't been set yet, return null
    if (rec.valence == null && rec.familiarity == null) return null;

    return {
      valence: rec.valence ?? 0,
      arousal: rec.arousal ?? 0.5,
      familiarity: rec.familiarity ?? 0,
      safety: rec.safety ?? 0.5,
    };
  }

  async getSnapshot(topN = 3): Promise<UnconsciousSnapshot> {
    const drives = await this.getDrives();

    // Get entities with emotional data, sorted by absolute pull
    const result = await this.graphDb.runQuery(
      `MATCH (e:Entity)
       WHERE e.valence IS NOT NULL
       RETURN e.chromaId AS chromaId, e.canonicalName AS name,
              e.valence AS valence, e.arousal AS arousal,
              e.familiarity AS familiarity, e.safety AS safety
       ORDER BY abs(e.valence) * e.arousal DESC
       LIMIT $limit`,
      { limit: topN * 2 },
    );

    const feelings: GutFeeling[] = (result.records as any[]).map((rec) => {
      const pull = this.computePull(
        rec.valence ?? 0,
        rec.arousal ?? 0.5,
        rec.familiarity ?? 0,
        drives,
      );
      return {
        entityChromaId: rec.chromaId,
        entityName: rec.name,
        valence: rec.valence ?? 0,
        arousal: rec.arousal ?? 0.5,
        familiarity: rec.familiarity ?? 0,
        safety: rec.safety ?? 0.5,
        pull,
      };
    });

    // Sort by absolute pull and take top N
    feelings.sort((a, b) => Math.abs(b.pull) - Math.abs(a.pull));
    const topFeelings = feelings.slice(0, topN);

    return { drives, topFeelings };
  }

  async getEmotionalSeedBias(entityChromaIds: string[]): Promise<Map<string, number>> {
    const biases = new Map<string, number>();
    if (entityChromaIds.length === 0) return biases;

    const drives = await this.getDrives();

    for (const chromaId of entityChromaIds) {
      const feeling = await this.getEntityFeeling(chromaId);
      if (!feeling) {
        biases.set(chromaId, 0.5); // neutral default
        continue;
      }

      // Weight combines: arousal, drive alignment, valence intensity
      const valenceIntensity = Math.abs(feeling.valence);
      const noveltyAlignment = drives.novelty * (1 - feeling.familiarity);
      const comfortAlignment = drives.comfort * feeling.familiarity;
      const driveAlign = Math.max(noveltyAlignment, comfortAlignment);

      const weight = this.clamp(
        0.3 + 0.3 * feeling.arousal + 0.2 * driveAlign + 0.2 * valenceIntensity,
        0,
        1,
      );
      biases.set(chromaId, weight);
    }

    return biases;
  }

  formatGutFeelings(snapshot: UnconsciousSnapshot): string {
    if (snapshot.topFeelings.length === 0) return '';

    const lines = snapshot.topFeelings.map((f) => {
      const valenceWord = f.valence > 0.2 ? 'positive' : f.valence < -0.2 ? 'negative' : 'neutral';
      const familiarityWord = f.familiarity > 0.5 ? 'familiar' : 'unfamiliar';
      const arousalWord = f.arousal > 0.6 ? 'intense' : 'calm';
      const safetyWord = f.safety < 0.3 ? 'low safety' : '';

      const descriptors = [valenceWord, familiarityWord, arousalWord, safetyWord].filter(Boolean).join(', ');

      if (f.valence > 0.2) {
        return `- I have a warm feeling about ${f.entityName} (${descriptors})`;
      } else if (f.valence < -0.2) {
        return `- Something about ${f.entityName} makes me uneasy (${descriptors})`;
      } else {
        return `- ${f.entityName} is on my mind (${descriptors})`;
      }
    });

    return lines.join('\n');
  }

  // --- Private methods ---

  private async ensureDrivesNode(): Promise<void> {
    try {
      await this.graphDb.runQuery(
        `MERGE (d:UnconsciousDrives {id: 'singleton'})
         ON CREATE SET d.novelty = 0.5, d.comfort = 0.5,
                       d.connection = 0.5, d.significance = 0.5,
                       d.createdAt = datetime(), d.updatedAt = datetime()`,
      );
      this.logger.log('UnconsciousDrives singleton ensured');
    } catch (err) {
      this.logger.error(`Failed to ensure drives node: ${(err as Error).message}`);
    }
  }

  private async getDrives(): Promise<CoreDrives> {
    const result = await this.graphDb.runQuery(
      `MATCH (d:UnconsciousDrives {id: 'singleton'})
       RETURN d.novelty AS novelty, d.comfort AS comfort,
              d.connection AS connection, d.significance AS significance`,
    );

    if (result.records.length === 0) {
      return { novelty: 0.5, comfort: 0.5, connection: 0.5, significance: 0.5 };
    }

    const rec = result.records[0] as any;
    return {
      novelty: rec.novelty ?? 0.5,
      comfort: rec.comfort ?? 0.5,
      connection: rec.connection ?? 0.5,
      significance: rec.significance ?? 0.5,
    };
  }

  private async computeValenceSignal(text: string): Promise<number> {
    if (!this.positiveAnchor || !this.negativeAnchor) return 0;

    try {
      const textEmbedding = await this.embedding.embed(text);
      const posSim = this.embedding.cosineSimilarity(textEmbedding, this.positiveAnchor);
      const negSim = this.embedding.cosineSimilarity(textEmbedding, this.negativeAnchor);
      return this.clamp(posSim - negSim, -1, 1);
    } catch {
      return 0;
    }
  }

  private computePull(
    valence: number,
    arousal: number,
    familiarity: number,
    drives: CoreDrives,
  ): number {
    // Drive alignment: novelty craves unfamiliar, comfort craves familiar
    const noveltyPull = drives.novelty * (1 - familiarity);
    const comfortPull = drives.comfort * familiarity;
    const driveAlignment = Math.max(noveltyPull, comfortPull, 0.1);

    return valence * arousal * driveAlignment;
  }

  private ema(oldValue: number, signal: number, alpha: number): number {
    return alpha * signal + (1 - alpha) * oldValue;
  }

  private clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
  }
}
