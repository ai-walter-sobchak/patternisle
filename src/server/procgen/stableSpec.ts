import { createHash } from "node:crypto";
import type { MapSpecV1 } from "./spec";

/** Stable JSON: sort object keys so serialization is deterministic. */
export function stableStringify(obj: unknown): string {
  if (obj === null || typeof obj !== "object") {
    return JSON.stringify(obj);
  }
  if (Array.isArray(obj)) {
    return "[" + obj.map(stableStringify).join(",") + "]";
  }
  const keys = Object.keys(obj).sort();
  const pairs = keys.map((k) => JSON.stringify(k) + ":" + stableStringify((obj as Record<string, unknown>)[k]));
  return "{" + pairs.join(",") + "}";
}

export function specHash(spec: MapSpecV1): string {
  return createHash("sha256").update(stableStringify(spec), "utf8").digest("hex");
}
