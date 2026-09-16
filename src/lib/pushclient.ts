/**
 * Turning on push notifications in a browser, without the infinite spinner.
 *
 * THE BUG THIS EXISTS TO KILL: `navigator.serviceWorker.ready` is a promise
 * that resolves when a service worker is registered and active — and NEVER
 * REJECTS if one isn't. Nothing times it out. So a page that forgot to call
 * `register()`, or where registration quietly failed, awaits that promise
 * forever and the button spins until the tab is closed. There is no error, no
 * log, and nothing to tell the person what went wrong.
 *
 * Both portals had the same five-step dance copied out, so both had the same
 * hole. One implementation, one place to fix it.
 */

export type PushResult =
  | { ok: true; subscription: PushSubscriptionJSON }
  | { ok: false; reason: "unsupported" | "blocked" | "no-key" | "timeout" | "failed"; message: string };

const READY_TIMEOUT_MS = 10_000;

const IOS_HINT =
  "On an iPhone this needs iOS 16.4 or newer AND the app opened from a home-screen icon (Share → Add to Home Screen).";

/**
 * Base64url VAPID key → the bytes `subscribe()` wants.
 *
 * Returns a plain ArrayBuffer rather than a Uint8Array: newer TypeScript makes
 * Uint8Array generic over its backing buffer, and the generic form isn't
 * assignable to BufferSource. ArrayBuffer is, in every version.
 */
function vapidKeyBytes(base64: string): ArrayBuffer {
  const b64 = base64.replace(/-/g, "+").replace(/_/g, "/");
  const pad = "=".repeat((4 - (b64.length % 4)) % 4);
  const raw = atob(b64 + pad);
  const buffer = new ArrayBuffer(raw.length);
  const view = new Uint8Array(buffer);
  for (let i = 0; i < raw.length; i++) view[i] = raw.charCodeAt(i);
  return buffer;
}

/**
 * Register the worker and wait for it, but give up rather than hang.
 *
 * `register()` is called here rather than assumed, because the caller having
 * done it somewhere else is exactly the assumption that broke: the admin page
 * registered inside an effect gated on a role check, that check stopped
 * matching when accounts gained roles, and the button spun forever.
 */
async function readyWorker(): Promise<ServiceWorkerRegistration | null> {
  try {
    await navigator.serviceWorker.register("/sw.js");
  } catch {
    // An existing registration is fine; a failed one is caught by the race.
  }
  let timer: number | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = window.setTimeout(() => resolve(null), READY_TIMEOUT_MS);
  });
  try {
    return await Promise.race([navigator.serviceWorker.ready, timeout]);
  } finally {
    if (timer !== undefined) window.clearTimeout(timer);
  }
}

/**
 * Ask for permission, subscribe, and hand back something postable.
 *
 * Every failure is a named reason with a sentence a person can act on. The
 * caller never has to guess why nothing happened.
 */
export async function subscribeToPush(vapidPublicKey: string): Promise<PushResult> {
  if (typeof window === "undefined" || !("Notification" in window) || !("serviceWorker" in navigator)) {
    return { ok: false, reason: "unsupported", message: `This browser can't do notifications. ${IOS_HINT}` };
  }
  if (!("PushManager" in window)) {
    return { ok: false, reason: "unsupported", message: `This browser can't do push notifications. ${IOS_HINT}` };
  }

  /* Checked BEFORE prompting for permission. Asking someone to allow
     notifications and then failing on a missing server key is the rudest
     possible order to do this in. */
  if (!vapidPublicKey) {
    return {
      ok: false,
      reason: "no-key",
      message:
        "Notifications aren't set up on the server yet — VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY need to be in the project's environment variables.",
    };
  }

  let permission: NotificationPermission;
  try {
    permission = await Notification.requestPermission();
  } catch {
    return { ok: false, reason: "blocked", message: "This browser wouldn't show the notifications prompt." };
  }
  if (permission !== "granted") {
    return {
      ok: false,
      reason: "blocked",
      message:
        permission === "denied"
          ? "Notifications are blocked for this site. Allow them in your browser settings for this site, then try again."
          : "The notifications prompt was dismissed — try again and choose Allow.",
    };
  }

  const reg = await readyWorker();
  if (!reg) {
    return {
      ok: false,
      reason: "timeout",
      message: `The background helper this needs didn't start. Reload the page and try once more. ${IOS_HINT}`,
    };
  }

  try {
    const existing = await reg.pushManager.getSubscription();
    // Re-subscribing on a device that already has one is how you end up with
    // a stale endpoint that silently stops delivering.
    const sub =
      existing ??
      (await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: vapidKeyBytes(vapidPublicKey),
      }));
    return { ok: true, subscription: sub.toJSON() };
  } catch (err) {
    const detail = err instanceof Error && err.message ? ` (${err.message})` : "";
    return { ok: false, reason: "failed", message: `Couldn't turn notifications on here${detail}. ${IOS_HINT}` };
  }
}
