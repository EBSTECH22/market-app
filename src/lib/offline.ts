/**
 * Sales rung while the internet is down.
 *
 * A market's wifi drops. Until now that meant the till simply could not take
 * money: every sale went straight to the database, and a failed fetch told the
 * cashier to ring it again later — which, on a Saturday with a queue, means
 * either a closed till or a stack of handwritten notes nobody reconciles.
 *
 * So a sale that can't reach the server is written to THIS DEVICE and posted
 * when the connection comes back. Four things make that safe rather than
 * reckless:
 *
 *   1. AN IDEMPOTENCY KEY PER SALE. The same queued sale can be posted twice —
 *      by a retry, by two tabs, by a refresh mid-sync — and the server stores
 *      the key, so the second attempt returns the FIRST sale instead of ringing
 *      a duplicate. Without this, "sync" is a machine for double-charging.
 *   2. NOTHING IS DELETED UNTIL THE SERVER ACCEPTS IT. A queued sale leaves this
 *      device only after a response that confirms it was booked.
 *   3. A SALE THE SERVER REJECTS IS KEPT AND SHOWN, never dropped. After enough
 *      failed attempts it stops retrying and asks a person, because a sale that
 *      vanishes quietly is money that vanishes quietly.
 *   4. IndexedDB, NOT localStorage. localStorage is synchronous, ~5MB, and
 *      shared with anything else on the origin; a till mid-shift should not be
 *      one stray write away from losing its queue.
 *
 * Browser-only — every function no-ops or throws a clean error server-side.
 */

const DB_NAME = "nm_register";
const DB_VERSION = 1;
const STORE = "queued_sales";

/** Stop retrying after this many failures and put it in front of a human. */
export const MAX_ATTEMPTS = 6;

export type QueuedLine = {
  itemId: string;
  quantity: number;
  /** Carried for the on-screen list — the server prices from the item id. */
  name: string;
  priceCents: number;
};

export type QueuedSale = {
  /** Idempotency key. Also the primary key in the store. */
  key: string;
  createdAtIso: string;
  employee: string;
  paymentMethod: "CASH" | "CARD";
  cardName: string;
  cashTenderedCents: number;
  /** What the customer was told, computed on this device with the same math the server uses. */
  totalCents: number;
  changeCents: number;
  lines: QueuedLine[];
  attempts: number;
  lastError: string;
};

function idb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("This browser can't store offline sales."));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: "key" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error("Couldn't open the offline store."));
  });
}

function run<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return idb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(STORE, mode);
        const req = fn(tx.objectStore(STORE));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error || new Error("Offline store write failed."));
        tx.oncomplete = () => db.close();
      })
  );
}

/**
 * A key unique enough that two tills, two tabs and a clock that jumped can't
 * collide. crypto.randomUUID isn't on older iPads, hence the fallback.
 */
export function newSaleKey(): string {
  try {
    if (typeof crypto !== "undefined" && "randomUUID" in crypto) return `off_${crypto.randomUUID()}`;
  } catch {
    /* fall through */
  }
  return `off_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`;
}

export async function queueSale(sale: Omit<QueuedSale, "attempts" | "lastError">): Promise<void> {
  await run("readwrite", (s) => s.put({ ...sale, attempts: 0, lastError: "" }));
}

export async function queuedSales(): Promise<QueuedSale[]> {
  const rows = await run<QueuedSale[]>("readonly", (s) => s.getAll() as IDBRequest<QueuedSale[]>);
  // Oldest first: tickets should reach the books in the order they were rung.
  return (rows || []).sort((a, b) => a.createdAtIso.localeCompare(b.createdAtIso));
}

export async function removeQueuedSale(key: string): Promise<void> {
  await run("readwrite", (s) => s.delete(key));
}

export async function markAttempt(sale: QueuedSale, error: string): Promise<void> {
  await run("readwrite", (s) => s.put({ ...sale, attempts: sale.attempts + 1, lastError: error.slice(0, 200) }));
}

/** True when this sale has failed enough times that it needs a person. */
export const isStuck = (s: QueuedSale): boolean => s.attempts >= MAX_ATTEMPTS;

export type SyncResult = { posted: number; stuck: number; failed: number };

/**
 * Post everything waiting, oldest first.
 *
 * Stops at the first network failure rather than grinding through the whole
 * queue — if one can't reach the server, none of them can, and hammering a dead
 * connection just delays the retry that will work. A sale the server REJECTS
 * (bad data, deleted item) is different: that one is marked and the rest carry
 * on, because one bad ticket must not block the day's takings.
 */
export async function syncQueuedSales(): Promise<SyncResult> {
  const pending = await queuedSales();
  let posted = 0;
  let stuck = 0;
  let failed = 0;

  for (const sale of pending) {
    if (isStuck(sale)) { stuck++; continue; }

    let res: Response;
    try {
      res = await fetch("/api/admin/sale", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          paymentMethod: sale.paymentMethod,
          cardName: sale.cardName,
          cashTenderedCents: sale.cashTenderedCents,
          /* The price the customer actually paid travels with the line. The
             server only honours it on an offline sale — see the sale route. */
          lines: sale.lines.map((l) => ({ itemId: l.itemId, quantity: l.quantity, priceCents: l.priceCents })),
          idemKey: sale.key,
          offline: true,
          soldAtIso: sale.createdAtIso,
          employeeName: sale.employee,
        }),
      });
    } catch {
      // Still no connection. Leave everything where it is, without counting a
      // failed attempt — the sale did nothing wrong.
      break;
    }

    /* The session expired while the till was offline — a staff PIN session
       lasts 14 hours. Nothing is wrong with these sales; somebody just has to
       sign in again. Counting attempts here would burn through the retry budget
       and mark a whole shift's takings as broken. */
    if (res.status === 401 || res.status === 403) break;

    if (res.ok) {
      await removeQueuedSale(sale.key);
      posted++;
      continue;
    }

    /* A 5xx is the server having a bad moment, not the sale being wrong, so it
       stays retryable. A 4xx means this ticket will never post as-is. */
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    await markAttempt(sale, String(body.error || `Server said ${res.status}`));
    failed++;
    if (res.status >= 500) break;
  }

  return { posted, stuck, failed };
}
