import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { verifyPassword, vendorCookie, SESSION_COOKIE_OPTIONS, SESSION_MAX_AGE_SECONDS } from "@/lib/auth";
import { enforceRateLimit, LIMITS } from "@/lib/ratelimit";
import { runRoute } from "@/lib/handler";

export async function POST(req: NextRequest) {
  return runRoute("vendor/login POST", async () => {
    const { email, password } = await req.json();
    if (!email || !password) return NextResponse.json({ error: "Email and password required." }, { status: 400 });

    const limited = await enforceRateLimit(req, "vendor-login", String(email), LIMITS.login, "Too many sign-in attempts.");
    if (limited) return limited;

    const vendor = await db.vendor.findUnique({ where: { email: String(email).toLowerCase().trim() } });
    if (!vendor || !vendor.active || !verifyPassword(String(password), vendor.passwordHash)) {
      return NextResponse.json({ error: "Wrong email or password." }, { status: 401 });
    }
    if (vendor.portalLocked) {
      /* The old message assumed the only reason to be locked was an unsigned
         agreement. A vendor who HAD signed and just hadn't paid was told to go
         find their signing link — which reads like their signature failed, and
         sent them to the phone. Say which of the two it actually is. */
      const contract = await db.contract.findFirst({
        where: { vendorId: vendor.id, status: { notIn: ["VOIDED", "ENDED", "WITHDRAWN"] } },
        orderBy: { createdAt: "desc" },
        select: { vendorSignedAt: true, marketSignedAt: true },
      });
      const executed = !!contract?.vendorSignedAt && !!contract?.marketSignedAt;

      if (executed) {
        const agg = await db.ledgerEntry.aggregate({
          where: { vendorId: vendor.id },
          _sum: { amountCents: true },
        });
        const balance = agg._sum.amountCents || 0;
        const due = balance < 0 ? -balance : 0;
        return NextResponse.json({
          error: due > 0
            ? `We have your signed agreement — thank you. Your portal opens as soon as the first month's rent of $${(due / 100).toFixed(2)} is paid. The pay link is in your email, or pay at the front desk.`
            : "We have your signed agreement and your payment — your portal is being set up. Check your email for your login details, or ask us at the market.",
        }, { status: 403 });
      }

      if (contract?.vendorSignedAt && !contract?.marketSignedAt) {
        return NextResponse.json({
          error: "We have your signature — the market still needs to countersign. You'll get an email the moment it's done.",
        }, { status: 403 });
      }

      return NextResponse.json({
        error: "Your portal opens once your booth agreement is signed — check your email for the signing link, or ask us at the market.",
      }, { status: 403 });
    }

    const res = NextResponse.json({ ok: true });
    const c = vendorCookie(vendor.id);
    res.cookies.set(c.name, c.value, { ...SESSION_COOKIE_OPTIONS, maxAge: SESSION_MAX_AGE_SECONDS.vendor });
    return res;
  });
}
