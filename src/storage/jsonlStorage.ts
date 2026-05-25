import { promises as fs } from "node:fs";
import { dirname } from "node:path";
import {
  getPaths,
  shardDir,
  shardManifestPath,
  snapshotPath,
  snapshotsDir,
  type CsmPaths,
} from "./paths.js";
import {
  type ChronicleEvent,
  type MemoryDirectory,
  type MemoryDirectoryEntry,
  type MemoryShardSnapshot,
  type QueryRunRecord,
  type ShardManifest,
} from "../core/types.js";
import { stableStringify } from "../utils/json.js";

/** The minimal set of storage methods the read-only `ask()` pipeline needs.
 *  `JsonlStorage` structurally satisfies this; in-memory adapters (e.g. the
 *  CSM benchmark baseline) implement it without touching disk.
 *
 *  `appendQueryRun` is optional because `ask({ skipQueryLog: true, ... })`
 *  never invokes it — adapters that don't need query-run logging can omit it. */
export interface StorageReader {
  loadDirectory(): Promise<MemoryDirectory>;
  loadSnapshot(shardId: string, snapshotId: string): Promise<MemoryShardSnapshot | null>;
  appendQueryRun?(record: QueryRunRecord): Promise<void>;
}

/** Filesystem-backed storage layer.
 *  All durable mutations live here. The query path uses only the read methods.
 */
export class JsonlStorage implements StorageReader {
  readonly paths: CsmPaths;

  constructor(rootDir?: string) {
    this.paths = getPaths(rootDir);
  }

  // ─── lifecycle ────────────────────────────────────────────────────────────
  async ensureLayout(): Promise<void> {
    await fs.mkdir(this.paths.data, { recursive: true });
    await fs.mkdir(this.paths.shardsDir, { recursive: true });
    await this.ensureFile(this.paths.chronicleFile, "");
    await this.ensureFile(this.paths.queryRunsFile, "");
    if (!(await fileExists(this.paths.directoryFile))) {
      const empty: MemoryDirectory = { version: 1, entries: [] };
      await this.writeJson(this.paths.directoryFile, empty);
    }
  }

  isInitialized(): Promise<boolean> {
    return fileExists(this.paths.directoryFile);
  }

  // ─── directory ────────────────────────────────────────────────────────────
  async loadDirectory(): Promise<MemoryDirectory> {
    if (!(await fileExists(this.paths.directoryFile))) {
      return { version: 1, entries: [] };
    }
    const raw = await fs.readFile(this.paths.directoryFile, "utf8");
    return JSON.parse(raw) as MemoryDirectory;
  }

  async saveDirectory(dir: MemoryDirectory): Promise<void> {
    await this.writeJson(this.paths.directoryFile, dir);
  }

  async upsertDirectoryEntry(entry: MemoryDirectoryEntry): Promise<void> {
    const dir = await this.loadDirectory();
    const ix = dir.entries.findIndex((e) => e.id === entry.id);
    if (ix === -1) dir.entries.push(entry);
    else dir.entries[ix] = entry;
    await this.saveDirectory(dir);
  }

  // ─── shard manifest + snapshots ───────────────────────────────────────────
  async ensureShardDir(shardId: string): Promise<void> {
    await fs.mkdir(snapshotsDir(this.paths, shardId), { recursive: true });
  }

  async loadManifest(shardId: string): Promise<ShardManifest | null> {
    const p = shardManifestPath(this.paths, shardId);
    if (!(await fileExists(p))) return null;
    const raw = await fs.readFile(p, "utf8");
    return JSON.parse(raw) as ShardManifest;
  }

  async saveManifest(manifest: ShardManifest): Promise<void> {
    await this.ensureShardDir(manifest.id);
    await this.writeJson(shardManifestPath(this.paths, manifest.id), manifest);
  }

  async loadSnapshot(shardId: string, snapshotId: string): Promise<MemoryShardSnapshot | null> {
    const p = snapshotPath(this.paths, shardId, snapshotId);
    if (!(await fileExists(p))) return null;
    const raw = await fs.readFile(p, "utf8");
    return JSON.parse(raw) as MemoryShardSnapshot;
  }

  /** Snapshots are immutable. Refuse to overwrite an existing snapshot file. */
  async writeSnapshot(snapshot: MemoryShardSnapshot): Promise<void> {
    await this.ensureShardDir(snapshot.shardId);
    const p = snapshotPath(this.paths, snapshot.shardId, snapshot.snapshotId);
    if (await fileExists(p)) {
      throw new Error(
        `Refusing to overwrite immutable snapshot ${snapshot.shardId}/${snapshot.snapshotId}`,
      );
    }
    await fs.writeFile(p, stableStringify(snapshot), "utf8");
  }

  async listSnapshotIds(shardId: string): Promise<string[]> {
    const dir = snapshotsDir(this.paths, shardId);
    if (!(await fileExists(dir))) return [];
    const files = await fs.readdir(dir);
    return files
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.replace(/\.json$/, ""))
      .sort();
  }

  // ─── chronicle ────────────────────────────────────────────────────────────
  async appendChronicle(event: ChronicleEvent): Promise<void> {
    await fs.appendFile(this.paths.chronicleFile, JSON.stringify(event) + "\n", "utf8");
  }

  async readChronicle(): Promise<ChronicleEvent[]> {
    return readJsonl<ChronicleEvent>(this.paths.chronicleFile);
  }

  // ─── query runs (read-only metadata log) ──────────────────────────────────
  async appendQueryRun(record: QueryRunRecord): Promise<void> {
    await fs.appendFile(this.paths.queryRunsFile, JSON.stringify(record) + "\n", "utf8");
  }

  async readQueryRuns(): Promise<QueryRunRecord[]> {
    return readJsonl<QueryRunRecord>(this.paths.queryRunsFile);
  }

  // ─── shard listing ────────────────────────────────────────────────────────
  async listShardIds(): Promise<string[]> {
    if (!(await fileExists(this.paths.shardsDir))) return [];
    const entries = await fs.readdir(this.paths.shardsDir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  }

  shardDirPath(shardId: string): string {
    return shardDir(this.paths, shardId);
  }

  // ─── helpers ──────────────────────────────────────────────────────────────
  private async writeJson(path: string, value: unknown): Promise<void> {
    await fs.mkdir(dirname(path), { recursive: true });
    await fs.writeFile(path, stableStringify(value), "utf8");
  }

  private async ensureFile(path: string, contents: string): Promise<void> {
    if (!(await fileExists(path))) {
      await fs.mkdir(dirname(path), { recursive: true });
      await fs.writeFile(path, contents, "utf8");
    }
  }
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function readJsonl<T>(path: string): Promise<T[]> {
  if (!(await fileExists(path))) return [];
  const raw = await fs.readFile(path, "utf8");
  if (!raw.trim()) return [];
  return raw
    .split(/\r?\n/)
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as T);
}
