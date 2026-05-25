"""RQ1 scaling report: accuracy + citation F1 vs corpus size, per system.
Reads scaling-rq1 (100K cell) + scaling-1m (1M cell). Runnable on partial data
for a live preview; on complete data it's the finalization source for the docs.
"""
import json, statistics as st
from collections import defaultdict

RUNS = {100_000: "scaling-rq1", 1_000_000: "scaling-1m"}
SYS = ["csm", "rag", "longctx"]

def load(run, size):
    out = defaultdict(lambda: {"acc": 0, "n": 0, "f1": []})
    path = f"data/eval/runs/{run}/results.jsonl"
    try:
        for l in open(path, encoding="utf-8"):
            if not l.strip(): continue
            r = json.loads(l)
            if r.get("corpusSize") != size: continue
            d = out[r["system"]]
            d["acc"] += 1 if r["correct"] else 0
            d["n"] += 1
            d["f1"].append(r.get("citationF1", 0))
    except FileNotFoundError:
        pass
    return out

data = {size: load(run, size) for size, run in RUNS.items()}

print("RQ1 scaling — accuracy (and citation F1) vs corpus size")
print(f"{'system':<10} {'100K':>16} {'1M':>16}")
for s in SYS:
    cells = []
    for size in (100_000, 1_000_000):
        d = data[size].get(s)
        if d and d["n"]:
            cells.append(f"{d['acc']}/{d['n']} F1={st.mean(d['f1']):.3f}")
        else:
            cells.append("(pending)")
    print(f"{s:<10} {cells[0]:>16} {cells[1]:>16}")

print("\nRQ1 reading (fill on completion):")
for s in SYS:
    a = data[100_000].get(s); b = data[1_000_000].get(s)
    if a and a["n"] and b and b["n"]:
        pa = 100*a["acc"]/a["n"]; pb = 100*b["acc"]/b["n"]
        print(f"  {s}: {pa:.0f}% @100K -> {pb:.0f}% @1M  (delta {pb-pa:+.0f}pp)")
    else:
        print(f"  {s}: 1M still computing ({(b or {}).get('n',0)}/30)")
