"""Context Swarm Memory provider for Agent Memory Benchmark.

This file is copied into an AMB checkout by `npm run amb:patch`.
It keeps AMB's public runner unchanged while delegating retrieval to this
repository's TypeScript CSM implementation.
"""

from __future__ import annotations

import json
import os
import subprocess
import time
import uuid
from hashlib import sha256
from pathlib import Path

from ..models import Document
from .base import MemoryProvider


class CSMMemoryProvider(MemoryProvider):
    name = "csm"
    description = "Context Swarm Memory bridge backed by the TypeScript CSM repo."
    kind = "local"
    provider = "context-swarm-memory"
    variant = "amb-bridge"
    link = "https://github.com/muhamadjawdatsalemalakoum/context-swarm-memory"
    concurrency = 1

    def __init__(self) -> None:
        self._store_dir: Path | None = None
        self._documents_path: Path | None = None
        self._repo_dir = Path(os.environ.get("CSM_REPO_DIR", "")).expanduser()
        if not str(self._repo_dir):
            self._repo_dir = Path.cwd()
        self._model = os.environ.get("CSM_AMB_MODEL") or os.environ.get("CSM_MODEL") or "gemini-3.5-flash"
        self._model_context = os.environ.get("CSM_AMB_MODEL_CONTEXT", "8192")

    def prepare(self, store_dir: Path, unit_ids: set[str] | None = None, reset: bool = True) -> None:
        self._store_dir = store_dir
        self._store_dir.mkdir(parents=True, exist_ok=True)
        self._documents_path = self._store_dir / "documents.jsonl"
        if reset and self._documents_path.exists():
            self._documents_path.unlink()
        if not self._repo_dir.exists():
            raise RuntimeError(
                f"CSM_REPO_DIR does not exist: {self._repo_dir}. "
                "Set CSM_REPO_DIR to the context-swarm-memory checkout."
            )

    def ingest(self, documents: list[Document]) -> None:
        if self._documents_path is None:
            raise RuntimeError("CSMMemoryProvider.prepare() must run before ingest().")
        with self._documents_path.open("a", encoding="utf-8") as fh:
            for doc in documents:
                fh.write(json.dumps({
                    "id": doc.id,
                    "content": doc.content,
                    "user_id": doc.user_id,
                    "timestamp": doc.timestamp,
                    "context": doc.context,
                }, ensure_ascii=False))
                fh.write("\n")

    def retrieve(
        self,
        query: str,
        k: int = 10,
        user_id: str | None = None,
        query_timestamp: str | None = None,
    ) -> tuple[list[Document], dict | None]:
        if self._store_dir is None:
            raise RuntimeError("CSMMemoryProvider.prepare() must run before retrieve().")

        request_path = self._store_dir / f"request-{uuid.uuid4().hex}.json"
        return_k = int(os.environ.get("CSM_AMB_RETURN_K", str(k)))
        request_path.write_text(json.dumps({
            "query": query,
            "k": return_k,
            "user_id": user_id,
            "query_timestamp": query_timestamp,
        }), encoding="utf-8")

        started = time.perf_counter()
        try:
            completed = subprocess.run(
                [
                    "npm",
                    "run",
                    "-s",
                    "amb:csm:retrieve",
                    "--",
                    "--store",
                    str(self._store_dir),
                    "--request",
                    str(request_path),
                    "--model",
                    self._model,
                    "--model-context",
                    self._model_context,
                ],
                cwd=str(self._repo_dir),
                text=True,
                capture_output=True,
                check=False,
                timeout=float(os.environ.get("CSM_AMB_RETRIEVE_TIMEOUT_SEC", "600")),
            )
        finally:
            try:
                request_path.unlink()
            except FileNotFoundError:
                pass

        if completed.returncode != 0:
            raise RuntimeError(
                "CSM retrieval subprocess failed: "
                + (completed.stderr or completed.stdout)[-4000:]
            )

        payload = json.loads(completed.stdout)
        docs = [
            Document(
                id=str(item.get("id", f"csm-doc-{idx}")),
                content=str(item.get("content", "")),
                user_id=item.get("user_id"),
                timestamp=item.get("timestamp"),
                context=item.get("context"),
            )
            for idx, item in enumerate(payload.get("documents", []))
        ]
        raw = payload.get("raw_response") or {}
        raw["bridge_wall_time_ms"] = round((time.perf_counter() - started) * 1000, 1)
        self._append_telemetry(query, return_k, user_id, docs, raw)
        return docs, raw

    def _append_telemetry(
        self,
        query: str,
        return_k: int,
        user_id: str | None,
        docs: list[Document],
        raw: dict,
    ) -> None:
        telemetry_path = os.environ.get("CSM_AMB_TELEMETRY_JSONL")
        if not telemetry_path:
            return

        meta = raw.get("meta") if isinstance(raw.get("meta"), dict) else {}
        record = {
            "provider": "context-swarm-memory",
            "query_sha256": sha256(query.encode("utf-8")).hexdigest(),
            "query": query,
            "user_id": user_id,
            "return_k": return_k,
            "docs_returned": len(docs),
            "doc_ids": [doc.id for doc in docs],
            "returned_doc_chars": sum(len(doc.content or "") for doc in docs),
            "bridge_wall_time_ms": raw.get("bridge_wall_time_ms"),
            # `inputTokens`/`outputTokens` come from CsmBaseline and include
            # every LLM call CSM actually made in the bridge: probes, recalls,
            # synthesis, plus the internal CSM answer call that AMB discards.
            "csm_internal_input_tokens": raw.get("inputTokens"),
            "csm_internal_output_tokens": raw.get("outputTokens"),
            "csm_internal_total_tokens": (
                _num(raw.get("inputTokens")) + _num(raw.get("outputTokens"))
            ),
            "csm_pipeline_input_tokens": meta.get("pipelineInputTokens"),
            "csm_pipeline_output_tokens": meta.get("pipelineOutputTokens"),
            "csm_pipeline_latency_ms": meta.get("pipelineLatencyMs"),
            "csm_internal_answer_input_tokens": meta.get("finalCallInputTokens"),
            "csm_internal_answer_output_tokens": meta.get("finalCallOutputTokens"),
            "csm_internal_answer_latency_ms": meta.get("finalCallLatencyMs"),
            "csm_probe_count": meta.get("probeCount"),
            "csm_recall_count": meta.get("recallCount"),
            "csm_context_tokens_before_amb_capsule": meta.get("contextTokens"),
            "csm_packet_tokens": meta.get("packetTokens"),
            "csm_retrieved_event_count": len(meta.get("csmRetrievedEventIds") or []),
            "csm_packed_event_count": len(meta.get("packedEventIds") or []),
            "csm_returned_event_count": len(raw.get("returnedEventIds") or []),
            "csm_evidence_capsule": raw.get("evidenceCapsule"),
            "amb_intent": raw.get("ambIntent"),
        }

        path = Path(telemetry_path).expanduser()
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(record, ensure_ascii=False, sort_keys=True))
            fh.write("\n")


def _num(value) -> float:
    return value if isinstance(value, (int, float)) else 0
