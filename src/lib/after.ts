/**
 * Let slow side-work (vendor pushes, receipt emails) finish AFTER the till has
 * its answer.
 *
 * On Vercel the function is kept alive for promises registered with the
 * platform's waitUntil, so the reply goes back immediately and the pushes
 * still land. This is the same hook the official @vercel/functions package
 * uses, read directly so no new package has to be installed.
 *
 * Anywhere else (local dev) it falls back to the old behaviour: wait for the
 * work, but never more than `capMs`.
 */
const CONTEXT = Symbol.for("@vercel/request-context");

export function afterResponse(work: Promise<unknown>, capMs = 1200): Promise<void> {
  const settled = work.then(() => undefined, () => undefined);
  try {
    const ctx = (globalThis as unknown as Record<symbol, { get?: () => { waitUntil?: (p: Promise<unknown>) => void } } | undefined>)[CONTEXT]?.get?.();
    if (ctx?.waitUntil) {
      ctx.waitUntil(settled);
      return Promise.resolve();
    }
  } catch {
    /* fall through to the capped wait */
  }
  return Promise.race([settled, new Promise<void>((r) => setTimeout(r, capMs))]);
}
