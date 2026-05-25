import { randomBytes } from "node:crypto";

function shortHex(bytes = 4): string {
  return randomBytes(bytes).toString("hex");
}

export function newRunId(): string {
  return `run_${Date.now().toString(36)}_${shortHex(3)}`;
}

export function newChronicleId(): string {
  return `c_${Date.now().toString(36)}_${shortHex(3)}`;
}

export function newEventId(seq?: number): string {
  if (typeof seq === "number") {
    return `e_${seq.toString().padStart(4, "0")}`;
  }
  return `e_${shortHex(4)}`;
}

export function newSnapshotId(seq: number): string {
  return `S${seq.toString().padStart(3, "0")}`;
}

export function nextSnapshotId(currentSnapshotId: string): string {
  // Snapshots in MVP are sequential per shard: S001, S002, ...
  const m = currentSnapshotId.match(/^S(\d+)$/);
  if (!m) return `S001`;
  const next = parseInt(m[1]!, 10) + 1;
  return newSnapshotId(next);
}

export function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

export function newShardId(name: string): string {
  const slug = slugify(name) || "shard";
  return `${slug}-${shortHex(2)}`;
}
