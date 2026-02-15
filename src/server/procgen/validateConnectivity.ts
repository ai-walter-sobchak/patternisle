import { MapSpecV1 } from "./spec";
import { bakeGridFromSpec, toCell } from "./gridBake";

// NOTE: cellSize=1 is required for accurate BFS connectivity; larger cells can alias gates shut.

/** Fixed cell size for connectivity validation. Do not increase for "perf" — it causes false failures. */
const CONNECTIVITY_CELL_SIZE = 1 as const;

function idx(x: number, y: number, n: number) {
  return y * n + x;
}

export function validateConnectivity(spec: MapSpecV1): { ok: true } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const g = bakeGridFromSpec(spec, CONNECTIVITY_CELL_SIZE);

  const target = toCell(g, spec.objective.center);

  const neighbors = [
    { x: 1, y: 0 }, { x: -1, y: 0 },
    { x: 0, y: 1 }, { x: 0, y: -1 },
  ];

  function runBFS(startX: number, startY: number): boolean {
    const seen = new Uint8Array(g.size * g.size);
    const qx = new Int32Array(g.size * g.size);
    const qy = new Int32Array(g.size * g.size);
    let qh = 0, qt = 0;

    const push = (x: number, y: number) => {
      const i = idx(x, y, g.size);
      if (seen[i]) return;
      if (g.blocked[i]) return;
      seen[i] = 1;
      qx[qt] = x;
      qy[qt] = y;
      qt++;
    };

    push(startX, startY);

    while (qh < qt) {
      const x = qx[qh];
      const y = qy[qh];
      qh++;

      if (x === target.x && y === target.y) return true;

      for (const d of neighbors) {
        const nx = x + d.x;
        const ny = y + d.y;
        if (nx < 0 || ny < 0 || nx >= g.size || ny >= g.size) continue;
        push(nx, ny);
      }
    }
    return false;
  }

  for (const s of spec.spawnZones) {
    const sc = toCell(g, { x: s.rect.x + s.rect.w / 2, y: s.rect.y + s.rect.h / 2 });

    // If spawn center is blocked (rasterization), try 3x3 around it
    let found = false;
    for (let dy = -1; dy <= 1 && !found; dy++) {
      for (let dx = -1; dx <= 1 && !found; dx++) {
        const nx = sc.x + dx;
        const ny = sc.y + dy;
        if (nx < 0 || ny < 0 || nx >= g.size || ny >= g.size) continue;
        if (g.blocked[idx(nx, ny, g.size)]) continue;
        found = runBFS(nx, ny);
      }
    }

    if (!found) errors.push(`team ${s.teamId} spawn cannot reach objective (cellSize=${CONNECTIVITY_CELL_SIZE})`);
  }

  return errors.length ? { ok: false, errors } : { ok: true };
}
