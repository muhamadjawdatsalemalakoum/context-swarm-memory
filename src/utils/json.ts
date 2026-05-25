// Deterministic-ish JSON helpers and a forgiving JSON-extract for LLM outputs.

export function stableStringify(value: unknown, indent = 2): string {
  return JSON.stringify(sortKeys(value), null, indent);
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      out[k] = sortKeys((value as Record<string, unknown>)[k]);
    }
    return out;
  }
  return value;
}

/** Try to parse JSON; if the string has surrounding prose or fences, extract the first {...} or [...] block. */
export function extractJson<T = unknown>(raw: string): T {
  const trimmed = raw.trim();
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    // continue
  }

  // Strip ```json fences.
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch) {
    try {
      return JSON.parse(fenceMatch[1]!.trim()) as T;
    } catch {
      // continue
    }
  }

  // Find the first balanced JSON object or array.
  const candidate = findFirstJsonSpan(trimmed);
  if (candidate) {
    return JSON.parse(candidate) as T;
  }

  throw new Error(`Could not parse JSON from response: ${trimmed.slice(0, 200)}`);
}

function findFirstJsonSpan(src: string): string | null {
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === "{" || c === "[") {
      const end = matchBalanced(src, i);
      if (end > i) return src.slice(i, end + 1);
    }
  }
  return null;
}

function matchBalanced(src: string, start: number): number {
  const open = src[start]!;
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inStr = false;
  let escape = false;
  for (let i = start; i < src.length; i++) {
    const ch = src[i]!;
    if (inStr) {
      if (escape) {
        escape = false;
      } else if (ch === "\\") {
        escape = true;
      } else if (ch === '"') {
        inStr = false;
      }
      continue;
    }
    if (ch === '"') {
      inStr = true;
      continue;
    }
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}
