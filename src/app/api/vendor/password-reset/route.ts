import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { hashPassword, makeResetToken, verifyResetToken } from "@/lib/auth";
import { enforceRateLimit } from "@/lib/ratelimit";
import { runRoute } from "@/lib/handler";
import { sendVendorResetLinkEmail } from "@/lib/email";

/**
 * Self-serve vendor password reset.
 *
 *   POST { email }            → email a one-hour reset link (always generic)
 *   PUT  { token, password }  → set the new password
 *
 * No reset-token table: the link is a stateless signed token (see
 * makeResetToken / verifyResetToken in src/lib/auth.ts). It carries its own
 * expiry, and because the vendor's current password hash is inside the
 * signature it stops verifying the instant the password changes — so a link is
 * good once, for an hour, and nothing is persisted.
 */

// Tight: this endpoint sends mail to an address the caller supplies, so it is
// both an account-enumeration probe and a way to spam someone's inbox.
const REQUEST_LIMIT = { limit: 5, windowMs: 15 * 60 * 1000 };
// Forging a token means guessing a 256-bit HMAC, but don't let anyone grind.
const COMPLETE_LIMIT = { limit: 10, windowMs: 15 * 60 * 1000 };

/**
 * The single response every POST gets. Whether the address is registered,
 * inactive, locked out of the portal, or complete fiction, the caller is told
 * exactly this — otherwise the form becomes a "which of these emails has a
 * vendor account?" oracle.
 */
const GENERIC = "If that email is registered with the market, a reset link is on its way. Check your inbox — and your spam folder.";

export async function POST(req: NextRequest) {
  return runRoute("vendor/password-reset POST", async () => {
    const { email } = await req.json();
    const address = String(email || "").toLowerCase().trim();
    if (!address) return NextResponse.json({ error: "Enter the email address you sign in with." }, { status: 400 });

    const limited = await enforceRateLimit(req, "vendor-password-reset", address, REQUEST_LIMIT, "Too many reset requests.");
    if (limited) return limited;

    const vendor = await db.vendor.findUnique({ where: { email: address } });

    // Send only to a real, active vendor whose portal is actually open. A
    // portalLocked vendor has nothing to sign in to yet, so a reset link would
    // just be confusing — they get the same generic reply and no email.
    if (vendor && vendor.active && !vendor.portalLocked) {
      try {
        const token = makeResetToken(vendor.id, vendor.passwordHash);
        const base = process.env.NEXT_PUBLIC_BASE_URL || `https://${req.headers.get("host")}`;
        await sendVendorResetLinkEmail(vendor.email, vendor.businessName, `${base}/reset/${token}`);
      } catch (err) {
        // A mail or config failure must not change the shape or the timing
        // class of the answer — log it, tell the caller the same thing.
        console.error("[vendor/password-reset POST] could not send reset link:", err);
      }
    }

    return NextResponse.json({ ok: true, message: GENERIC });
  });
}

export async function PUT(req: NextRequest) {
  return runRoute("vendor/password-reset PUT", async () => {
    const { token, password } = await req.json();
    const raw = String(token || "");
    const next = String(password || "");

    // `code` lets the reset page tell "this link is dead, go get another" apart
    // from "fix this field and resubmit" without matching on message text.
    if (!raw) {
      return NextResponse.json(
        { error: "That reset link is incomplete. Request a new one from the login page.", code: "invalid_token" },
        { status: 400 }
      );
    }

    // Keyed on a prefix of the token rather than the whole thing, so an
    // attacker can't sidestep the limit by varying the signature each try.
    const limited = await enforceRateLimit(req, "vendor-password-reset-complete", raw.slice(0, 48), COMPLETE_LIMIT, "Too many attempts.");
    if (limited) return limited;

    if (next.length < 8) {
      return NextResponse.json(
        { error: "Your new password must be at least 8 characters.", code: "weak_password" },
        { status: 400 }
      );
    }

    const result = await verifyResetToken(raw);
    if (!result) {
      return NextResponse.json(
        {
          error: "This reset link has expired or has already been used. Request a fresh one from the login page.",
          code: "invalid_token",
        },
        { status: 400 }
      );
    }

    await db.vendor.update({
      where: { id: result.vendorId },
      data: { passwordHash: hashPassword(next), mustChangePassword: false },
    });

    // No session is issued here on purpose: setting a password shouldn't also
    // be a way in. They sign in at / with the password they just chose, which
    // also proves the new one works while the link is still fresh in mind.
    return NextResponse.json({ ok: true });
  });
}
