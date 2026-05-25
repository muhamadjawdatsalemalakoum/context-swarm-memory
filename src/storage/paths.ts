import { resolve, join } from "node:path";

export interface CsmPaths {
  root: string;
  data: string;
  directoryFile: string;
  shardsDir: string;
  chronicleFile: string;
  queryRunsFile: string;
}

export function getPaths(rootDir: string = process.env.CSM_HOME ?? process.cwd()): CsmPaths {
  const root = resolve(rootDir);
  const data = join(root, "data");
  return {
    root,
    data,
    directoryFile: join(data, "directory.json"),
    shardsDir: join(data, "shards"),
    chronicleFile: join(data, "chronicle.jsonl"),
    queryRunsFile: join(data, "query-runs.jsonl"),
  };
}

export function shardDir(paths: CsmPaths, shardId: string): string {
  return join(paths.shardsDir, shardId);
}

export function shardManifestPath(paths: CsmPaths, shardId: string): string {
  return join(shardDir(paths, shardId), "manifest.json");
}

export function snapshotPath(paths: CsmPaths, shardId: string, snapshotId: string): string {
  return join(shardDir(paths, shardId), "snapshots", `${snapshotId}.json`);
}

export function snapshotsDir(paths: CsmPaths, shardId: string): string {
  return join(shardDir(paths, shardId), "snapshots");
}
