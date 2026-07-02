#!/usr/bin/env python3
"""Per-category analysis + A/B comparison for AMB BEAM run result JSONs.

Reads the omb `<split>.json` (or `.json.gz`) result files, groups the per-query
`results` list by `meta.question_category`, and reports mean nugget `score` and
count per category. With two runs, prints the per-category delta (A=baseline,
B=variant) so a fix's category effect — and any winner-regression — is visible
at a glance.

Pure read-only analysis of eval OUTPUTS (answers + judge scores). It never
touches retrieval logic and never feeds anything back into CSM, so it cannot
leak gold into the read path (same class as scripts/measure-*.ts).

Usage:
  python scripts/amb-analyze-run.py <runA.json[.gz]> [runB.json[.gz]] [--cat summarization,event_ordering]
"""
import gzip
import json
import sys
from collections import defaultdict


def load(path):
    op = gzip.open if path.endswith(".gz") else open
    with op(path, "rt", encoding="utf-8") as fh:
        return json.load(fh)


def by_category(doc):
    """category -> list of (query_id, score)."""
    out = defaultdict(list)
    for r in doc.get("results", []):
        cat = (r.get("meta") or {}).get("question_category") or "?"
        score = r.get("score")
        if score is None:
            score = 1.0 if r.get("correct") else 0.0
        out[cat].append((r.get("query_id"), float(score)))
    return out


def mean(xs):
    return sum(xs) / len(xs) if xs else float("nan")


def summarize(doc, label):
    cats = by_category(doc)
    print(f"\n=== {label} :: {doc.get('run_name')} "
          f"(n={doc.get('total_queries')}, overall acc={doc.get('accuracy'):.4f}) ===")
    print(f"{'category':32s} {'n':>4s} {'mean':>8s}")
    rows = {}
    for cat in sorted(cats):
        scores = [s for _, s in cats[cat]]
        rows[cat] = (len(scores), mean(scores))
        print(f"{cat:32s} {len(scores):>4d} {mean(scores):>8.4f}")
    allscores = [s for cat in cats for _, s in cats[cat]]
    print(f"{'ALL':32s} {len(allscores):>4d} {mean(allscores):>8.4f}")
    return rows, cats


def compare(a_doc, b_doc, focus):
    a_rows, a_cats = summarize(a_doc, "A (baseline)")
    b_rows, b_cats = summarize(b_doc, "B (variant)")
    print("\n=== PER-CATEGORY DELTA (B - A) ===")
    print(f"{'category':32s} {'nA':>4s} {'nB':>4s} {'A':>8s} {'B':>8s} {'delta':>8s}  flag")
    cats = sorted(set(a_rows) | set(b_rows))
    net_a = []
    net_b = []
    for cat in cats:
        nA, mA = a_rows.get(cat, (0, float("nan")))
        nB, mB = b_rows.get(cat, (0, float("nan")))
        delta = mB - mA
        flag = ""
        if delta <= -0.02:
            flag = "REGRESSION"
        elif delta >= 0.02:
            flag = "gain"
        focusmark = " <<<" if focus and cat in focus else ""
        print(f"{cat:32s} {nA:>4d} {nB:>4d} {mA:>8.4f} {mB:>8.4f} {delta:>+8.4f}  {flag}{focusmark}")
    # Paired delta on the intersection of query_ids (controls for query mix).
    a_by_id = {qid: s for cat in a_cats for qid, s in a_cats[cat]}
    b_by_id = {qid: s for cat in b_cats for qid, s in b_cats[cat]}
    shared = sorted(set(a_by_id) & set(b_by_id))
    if shared:
        da = mean([a_by_id[q] for q in shared])
        db = mean([b_by_id[q] for q in shared])
        print(f"\nPaired on {len(shared)} shared query_ids: A={da:.4f}  B={db:.4f}  delta={db-da:+.4f}")
        # per-query movers
        movers = sorted(((b_by_id[q] - a_by_id[q], q) for q in shared), key=lambda t: t[0])
        big = [m for m in movers if abs(m[0]) >= 0.34]
        if big:
            print(f"  big movers (|delta|>=0.34): {len(big)}")
            for d, q in big[:24]:
                print(f"    {d:+.3f}  {q}")


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    focus = None
    for a in sys.argv[1:]:
        if a.startswith("--cat"):
            val = a.split("=", 1)[1] if "=" in a else sys.argv[sys.argv.index(a) + 1]
            focus = set(val.split(","))
    if not args:
        print(__doc__)
        sys.exit(1)
    if len(args) == 1:
        summarize(load(args[0]), "RUN")
    else:
        compare(load(args[0]), load(args[1]), focus)


if __name__ == "__main__":
    main()
