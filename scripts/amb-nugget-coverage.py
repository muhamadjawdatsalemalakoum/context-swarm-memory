#!/usr/bin/env python3
"""No-API proxy: does the answer-visible context actually CONTAIN the rubric nuggets?

Unlike the (falsified) retrieval-coverage proxy, this measures the FINAL
answer-visible context against the gold rubric and is VALIDATED against the real
judge scores stored in the same result file — so we can see whether it predicts
score before trusting it as a pre/post-run signal.

For each query: nugget_coverage = fraction of rubric nuggets whose distinctive
terms appear (lexically) in the context. Then report per-category mean coverage
and the Pearson correlation between coverage and the real `score`. With two runs
(baseline + variant) it also reports paired Δcoverage vs Δscore.

Pure offline analysis of eval OUTPUTS (context + gold rubric + judge score). It
never feeds anything into retrieval, so it cannot leak gold into the read path.

Usage:
  python scripts/amb-nugget-coverage.py <runA.json[.gz]> [runB.json[.gz]] [--cat summarization]
"""
import gzip
import json
import re
import sys
from collections import defaultdict

STOP = set(
    "the a an and or of to in on for with your you my our we i it is are was were be been "
    "that this these those there here as at by from into over under then than how what when "
    "which who whom whose will would should could can may might do did does done have has had "
    "llm response should contain about across after before during including detail details "
    "regarding various overall key development developments progress made make making".split()
)
TERM = re.compile(r"[a-z0-9]{4,}")


def load(path):
    op = gzip.open if path.endswith(".gz") else open
    with op(path, "rt", encoding="utf-8") as fh:
        return json.load(fh)


def distinctive_terms(nugget):
    nugget = re.sub(r"(?i)llm response should contain:?", " ", nugget)
    terms = [t for t in TERM.findall(nugget.lower()) if t not in STOP]
    # de-dupe, keep order, cap so one long nugget doesn't dominate
    seen, out = set(), []
    for t in terms:
        if t not in seen:
            seen.add(t)
            out.append(t)
    return out[:14]


def nugget_coverage(context, rubric, thresh=0.5):
    if not rubric:
        return None
    ctx = context.lower()
    covered = 0
    for nug in rubric:
        terms = distinctive_terms(nug if isinstance(nug, str) else str(nug))
        if not terms:
            continue
        hit = sum(1 for t in terms if t in ctx)
        if hit / len(terms) >= thresh:
            covered += 1
    return covered / len(rubric)


def pearson(xs, ys):
    n = len(xs)
    if n < 2:
        return float("nan")
    mx, my = sum(xs) / n, sum(ys) / n
    cov = sum((x - mx) * (y - my) for x, y in zip(xs, ys))
    vx = sum((x - mx) ** 2 for x in xs) ** 0.5
    vy = sum((y - my) ** 2 for y in ys) ** 0.5
    return cov / (vx * vy) if vx and vy else float("nan")


def per_query(doc, focus):
    out = {}
    for r in doc.get("results", []):
        cat = (r.get("meta") or {}).get("question_category") or "?"
        if focus and cat not in focus:
            continue
        rubric = (r.get("meta") or {}).get("rubric")
        cov = nugget_coverage(r.get("context", ""), rubric)
        if cov is None:
            continue
        out[r["query_id"]] = (cat, cov, float(r.get("score", 0.0)))
    return out


def report_single(doc, label, focus):
    pq = per_query(doc, focus)
    bycat = defaultdict(list)
    for _, (cat, cov, sc) in pq.items():
        bycat[cat].append((cov, sc))
    print(f"\n=== {label} :: {doc.get('run_name')} ===")
    print(f"{'category':28s} {'n':>3s} {'nugget_cov':>11s} {'score':>7s}")
    allc, alls = [], []
    for cat in sorted(bycat):
        covs = [c for c, _ in bycat[cat]]
        scs = [s for _, s in bycat[cat]]
        allc += covs
        alls += scs
        print(f"{cat:28s} {len(covs):>3d} {sum(covs)/len(covs):>11.3f} {sum(scs)/len(scs):>7.3f}")
    print(f"corr(nugget_cov, score) across {len(allc)} queries: {pearson(allc, alls):+.3f}")
    return pq


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    focus = None
    for a in sys.argv[1:]:
        if a.startswith("--cat"):
            focus = set((a.split("=", 1)[1] if "=" in a else sys.argv[sys.argv.index(a) + 1]).split(","))
    if not args:
        print(__doc__)
        sys.exit(1)
    a = report_single(load(args[0]), "A", focus)
    if len(args) > 1:
        b = report_single(load(args[1]), "B", focus)
        shared = sorted(set(a) & set(b))
        dcov = [b[q][1] - a[q][1] for q in shared]
        dsc = [b[q][2] - a[q][2] for q in shared]
        print(f"\n=== PAIRED (B - A) on {len(shared)} queries ===")
        print(f"mean Δnugget_cov: {sum(dcov)/len(dcov):+.3f}   mean Δscore: {sum(dsc)/len(dsc):+.3f}")
        print(f"corr(Δnugget_cov, Δscore): {pearson(dcov, dsc):+.3f}  (high = the proxy predicts the gain)")


if __name__ == "__main__":
    main()
