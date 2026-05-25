export function nowIso(): string {
  return new Date().toISOString();
}

export function ageDays(iso: string, ref: Date = new Date()): number {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return Number.POSITIVE_INFINITY;
  return (ref.getTime() - t) / (1000 * 60 * 60 * 24);
}
