import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type {
  BaselineResult,
  BaselineRunContext,
  BaselineRunner,
} from "../src/eval/baselines/types.js";
import type { Corpus } from "../src/eval/corpus.js";
import type { Query } from "../src/eval/mcq.js";
import { replayResults, runBenchmark } from "../src/eval/runner.js";

/**
 * Stub baseline: returns a canned `chosenOption` for every query. Used to
 * exercise the runner's plumbing without requiring an LLM provider.
 */
class StubBaseline implements BaselineRunner {
  readonly name: string;
  constructor(
    name: string,
    private readonly chosenOption: number,
  ) {
    this.name = name;
  }
  async answer(
    _query: Query,
    corpus: Corpus,
    _ctx: BaselineRunContext,
  ): Promise<BaselineResult> {
    return {
      answer: {
        kind: "mcq",
        chosenOption: this.chosenOption,
        citedEventIds: corpus.coreEvents.slice(0, 2).map((e) => e.id),
        rawOutput: `ANSWER: ${this.chosenOption}`,
      },
      inputTokens: 100,
      outputTokens: 5,
      latencyMs: 1,
      model: "stub-model",
      meta: { stub: true },
    };
  }
}

/** Stub that returns a canned free-form answer. */
class FreeFormStubBaseline implements BaselineRunner {
  readonly name: string;
  constructor(
    name: string,
    private readonly chosenAnswer: string,
  ) {
    this.name = name;
  }
  async answer(
    _query: Query,
    corpus: Corpus,
    _ctx: BaselineRunContext,
  ): Promise<BaselineResult> {
    return {
      answer: {
        kind: "free-form",
        chosenAnswer: this.chosenAnswer,
        citedEventIds: corpus.coreEvents.slice(0, 1).map((e) => e.id),
        rawOutput: `ANSWER: ${this.chosenAnswer}`,
      },
      inputTokens: 100,
      outputTokens: 5,
      latencyMs: 1,
      model: "stub-model",
      meta: { stub: true, mode: "free-form" },
    };
  }
}

let workDir: string;
let corpusDir: string;
let outputDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "csm-runner-test-"));
  corpusDir = join(workDir, "corpus");
  outputDir = join(workDir, "output");
  await mkdir(corpusDir, { recursive: true });

  // 3 core + 4 filler events, 100 tokens each = 700 tokens total in the pool.
  const events = [
    { id: "e1", shardId: "s1", content: "Core 1", tokenCount: 100, isCore: true, tier: 0 },
    { id: "e2", shardId: "s1", content: "Core 2", tokenCount: 100, isCore: true, tier: 0 },
    { id: "e3", shardId: "s2", content: "Core 3", tokenCount: 100, isCore: true, tier: 0 },
    { id: "f1", shardId: "s-filler", content: "Filler 1", tokenCount: 100, isCore: false, tier: 1 },
    { id: "f2", shardId: "s-filler", content: "Filler 2", tokenCount: 100, isCore: false, tier: 1 },
    { id: "f3", shardId: "s-filler", content: "Filler 3", tokenCount: 100, isCore: false, tier: 1 },
    { id: "f4", shardId: "s-filler", content: "Filler 4", tokenCount: 100, isCore: false, tier: 1 },
  ];
  await writeFile(
    join(corpusDir, "events.jsonl"),
    events.map((e) => JSON.stringify(e)).join("\n"),
    "utf8",
  );

  const queries = {
    version: 1,
    queries: [
      {
        id: "q1",
        question: "What is the answer?",
        options: Array.from({ length: 5 }, (_, i) => `Option ${i + 1}`),
        correctOption: 3,
        relevantEventIds: ["e1", "e2"],
      },
    ],
  };
  await writeFile(join(corpusDir, "queries.json"), JSON.stringify(queries), "utf8");
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe("runBenchmark", () => {
  it("runs a 1×1×1×1×1 matrix end-to-end and writes the expected files", async () => {
    const stub = new StubBaseline("stub-correct", 3);
    const result = await runBenchmark({
      runId: "test-run",
      corpusDir,
      corpusSizes: [500],
      modelContexts: [4096],
      trials: 1,
      model: "stub-model",
      outputDir,
      systems: [stub],
    });

    expect(result.results).toHaveLength(1);
    expect(result.summaries).toHaveLength(1);
    expect(result.summaries[0]!.accuracy).toBe(1);
    expect(result.summaries[0]!.system).toBe("stub-correct");
    expect(result.summaries[0]!.n).toBe(1);
    expect(existsSync(join(outputDir, "config.json"))).toBe(true);
    expect(existsSync(join(outputDir, "results.jsonl"))).toBe(true);
    expect(existsSync(join(outputDir, "summary.json"))).toBe(true);
  });

  it("scores a wrong answer as 0% accuracy", async () => {
    const stub = new StubBaseline("stub-wrong", 1);
    const result = await runBenchmark({
      runId: "test-wrong",
      corpusDir,
      corpusSizes: [500],
      modelContexts: [4096],
      trials: 1,
      model: "stub-model",
      outputDir,
      systems: [stub],
    });
    expect(result.summaries[0]!.accuracy).toBe(0);
  });

  it("aggregates multiple trials into one cell summary", async () => {
    const stub = new StubBaseline("stub-multi", 3);
    const result = await runBenchmark({
      runId: "test-trials",
      corpusDir,
      corpusSizes: [500],
      modelContexts: [4096],
      trials: 3,
      model: "stub-model",
      outputDir,
      systems: [stub],
    });
    expect(result.results).toHaveLength(3);
    expect(result.summaries).toHaveLength(1);
    expect(result.summaries[0]!.n).toBe(3);
  });

  it("applies adaptive early-stop at the threshold", async () => {
    const stub = new StubBaseline("stub-fails", 1); // always wrong
    const result = await runBenchmark({
      runId: "test-early-stop",
      corpusDir,
      corpusSizes: [500, 600, 700], // 3 sizes; should stop after the first fails
      modelContexts: [4096],
      trials: 1,
      model: "stub-model",
      outputDir,
      systems: [stub],
      earlyStopThreshold: 0.5,
    });
    // Should only run the first cell; subsequent corpus sizes skipped.
    expect(result.results).toHaveLength(1);
    expect(result.earlyStopMap).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ system: "stub-fails", modelContext: 4096 }),
      ]),
    );
  });

  it("replay regenerates summary from results.jsonl without re-running cells", async () => {
    const stub = new StubBaseline("stub-replay", 3);
    await runBenchmark({
      runId: "test-replay",
      corpusDir,
      corpusSizes: [500],
      modelContexts: [4096],
      trials: 2,
      model: "stub-model",
      outputDir,
      systems: [stub],
    });

    const replayed = await replayResults({ outputDir });
    expect(replayed.summaries).toHaveLength(1);
    expect(replayed.summaries[0]!.accuracy).toBe(1);
    expect(replayed.summaries[0]!.n).toBe(2);

    // summary.json should have been overwritten with the replay marker.
    const summary = JSON.parse(
      await readFile(join(outputDir, "summary.json"), "utf8"),
    ) as { replay?: boolean };
    expect(summary.replay).toBe(true);
  });

  it("resumes a partial run instead of duplicating cells", async () => {
    const stub = new StubBaseline("stub-resume", 3);
    await runBenchmark({
      runId: "test-resume",
      corpusDir,
      corpusSizes: [500],
      modelContexts: [4096],
      trials: 2,
      model: "stub-model",
      outputDir,
      systems: [stub],
    });
    // Re-run the same config — every cell already in results.jsonl, so the
    // runner should skip them. Total cells stays at 2 (not 4).
    const second = await runBenchmark({
      runId: "test-resume",
      corpusDir,
      corpusSizes: [500],
      modelContexts: [4096],
      trials: 2,
      model: "stub-model",
      outputDir,
      systems: [stub],
    });
    expect(second.results).toHaveLength(2);
  });

  it("runs a free-form query end-to-end and populates chosenAnswer/correctAnswer", async () => {
    // Overwrite queries.json with a free-form query.
    const queries = {
      version: 1,
      queries: [
        {
          kind: "free-form",
          id: "bq-test",
          question: "Where is the answer?",
          correctAnswer: "kitchen",
          alternativeAnswers: ["the kitchen"],
          relevantEventIds: ["e1"],
          category: "babilong-task1",
        },
      ],
    };
    await writeFile(join(corpusDir, "queries.json"), JSON.stringify(queries), "utf8");

    const stub = new FreeFormStubBaseline("ff-stub-correct", "kitchen");
    const result = await runBenchmark({
      runId: "test-freeform",
      corpusDir,
      corpusSizes: [500],
      modelContexts: [4096],
      trials: 1,
      model: "stub-model",
      outputDir,
      systems: [stub],
    });

    expect(result.results).toHaveLength(1);
    expect(result.results[0]!.queryKind).toBe("free-form");
    expect(result.results[0]!.chosenAnswer).toBe("kitchen");
    expect(result.results[0]!.correctAnswer).toBe("kitchen");
    expect(result.summaries[0]!.accuracy).toBe(1);
  });

  it("scores free-form wrong answer as 0% accuracy", async () => {
    const queries = {
      version: 1,
      queries: [
        {
          kind: "free-form",
          id: "bq-test",
          question: "Where is the answer?",
          correctAnswer: "kitchen",
          relevantEventIds: ["e1"],
        },
      ],
    };
    await writeFile(join(corpusDir, "queries.json"), JSON.stringify(queries), "utf8");

    const stub = new FreeFormStubBaseline("ff-stub-wrong", "garage");
    const result = await runBenchmark({
      runId: "test-freeform-wrong",
      corpusDir,
      corpusSizes: [500],
      modelContexts: [4096],
      trials: 1,
      model: "stub-model",
      outputDir,
      systems: [stub],
    });
    expect(result.summaries[0]!.accuracy).toBe(0);
  });

  it("respects queryIdsFilter", async () => {
    // Add a second query
    const queries = {
      version: 1,
      queries: [
        {
          id: "q1",
          question: "Q1?",
          options: ["a", "b", "c", "d", "e"],
          correctOption: 3,
          relevantEventIds: ["e1"],
        },
        {
          id: "q2",
          question: "Q2?",
          options: ["a", "b", "c", "d", "e"],
          correctOption: 2,
          relevantEventIds: ["e2"],
        },
      ],
    };
    await writeFile(join(corpusDir, "queries.json"), JSON.stringify(queries), "utf8");

    const stub = new StubBaseline("stub-filter", 3);
    const result = await runBenchmark({
      runId: "test-filter",
      corpusDir,
      corpusSizes: [500],
      modelContexts: [4096],
      trials: 1,
      model: "stub-model",
      outputDir,
      systems: [stub],
      queryIdsFilter: ["q1"], // only run q1
    });
    expect(result.results).toHaveLength(1);
    expect(result.results[0]!.queryId).toBe("q1");
  });
});
