"use client";

import { useEffect, useState } from "react";
import {
  Button, LinkButton, Field, Input, Card, Note, Icon, Modal,
} from "@/components/ui";

export default function VendorLoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  /* Forgot-password flow. This page sits outside <AppProviders>, so there is no
     toast or dialog context here — feedback is local state and a <Note>. */
  const [forgotOpen, setForgotOpen] = useState(false);
  const [forgotEmail, setForgotEmail] = useState("");
  const [forgotError, setForgotError] = useState("");
  const [forgotSent, setForgotSent] = useState("");
  const [forgotBusy, setForgotBusy] = useState(false);
  const [platform, setPlatform] = useState<"IOS" | "ANDROID" | "OTHER" | "INSTALLED">("OTHER");
  const [installEvt, setInstallEvt] = useState<{ prompt: () => Promise<void> } | null>(null);

  useEffect(() => {
    // which phone is this, and is the app already on the home screen?
    const ua = navigator.userAgent;
    const standalone = window.matchMedia("(display-mode: standalone)").matches
      || (navigator as unknown as { standalone?: boolean }).standalone === true;
    if (standalone) setPlatform("INSTALLED");
    else if (/iPhone|iPad|iPod/i.test(ua)) setPlatform("IOS");
    else if (/Android/i.test(ua)) setPlatform("ANDROID");
    const onPrompt = (e: Event) => {
      e.preventDefault();
      setInstallEvt(e as unknown as { prompt: () => Promise<void> });
    };
    window.addEventListener("beforeinstallprompt", onPrompt);
    return () => window.removeEventListener("beforeinstallprompt", onPrompt);
  }, []);

  useEffect(() => {
    // already logged in? go to the dashboard
    fetch("/api/vendor/me").then((r) => { if (r.ok) window.location.href = "/vendor"; });
  }, []);

  const login = async () => {
    setError(""); setBusy(true);
    const res = await fetch("/api/vendor/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    setBusy(false);
    if (!res.ok) {
      const data = await res.json();
      setError(data.error || "Login failed.");
      return;
    }
    window.location.href = "/vendor";
  };

  const openForgot = () => {
    setForgotEmail(email);
    setForgotError("");
    setForgotSent("");
    setForgotOpen(true);
  };

  const requestReset = async () => {
    setForgotError("");
    if (!forgotEmail.trim()) {
      setForgotError("Enter the email address you sign in with.");
      return;
    }
    setForgotBusy(true);
    try {
      const res = await fetch("/api/vendor/password-reset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: forgotEmail }),
      });
      const data = await res.json().catch(() => ({}));
      setForgotBusy(false);
      if (!res.ok) {
        setForgotError(data.error || "Couldn't send the reset link. Try again in a moment.");
        return;
      }
      /* Deliberately the same confirmation whether or not that address has an
         account — the server won't say, and neither will this. */
      setForgotSent(
        data.message ||
          "If that email is registered with the market, a reset link is on its way. Check your inbox — and your spam folder."
      );
    } catch {
      setForgotBusy(false);
      setForgotError("Couldn't reach the market just now. Check your connection and try again.");
    }
  };

  return (
    <main className="row center" style={{ minHeight: "100dvh", padding: "var(--sp-6) var(--sp-4)" }}>
      <div style={{ width: "100%", maxWidth: 400 }}>
        <div style={{ textAlign: "center", marginBottom: "var(--sp-6)" }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/logo.png" alt="" style={{ width: 96, height: 96, margin: "0 auto var(--sp-3)" }} />
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/wordmark.png"
            alt="Community Harvest"
            style={{ width: 210, maxWidth: "76%", height: "auto", margin: "0 auto" }}
          />
          <p className="t-label mt-2">Food and Craft Market</p>
          <p className="t-sm t-muted mt-1">Vendor portal</p>
        </div>

        <div className="card card-pad">
          <form className="stack g-4" onSubmit={(e) => { e.preventDefault(); void login(); }}>
            <Field label="Email" required>
              {(p) => (
                <Input
                  {...p}
                  type="email"
                  autoComplete="username"
                  inputMode="email"
                  autoCapitalize="none"
                  value={email}
                  onChange={(e) => { setEmail(e.target.value); setError(""); }}
                />
              )}
            </Field>

            <Field label="Password" required>
              {(p) => (
                <Input
                  {...p}
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => { setPassword(e.target.value); setError(""); }}
                />
              )}
            </Field>

            {error ? <Note tone="error">{error}</Note> : null}

            <Button type="submit" variant="primary" size="lg" block loading={busy} icon="unlock">
              {busy ? "Signing in…" : "Log in"}
            </Button>
          </form>

          <div className="mt-3" style={{ textAlign: "center" }}>
            <Button variant="ghost" size="sm" icon="help" onClick={openForgot}>
              Forgot your password?
            </Button>
          </div>

          <hr className="divider mt-4 mb-4" />

          {/* The old copy sent people to the market office for a new booth AND
              for a forgotten password. The application form has its own page,
              and the reset above is now self-serve — so staff are the fallback
              here, not the front door. */}
          <div className="stack g-3">
            <div className="stack g-1">
              <span className="t-label">No account yet?</span>
              <p className="t-sm t-secondary">
                Booth space is $150/mo for a 5×5. Apply online and the market gets back to you.
              </p>
              <div className="mt-1">
                <LinkButton href="/apply" variant="secondary" icon="contract" block>
                  Apply for a booth
                </LinkButton>
              </div>
            </div>

            <p className="t-xs t-muted">
              Still stuck after a reset? Ask any staff member at the market, or email the market
              office, and they&rsquo;ll get you back in.
            </p>
          </div>
        </div>

        {platform === "IOS" && (
          <div className="mt-4">
            <Card title="Put this on your home screen">
              <div className="stack g-3">
                <ol className="stack g-2 t-sm" style={{ margin: 0, paddingLeft: "1.1rem", listStyle: "decimal" }}>
                  <li>Tap the <b>Share</b> button below — the square with the up arrow.</li>
                  <li>Scroll down, tap <b>&ldquo;Add to Home Screen,&rdquo;</b> then <b>Add</b>.</li>
                  <li>Open the new icon — you get a real app, and sale alerts can buzz your phone.</li>
                </ol>
                <p className="t-xs t-muted">
                  Full guide with everything else: <a href="/guide">the vendor guide</a>.
                </p>
              </div>
            </Card>
          </div>
        )}

        {platform === "ANDROID" && (
          <div className="mt-4">
            <Card title="Put this on your home screen">
              <div className="stack g-3">
                {installEvt ? (
                  <div>
                    <Button variant="secondary" icon="download" onClick={() => installEvt.prompt()}>
                      Install the app — one tap
                    </Button>
                  </div>
                ) : (
                  <ol className="stack g-2 t-sm" style={{ margin: 0, paddingLeft: "1.1rem", listStyle: "decimal" }}>
                    <li>Tap the menu in the top-right corner of Chrome.</li>
                    <li>Tap <b>&ldquo;Add to Home screen&rdquo;</b> (or <b>&ldquo;Install app&rdquo;</b>) and confirm.</li>
                    <li>Open the new icon — a real app, and sale alerts can buzz your phone.</li>
                  </ol>
                )}
                <p className="t-xs t-muted">
                  Full guide with everything else: <a href="/guide">the vendor guide</a>.
                </p>
              </div>
            </Card>
          </div>
        )}

        {platform === "OTHER" && (
          <p className="t-xs t-muted mt-4" style={{ textAlign: "center" }}>
            <Icon name="help" size={12} /> Setting up on your phone? The full vendor guide is at{" "}
            <a href="/guide">/guide</a>.
          </p>
        )}
      </div>

      <Modal
        open={forgotOpen}
        onClose={() => setForgotOpen(false)}
        title="Reset your password"
        description={
          forgotSent
            ? undefined
            : "We'll email you a link to choose a new one. It's good for an hour."
        }
        width="sm"
        footer={
          forgotSent ? (
            <Button variant="primary" onClick={() => setForgotOpen(false)}>Done</Button>
          ) : (
            <>
              <Button variant="ghost" onClick={() => setForgotOpen(false)}>Cancel</Button>
              <Button variant="primary" loading={forgotBusy} icon="mail" onClick={() => void requestReset()}>
                {forgotBusy ? "Sending…" : "Email me a link"}
              </Button>
            </>
          )
        }
      >
        {forgotSent ? (
          <Note tone="success" title="Check your email">{forgotSent}</Note>
        ) : (
          <form
            className="stack g-4"
            onSubmit={(e) => { e.preventDefault(); void requestReset(); }}
          >
            <Field label="Email" hint="The address the market has on file for your booth." required>
              {(p) => (
                <Input
                  {...p}
                  type="email"
                  autoComplete="username"
                  inputMode="email"
                  autoCapitalize="none"
                  value={forgotEmail}
                  onChange={(e) => { setForgotEmail(e.target.value); setForgotError(""); }}
                />
              )}
            </Field>

            {forgotError ? <Note tone="error">{forgotError}</Note> : null}
          </form>
        )}
      </Modal>
    </main>
  );
}
