#!/usr/bin/env tsx
/**
 * Fetch a local slice of the BEAM dataset from the upstream
 * agent-memory-benchmark (AMB) repo for the T3 retrieval-recall harness.
 *
 * What it does:
 *   1. Ensures a blobless sparse clone of AMB pinned at AMB_SHA in a
 *      directory OUTSIDE this repo (default `E:\benchmarks\amb-t3-data` when
 *      E:\ exists, else `<os tmp>/amb-t3-data`; override with
 *      `--clone-dir <path>` or `CSM_AMB_CLONE_DIR`). Only `data/beam` and
 *      `src/memory_bench/dataset` are checked out.
 *   2. Copies the requested split directories (default: `100k`) verbatim
 *      (still gzipped, byte-identical to upstream) into the gitignored
 *      `data/eval/corpus-beam-slice/<split>/`.
 *   3. Writes `manifest.json` (AMB SHA, per-file SHA-256, sizes, dates) and
 *      `census.json` — units x sessions x token estimates for EVERY split
 *      present in AMB `data/beam`, computed from the clone (the scale input
 *      briefs T2/T8 cite).
 *
 * Network use: `git clone`/`git checkout` against github.com only. Every git
 * step is logged; on failure the script prints manual instructions instead
 * (the fetch-babilong.ts convention).
 *
 * NEVER commit the fetched data. `data/eval/corpus-beam-slice/` is
 * gitignored; committed fixtures for tests are tiny and synthetic
 * (tests/fixtures/beam/).
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";

/** The AMB commit every artifact in this harness is pinned to. */
export const AMB_SHA = "45fa380523afab9b1acd667a03de51c5ea63f4d2";
export const AMB_REMOTE = "https://github.com/vectorize-io/agent-memory-benchmark.git";

const SPARSE_PATHS = ["data/beam", "src/memory_bench/dataset"];
const BEAM_SPLIT_FILES = [
  "categories.json.gz",
  "documents.json.gz",
  "queries.json.gz",
  "stats.json.gz",
];

interface CliArgs {
  cloneDir: string;
  sliceDir: string;
  splits: string[];
  censusOnly: boolean;
  force: boolean;
}

function defaultCloneDir(): string {
  if (process.env.CSM_AMB_CLONE_DIR) return resolve(process.env.CSM_AMB_CLONE_DIR);
  if (existsSync("E:\\")) return "E:\\benchmarks\\amb-t3-data";
  return join(tmpdir(), "amb-t3-data");
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    cloneDir: defaultCloneDir(),
    sliceDir: resolve(process.cwd(), "data", "eval", "corpus-beam-slice"),
    splits: ["100k"],
    censusOnly: false,
    force: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const next = argv[i + 1];
    if (a === "--clone-dir" && next) {
      args.cloneDir = resolve(next);
      i++;
    } else if (a === "--splits" && next) {
      args.splits = next.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
      i++;
    } else if (a === "--census-only") {
      args.censusOnly = true;
    } else if (a === "--force") {
      args.force = true;
    } else if (a === "--help" || a === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown arg: ${a}. Use --help.`);
    }
  }
  return args;
}

function printHelp(): void {
  process.stdout.write(
    [
      "Usage: npx tsx scripts/fetch-beam-slice.ts [--splits 100k[,500k,1m,10m]] [--clone-dir <path>] [--census-only] [--force]",
      "",
      `Pins AMB at ${AMB_SHA.slice(0, 9)} and copies data/beam splits into data/eval/corpus-beam-slice/ (gitignored).`,
      "Also writes census.json covering every split present upstream.",
      "",
      "Default splits: 100k     (500k/1m/10m exist upstream; fetch on demand)",
      `Default clone dir: ${defaultCloneDir()}  (override: --clone-dir or CSM_AMB_CLONE_DIR)`,
      "",
    ].join("\n"),
  );
}

// ─── git orchestration ──────────────────────────────────────────────────────

function git(cloneDir: string, gitArgs: string[], opts: { allowFail?: boolean } = {}): string {
  const display = `git ${gitArgs.join(" ")}`;
  process.stdout.write(`  [git] ${display}\n`);
  try {
    return execFileSync("git", ["-C", cloneDir, ...gitArgs], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (err) {
    if (opts.allowFail) return "";
    throw new Error(`${display} failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function ensureClone(cloneDir: string): Promise<void> {
  if (!existsSync(join(cloneDir, ".git"))) {
    process.stdout.write(`Cloning AMB (blobless, no checkout) into ${cloneDir} ...\n`);
    process.stdout.write(`  [git] clone --filter=blob:none --no-checkout --single-branch ${AMB_REMOTE}\n`);
    execFileSync(
      "git",
      ["clone", "--filter=blob:none", "--no-checkout", "--single-branch", AMB_REMOTE, cloneDir],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
  } else {
    process.stdout.write(`Reusing existing clone at ${cloneDir}\n`);
  }

  // Tolerate stalls: fail transfers that drop below 1KB/s for 60s, then retry.
  git(cloneDir, ["config", "http.lowSpeedLimit", "1000"], { allowFail: true });
  git(cloneDir, ["config", "http.lowSpeedTime", "60"], { allowFail: true });
  git(cloneDir, ["sparse-checkout", "init", "--cone"], { allowFail: true });
  git(cloneDir, ["sparse-checkout", "set", ...SPARSE_PATHS]);

  const head = git(cloneDir, ["rev-parse", "HEAD"], { allowFail: true }).trim();
  if (head !== AMB_SHA || !existsSync(join(cloneDir, "data", "beam"))) {
    process.stdout.write(`Checking out pinned SHA ${AMB_SHA} (downloads BEAM blobs on first run) ...\n`);
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= 5; attempt++) {
      try {
        git(cloneDir, ["checkout", AMB_SHA]);
        lastError = null;
        break;
      } catch (err) {
        lastError = err;
        process.stdout.write(`  checkout attempt ${attempt} failed (${err instanceof Error ? err.message.split("\n")[0] : String(err)}); retrying in 5s ...\n`);
        await new Promise((r) => setTimeout(r, 5_000));
      }
    }
    if (lastError) {
      throw new Error(
        [
          `Could not check out AMB ${AMB_SHA} after 5 attempts.`,
          "Manual fallback:",
          `  git clone --filter=blob:none --no-checkout --single-branch ${AMB_REMOTE} <dir>`,
          "  git -C <dir> sparse-checkout init --cone",
          `  git -C <dir> sparse-checkout set ${SPARSE_PATHS.join(" ")}`,
          `  git -C <dir> checkout ${AMB_SHA}`,
          "  then re-run this script with --clone-dir <dir>.",
        ].join("\n"),
      );
    }
  }

  const verified = git(cloneDir, ["rev-parse", "HEAD"]).trim();
  if (verified !== AMB_SHA) {
    throw new Error(`Clone HEAD is ${verified}, expected pinned ${AMB_SHA}.`);
  }
  process.stdout.write(`Clone ready at ${cloneDir} @ ${verified.slice(0, 9)}\n`);
}

// ─── census ─────────────────────────────────────────────────────────────────

/** Whitespace-free 4-chars-per-token estimator — same arithmetic as
 *  src/core/tokenBudget.ts:estimateTokens, duplicated here so the fetch
 *  script stays dependency-free (it runs before npm deps may exist). */
function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

async function readGzJson(path: string): Promise<unknown> {
  const buf = await readFile(path);
  return JSON.parse(gunzipSync(buf).toString("utf8"));
}

export interface BeamSplitCensus {
  split: string;
  /** Distinct user_id values across documents (BEAM "units"). */
  units: number;
  /** Total documents (sessions) and per-unit min/avg/max. */
  documents: number;
  documentsPerUnit: { min: number; avg: number; max: number };
  /** Whitespace-estimate of total document content tokens (chars/4). */
  contentTokensEstimate: number;
  tokensPerUnit: { min: number; avg: number; max: number };
  queries: number;
  queriesByCategory: Record<string, number>;
  /** Pass-through of upstream stats.json.gz for cross-checking. */
  upstreamStats: unknown;
}

async function censusForSplit(beamDir: string, split: string): Promise<BeamSplitCensus> {
  const dir = join(beamDir, split);
  const documents = (await readGzJson(join(dir, "documents.json.gz"))) as Array<
    Record<string, unknown>
  >;
  const queries = (await readGzJson(join(dir, "queries.json.gz"))) as Array<
    Record<string, unknown>
  >;
  let upstreamStats: unknown = null;
  try {
    upstreamStats = await readGzJson(join(dir, "stats.json.gz"));
  } catch {
    upstreamStats = "unreadable";
  }

  const docsPerUnit = new Map<string, number>();
  const tokensPerUnit = new Map<string, number>();
  let contentTokens = 0;
  for (const doc of documents) {
    const userId = String(doc.user_id ?? doc.userId ?? "__none__");
    const content = typeof doc.content === "string" ? doc.content : "";
    const tokens = estimateTokens(content);
    contentTokens += tokens;
    docsPerUnit.set(userId, (docsPerUnit.get(userId) ?? 0) + 1);
    tokensPerUnit.set(userId, (tokensPerUnit.get(userId) ?? 0) + tokens);
  }

  const queriesByCategory: Record<string, number> = {};
  for (const q of queries) {
    const meta = (q.meta ?? {}) as Record<string, unknown>;
    const fromId =
      typeof q.id === "string" ? /^[^_]+_(.+)_\d+$/.exec(q.id)?.[1] : undefined;
    const cat = String(meta.question_category ?? q.category ?? fromId ?? "unknown");
    queriesByCategory[cat] = (queriesByCategory[cat] ?? 0) + 1;
  }

  const docCounts = [...docsPerUnit.values()];
  const tokenCounts = [...tokensPerUnit.values()];
  const minAvgMax = (xs: number[]): { min: number; avg: number; max: number } =>
    xs.length === 0
      ? { min: 0, avg: 0, max: 0 }
      : {
          min: Math.min(...xs),
          avg: Math.round(xs.reduce((a, b) => a + b, 0) / xs.length),
          max: Math.max(...xs),
        };

  return {
    split,
    units: docsPerUnit.size,
    documents: documents.length,
    documentsPerUnit: minAvgMax(docCounts),
    contentTokensEstimate: contentTokens,
    tokensPerUnit: minAvgMax(tokenCounts),
    queries: queries.length,
    queriesByCategory,
    upstreamStats,
  };
}

// ─── slice copy + manifest ──────────────────────────────────────────────────

async function sha256File(path: string): Promise<string> {
  const buf = await readFile(path);
  return createHash("sha256").update(buf).digest("hex");
}

async function main(): Promise<void> {
  let args: CliArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`Argument error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(2);
  }

  await ensureClone(args.cloneDir);
  const beamDir = join(args.cloneDir, "data", "beam");
  const splitsPresent = (await readdir(beamDir, { withFileTypes: true }))
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  process.stdout.write(`Splits present upstream: ${splitsPresent.join(", ")}\n`);

  for (const split of args.splits) {
    if (!splitsPresent.includes(split)) {
      throw new Error(`Requested split "${split}" not in upstream data/beam (${splitsPresent.join(", ")}).`);
    }
  }

  // Census covers EVERY split present (T2/T8 input), not just fetched ones.
  process.stdout.write("Computing census for every upstream split ...\n");
  const census: BeamSplitCensus[] = [];
  for (const split of splitsPresent) {
    const c = await censusForSplit(beamDir, split);
    census.push(c);
    process.stdout.write(
      `  ${split.padEnd(5)} units=${c.units} docs=${c.documents} ` +
        `tokens~${(c.contentTokensEstimate / 1e6).toFixed(2)}M queries=${c.queries}\n`,
    );
  }

  await mkdir(args.sliceDir, { recursive: true });
  await writeFile(
    join(args.sliceDir, "census.json"),
    `${JSON.stringify({ ambSha: AMB_SHA, computedAtIso: new Date().toISOString(), splits: census }, null, 2)}\n`,
    "utf8",
  );
  process.stdout.write(`Wrote ${join(args.sliceDir, "census.json")}\n`);

  if (args.censusOnly) {
    process.stdout.write("Census-only mode: skipping slice copy.\n");
    return;
  }

  const manifestFiles: Array<{ path: string; bytes: number; sha256: string }> = [];
  for (const split of args.splits) {
    const outDir = join(args.sliceDir, split);
    await mkdir(outDir, { recursive: true });
    for (const file of BEAM_SPLIT_FILES) {
      const src = join(beamDir, split, file);
      const dst = join(outDir, file);
      if (!existsSync(src)) {
        process.stdout.write(`  [skip] ${split}/${file} not present upstream\n`);
        continue;
      }
      if (!args.force && existsSync(dst)) {
        process.stdout.write(`  [skip] ${split}/${file} already fetched (use --force to refresh)\n`);
      } else {
        await copyFile(src, dst);
      }
      const s = await stat(dst);
      manifestFiles.push({
        path: `${split}/${file}`,
        bytes: s.size,
        sha256: await sha256File(dst),
      });
      process.stdout.write(
        `  [ok]   ${split}/${file}  ${(s.size / 1024 / 1024).toFixed(2)} MB\n`,
      );
    }
  }

  const manifest = {
    ambRemote: AMB_REMOTE,
    ambSha: AMB_SHA,
    fetchedAtIso: new Date().toISOString(),
    cloneDir: args.cloneDir,
    splits: args.splits,
    files: manifestFiles,
    note: "Byte-identical copies of upstream data/beam files. Gitignored — never commit.",
  };
  await writeFile(
    join(args.sliceDir, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
  process.stdout.write(`Wrote ${join(args.sliceDir, "manifest.json")}\nDone.\n`);
}

main().catch((err) => {
  process.stderr.write(
    `fetch-beam-slice fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
  );
  process.exit(1);
});
