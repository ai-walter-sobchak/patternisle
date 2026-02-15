export type Vec2 = { x: number; y: number };
export type Rect = { x: number; y: number; w: number; h: number };

export type SpawnZone = {
  teamId: 0 | 1 | 2 | 3;
  rect: Rect;
  facingDeg: number;
};

export type ObjectiveZone = { center: Vec2; radius: number };

export type WallSegment = {
  a: Vec2;
  b: Vec2;
  thickness: number;
  // Optional metadata for debugging/tuning
  tag?: "ring" | "spoke" | "perimeter";
};

export type Cover = {
  center: Vec2;
  radius: number;
  kind: "pillar" | "crate" | "lowwall";
};

export type MapSpecV1 = {
  v: 1;
  seed: string;
  size: number;
  center: Vec2;

  rings: 3;
  // Radii for rings (outer -> inner). outerRadii[0] is outer boundary ring radius.
  ringRadii: [number, number, number];

  // Lane structure
  segments: number; // ring segmentation count
  spokes: number;   // number of spoke lanes

  spawnZones: SpawnZone[];
  objective: ObjectiveZone;

  wallSegments: WallSegment[];
  cover: Cover[];
};
