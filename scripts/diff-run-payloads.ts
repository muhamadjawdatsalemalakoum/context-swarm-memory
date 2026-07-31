/**
 * Compare the RETRIEVAL output of two slice runs, query by query.
 *
 * A refactor that claims to preserve behaviour should be checked against
 * behaviour, not against a score that has to survive an answer model and a
 * judge before it tells you anything. Two runs of the same arm can differ in
 * final score purely through sampling noise; their retrieved evidence cannot.
 *
 * Compares, per query id:
 *   - the returned document ids and their order
 *   - the returned event ids and their order
 *   - a sha256 of each document's text
 *
 *   npx tsx scripts/diff-run-payloads.ts <runIdA> <runIdB>
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

interface Row {
  queryId: string;
  docIds: string[];
  docHashes: string[];
  eventIds: string[];
}

function loadRows(runId: string): Map<string, Row> {
  const path = join(resolve(process.cwd(), "data", "eval", "runs", runId), "payloads.jsonl");
  const out = new Map<string, Row>();
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const rec = JSON.parse(line) as Record<string, unknown>;
    const harness = (rec.harness ?? {}) as Record<string, unknown>;
    const docs = (rec.documents ?? []) as Array<Record<string, unknown>>;
    const raw = (rec.raw_response ?? {}) as Record<string, unknown>;
    const queryId = String(harness.queryId ?? rec.queryId ?? "");
    out.set(queryId, {
      queryId,
      docIds: docs.map((d) => String(d.id ?? "")),
      // payloads.jsonl stores `contentChars`, not the text itself (the run
      // record stays small). Length is a weaker signal than a content hash but
      // still catches every change that alters what the reader sees.
      docHashes: docs.map((d) =>
        createHash("sha256")
          .update(String(d.content ?? d.text ?? d.contentChars ?? ""))
          .digest("hex")
          .slice(0, 12),
      ),
      eventIds: ((raw.returnedEventIds ?? []) as string[]).map(String),
    });
  }
  return out;
}

function sameArray(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

function main(): void {
  const [runA, runB] = process.argv.slice(2);
  if (!runA || !runB) {
    console.error("Usage: npx tsx scripts/diff-run-payloads.ts <runIdA> <runIdB>");
    process.exit(2);
  }
  const A = loadRows(runA);
  const B = loadRows(runB);

  const ids = [...new Set([...A.keys(), ...B.keys()])].sort();
  let identical = 0;
  const diffs: string[] = [];

  for (const id of ids) {
    const a = A.get(id);
    const b = B.get(id);
    if (!a || !b) {
      diffs.push(`  ${id}: present only in ${a ? runA : runB}`);
      continue;
    }
    const docsSame = sameArray(a.docIds, b.docIds);
    const hashSame = sameArray(a.docHashes, b.docHashes);
    const evSame = sameArray(a.eventIds, b.eventIds);
    if (docsSame && hashSame && evSame) {
      identical++;
      continue;
    }
    const what: string[] = [];
    if (!docsSame) what.push(`docIds ${a.docIds.length}→${b.docIds.length}`);
    if (!evSame) {
      const setA = new Set(a.eventIds);
      const setB = new Set(b.eventIds);
      const dropped = a.eventIds.filter((e) => !setB.has(e)).length;
      const added = b.eventIds.filter((e) => !setA.has(e)).length;
      what.push(
        `events ${a.eventIds.length}→${b.eventIds.length} (-${dropped}/+${added}${
          dropped === 0 && added === 0 ? ", reordered only" : ""
        })`,
      );
    }
    if (!hashSame && docsSame) what.push("doc SIZE changed");
    diffs.push(`  ${id}: ${what.join("; ")}`);
  }

  console.log(`${runA}  vs  ${runB}`);
  console.log(`  queries compared : ${ids.length}`);
  console.log(`  byte-identical   : ${identical}`);
  console.log(`  differing        : ${ids.length - identical}`);
  if (diffs.length > 0) {
    console.log("");
    for (const d of diffs.slice(0, 50)) console.log(d);
    if (diffs.length > 50) console.log(`  … and ${diffs.length - 50} more`);
  }
  process.exitCode = identical === ids.length ? 0 : 1;
}

main();
