# Scientific Release Checklist

This is the checklist for turning a GitHub-public prototype into a citable
research artifact.

## 1. Freeze the code artifact

1. Confirm the working tree is clean.
2. Run:

```bash
npm run lint
npm test
npm run build
npm run verify:published
npx tsx scripts/verify-corpus.ts
npx tsx scripts/verify-no-leakage.ts
npm audit
```

3. Tag the release:

```bash
git tag -a v0.2.0 -m "Context Swarm Memory v0.2.0 evidence release"
git push origin v0.2.0
```

## 2. Create a DOI-backed archive

Recommended path: connect the GitHub repository to Zenodo and archive the
`v0.2.0` GitHub release. Zenodo will read `.zenodo.json` and mint a DOI.

Archive contents should include:

- source code at the tagged commit
- committed corpus and canonical result rows
- README, methodology, evidence, reproduction, and replication docs
- generated charts used in the README
- `CITATION.cff`
- sidecar requirements and lock files

After Zenodo mints the DOI:

1. Add the DOI badge to `README.md`.
2. Add the DOI to `CITATION.cff`.
3. Add the DOI to this checklist and `docs/EVIDENCE.md`.
4. Commit and push the DOI update.

OSF is a reasonable alternative if you want a project page with richer narrative
metadata and file organization.

## 3. Run 3-trial confirmation

The current public evidence is a single-trial R&D result. To strengthen it:

```bash
npm run bench:confirm -- --run-id confirm-gemma-v1 --model gemma4:31b
npm run bench:trials -- confirm-gemma-v1
```

For a faster hosted cross-model run:

```bash
export CSM_PROVIDER=gemini
export GEMINI_API_KEY=...
npm run bench:confirm -- --run-id confirm-gemini35-flash-v1 --model gemini-3.5-flash --model-contexts 160K --corpus-sizes 100K,1M,2M
npm run bench:trials -- confirm-gemini35-flash-v1
```

Publish the resulting `trial-summary.md` and `results.jsonl` as either committed
evidence rows or release artifacts. Do not replace the Gemma headline with
Gemini numbers unless the README clearly says the answering model changed.

## 4. Sidecar reproducibility

The sidecar environment is documented in `services/README.md`.

Minimum artifact set:

- `services/*-sidecar/requirements.txt`
- `services/locks/*`
- `services/Dockerfile.sidecar`
- `services/docker-compose.sidecars.yml`
- the exact sidecar logs for any blocked finding

## 5. Independent replication

Independent replication cannot be done by the author alone. The repo provides
`docs/REPLICATION_KIT.md` and a replication issue template so an outside reader
can report:

- commit/tag and DOI
- hardware
- provider/model
- exact commands
- produced run IDs
- result deltas from the published evidence

A replication report should be linked from `docs/EVIDENCE.md` after review.
