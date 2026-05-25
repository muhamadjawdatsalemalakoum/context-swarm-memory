#!/usr/bin/env tsx
/**
 * One-shot fetcher for the BABILong benchmark splits we need for the CSM
 * scaling sweep. Pulls Tasks 1, 2, 3 (single-fact / two-fact / three-fact
 * supporting-facts) at context lengths {0K, 4K, 8K, 32K, 128K, 256K, 1M}
 * directly from Hugging Face's public `resolve` URLs — no auth, no
 * `datasets`-library dependency, no Python.
 *
 * BABILong on HF is published as multiple sibling repos, one per context
 * length, under the `RMT-team` org. The canonical naming pattern is
 * `RMT-team/babilong-<length>-samples`, with files laid out per task at
 * `data/<task>-<split>-NNNNN-of-MMMMM.parquet` (HF's default Datasets-pyarrow
 * sharding). The 0K split (raw bAbI with no haystack) is published as a
 * subconfig of `RMT-team/babilong-1k-samples` per the BABILong paper, so we
 * source it from there. See the per-row mapping in `LENGTH_REPOS` below.
 *
 * The script is idempotent: each downloaded file lives at
 *   data/eval/corpus-babilong/raw/task<N>_<length>.<ext>
 * and is skipped on subsequent runs.
 *
 * IF a URL 404s (e.g. HF restructures the dataset, or the chosen length
 * doesn't have a dedicated repo) the script logs the unreachable file but
 * keeps going — the loader will fail clearly later, and the user can drop
 * a manually-downloaded copy at the same path. See
 * `data/eval/corpus-babilong/README.md` for the expected layout.
 *
 * Usage:
 *   npx tsx scripts/fetch-babilong.ts
 *   npx tsx scripts/fetch-babilong.ts --tasks 1,2 --lengths 0K,4K
 *
 * No network call is made unless this script is executed directly — it's
 * never imported by anything in `src/`.
 */

import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

// --------------------------------------------------------------------------
// Configuration
// --------------------------------------------------------------------------

/**
 * The context lengths we care about for the CSM sweep, in label form.
 * Order matters only for logging; the script downloads in this order.
 *
 * 0K = raw bAbI (no haystack). The BABILong paper treats this as the
 * "no-noise" floor. It's published as a subset of `babilong-1k-samples`
 * upstream (the 0K column of every BABILong results table) — we mirror that.
 */
const LENGTH_LABELS = ["0K", "4K", "8K", "32K", "128K", "256K", "1M"] as const;
type LengthLabel = (typeof LENGTH_LABELS)[number];

/** Tasks we sweep over. BABILong uses `qa<N>` naming upstream. */
const TASK_IDS = [1, 2, 3] as const;
type TaskId = (typeof TASK_IDS)[number];

/**
 * HF repo + parquet path for each (task, length) combination.
 *
 * The HF resolve URL is composed as:
 *   https://huggingface.co/datasets/<repo>/resolve/main/<path>
 *
 * Path convention for the `babilong-<length>-samples` repos (verified by
 * spec, but may drift — re-check at fetch time via the printed URL):
 *
 *   data/<task>-test-00000-of-00001.parquet
 *
 * For 0K we point at the 1K-samples repo's `qa<N>_0k` subset; the BABILong
 * authors keep the no-haystack split inside the 1K bucket.
 */
function repoForLength(length: LengthLabel): string {
  // The 0K (no-haystack) data lives inside the 1K-samples repo.
  const lowered = length === "0K" ? "1k" : length.toLowerCase();
  return `RMT-team/babilong-${lowered}-samples`;
}

/**
 * The path within the repo for a given (task, length). Returns the
 * fully-formed HF resolve URL.
 *
 * Note: we cannot pre-verify the exact `NNNNN-of-MMMMM` shard count
 * without an HF API call. In practice every BABILong split currently
 * ships as a single shard (`00000-of-00001`); if that ever changes we'll
 * see a 404 and the script will log the attempted URL for inspection.
 */
function urlFor(task: TaskId, length: LengthLabel): string {
  const repo = repoForLength(length);
  // The on-repo split label changes for 0K — it's the no-haystack variant
  // of each task. Upstream BABILong publishes this as `qa<N>_0k`. For all
  // other lengths the split label is just the task name (`qa1`, `qa2`, ...)
  // and the length is implicit in the repo.
  const taskSplit = length === "0K" ? `qa${task}_0k` : `qa${task}`;
  const path = `data/${taskSplit}-test-00000-of-00001.parquet`;
  return `https://huggingface.co/datasets/${repo}/resolve/main/${path}`;
}

/**
 * Local on-disk path for the downloaded file. Lives under the gitignored
 * `data/eval/corpus-babilong/raw/` (see the README in that dir).
 */
function localPathFor(task: TaskId, length: LengthLabel, ext: string): string {
  return resolve(
    process.cwd(),
    "data",
    "eval",
    "corpus-babilong",
    "raw",
    `task${task}_${length}.${ext}`,
  );
}

// --------------------------------------------------------------------------
// Tiny argv parser (avoid pulling in commander/yargs for a one-off script)
// --------------------------------------------------------------------------

interface CliArgs {
  tasks: TaskId[];
  lengths: LengthLabel[];
}

function parseArgs(argv: string[]): CliArgs {
  let tasks: TaskId[] = [...TASK_IDS];
  let lengths: LengthLabel[] = [...LENGTH_LABELS];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--tasks" && i + 1 < argv.length) {
      const parsed = argv[++i]!
        .split(",")
        .map((s) => Number.parseInt(s.trim(), 10));
      for (const t of parsed) {
        if (!TASK_IDS.includes(t as TaskId)) {
          throw new Error(
            `Unknown task ${t}; supported: ${TASK_IDS.join(", ")}`,
          );
        }
      }
      tasks = parsed as TaskId[];
    } else if (a === "--lengths" && i + 1 < argv.length) {
      const parsed = argv[++i]!.split(",").map((s) => s.trim().toUpperCase());
      for (const l of parsed) {
        if (!LENGTH_LABELS.includes(l as LengthLabel)) {
          throw new Error(
            `Unknown length "${l}"; supported: ${LENGTH_LABELS.join(", ")}`,
          );
        }
      }
      lengths = parsed as LengthLabel[];
    } else if (a === "--help" || a === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown arg: ${a}. Use --help for usage.`);
    }
  }
  return { tasks, lengths };
}

function printHelp(): void {
  process.stdout.write(
    [
      "Usage: npx tsx scripts/fetch-babilong.ts [--tasks 1,2,3] [--lengths 0K,4K,8K,32K,128K,256K,1M]",
      "",
      "Pulls BABILong Tasks 1/2/3 at the listed context lengths from Hugging Face.",
      "Idempotent: skips files that already exist on disk.",
      "",
      `Default tasks:   ${TASK_IDS.join(",")}`,
      `Default lengths: ${LENGTH_LABELS.join(",")}`,
      "",
      "Output: data/eval/corpus-babilong/raw/task<N>_<length>.<ext>",
      "",
    ].join("\n"),
  );
}

// --------------------------------------------------------------------------
// Downloader
// --------------------------------------------------------------------------

interface DownloadResult {
  task: TaskId;
  length: LengthLabel;
  url: string;
  /** Local path (only present on success / skip). */
  localPath?: string;
  /** Size in bytes on success/skip. 0 on failure. */
  bytes: number;
  status: "downloaded" | "skipped" | "failed";
  error?: string;
}

/**
 * Download a single file from HF. Returns metadata about the operation.
 * Never throws — failures are captured in the result for the summary to
 * surface clearly.
 */
async function downloadOne(
  task: TaskId,
  length: LengthLabel,
): Promise<DownloadResult> {
  const url = urlFor(task, length);
  const localPath = localPathFor(task, length, "parquet");

  if (existsSync(localPath)) {
    const { size } = await import("node:fs/promises").then((m) =>
      m.stat(localPath),
    );
    return {
      task,
      length,
      url,
      localPath,
      bytes: size,
      status: "skipped",
    };
  }

  await mkdir(dirname(localPath), { recursive: true });

  let response: Response;
  try {
    // `fetch` is global in Node 20+. We pass redirect: "follow" explicitly
    // because HF uses CDN redirects from huggingface.co → cdn-lfs.huggingface.co.
    response = await fetch(url, { redirect: "follow" });
  } catch (err) {
    return {
      task,
      length,
      url,
      bytes: 0,
      status: "failed",
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
      error: `HTTP ${response.status} ${response.statusText}`,
    };
  }

  // Stream into a buffer. BABILong parquet shards are typically <500MB even
  // at 1M context, so buffering is fine; the alternative (streaming to disk)
  // adds complexity for negligible benefit.
  const buf = Buffer.from(await response.arrayBuffer());
  if (buf.length === 0) {
    return {
      task,
      length,
      url,
      bytes: 0,
      status: "failed",
      error: "empty response body",
    };
  }

  await writeFile(localPath, buf);
  return {
    task,
    length,
    url,
    localPath,
    bytes: buf.length,
    status: "downloaded",
  };
}

// --------------------------------------------------------------------------
// Main
// --------------------------------------------------------------------------

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
    `Fetching BABILong: ${args.tasks.length} tasks × ${args.lengths.length} lengths = ${args.tasks.length * args.lengths.length} files\n` +
      `Tasks:   ${args.tasks.map((t) => `qa${t}`).join(", ")}\n` +
      `Lengths: ${args.lengths.join(", ")}\n\n`,
  );

  const results: DownloadResult[] = [];
  for (const length of args.lengths) {
    for (const task of args.tasks) {
      const r = await downloadOne(task, length);
      results.push(r);
      const tag = `qa${task}/${length}`.padEnd(10);
      const url = r.url;
      if (r.status === "downloaded") {
        const mb = (r.bytes / (1024 * 1024)).toFixed(2);
        process.stdout.write(`  [OK]   ${tag}  ${mb} MB  ${url}\n`);
      } else if (r.status === "skipped") {
        const mb = (r.bytes / (1024 * 1024)).toFixed(2);
        process.stdout.write(`  [skip] ${tag}  ${mb} MB  (already on disk)\n`);
      } else {
        process.stdout.write(`  [FAIL] ${tag}  ${r.error}  ${url}\n`);
      }
    }
  }

  const downloaded = results.filter((r) => r.status === "downloaded");
  const skipped = results.filter((r) => r.status === "skipped");
  const failed = results.filter((r) => r.status === "failed");
  const totalBytes = results.reduce((s, r) => s + r.bytes, 0);
  const totalMb = (totalBytes / (1024 * 1024)).toFixed(2);

  process.stdout.write(
    `\nDone. ${downloaded.length} downloaded, ${skipped.length} skipped, ${failed.length} failed. Total on disk: ${totalMb} MB.\n`,
  );

  if (failed.length > 0) {
    process.stdout.write(
      `\nFailures detected. The fetch URL pattern is best-effort — Hugging\n` +
        `Face occasionally restructures dataset repos. If a (task, length)\n` +
        `combination is unreachable here, drop a manually-downloaded copy at\n` +
        `the path shown above and the loader will pick it up. See\n` +
        `data/eval/corpus-babilong/README.md for the expected layout.\n`,
    );
    process.exit(1);
  }
}

// Node 20+ supports top-level await in ESM; we still wrap for the
// process-exit-code semantics.
main().catch((err) => {
  process.stderr.write(
    `fetch-babilong fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
  );
  process.exit(1);
});
