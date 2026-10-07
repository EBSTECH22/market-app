"use client";

/**
 * "Turn on alerts on this device" for office staff — owners AND managers.
 *
 * The only switch for this used to live in Settings, which managers can't
 * open, so a manager had no way to get job applications, vendor messages or
 * new vendor applications on their phone. This button goes on the screens
 * they do use.
 */
import { useEffect, useState } from "react";
import { Button, useToast } from "@/components/ui";
import { subscribeToPush } from "@/lib/pushclient";

export function AdminPushButton({ size = "sm" }: { size?: "sm" | "md" }) {
  const toast = useToast();
  const [key, setKey] = useState("");
  const [on, setOn] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void fetch("/api/admin/push").then(async (r) => {
      if (r.ok) setKey(String((await r.json()).publicKey || ""));
    }).catch(() => {});
    /* Already on here? Permission granted and a live subscription. */
    void (async () => {
      try {
        if (typeof Notification === "undefined" || Notification.permission !== "granted" || !("serviceWorker" in navigator)) return;
        const reg = await navigator.serviceWorker.getRegistration();
        const sub = await reg?.pushManager.getSubscription();
        if (sub) setOn(true);
      } catch { /* not supported */ }
    })();
  }, []);

  const enable = async () => {
    setBusy(true);
    try {
      const result = await subscribeToPush(key);
      if (!result.ok) { toast.error("Alerts not turned on", result.message); return; }
      const r = await fetch("/api/admin/push", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(result.subscription),
      });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        toast.error("Alerts not turned on", String(d.error || "The server wouldn't save it — try again."));
        return;
      }
      setOn(true);
      toast.success("Alerts on", "This device gets job applications, vendor messages and new vendor applications.");
    } finally { setBusy(false); }
  };

  return (
    <Button size={size} variant={on ? "ghost" : "secondary"} icon="bell" loading={busy} disabled={busy} onClick={() => void enable()}>
      {on ? "Alerts on here" : "Turn on alerts"}
    </Button>
  );
}
