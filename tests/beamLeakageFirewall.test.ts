/**
 * BEAM-slice leakage firewall — the project's hardest rule, enforced
 * statically over the import graph.
 *
 * BEAM gold answers / evidence references are EVAL-SIDE ONLY. The one module
 * allowed to touch them is `src/eval/retrievalScore.ts`. This test proves,
 * by walking the real import statements on disk, that:
 *
 *   1. The gold module is a LEAF: it imports node: builtins only — no
 *      project modules, no npm packages. Its project-import closure is
 *      therefore trivially disjoint from everything the retrieval path
 *      imports (the brief's "import-isolated from everything the retrieval
 *      path imports", taken at its strictest).
 *   2. The retrieval path (`scripts/amb-csm-retrieve.ts`,
 *      `scripts/amb-csm-server.ts`, `scripts/run-beam-slice.ts`,
 *      `src/eval/corpus/beam.ts`) can never reach the gold module:
 *      `retrievalScore.ts` is absent from each of their transitive runtime
 *      closures.
 *   3. Nothing in `src/` or `scripts/` imports the gold module except the
 *      eval-side scoring tools in `EVAL_SIDE_GOLD_CONSUMERS` (the CLI plus the
 *      token-free measurement scripts) — reverse-dependency scan over the whole
 *      repo. Each is itself isolated from retrieval logic. Tests are exempt —
 *      they live outside both paths and assert on behavior.
 *   4. The eval-side CLI is itself import-isolated from the retrieval path:
 *      its closure contains no `src/core/**`, no `src/providers/**`, no
 *      `src/eval/baselines/**`, and no `scripts/amb-*` module. The only
 *      bridge between the two sides is the payload JSONL file on disk.
 *
 * Type-only imports (`import type … from`) are erased by the compiler and
 * carry no values at runtime, so they are not edges in this graph. Mixed
 * imports (`import { type A, b } from`) ARE edges.
 *
 * If this test fails, do not weaken it — move the offending import.
 */

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, resolve, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const GOLD_MODULE = "src/eval/retrievalScore.ts";
const EVAL_CLI = "scripts/score-beam-slice.ts";
/**
 * Eval-side scoring/measurement tools allowed to read the gold module. All
 * read gold ONLY to SCORE (never to rank/retrieve) and none is imported by the
 * retrieval path. Each is isolated from retrieval logic below (same guarantee
 * as the CLI), so adding a tool here STRENGTHENS coverage, it does not weaken
 * the firewall. The retrieval-path invariants (#1/#2/#3) are unaffected.
 */
const EVAL_SIDE_GOLD_CONSUMERS = [
  EVAL_CLI,
  "scripts/measure-return-strategies.ts",
  "scripts/measure-returnk-sweep.ts",
];
const RETRIEVAL_ENTRYPOINTS = [
  "scripts/amb-csm-retrieve.ts",
  "scripts/amb-csm-server.ts",
  "scripts/run-beam-slice.ts",
  "src/eval/corpus/beam.ts",
];

// ─── Static import scanner ──────────────────────────────────────────────────

interface ModuleImports {
  /** Repo-relative paths of project files imported at runtime. */
  project: string[];
  /** Bare specifiers (node: builtins and npm packages) imported at runtime. */
  external: string[];
}

/** Strip // and /* comments + template literals conservatively so commented
 *  import examples don't count as edges. String literals inside import
 *  statements survive because we re-scan the stripped source. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^[ \t]*\/\/.*$/gm, " ");
}

/**
 * Extract runtime import specifiers from one TypeScript source file.
 * Covers: `import … from "x"`, `import "x"`, `export … from "x"`,
 * `await import("x")`. Excludes `import type` / `export type` (erased).
 */
function runtimeImportSpecifiers(source: string): string[] {
  const text = stripComments(source);
  const out: string[] = [];

  // import / export … from "spec"  (excluding `import type` / `export type`)
  const fromRe =
    /(?:^|\n)\s*(import|export)\s+([\s\S]*?)\s+from\s+["']([^"']+)["']/g;
  for (const m of text.matchAll(fromRe)) {
    const clause = m[2]!.trim();
    // `import type { A }` / `export type { A }` — type-only, erased.
    if (/^type\b(?!\s*,)/.test(clause)) continue;
    out.push(m[3]!);
  }

  // side-effect imports: import "spec";
  for (const m of text.matchAll(/(?:^|\n)\s*import\s+["']([^"']+)["']/g)) {
    out.push(m[1]!);
  }

  // dynamic imports: import("spec")
  for (const m of text.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g)) {
    out.push(m[1]!);
  }

  return out;
}

/** NodeNext: `./x.js` in source resolves to `./x.ts` on disk. */
function resolveProjectSpecifier(fromFile: string, spec: string): string | null {
  if (!spec.startsWith(".")) return null;
  const base = resolve(dirname(resolve(REPO_ROOT, fromFile)), spec);
  const candidates = [
    base.replace(/\.js$/, ".ts"),
    base.replace(/\.js$/, ".tsx"),
    `${base}.ts`,
    base, // already .ts
  ];
  for (const c of candidates) {
    if (c.endsWith(".ts") && existsSync(c)) {
      return relative(REPO_ROOT, c).split(sep).join("/");
    }
  }
  throw new Error(
    `beamLeakageFirewall: cannot resolve import "${spec}" from ${fromFile}`,
  );
}

function scanModule(repoRelPath: string): ModuleImports {
  const abs = resolve(REPO_ROOT, repoRelPath);
  const source = readFileSync(abs, "utf8");
  const project: string[] = [];
  const external: string[] = [];
  for (const spec of runtimeImportSpecifiers(source)) {
    const resolved = resolveProjectSpecifier(repoRelPath, spec);
    if (resolved) project.push(resolved);
    else external.push(spec);
  }
  return { project: dedupe(project), external: dedupe(external) };
}

/** BFS transitive closure of project-file runtime imports. */
function closure(entry: string): Set<string> {
  const seen = new Set<string>([entry]);
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.shift()!;
    for (const dep of scanModule(file).project) {
      if (!seen.has(dep)) {
        seen.add(dep);
        queue.push(dep);
      }
    }
  }
  return seen;
}

function dedupe<T>(items: T[]): T[] {
  return [...new Set(items)];
}

/** Recursively list .ts files under a repo-relative dir (no node_modules). */
function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const entry of readdirSync(resolve(REPO_ROOT, d), {
      withFileTypes: true,
    })) {
      const rel = `${d}/${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === "dist") continue;
        walk(rel);
      } else if (entry.name.endsWith(".ts")) {
        out.push(rel);
      }
    }
  };
  walk(dir);
  return out;
}

// ─── The firewall ───────────────────────────────────────────────────────────

describe("BEAM gold leakage firewall (static import graph)", () => {
  it("firewall_gold_module_is_a_node_builtin_leaf", () => {
    const { project, external } = scanModule(GOLD_MODULE);
    expect(project).toEqual([]);
    for (const spec of external) {
      expect(spec.startsWith("node:"), `non-builtin import "${spec}"`).toBe(
        true,
      );
    }
  });

  it("firewall_retrieval_path_never_reaches_gold_module", () => {
    for (const entry of RETRIEVAL_ENTRYPOINTS) {
      const reach = closure(entry);
      expect(
        reach.has(GOLD_MODULE),
        `${entry} transitively imports ${GOLD_MODULE}`,
      ).toBe(false);
      expect(
        reach.has(EVAL_CLI),
        `${entry} transitively imports ${EVAL_CLI}`,
      ).toBe(false);
    }
  });

  it("firewall_gold_closure_disjoint_from_retrieval_closure", () => {
    // The brief's exact wording: the gold-touching module must be
    // import-isolated from EVERYTHING the retrieval path imports.
    const goldClosure = closure(GOLD_MODULE);
    goldClosure.delete(GOLD_MODULE);
    for (const entry of RETRIEVAL_ENTRYPOINTS) {
      const retrievalClosure = closure(entry);
      const shared = [...goldClosure].filter((f) => retrievalClosure.has(f));
      expect(shared, `shared modules with ${entry}`).toEqual([]);
    }
  });

  it("firewall_only_eval_side_tools_import_the_gold_module", () => {
    const allFiles = [...listTsFiles("src"), ...listTsFiles("scripts")];
    const importers = allFiles.filter(
      (f) => f !== GOLD_MODULE && scanModule(f).project.includes(GOLD_MODULE),
    );
    expect(importers.sort()).toEqual([...EVAL_SIDE_GOLD_CONSUMERS].sort());
  });

  it("firewall_eval_side_gold_consumers_are_isolated_from_retrieval_logic", () => {
    const forbiddenPrefixes = [
      "src/core/",
      "src/providers/",
      "src/eval/baselines/",
      "scripts/amb-",
    ];
    for (const consumer of EVAL_SIDE_GOLD_CONSUMERS) {
      const violations = [...closure(consumer)].filter((f) =>
        forbiddenPrefixes.some((p) => f.startsWith(p)),
      );
      expect(violations, `${consumer} reaches retrieval logic`).toEqual([]);
    }
  });

  it("firewall_run_payloads_are_the_only_bridge_no_module_reads_scores_back", () => {
    // The score artifacts written by the eval CLI must never be read by the
    // retrieval side. Static proxy: no retrieval-path module mentions the
    // score artifact filenames.
    const scoreArtifacts = ["retrieval-scores", "beam-gold"];
    for (const entry of RETRIEVAL_ENTRYPOINTS) {
      for (const file of closure(entry)) {
        const source = stripComments(
          readFileSync(resolve(REPO_ROOT, file), "utf8"),
        );
        for (const needle of scoreArtifacts) {
          expect(
            source.includes(needle),
            `${file} references score artifact "${needle}"`,
          ).toBe(false);
        }
      }
    }
  });
});
