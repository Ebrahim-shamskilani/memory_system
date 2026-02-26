export interface EmotionalProfile {
  valence: number;       // [-1.0 ... +1.0]
  arousal: number;       // [0.0 ... 1.0]
  familiarity: number;   // [0.0 ... 1.0]
  safety: number;        // [0.0 ... 1.0]
}

export interface CoreDrives {
  novelty: number;       // [0.0 ... 1.0]
  comfort: number;       // [0.0 ... 1.0]
  connection: number;    // [0.0 ... 1.0]
  significance: number;  // [0.0 ... 1.0]
}

export interface GutFeeling {
  entityChromaId: string;
  entityName: string;
  valence: number;
  arousal: number;
  familiarity: number;
  safety: number;
  pull: number;          // computed: how strongly drawn to this entity right now
}

export interface UnconsciousSnapshot {
  drives: CoreDrives;
  topFeelings: GutFeeling[];  // top N entities by |pull|
}
