"use client";

import { useState } from "react";
import { Button, Card, Field, Icon, Input, LinkButton, Note } from "@/components/ui";

/**
 * Landing page for the link in sendVendorResetLinkEmail.
 *
 * The token is never checked on render — nothing is validated until the vendor
 * submits a new password, so opening the link (or a mail client prefetching it)
 * changes nothing. An expired or already-used token comes back as `expired`
 * from the PUT and we point them at a fresh request instead of a dead end.
 */
export default function VendorPasswordResetPage({ params }: { params: { token: string } }) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [lengthError, setLengthError] = useState("");
  const [matchError, setMatchError] = useState("");
  const [expired, setExpired] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  const clearErrors = () => {
    setError("");
    setLengthError("");
    setMatchError("");
  };

  const submit = async () => {
    clearErrors();

    if (password.length < 8) {
      setLengthError("Pick a password of at least 8 characters.");
      return;
    }
    if (password !== confirm) {
      setMatchError("These two don't match. Retype them and they'll go through.");
      return;
    }

    setBusy(true);
    try {
      const res = await fetch("/api/vendor/password-reset", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: params.token, password }),
      });
      const data = await res.json().catch(() => ({}));
      setBusy(false);

      if (!res.ok) {
        // `invalid_token` means the link itself is dead — expired, or already
        // used, which unsigns it. Swap the whole page rather than showing an
        // error above a form that can never succeed.
        if (data.code === "invalid_token") {
          setExpired(true);
          return;
        }
        setError(data.error || "Couldn't set your new password. Try again.");
        return;
      }
      setDone(true);
    } catch {
      setBusy(false);
      setError("Couldn't reach the market just now. Check your connection and try again.");
    }
  };

  return (
    <main className="public-wrap public-narrow">
      <div className="hero">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/wordmark.png"
          alt="Community Harvest"
          style={{ width: 190, maxWidth: "62%", height: "auto", margin: "0 auto var(--sp-4)", display: "block" }}
        />
        <h1 className="hero-title">
          {done ? "Your password is set" : expired ? "This link no longer works" : "Choose a new password"}
        </h1>
        <p className="hero-sub">
          {done
            ? "Sign in with your new password and you're back in your vendor portal."
            : expired
            ? "Reset links last an hour, and they stop working once a password has been changed."
            : "Pick something you'll remember. You'll use it to sign in to your vendor portal."}
        </p>
      </div>

      {!done && !expired && (
        <Card title="New password">
          <form
            className="stack g-4"
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
          >
            <Field label="New password" hint="At least 8 characters." required error={lengthError}>
              {(p) => (
                <Input
                  {...p}
                  type="password"
                  autoComplete="new-password"
                  value={password}
                  onChange={(e) => {
                    setPassword(e.target.value);
                    clearErrors();
                  }}
                />
              )}
            </Field>

            <Field label="Confirm new password" required error={matchError}>
              {(p) => (
                <Input
                  {...p}
                  type="password"
                  autoComplete="new-password"
                  value={confirm}
                  onChange={(e) => {
                    setConfirm(e.target.value);
                    clearErrors();
                  }}
                />
              )}
            </Field>

            {error ? <Note tone="error">{error}</Note> : null}

            <Button type="submit" variant="primary" size="lg" block loading={busy} icon="lock">
              {busy ? "Saving…" : "Save new password"}
            </Button>
          </form>
        </Card>
      )}

      {done && (
        <Card>
          <div className="stack g-4" style={{ textAlign: "center" }}>
            <span style={{ color: "var(--accent)", display: "block" }}>
              <Icon name="checkCircle" size={34} />
            </span>
            <p className="t-body t-secondary" style={{ margin: 0 }}>
              Your vendor portal password has been changed. For safety, the link in your email won&rsquo;t work
              again &mdash; if you ever need another one, ask for it from the login page.
            </p>
            <LinkButton href="/" variant="primary" size="lg" block icon="unlock">
              Go to the login page
            </LinkButton>
          </div>
        </Card>
      )}

      {expired && (
        <Card>
          <div className="stack g-4">
            <Note tone="warn" title="Nothing has changed">
              Your password is still the old one. This usually means the link sat in your inbox for more than an
              hour, or a newer reset link replaced it. Requesting a new one takes a few seconds.
            </Note>
            <LinkButton href="/" variant="primary" size="lg" block icon="mail">
              Request a new reset link
            </LinkButton>
            <p className="t-xs t-muted" style={{ textAlign: "center", margin: 0 }}>
              On the login page, use &ldquo;Forgot your password?&rdquo; to have a fresh link emailed to you.
            </p>
          </div>
        </Card>
      )}
    </main>
  );
}
