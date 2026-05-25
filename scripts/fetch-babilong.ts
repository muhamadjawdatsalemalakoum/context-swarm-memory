#!/usr/bin/env tsx
/**
 * Fetch BABILong rows from Hugging Face as JSONL.
 *
 * The original integration expected parquet files. That made the public path
 * fragile because fresh clones would need an extra parquet reader. Hugging
 * Face's dataset-server exposes the same rows as JSON, so this script writes
 * the loader's native JSONL format directly:
 *
 *   data/eval/corpus-babilong/raw/task<N>_<length>.jsonl
 *
 * The default is a 30-row public subset per (task, length) cell. Use
 * `--rows all` to pull every available row for a full local study.
 */

import { existsSync } from "node:fs";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const LENGTH_LABELS = [
  "0K",
  "4K",
  "8K",
  "32K",
  "128K",
  "256K",
  "1M",
] as const;
type LengthLabel = (typeof LENGTH_LABELS)[number];

const TASK_IDS = [1, 2, 3] as const;
type TaskId = (typeof TASK_IDS)[number];

interface CliArgs {
  tasks: TaskId[];
  lengths: LengthLabel[];
  rows: number;
  force: boolean;
}

interface DownloadResult {
  task: TaskId;
  length: LengthLabel;
  url: string;
  localPath?: string;
  bytes: number;
  status: "downloaded" | "skipped" | "failed";
  rows: number;
  error?: string;
}

function parseArgs(argv: string[]): CliArgs {
  let tasks: TaskId[] = [...TASK_IDS];
  let lengths: LengthLabel[] = [...LENGTH_LABELS];
  let rows = 30;
  let force = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const next = argv[i + 1];
    if (a === "--tasks" && next) {
      const parsed = next.split(",").map((s) => Number.parseInt(s.trim(), 10));
      for (const t of parsed) {
        if (!TASK_IDS.includes(t as TaskId)) {
          throw new Error(`Unknown task ${t}; supported: ${TASK_IDS.join(", ")}`);
        }
      }
      tasks = parsed as TaskId[];
      i++;
    } else if (a === "--lengths" && next) {
      const parsed = next.split(",").map((s) => s.trim().toUpperCase());
      for (const l of parsed) {
        if (!LENGTH_LABELS.includes(l as LengthLabel)) {
          throw new Error(
            `Unknown length "${l}"; supported: ${LENGTH_LABELS.join(", ")}`,
          );
        }
      }
      lengths = parsed as LengthLabel[];
      i++;
    } else if (a === "--rows" && next) {
      const raw = next.trim().toLowerCase();
      rows = raw === "all" ? Number.POSITIVE_INFINITY : Number.parseInt(raw, 10);
      if (raw !== "all" && (!Number.isFinite(rows) || rows <= 0)) {
        throw new Error(`Invalid --rows value "${next}". Use a positive integer or "all".`);
      }
      i++;
    } else if (a === "--force") {
      force = true;
    } else if (a === "--help" || a === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown arg: ${a}. Use --help for usage.`);
    }
  }

  return { tasks, lengths, rows, force };
}

function printHelp(): void {
  process.stdout.write(
    [
      "Usage: npx tsx scripts/fetch-babilong.ts [--tasks 1,2,3] [--lengths 0K,4K,8K,32K,128K,256K,1M] [--rows 30|all] [--force]",
      "",
      "Fetches BABILong rows from Hugging Face dataset-server as JSONL.",
      "",
      `Default tasks:   ${TASK_IDS.join(",")}`,
      `Default lengths: ${LENGTH_LABELS.join(",")}`,
      "Default rows:    30 per (task, length) cell",
      "",
      "Output: data/eval/corpus-babilong/raw/task<N>_<length>.jsonl",
      "",
    ].join("\n"),
  );
}

function localPathFor(task: TaskId, length: LengthLabel): string {
  return resolve(
    process.cwd(),
    "data",
    "eval",
    "corpus-babilong",
    "raw",
    `task${task}_${length}.jsonl`,
  );
}

function rowsUrlFor(
  task: TaskId,
  length: LengthLabel,
  offset: number,
  rows: number,
): string {
  const params = new URLSearchParams({
    dataset: "RMT-team/babilong-1k-samples",
    config: length.toLowerCase(),
    split: `qa${task}`,
    offset: String(offset),
    length: String(rows),
  });
  return `https://datasets-server.huggingface.co/rows?${params.toString()}`;
}

async function downloadOne(
  task: TaskId,
  length: LengthLabel,
  rowLimit: number,
  force: boolean,
): Promise<DownloadResult> {
  const localPath = localPathFor(task, length);
  const firstUrl = rowsUrlFor(task, length, 0, Number.isFinite(rowLimit) ? Math.min(rowLimit, 100) : 100);

  if (!force && existsSync(localPath)) {
    const s = await stat(localPath);
    return {
      task,
      length,
      url: firstUrl,
      localPath,
      bytes: s.size,
      status: "skipped",
      rows: await countJsonlRows(localPath),
    };
  }

  await mkdir(dirname(localPath), { recursive: true });

  const outRows: unknown[] = [];
  const pageSize = 100;
  for (let offset = 0; offset < rowLimit; offset += pageSize) {
    const wanted = Number.isFinite(rowLimit)
      ? Math.min(pageSize, rowLimit - offset)
      : pageSize;
    const url = rowsUrlFor(task, length, offset, wanted);

    let response: Response;
    try {
      response = await fetch(url);
    } catch (err) {
      return {
        task,
        length,
        url,
        bytes: 0,
        status: "failed",
        rows: 0,
        error: `fetch threw: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    if (!response.ok) {
      return {
        task,
        length,
        url,
        bytes: 0,
        status: "failed",
        rows: 0,
        error: `HTTP ${response.status} ${response.statusText}`,
      };
    }

    const body = (await response.json()) as {
      rows?: Array<{ row?: unknown }>;
      error?: string;
    };
    if (body.error) {
      return {
        task,
        length,
        url,
        bytes: 0,
        status: "failed",
        rows: 0,
        error: body.error,
      };
    }

    const pageRows = body.rows ?? [];
    for (const item of pageRows) {
      if (item.row) outRows.push(item.row);
    }
    if (pageRows.length < wanted) break;
  }

  if (outRows.length === 0) {
    return {
      task,
      length,
      url: firstUrl,
      bytes: 0,
      status: "failed",
      rows: 0,
      error: "dataset-server returned zero rows",
    };
  }

  const text = `${outRows.map((row) => JSON.stringify(row)).join("\n")}\n`;
  await writeFile(localPath, text, "utf8");
  return {
    task,
    length,
    url: firstUrl,
    localPath,
    bytes: Buffer.byteLength(text),
    status: "downloaded",
    rows: outRows.length,
  };
}

async function countJsonlRows(path: string): Promise<number> {
  const text = await import("node:fs/promises").then((m) => m.readFile(path, "utf8"));
  return text.split(/\r?\n/).filter((line) => line.trim().length > 0).length;
}

async function main(): Promise<void> {
  let args: CliArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(
      `Argument error: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(2);
  }

  process.stdout.write(
    `Fetching BABILong: ${args.tasks.length} tasks x ${args.lengths.length} lengths\n` +
      `Tasks:   ${args.tasks.map((t) => `qa${t}`).join(", ")}\n` +
      `Lengths: ${args.lengths.join(", ")}\n` +
      `Rows:    ${Number.isFinite(args.rows) ? args.rows : "all"} per cell\n\n`,
  );

  const results: DownloadResult[] = [];
  for (const length of args.lengths) {
    for (const task of args.tasks) {
      const r = await downloadOne(task, length, args.rows, args.force);
      results.push(r);
      const tag = `qa${task}/${length}`.padEnd(10);
      if (r.status === "failed") {
        process.stdout.write(`  [FAIL] ${tag}  ${r.error}  ${r.url}\n`);
      } else {
        const mb = (r.bytes / (1024 * 1024)).toFixed(2);
        const verb = r.status === "skipped" ? "skip" : "OK";
        process.stdout.write(
          `  [${verb.padEnd(4)}] ${tag}  rows=${r.rows}  ${mb} MB  ${r.localPath}\n`,
        );
      }
    }
  }

  const downloaded = results.filter((r) => r.status === "downloaded").length;
  const skipped = results.filter((r) => r.status === "skipped").length;
  const failed = results.filter((r) => r.status === "failed").length;
  const totalMb = (results.reduce((s, r) => s + r.bytes, 0) / (1024 * 1024)).toFixed(2);
  process.stdout.write(
    `\nDone. ${downloaded} downloaded, ${skipped} skipped, ${failed} failed. Total on disk: ${totalMb} MB.\n`,
  );
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  process.stderr.write(
    `fetch-babilong fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
  );
  process.exit(1);
});
