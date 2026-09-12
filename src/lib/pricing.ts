// One source of truth for sale pricing — every surface charges/shows the same number
export function effectivePriceCents(item: { priceCents: number; salePercent: number }): number {
  const pct = Math.max(0, Math.min(90, item.salePercent || 0));
  if (pct === 0) return item.priceCents;
  return Math.max(0, Math.round((item.priceCents * (100 - pct)) / 100));
}
