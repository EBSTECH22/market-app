"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { usePulse } from "@/lib/usePulse";
import {
  Icon, Button, IconButton, LinkButton, Field, Input, Select, Textarea, MoneyInput, SearchInput,
  Checkbox, ToggleTile, Segmented, Modal, Panel, useDialog, useToast,
  DataTable, DescList, Badge, Card, Stat, EmptyState, Note, Skeleton,
  SkeletonStats, PageHeader, type Column, type IconName, type BadgeTone,
} from "@/components/ui";
import { money, fmtDate, fmtDateShort, fmtDateTime, fmtTime, relTime, isoDate, isoDateTime, fmtPhone, plural, dollarsToCents } from "@/lib/format";
import { TZ, centralDayStart } from "@/lib/time";
import { useHashTab } from "@/lib/useHashTab";
import { CashTender } from "@/components/register/CashTender";
import { taxFor, displayRate, normalizeTaxClass } from "@/lib/tax";
import { subscribeToPush } from "@/lib/pushclient";
import { type Capability, type Role, ROLE_LABEL, ROLE_BLURB } from "@/lib/roles";
import { auditLabel, actorLabel } from "@/lib/auditkinds";
import { newSaleKey } from "@/lib/offline";

type Vendor = { id: string; code: string; businessName: string; contactName: string; email: string; phone: string; commissionPercent: number; active: boolean; allowSelfCheckout: boolean; balance: number; applicationId?: string | null; portalLocked?: boolean; hasSignedContract?: boolean };
type FloorItem = { id: string; sku: string; name: string; priceCents: number; basePriceCents?: number; salePercent?: number; quantity: number; taxClass?: string; vendorName: string; vendorCode: string; lowStockAt?: number };
type Overview = { today: { count: number; totalCents: number; taxCents: number }; month: { count: number; totalCents: number; taxCents: number }; vendors: number; floor: FloorItem[] };
type CartLine = { itemId: string; sku: string; name: string; vendorName: string; priceCents: number; basePriceCents?: number; quantity: number; taxClass?: string };
/** Computed server-side in /api/admin/contracts — see src/lib/agreement.ts. */
type Delivery = {
  state: "DRAFT" | "SENT" | "OPENED" | "SIGNED" | "EXECUTED";
  label: string;
  sentAt: string | null;
  viewedAt: string | null;
  daysSinceSent: number | null;
  daysSinceOpened: number | null;
  stale: boolean;
};

const DELIVERY_TONE: Record<Delivery["state"], BadgeTone> = {
  DRAFT: "neutral", SENT: "info", OPENED: "warn", SIGNED: "info", EXECUTED: "success",
};
const DELIVERY_ICON: Record<Delivery["state"], IconName> = {
  DRAFT: "clipboard", SENT: "mail", OPENED: "eye", SIGNED: "check", EXECUTED: "checkCircle",
};

/** Where an agreement is, and when it last moved. The whole point is the
    second line: "Opened" without a timestamp doesn't tell you whether to
    chase them today or leave it another day. */
function DeliveryCell({ d }: { d: Delivery | undefined }) {
  if (!d) return <Badge tone="neutral" dot>Unknown</Badge>;
  const when =
    d.state === "OPENED" && d.viewedAt
      ? `Opened ${relTime(d.viewedAt)} · ${fmtDateTime(d.viewedAt)}`
      : (d.state === "SIGNED" || d.state === "EXECUTED") && d.viewedAt
        ? `Opened ${fmtDateShort(d.viewedAt)}`
        : d.state === "SENT" && d.sentAt
          ? `Sent ${relTime(d.sentAt)} · never opened`
          : d.state === "DRAFT"
            ? "Not emailed yet"
            : null;
  return (
    <div className="stack g-1" style={{ minWidth: 0 }}>
      <span className="row g-1 wrap">
        <Badge tone={DELIVERY_TONE[d.state]} icon={DELIVERY_ICON[d.state]}>{d.label}</Badge>
        {d.stale ? (
          <Badge tone="danger" icon="warning">
            {plural(d.daysSinceSent ?? 0, "day")} out
          </Badge>
        ) : null}
      </span>
      {when ? <span className="t-xs t-muted truncate">{when}</span> : null}
    </div>
  );
}

type Contract = { id: string; vendorId: string; boothLabel: string; monthlyRentCents: number; startDate: string; status: string; noticeGivenAt: string | null; endDate: string | null; vendorSignedAt: string | null; marketSignedAt: string | null; viewedAt?: string | null; signToken?: string | null; vendor: { businessName: string; code: string; cardLast4?: string }; vendorBalanceCents?: number; rentChargedCents?: number; rentPaidCents?: number; rentDueCents?: number; delivery?: Delivery; invoiceViews?: { count: number; lastAt: string | null; tracked?: boolean } };

/** One recorded open of a vendor's invoice — /api/admin/contracts/{id}/views. */
type InvoiceView = { id: string; viewedAt: string; userAgent: string | null };

/** A user-agent string is noise to the person reading this log; the only
    honest thing it answers is "phone or computer". Everything else stays
    hidden rather than being paraded as precision we don't have. */
function deviceFromUA(ua: string | null | undefined): string {
  const s = (ua || "").toLowerCase();
  if (s.includes("iphone")) return "iPhone";
  if (s.includes("ipad")) return "iPad";
  if (s.includes("android")) return "Android";
  /* iPadOS reports "Macintosh", so this has to come after the iPad check. */
  if (s.includes("macintosh") || s.includes("mac os")) return "Mac";
  if (s.includes("windows")) return "Windows";
  return "Other";
}

/** Has the vendor actually looked at the invoice we sent them? Only worth
    showing once the agreement is executed — before that there's no invoice.
    Admin previews are never logged, so a zero here really means zero. */
/**
 * Invoice open status — but only where it means something.
 *
 * Three ways "no opens" can be true and only one is worth chasing:
 *   - they've already paid, so whether they opened it is moot
 *   - their invoice predates view tracking, so nobody was watching
 *   - they owe money, we were watching, and they haven't looked
 * Showing "not opened" for the first two told the owner a vendor was
 * ignoring an invoice they'd actually settled weeks ago.
 */
/* Rows come from /api/admin/rent-ledger — one row per executed agreement, which
   is the same thing as one invoice sent. */
type InvoiceRow = {
  contractId: string; vendorId: string; code: string; businessName: string;
  email: string; phone: string; boothLabel: string; signToken: string;
  monthlyRentCents: number; contractStatus: string; executedAt: string | null;
  chargedCents: number; paidCents: number; paymentCount: number;
  balanceCents: number; outstandingCents: number;
  /* Rent charged minus rent paid — what the badge is actually about. The old
     badge read the whole account balance, so it flipped back to Unpaid the
     moment anything else moved: next month's rent, a payout, an adjustment. */
  rentDueCents: number;
  boothsOnAccount: number;
  coveredBy: "SALES" | "ADJUSTMENT";
  status: "PAID" | "PARTIAL" | "UNPAID" | "COVERED" | "NOT_INVOICED";
  lastPaymentAt: string | null; lastChargeAt: string | null; cardLast4: string;
  opens: { count: number; lastAt: string | null; tracked: boolean };
};

type RentLedger = {
  invoices: InvoiceRow[];
  neverPaid: InvoiceRow[];
  totals: {
    invoicedCents: number; collectedCents: number; outstandingCents: number;
    rentDueCents: number; unpaidCount: number; neverPaidCount: number;
  };
  trackingSince: string;
};

type BankState = {
  configured: boolean;
  available?: number;
  pending?: number;
  payouts?: { id: string; amount: number; status: string; arrival: string }[];
  error?: string;
} | null;

/** A Stripe payout that hasn't landed yet. */
const isIncoming = (p: { status: string }) => p.status === "pending" || p.status === "in_transit";

/**
 * "Friday, Sep 19" rather than "Sep 19, 2026".
 *
 * A deposit date is read to answer "is that before or after the weekend", and
 * nobody does that arithmetic from a numeral. The weekday is the useful half.
 */
const fmtArrival = (iso: string): string => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric", timeZone: TZ });
};

/**
 * The top of the money page: three questions, answered before any scrolling.
 *
 *   1. How much is coming into my bank, and what day?
 *   2. Who has paid their rent and who hasn't?
 *   3. What are the totals?
 *
 * All of it was already on this page and all of it was findable — spread over
 * six cards in an order that made sense to whoever built them and to nobody
 * standing there wanting to know whether Thursday's deposit covers payroll.
 * Nothing new is fetched here; it is the same numbers, put where the eye lands
 * first and said in words rather than left to be inferred from a table.
 */
type Upcoming = {
  stripeError: string;
  availableCents: number;
  deposits: { id: string; amountCents: number; status: string; arrival: string }[];
  depositTotalCents: number;
  rent: {
    runAt: string; monthLabel: string; totalCents: number; chargeCount: number;
    lines: {
      contractId: string; vendorName: string; vendorCode: string; boothLabel: string;
      amountCents: number; monthlyRentCents: number; action: string; reason: string;
      nextChargeAt: string | null; nextChargeCents: number; nextChargeReason: string;
      creditDays: number; afterCreditCents: number | null;
    }[];
  };
  closedDays: {
    opensAt: string | null;
    appliedAt: string | null;
    rows: { contractId: string; vendorName: string; boothLabel: string; startDate: string; monthlyRentCents: number; days: number }[];
    estimatedCreditCents: number;
  };
  payout: {
    day: number; nextAt: string | null; owedCents: number; vendorCount: number; notSetUpCents: number;
    rows: { vendorId: string; vendorName: string; vendorCode: string; balanceCents: number; payoutsEnabled: boolean }[];
  };
};

/** Whole days from now until a date, in market time. Negative once it's past. */
const daysUntil = (iso: string): number => {
  const then = new Date(iso).getTime();
  return Math.ceil((then - Date.now()) / (24 * 60 * 60 * 1000));
};

const inWords = (iso: string): string => {
  const d = daysUntil(iso);
  if (d <= 0) return "today";
  if (d === 1) return "tomorrow";
  return `in ${d} days`;
};

/**
 * What is going to happen, before it happens.
 *
 * The rest of this page is a record of things that already have. That is fine
 * for the books and useless for deciding whether Thursday's deposit covers
 * Friday's payout run — a question that is entirely about the future and was
 * previously answerable only by opening Stripe in one tab, counting booths in
 * another, and knowing by heart that rent posts at one in the morning on the
 * 1st.
 *
 * The rent figures are not an estimate. They come from the same planner the
 * cron executes, so what is listed here is what will post.
 */
function UpcomingMoney({
  data, busy, onSave, onCredit,
}: {
  data: Upcoming | null;
  busy: boolean;
  onSave: (opensAt: string, payoutDay: number) => void;
  onCredit: () => void;
}) {
  /* Open by default. A preview you have to click to see is a preview nobody
     reads, which is how a charge date nobody knew about gets discovered by the
     vendor it happened to. */
  const [showRent, setShowRent] = useState(true);
  const [showOwed, setShowOwed] = useState(false);
  const [opensDraft, setOpensDraft] = useState("");
  const [dayDraft, setDayDraft] = useState("");

  /* Drafts start from the saved values, and only once — typing must not be
     undone by the next background refresh. */
  useEffect(() => {
    if (!data) return;
    setOpensDraft((v) => v || (data.closedDays.opensAt ? isoDate(new Date(data.closedDays.opensAt)) : ""));
    setDayDraft((v) => v || (data.payout.day ? String(data.payout.day) : ""));
  }, [data]);

  if (!data) {
    return (
      <Card title="What's coming" subtitle="Deposits, the rent run, and the next payout.">
        <div className="stack g-2" aria-busy="true"><Skeleton height={16} /><Skeleton height={56} /><Skeleton height={56} /></div>
      </Card>
    );
  }

  const { deposits, rent, payout, closedDays } = data;
  const creditPending = closedDays.rows.length > 0 && !closedDays.appliedAt;

  return (
    <Card
      title="What's coming"
      subtitle="Every dated thing on the money calendar — what lands in your bank, what gets charged, what goes out."
    >
      <div className="stack g-5">
        {data.stripeError ? <Note tone="warn">{data.stripeError}</Note> : null}

        {/* ---- deposits ------------------------------------------------- */}
        <div className="stack g-2">
          <div className="row between wrap g-2">
            <span className="t-label">Deposits into your bank</span>
            <span className="t-sm num">
              <b>{money(data.depositTotalCents)}</b> across {plural(deposits.length, "deposit")}
            </span>
          </div>

          {deposits.length === 0 ? (
            <span className="t-sm t-muted">
              Nothing scheduled. {money(data.availableCents)} is sitting settled in Stripe and will go out on the next
              deposit.
            </span>
          ) : (
            <div className="stack g-1">
              {deposits.map((d) => (
                <div key={d.id} className="row between wrap g-3" style={{ padding: "var(--sp-2) 0", borderBottom: "1px solid var(--border-subtle)" }}>
                  <span className="row g-2 wrap" style={{ alignItems: "baseline" }}>
                    <b>{fmtArrival(d.arrival)}</b>
                    <span className="t-xs t-muted">{inWords(d.arrival)}</span>
                    <Badge tone={d.status === "in_transit" ? "success" : "info"} dot>
                      {d.status === "in_transit" ? "Sent" : "Scheduled"}
                    </Badge>
                  </span>
                  <span className="num">{money(d.amountCents)}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* ---- rent run -------------------------------------------------- */}
        <div className="stack g-2">
          <div className="row between wrap g-2">
            <span className="t-label">Rent charges out to vendors</span>
            <Button size="sm" variant="ghost" onClick={() => setShowRent((v) => !v)}>
              {showRent ? "Hide the breakdown" : "See every booth"}
            </Button>
          </div>

          <Note tone={creditPending ? "warn" : "info"}>
            <b>{money(rent.totalCents)}</b> posts automatically on <b>{fmtArrival(rent.runAt)}</b> ({inWords(rent.runAt)}),
            across {plural(rent.chargeCount, "booth")}. Nothing is taken from anyone&rsquo;s card — it lands on their
            ledger and their invoice. You&rsquo;ll get an email listing it the morning it runs.
          </Note>

          {creditPending ? (
            <Note tone="warn" title="Closed days not credited yet">
              {plural(closedDays.rows.length, "agreement")} started before the market opened
              {closedDays.opensAt ? ` on ${fmtArrival(closedDays.opensAt)}` : ""}, so those vendors paid a full month
              covering days there was no market. Crediting the days moves each one&rsquo;s prepaid date forward, which
              makes the next run bill them for that many days fewer — roughly{" "}
              <b>{money(closedDays.estimatedCreditCents)}</b> in total. Check the list below before you apply it;
              it can only be done once.
            </Note>
          ) : closedDays.appliedAt ? (
            <span className="t-xs t-muted">
              Closed days were credited {relTime(closedDays.appliedAt)} — the amounts above already reflect it.
            </span>
          ) : null}

          {creditPending ? (
            <div className="stack g-2">
              <DataTable
                rows={closedDays.rows}
                rowKey={(r) => r.contractId}
                mobileCards
                dense
                caption="Agreements that started before the market opened"
                columns={[
                  { key: "v", header: "Vendor", primary: true, sortBy: (r) => r.vendorName, cell: (r) => <b>{r.vendorName}</b> },
                  { key: "b", header: "Booth", cell: (r) => <span className="mono">{r.boothLabel}</span> },
                  { key: "s", header: "Lease started", sortBy: (r) => r.startDate, cell: (r) => fmtDateShort(r.startDate) },
                  { key: "d", header: "Days owed back", align: "right", sortBy: (r) => r.days, cell: (r) => <b className="num">{r.days}</b> },
                  {
                    key: "w", header: "Worth about", align: "right",
                    sortBy: (r) => r.days * r.monthlyRentCents,
                    cell: (r) => <span className="num">{money(Math.round((r.monthlyRentCents * r.days) / 30))}</span>,
                  },
                ]}
              />
              <div>
                <Button variant="primary" icon="check" disabled={busy} onClick={onCredit}>
                  Credit these closed days
                </Button>
              </div>
            </div>
          ) : null}

          {showRent ? (
            <>
              <span className="t-xs t-muted">
                Two different months. <b>On {fmtDateShort(rent.runAt)}</b> is what this run posts —
                &ldquo;nothing due&rdquo; means they already paid that month up front, not that they never get
                charged. <b>Then charged</b> is the next date they actually are, and what it will be. A charge
                posts whether or not their last invoice was paid; paying one never moves a charge date.
              </span>
              <DataTable
                rows={rent.lines}
              rowKey={(r) => r.contractId}
              mobileCards
              dense
                defaultSort={{ key: "next", dir: "asc" }}
                caption={`What the ${rent.monthLabel} rent run will charge each booth, and when each one is next charged`}
              columns={[
                { key: "v", header: "Vendor", primary: true, sortBy: (r) => r.vendorName, cell: (r) => <b>{r.vendorName}</b> },
                { key: "b", header: "Booth", cell: (r) => <span className="mono">{r.boothLabel}</span> },
                {
                  /* The header carries the DATE. Without it the column read as
                     "will charge: nothing" with no when attached, and a row
                     saying "next charge Nov 1, $216" next to "Nothing" looks
                     like a contradiction rather than two different months. */
                  key: "amt",
                  header: `On ${fmtDateShort(rent.runAt)}`,
                  mobileLabel: `On ${fmtDateShort(rent.runAt)}`,
                  align: "right",
                  sortBy: (r) => r.amountCents,
                  cell: (r) =>
                    r.amountCents === 0 ? (
                      <Badge tone="neutral">Nothing due</Badge>
                    ) : (
                      <span className="stack g-1" style={{ alignItems: "flex-end" }}>
                        <b className="num">{money(r.amountCents)}</b>
                        {r.amountCents !== r.monthlyRentCents ? (
                          <span className="t-xs t-muted num">of {money(r.monthlyRentCents)}</span>
                        ) : null}
                      </span>
                    ),
                },
                {
                  /* For anyone skipped by this run — still inside the month they
                     prepaid — this is the date that actually answers "when do
                     they next get billed", and it is why the table is here. */
                  key: "next", header: "Then charged", align: "right",
                  sortBy: (r) => r.nextChargeAt || "9999",
                  cell: (r) =>
                    !r.nextChargeAt ? (
                      <span className="t-xs t-muted">Not charged again</span>
                    ) : (
                      <span className="stack g-1" style={{ alignItems: "flex-end" }}>
                        <b>{fmtDate(r.nextChargeAt)}</b>
                        {r.creditDays > 0 && r.afterCreditCents !== null ? (
                          <>
                            <span className="t-xs t-muted num" style={{ textDecoration: "line-through" }}>
                              {money(r.nextChargeCents)}
                            </span>
                            <span className="t-xs num" style={{ color: "var(--accent-text)" }}>
                              {money(r.afterCreditCents)} after credit
                            </span>
                          </>
                        ) : (
                          <span className="t-xs t-muted num">{money(r.nextChargeCents)}</span>
                        )}
                      </span>
                    ),
                },
                { key: "why", header: "Why", cell: (r) => <span className="t-xs t-muted">{r.reason}</span> },
                ]}
              />
            </>
          ) : null}
        </div>

        {/* ---- payouts --------------------------------------------------- */}
        <div className="stack g-2">
          <div className="row between wrap g-2">
            <span className="t-label">Money out to vendors</span>
            <Button size="sm" variant="ghost" onClick={() => setShowOwed((v) => !v)}>
              {showOwed ? "Hide who's owed" : "See who's owed"}
            </Button>
          </div>

          <Note tone="info">
            <b>{money(payout.owedCents)}</b> is owed to {plural(payout.vendorCount, "vendor")} right now.
            {payout.nextAt
              ? <> Your payout day is the {payout.day}<sup>th</sup>, so the next run is <b>{fmtArrival(payout.nextAt)}</b> ({inWords(payout.nextAt)}).</>
              : " No payout day is set, so nothing is scheduled — set one below and this counts down to it."}
            {payout.notSetUpCents > 0
              ? ` ${money(payout.notSetUpCents)} of it belongs to vendors who haven't finished connecting a bank account, so it can't be sent automatically.`
              : ""}
          </Note>

          {payout.owedCents > data.availableCents + data.depositTotalCents ? (
            <Note tone="warn">
              You owe more than Stripe is holding for you — {money(payout.owedCents)} out against{" "}
              {money(data.availableCents + data.depositTotalCents)} available and on its way.
            </Note>
          ) : null}

          {showOwed ? (
            <DataTable
              rows={payout.rows}
              rowKey={(r) => r.vendorId}
              mobileCards
              defaultSort={{ key: "bal", dir: "desc" }}
              caption="Vendors the market currently owes"
              columns={[
                { key: "v", header: "Vendor", primary: true, sortBy: (r) => r.vendorName, cell: (r) => <b>{r.vendorName}</b> },
                { key: "c", header: "Code", cell: (r) => <span className="mono t-muted">{r.vendorCode}</span> },
                {
                  key: "s", header: "Bank",
                  cell: (r) => r.payoutsEnabled
                    ? <Badge tone="success" dot>Connected</Badge>
                    : <Badge tone="neutral" dot>Not set up</Badge>,
                },
                { key: "bal", header: "Owed", align: "right", sortBy: (r) => r.balanceCents, cell: (r) => <b className="num">{money(r.balanceCents)}</b> },
              ]}
            />
          ) : null}
        </div>

        {/* ---- the two dates everything above is measured from ----------- */}
        <div className="stack g-3" style={{ borderTop: "1px solid var(--border)", paddingTop: "var(--sp-4)" }}>
          <span className="t-label">The calendar</span>
          <div className="row wrap g-4" style={{ alignItems: "flex-end" }}>
            <Field label="Market opening day" hint="Used only to work out the closed-day credit.">
              {(p) => (
                <Input {...p} type="date" value={opensDraft} onChange={(e) => setOpensDraft(e.target.value)} style={{ width: 180 }} />
              )}
            </Field>
            <Field label="Pay vendors on day" hint="1–28. Blank or 0 for no fixed day.">
              {(p) => (
                <Input {...p} type="number" min="0" max="28" inputMode="numeric" value={dayDraft} onChange={(e) => setDayDraft(e.target.value)} style={{ width: 110 }} />
              )}
            </Field>
            <Button variant="secondary" disabled={busy} onClick={() => onSave(opensDraft, Number(dayDraft) || 0)}>
              Save dates
            </Button>
          </div>
        </div>
      </div>
    </Card>
  );
}

function MoneyAtAGlance({
  bank, ledger, payouts,
}: {
  bank: BankState;
  ledger: RentLedger | null;
  payouts: PayoutRow[];
}) {
  const deposits = (bank?.payouts || []).filter(isIncoming).slice().sort((a, b) => a.arrival.localeCompare(b.arrival));
  const incomingCents = deposits.reduce((n, p) => n + p.amount, 0);
  const next = deposits[0] || null;

  const t = ledger?.totals;
  const collected = t?.collectedCents ?? 0;
  const owed = t?.rentDueCents ?? 0;
  const invoiced = t?.invoicedCents ?? 0;

  /* Per VENDOR, not per booth. A vendor renting two booths has two rows and
     one bill, and counting the rows would report more payers than exist. */
  const perVendor = new Map<string, InvoiceRow>();
  for (const i of ledger?.invoices || []) if (!perVendor.has(i.vendorId)) perVendor.set(i.vendorId, i);
  const billed = [...perVendor.values()].filter((i) => i.status !== "NOT_INVOICED");
  const settled = billed.filter((i) => i.status === "PAID" || i.status === "COVERED").length;

  /* Denominator is what has actually been billed, so an empty month shows an
     empty bar rather than dividing by zero and rendering NaN%. */
  const paidPct = invoiced > 0 ? Math.round((Math.min(collected, invoiced) / invoiced) * 100) : 0;

  const owedOut = payouts.filter((p) => p.status === "PENDING").reduce((n, p) => n + p.netCents, 0);
  const owedOutCount = payouts.filter((p) => p.status === "PENDING").length;

  return (
    <Card
      title="Where your money is"
      subtitle="Coming in, going out, and who still owes you — everything below is the detail behind these four numbers."
    >
      <div className="stack g-5">
        <div className="grid-auto" style={{ ["--min" as string]: "210px" }}>
          <Stat
            feature
            label="Heading to your bank"
            value={money(incomingCents)}
            sub={
              next
                ? `${deposits.length > 1 ? `Next of ${deposits.length}: ` : ""}${fmtArrival(next.arrival)}`
                : "Nothing on its way right now"
            }
            icon="bank"
          />
          <Stat
            label="Sitting in Stripe"
            value={money(bank?.available || 0)}
            sub="Settled — goes out on the next deposit"
            icon="dollar"
          />
          <Stat
            label="Still clearing"
            value={money(bank?.pending || 0)}
            sub="Card money Stripe hasn't settled yet"
            icon="clock"
          />
          <Stat
            label="Rent still owed to you"
            value={money(owed)}
            sub={owed > 0 ? `${plural(t?.unpaidCount ?? 0, "vendor")} behind` : "Everyone is square"}
            icon={owed > 0 ? "alert" : "checkCircle"}
          />
        </div>

        {/* Said as a sentence, because a date in a table cell is a thing you
            work out and a sentence is a thing you read. */}
        {next ? (
          <Note tone={next.status === "in_transit" ? "success" : "info"}>
            <b>{money(next.amount)}</b> should land in your bank on <b>{fmtArrival(next.arrival)}</b>
            {next.status === "in_transit" ? " — Stripe has already sent it." : " — Stripe has it scheduled."}
            {deposits.length > 1
              ? ` ${plural(deposits.length - 1, "more deposit")} behind it, ${money(incomingCents - next.amount)} in total.`
              : ""}
          </Note>
        ) : null}

        {/* Rent, as a bar. The two numbers that matter are the two ends of it. */}
        <div className="stack g-2">
          <div className="row between wrap g-3">
            <span className="t-label">Rent this season</span>
            <span className="t-xs t-muted">
              {billed.length > 0
                ? `${settled} of ${plural(billed.length, "vendor")} settled`
                : "Nothing invoiced yet"}
            </span>
          </div>

          <div
            role="img"
            aria-label={`${money(collected)} collected of ${money(invoiced)} invoiced`}
            style={{
              display: "flex", height: 14, width: "100%", overflow: "hidden",
              borderRadius: 999, background: "var(--bg-sunken)", border: "1px solid var(--border)",
            }}
          >
            {/* Accent, not a green of its own: this design system treats
                accent as the "good" tone — the success badge and the success
                note both use it — and inventing a second green here would
                make the bar the only green on the page that means anything. */}
            <span style={{ width: `${paidPct}%`, background: "var(--accent)" }} />
            <span style={{ width: `${100 - paidPct}%`, background: owed > 0 ? "var(--danger)" : "transparent" }} />
          </div>

          <div className="row between wrap g-3">
            <span className="t-sm">
              <b className="num">{money(collected)}</b> collected
            </span>
            <span className="t-sm">
              <b className="num" style={{ color: owed > 0 ? "var(--danger)" : undefined }}>{money(owed)}</b> still owed
            </span>
          </div>
          <span className="t-xs t-muted">
            {money(invoiced)} invoiced in total.
            {(t?.neverPaidCount ?? 0) > 0
              ? ` ${plural(t?.neverPaidCount ?? 0, "vendor has", "vendors have")} never paid anything — listed further down.`
              : ""}
          </span>
        </div>

        {owedOut > 0 ? (
          <Note tone="warn">
            You owe <b>{money(owedOut)}</b> out to {plural(owedOutCount, "vendor")} in the open payout run.
            {(bank?.available || 0) < owedOut
              ? ` Your Stripe balance is ${money(bank?.available || 0)} — ${money(owedOut - (bank?.available || 0))} short of covering it.`
              : ""}
          </Note>
        ) : null}
      </div>
    </Card>
  );
}

/**
 * The invoice ledger: who was sent a bill, who has paid it, who hasn't.
 *
 * Two tables rather than one, because they answer different questions.
 * The first is "who owes money right now" — the working list you chase each
 * month. The second is "who has never paid a cent", which the first can hide
 * completely: a vendor invoiced three months ago who has paid nothing sits in
 * the same row as one who is a week late, and the seasonal freeloader is
 * precisely the one you don't want to discover in December.
 */
function RentLedgerCards({
  ledger, filter, onFilter, busy, onSendLink, onRecordPayment,
}: {
  ledger: RentLedger | null;
  filter: "OWING" | "ALL" | "PAID";
  onFilter: (f: "OWING" | "ALL" | "PAID") => void;
  busy: boolean;
  onSendLink: (row: InvoiceRow) => void;
  onRecordPayment: (row: InvoiceRow) => void;
}) {
  const t = ledger?.totals;
  /* Filtering on the badge, not on the balance. "Still owing" used to include
     anyone whose account was negative for any reason — including a vendor who
     had paid their rent and was simply owed a payout. */
  const rows = (ledger?.invoices || []).filter((i) =>
    filter === "ALL" ? true
    : filter === "PAID" ? (i.status === "PAID" || i.status === "COVERED")
    : i.rentDueCents > 0
  );

  const statusBadge = (i: InvoiceRow) =>
    i.status === "PAID" ? <Badge tone="success" dot>Paid</Badge>
    : i.status === "COVERED" ? (
      <Badge tone="info" dot>{i.coveredBy === "ADJUSTMENT" ? "Settled by adjustment" : "Covered by sales"}</Badge>
    )
    : i.status === "NOT_INVOICED" ? <Badge tone="neutral">Not billed yet</Badge>
    : i.status === "PARTIAL" ? <Badge tone="warn" dot>Part paid</Badge>
    : <Badge tone="danger" dot>Unpaid</Badge>;

  const columns: Column<InvoiceRow>[] = [
    {
      key: "vendor",
      header: "Vendor",
      primary: true,
      sortBy: (i) => i.businessName,
      cell: (i) => (
        <span className="stack g-1">
          <span style={{ fontWeight: 600 }}>{i.businessName}</span>
          <span className="t-xs t-muted">
            {i.code} · Booth {i.boothLabel}
            {/* One ledger per vendor, so a second booth shows the same figures.
                Better to say so than to let it read as double the rent. */}
            {i.boothsOnAccount > 1 ? ` · one account across ${i.boothsOnAccount} booths` : ""}
          </span>
        </span>
      ),
    },
    {
      key: "invoiced",
      header: "Rent charged",
      align: "right",
      sortBy: (i) => i.chargedCents,
      cell: (i) => <span className="num">{money(i.chargedCents)}</span>,
    },
    {
      key: "paid",
      header: "Paid",
      align: "right",
      sortBy: (i) => i.paidCents,
      cell: (i) => (
        <span className="stack g-1" style={{ alignItems: "flex-end" }}>
          <span className="num">{money(i.paidCents)}</span>
          {i.lastPaymentAt ? <span className="t-xs t-muted">{fmtDate(i.lastPaymentAt)}</span> : null}
        </span>
      ),
    },
    {
      key: "owed",
      header: "Rent still owed",
      align: "right",
      sortBy: (i) => i.rentDueCents,
      cell: (i) => (
        <span className="stack g-1" style={{ alignItems: "flex-end" }}>
          <span className={`num ${i.rentDueCents > 0 ? "t-danger" : "t-accent"}`}>
            {money(i.rentDueCents)}
          </span>
          {/* The two numbers answer different questions and only clutter the
              row when they disagree: rent owed is what to chase, the account
              balance is what the vendor's own invoice page shows them. */}
          {i.outstandingCents !== i.rentDueCents ? (
            <span className="t-xs t-muted">
              {i.outstandingCents > 0 ? `${money(i.outstandingCents)} on the account` : "account square"}
            </span>
          ) : null}
        </span>
      ),
    },
    {
      key: "status",
      header: "Status",
      sortBy: (i) => i.status,
      cell: (i) => (
        <span className="row wrap g-2">
          {statusBadge(i)}
          {/* Three states, not two. "Not opened" about an invoice sent before
              open-tracking existed would be an accusation we can't support. */}
          {i.opens.count > 0 ? (
            <span className="t-xs t-muted">Opened {fmtDate(i.opens.lastAt || "")}</span>
          ) : !i.opens.tracked ? (
            <span className="t-xs t-muted">Opens not tracked</span>
          ) : (
            <span className="t-xs t-muted">Not opened</span>
          )}
        </span>
      ),
    },
    {
      key: "act",
      header: "",
      align: "right",
      cell: (i) => (
        <span className="row wrap g-2 end">
          {i.signToken ? (
            <a className="btn btn-ghost btn-sm" href={`/rent/${i.signToken}`} target="_blank" rel="noopener">
              <Icon name="receipt" size={14} /> View
            </a>
          ) : null}
          {/* The button that was missing. Rent paid in cash or by check had
              nowhere to go except an adjustment, which never counts as a
              payment — so the invoice stayed unpaid no matter what was
              actually handed over. */}
          {i.rentDueCents > 0 ? (
            <Button size="sm" variant="secondary" icon="checkCircle" disabled={busy} onClick={() => onRecordPayment(i)}>
              Record payment
            </Button>
          ) : null}
          {i.rentDueCents > 0 && i.outstandingCents > 0 ? (
            <Button size="sm" icon="mail" disabled={busy} onClick={() => onSendLink(i)}>
              Send again
            </Button>
          ) : null}
        </span>
      ),
    },
  ];

  const neverPaidColumns: Column<InvoiceRow>[] = [
    columns[0],
    {
      key: "since",
      header: "Invoiced",
      sortBy: (i) => i.executedAt || "",
      cell: (i) =>
        i.executedAt ? (
          <span className="stack g-1">
            <span>{fmtDate(i.executedAt)}</span>
            <span className="t-xs t-muted">{relTime(i.executedAt)}</span>
          </span>
        ) : <span className="t-muted">Date not recorded</span>,
    },
    {
      key: "owed",
      header: "Owes",
      align: "right",
      sortBy: (i) => i.outstandingCents,
      cell: (i) => <span className="num t-danger">{money(i.outstandingCents)}</span>,
    },
    {
      key: "reach",
      header: "Get hold of them",
      cell: (i) => (
        <span className="row wrap g-2">
          {i.phone ? (
            <a className="btn btn-secondary btn-sm" href={`tel:${i.phone.replace(/\D/g, "")}`}>
              <Icon name="phone" size={14} /> Call
            </a>
          ) : null}
          {i.phone ? (
            <a className="btn btn-secondary btn-sm" href={`sms:${i.phone.replace(/\D/g, "")}`}>
              <Icon name="message" size={14} /> Text
            </a>
          ) : null}
        </span>
      ),
    },
    columns[5],
  ];

  return (
    <>
      <div className="grid-auto" style={{ ["--min" as string]: "220px" }}>
        {/* Rent owed, not the net of every account. A vendor who is owed a
            payout used to quietly cancel out one who owes rent, and the number
            you chase people with was the difference between the two. */}
        <Stat feature label="Rent still owed" value={money(t?.rentDueCents || 0)}
          sub={t ? `${plural(t.unpaidCount, "vendor")} behind` : "Loading…"} icon="alert" />
        <Stat label="Collected" value={money(t?.collectedCents || 0)} sub="Rent paid to date" icon="checkCircle" />
        <Stat label="Rent charged" value={money(t?.invoicedCents || 0)} sub="Across every invoice sent" icon="receipt" />
        <Stat label="Never paid" value={String(t?.neverPaidCount ?? 0)}
          sub="Invoiced, nothing received" icon="warning" />
      </div>

      <Card
        title="Invoices"
        subtitle="Everyone whose agreement is signed by both sides — the point at which rent posts and their pay link goes out."
        actions={
          <Segmented
            label="Filter invoices"
            value={filter}
            onChange={onFilter}
            options={[
              { value: "OWING", label: `Still owing (${(ledger?.invoices || []).filter((i) => i.rentDueCents > 0).length})` },
              { value: "PAID", label: "Settled" },
              { value: "ALL", label: "All" },
            ]}
          />
        }
        flush
      >
        <DataTable
          rows={rows}
          columns={columns}
          rowKey={(i) => i.contractId}
          loading={!ledger}
          skeletonRows={4}
          mobileCards
          defaultSort={{ key: "owed", dir: "desc" }}
          caption="Rent invoices, what has been paid against them, and what is still outstanding"
          empty={
            <EmptyState
              icon="checkCircle"
              title={filter === "OWING" ? "Nobody owes you anything" : "No invoices yet"}
              body={
                filter === "OWING"
                  ? "Every invoice you've sent has been paid in full."
                  : "Invoices appear here once an agreement is signed by both sides — that's when rent posts and the pay link goes out."
              }
            />
          }
        />
      </Card>

      {ledger && ledger.neverPaid.length > 0 ? (
        <Card
          title="Never paid anything"
          subtitle="Invoiced, and not a single payment received. Oldest first — these are the ones that go missing for a season."
        >
          <DataTable
            rows={ledger.neverPaid}
            columns={neverPaidColumns}
            rowKey={(i) => i.contractId}
            mobileCards
            defaultSort={{ key: "since", dir: "asc" }}
            caption="Vendors who have been invoiced but have never made a payment"
          />
        </Card>
      ) : null}
    </>
  );
}

/**
 * Where one vendor's invoice stands, in the agreements table.
 *
 * THE BUG THIS FIXES: opening the invoice used to win over everything. The
 * first branch was `if (count > 0)` and returned "Invoice opened 3×" and
 * stopped — so the only vendors who could ever show "Invoice paid" were the
 * ones who had NEVER opened it. Anybody who looked at their invoice and then
 * paid it still read as unpaid forever.
 *
 * Paid comes first now. Opens are context underneath, which is all they ever
 * were.
 */
function InvoiceOpensCell({
  v, owes, rentDue, rentCharged,
}: {
  v: Contract["invoiceViews"];
  /** What the whole account is short, if anything. */
  owes: number;
  /** Rent charged minus rent paid — the invoice question specifically. */
  rentDue: number;
  rentCharged: number;
}) {
  const count = v?.count ?? 0;
  /* relTime already reads as a phrase ("yesterday", "2 days ago"), so
     "Last …" would produce "Last yesterday". */
  const opens = count > 0
    ? <span className="t-xs t-muted truncate">Opened {count}&times;{v?.lastAt ? ` · ${relTime(v.lastAt)}` : ""}</span>
    : null;

  const wrap = (badge: ReactNode) => (
    <div className="stack g-1" style={{ minWidth: 0 }}>{badge}{opens}</div>
  );

  // Nothing has been billed yet, so there is no invoice to have paid.
  if (rentCharged === 0) return wrap(<Badge tone="neutral">Not billed yet</Badge>);

  if (rentDue <= 0) return wrap(<Badge tone="success" icon="checkCircle">Invoice paid</Badge>);

  /* Rent outstanding but the account is square — their sales credits or an
     adjustment cover it. Nothing to chase, but they didn't pay it. */
  if (owes <= 0) return wrap(<Badge tone="info" dot>Covered by their sales</Badge>);

  if (count > 0) return wrap(<Badge tone="warn" icon="eye">Opened, not paid</Badge>);

  if (v?.tracked === false) {
    return (
      <span title="Their invoice was sent before open-tracking existed, so there is nothing recorded either way.">
        <Badge tone="neutral" dot>Opens not tracked</Badge>
      </span>
    );
  }
  return <Badge tone="warn" dot>Invoice not opened</Badge>;
}

/** One reading of an agreement's status, so the table and the detail panel
    can't drift apart. WITHDRAWN (they pulled out before starting) and VOIDED
    (we replaced it with a corrected agreement) both used to fall through to
    "Ended" — the one thing neither of them is. */
function ContractStatusBadge({ status, endDate }: { status: string; endDate?: string | null }) {
  if (status === "ACTIVE") return <Badge tone="success" dot>Active</Badge>;
  if (status === "TERMINATING") {
    return <Badge tone="danger" dot>{endDate ? `Ends ${fmtDate(endDate)}` : "Ending"}</Badge>;
  }
  if (status === "WITHDRAWN") return <Badge tone="danger" dot>Backed out</Badge>;
  if (status === "VOIDED") return <Badge tone="neutral" dot>Voided</Badge>;
  return <Badge tone="neutral" dot>Ended</Badge>;
}

type Receipt = { id: string; number: number; employee: string; cardName: string; createdAt: string; subtotalCents: number; taxCents: number; totalCents: number; taxRate: number; paymentMethod: string; lines: CartLine[]; discountCents?: number; cardAdjustCents?: number; saleSavingsCents?: number; customerPoints?: number | null; customerContact?: string;
};
type Drawer = { id: string; employee: string; openedAt: string; openTotalCents: number; cashSalesCents: number } | null;
type Ticket = { id: string; number: number; dateStr: string; timeStr: string; status: string; paymentMethod: string; cardName: string; employee: string; totalCents: number; vendorCodes: string[] };
type Employee = { id: string; name: string };
type W4 = { filingStatus?: string; dependentsDollars?: string; otherIncomeDollars?: string; extraWithholdingDollars?: string; notes?: string };
type TeamMember = { id: string; name: string; payRateCents: number; w4: W4; deductions: { id: string; name: string; amountCents: number }[]; docs: { id: string; kind: string; filename: string; createdAt: string }[] };
type PayrollRow = { id: string; name: string; payRateCents: number; hours: number; grossCents: number; dedCents: number; netCents: number; deductions: { name: string; amountCents: number }[]; openEntries: number };
type Report = {
  start: string; end: string; gross: number; tax: number; cash: number; card: number; tickets: number; refundTotal?: number;
  vGross: number; vNet: number; units: number;
  byVendor: { vendor: { code: string; businessName: string }; cents: number }[];
  byItem: { name: string; q: number; c: number }[];
  byHour: Record<string, number>;
};

/* ---- sales tax return -------------------------------------------------- */

type TaxMonth = {
  month: string;
  label: string;
  tickets: number;
  returns: number;
  preSplitTickets: number;
  grossSalesCents: number;
  stateTaxableCents: number;
  localTaxableCents: number;
  exemptFromStateCents: number;
  standardSalesCents: number;
  foodSalesCents: number;
  standardTaxCents: number;
  foodTaxCents: number;
  taxCollectedCents: number;
  returnedSalesCents: number;
  returnedTaxCents: number;
};

type TaxReport = {
  selected: string;
  current: TaxMonth;
  months: TaxMonth[];
  rates: { standardPercent: number; foodPercent: number; statePercent: number; splitConfigured: boolean };
};

/* ---- activity log ------------------------------------------------------ */

type AuditRow = {
  id: string;
  at: string;
  actorType: string;
  actorName: string;
  actorRole: string;
  action: string;
  targetType: string;
  targetId: string;
  targetLabel: string;
  amountCents: number;
  detail: string;
  approvedBy: string;
};

/* ---- payout runs ------------------------------------------------------- */

/* Rows from /api/admin/stripe-reconcile — Stripe's record of rent payments,
   matched against the ledger. */
type ReconcileRow = {
  paymentIntentId: string;
  paidAt: string;
  vendorId: string;
  code: string;
  businessName: string;
  dueCents: number;
  feeCents: number;
  chargedCents: number;
  last4: string;
  description: string;
  verdict: "MISSING" | "RECORDED" | "PROBABLY_RECORDED" | "NO_VENDOR" | "NO_AMOUNT";
  matchedEntryId: string;
};

type Reconcile = {
  days: number;
  rows: ReconcileRow[];
  missingCount: number;
  missingCents: number;
  webhookConfigured: boolean;
  checkedCount: number;
};

/* Online orders waiting at the counter. Staff don't pack these — the vendor
   does — so all the till needs is "who's coming in for what". */
type PickupOrder = {
  id: string; number: number; status: string; statusLabel: string; fulfillment: string;
  customerName: string; customerEmail: string; customerPhone: string;
  vendorCode: string; vendorName: string;
  lines: { name: string; quantity: number }[];
  totalCents: number; createdAt: string; readyAt: string | null;
};

type PayoutRunRow = {
  id: string;
  periodStart: string;
  periodEnd: string;
  status: string;
  createdAt: string;
  createdBy: string;
  note: string;
  vendorCount: number;
  totalCents: number;
  paidCents: number;
  pendingCount: number;
};

type PayoutRow = {
  id: string;
  vendorId: string;
  vendorCode: string;
  vendorName: string;
  grossCents: number;
  commissionCents: number;
  refundCents: number;
  balanceCents: number;
  netCents: number;
  method: string;
  reference: string;
  status: string;
  paidAt: string | null;
  paidBy: string;
  transferId?: string;
  feeCents?: number;
  failureReason?: string;
  /** Live from the vendor row, not frozen into the run. */
  payoutsEnabled: boolean;
  hasAccount: boolean;
  accountNote: string;
  quotedFeeCents: number;
  quotedSendCents: number;
};

const DENOMS: [string, string, number][] = [
  ["b100", "$100 bills", 10000], ["b50", "$50 bills", 5000], ["b20", "$20 bills", 2000],
  ["b10", "$10 bills", 1000], ["b5", "$5 bills", 500], ["b1", "$1 bills", 100],
  ["q", "Quarters", 25], ["d", "Dimes", 10], ["n", "Nickels", 5], ["p", "Pennies", 1],
];

/* Tabs live in the URL hash so refresh, back/forward and shared links all work. */
const ADMIN_TABS = [
  "register", "time", "calendar", "reports", "bank", "floor", "vendors", "onboarding",
  "customers", "contracts", "tents", "team", "links", "settings",
] as const;
type AdminTab = (typeof ADMIN_TABS)[number];

/* Which capability each tab needs. The same table the API guards use, so the
   navigation and the server can't drift apart — a tab nobody can use never
   renders, and a tab that renders always works. */
const TAB_CAP: Record<AdminTab, Capability> = {
  register: "ops", time: "ops", floor: "ops",
  calendar: "market", vendors: "market", onboarding: "market",
  contracts: "market", customers: "market", tents: "market",
  reports: "financials", bank: "financials",
  team: "people",
  links: "config", settings: "config",
};

/* Grouped navigation — twelve peer buttons in one flat row gave no sense of
   what belonged together or what a cashier was allowed to touch. */
/* `href` turns an entry into a link to another screen rather than a tab switch.
   Applications needed it: the pipeline lives on its own page at
   /admin/applications, which was reachable ONLY from a small button buried in
   the Vendors tab. If you didn't already know the page existed, you couldn't
   find it — which is exactly what happened. */
const NAV: { group: string; items: { id: string; label: string; icon: IconName; href?: string; cap?: Capability }[] }[] = [
  {
    group: "Daily",
    items: [
      { id: "register", label: "Register", icon: "register" },
      { id: "kiosk", label: "Kiosk mode", icon: "lock", href: "/register", cap: "ops" as Capability },
      { id: "time", label: "Time clock", icon: "clock" },
      { id: "calendar", label: "Calendar", icon: "calendar" },
      { id: "floor", label: "Floor stock", icon: "grid" },
    ],
  },
  {
    group: "Money",
    items: [
      { id: "reports", label: "Reports", icon: "chart" },
      { id: "bank", label: "Bank & payouts", icon: "bank" },
    ],
  },
  {
    group: "People",
    items: [
      { id: "applications", label: "Applications", icon: "inbox", href: "/admin/applications", cap: "market" as Capability },
      { id: "vendors", label: "Vendors", icon: "store" },
      { id: "onboarding", label: "Onboarding", icon: "user" },
      { id: "contracts", label: "Agreements", icon: "contract" },
      { id: "customers", label: "Customers", icon: "star" },
      { id: "tents", label: "Tent days", icon: "tent" },
      { id: "team", label: "Team & payroll", icon: "users" },
    ],
  },
  {
    group: "Setup",
    items: [
      { id: "links", label: "Links & QR", icon: "link" },
      { id: "settings", label: "Settings", icon: "settings" },
    ],
  },
];

const TAB_META: Record<AdminTab, { label: string; icon: IconName; sub: string }> = {
  register: { label: "Register", icon: "register", sub: "Ring up sales, manage the drawer, handle refunds" },
  time: { label: "Time clock", icon: "clock", sub: "Your shifts and hours" },
  calendar: { label: "Calendar", icon: "calendar", sub: "Viewings, market days, and anything else you need to remember" },
  floor: { label: "Floor stock", icon: "grid", sub: "Everything on the market floor right now" },
  reports: { label: "Reports", icon: "chart", sub: "Sales by period, vendor, and item" },
  bank: { label: "Bank & payouts", icon: "bank", sub: "Stripe balance, payouts, and month-end settlement" },
  vendors: { label: "Vendors", icon: "store", sub: "Accounts, balances, applications, and complaints" },
  onboarding: { label: "Onboarding", icon: "user", sub: "Accepted vendors who aren't live to shoppers yet" },
  contracts: { label: "Agreements", icon: "contract", sub: "Booth agreements, signatures, and notice" },
  customers: { label: "Customers", icon: "star", sub: "Rewards members and their spend" },
  tents: { label: "Tent days", icon: "tent", sub: "Outdoor day-booth dates and bookings" },
  team: { label: "Team & payroll", icon: "users", sub: "Employees, pay rates, documents, and payroll runs" },
  links: { label: "Links & QR", icon: "link", sub: "Every public link and code for the market" },
  settings: { label: "Settings", icon: "settings", sub: "Tax, rent, card adjustment, staff PINs, and the banner" },
};

/* ------------------------------------------------------------ calendar -----
   The shapes below mirror /api/admin/calendar exactly. Kinds and statuses are
   loose labels on the server, so the lookup tables here are the single place
   the UI decides what each one looks like and what it's called in English. */

type EventKind = "VIEWING" | "MARKET_DAY" | "MOVE_IN" | "MEETING" | "REMINDER" | "OTHER";
type EventStatus = "SCHEDULED" | "CONFIRMED" | "DONE" | "CANCELED" | "NO_SHOW";

type CalEvent = {
  id: string;
  title: string;
  kind: EventKind;
  startAt: string;
  endAt: string | null;
  allDay: boolean;
  location: string;
  notes: string;
  applicationId: string;
  vendorId: string;
  contactName: string;
  contactPhone: string;
  contactEmail: string;
  status: EventStatus;
  remindedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

/* Every kind carries an icon as well as a colour — a chip on the month grid has
   to be readable to someone who can't tell the green one from the amber one. */
const KIND_META: Record<EventKind, {
  label: string; icon: IconName; tone: BadgeTone; bg: string; fg: string; dot: string;
}> = {
  VIEWING:    { label: "Viewing",        icon: "eye",      tone: "info",    bg: "var(--info-soft)",   fg: "var(--info-text)",      dot: "var(--info)" },
  MARKET_DAY: { label: "Market day",     icon: "store",    tone: "success", bg: "var(--accent-soft)", fg: "var(--accent-text)",    dot: "var(--accent)" },
  MOVE_IN:    { label: "Move-in",        icon: "box",      tone: "warn",    bg: "var(--warn-soft)",   fg: "var(--warn-text)",      dot: "var(--warn)" },
  MEETING:    { label: "Meeting",        icon: "users",    tone: "neutral", bg: "var(--bg-sunken)",   fg: "var(--text-secondary)", dot: "var(--text-secondary)" },
  REMINDER:   { label: "Reminder",       icon: "bell",     tone: "danger",  bg: "var(--danger-soft)", fg: "var(--danger-text)",    dot: "var(--danger)" },
  OTHER:      { label: "Something else", icon: "calendar", tone: "neutral", bg: "var(--bg-inset)",    fg: "var(--text-muted)",     dot: "var(--text-muted)" },
};
const KIND_ORDER: EventKind[] = ["VIEWING", "MARKET_DAY", "MOVE_IN", "MEETING", "REMINDER", "OTHER"];

const STATUS_META: Record<EventStatus, { label: string; tone: BadgeTone; icon: IconName }> = {
  SCHEDULED: { label: "Scheduled", tone: "neutral", icon: "clock" },
  CONFIRMED: { label: "Confirmed", tone: "success", icon: "check" },
  DONE:      { label: "Done",      tone: "info",    icon: "checkCircle" },
  CANCELED:  { label: "Canceled",  tone: "neutral", icon: "close" },
  NO_SHOW:   { label: "No-show",   tone: "danger",  icon: "alert" },
};
/* The four an operator actually reaches for; SCHEDULED is the starting state. */
const STATUS_CHOICES: EventStatus[] = ["CONFIRMED", "DONE", "CANCELED", "NO_SHOW"];

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** "YYYY-MM-DDTHH:mm" in MARKET time — what <input type="datetime-local"> emits
    and what the calendar API parses back. Both halves have to come from the
    same clock: pairing a Central date with the browser's local hours would
    shift an event whenever the viewer isn't in Central. Never round-trip
    through toISOString() either — that shifts by the whole UTC offset. */
const localInput = (d: Date): string => isoDateTime(d);

/** The Y-M-D of one month-grid square. These are synthetic dates built from
    local parts to represent a calendar cell, NOT points in time, so they are
    read back with the same local parts rather than converted to Central. */
const cellKey = (d: Date): string => {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

/** The 42 cells of a Sunday-first month grid, leading and trailing days included. */
const monthGrid = (anchor: Date): Date[] => {
  const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
  const start = new Date(first);
  start.setDate(1 - first.getDay());
  return Array.from({ length: 42 }, (_, i) => {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    return d;
  });
};

const longDay = (d: Date) =>
  d.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });

/** When an event runs, written the way a person would say it. */
const eventWhen = (e: CalEvent): string => {
  const start = new Date(e.startAt);
  if (e.allDay) return `${fmtDate(start)} · all day`;
  const end = e.endAt ? new Date(e.endAt) : null;
  const tail = end && end.toDateString() === start.toDateString()
    ? `–${fmtTime(end)}`
    : end ? ` – ${fmtDateTime(end)}` : "";
  return `${fmtDateTime(start)}${tail}`;
};

/* --------------------------------------------------------- contact links ---
   A phone number on a screen someone is holding should be one tap from a call
   or a text. One component so the vendor panel, onboarding, the calendar, tent
   bookings and complaints all behave identically. */
function PhoneActions({ phone, name }: { phone: string; name?: string }) {
  const digits = String(phone || "").replace(/\D/g, "");
  if (!digits) return <span className="t-muted">No phone on file</span>;
  const pretty = fmtPhone(phone);
  const who = name ? ` ${name}` : "";
  return (
    <span className="row wrap g-2" style={{ minWidth: 0 }}>
      <span className="num truncate">{pretty}</span>
      <LinkButton
        href={`tel:${digits}`}
        size="sm"
        variant="secondary"
        icon="phone"
        aria-label={`Call${who} at ${pretty}`}
      >
        Call
      </LinkButton>
      <LinkButton
        href={`sms:${digits}`}
        size="sm"
        variant="secondary"
        icon="message"
        aria-label={`Text${who} at ${pretty}`}
      >
        Text
      </LinkButton>
    </span>
  );
}

/** The same idea for an email address shown beside a phone number. */
function EmailAction({ email, name }: { email: string; name?: string }) {
  const addr = String(email || "").trim();
  if (!addr) return <span className="t-muted">No email on file</span>;
  const who = name ? ` ${name}` : "";
  return (
    <span className="row wrap g-2" style={{ minWidth: 0 }}>
      <span className="truncate">{addr}</span>
      <LinkButton
        href={`mailto:${addr}`}
        size="sm"
        variant="secondary"
        icon="mail"
        aria-label={`Email${who} at ${addr}`}
      >
        Email
      </LinkButton>
    </span>
  );
}

export default function AdminPage() {
  const [authed, setAuthed] = useState(false);
  const [role, setRole] = useState<"admin" | "staff" | null>(null);
  /* The real role and what it can reach, straight from the server. The nav is
     built from this rather than from a hardcoded list, so a screen can never
     offer something the API would refuse. */
  const [access, setAccess] = useState<Role | null>(null);
  const [caps, setCaps] = useState<Capability[]>([]);
  const allowed = (c: Capability) => caps.includes(c);

  type AccessRow = { id: string; name: string; email: string; role: Role; roleLabel: string; active: boolean; hasPassword: boolean };
  const [accessRows, setAccessRows] = useState<AccessRow[] | null>(null);
  const [accessMe, setAccessMe] = useState<string | null>(null);

  type MyAccount = { id: string; name: string; email: string; role: Role; roleLabel: string; hasPassword: boolean; mustChangePassword: boolean };
  const [myAccount, setMyAccount] = useState<MyAccount | null>(null);
  const [sharedPasswordSession, setSharedPasswordSession] = useState(false);
  const [meOpen, setMeOpen] = useState(false);
  const [meEmail, setMeEmail] = useState("");
  const [meCurrent, setMeCurrent] = useState("");
  const [meNew, setMeNew] = useState("");
  const [meErr, setMeErr] = useState("");
  const [staffName, setStaffName] = useState("");
  const [loginMode, setLoginMode] = useState<"staff" | "account" | "admin">("staff");
  const [loginEmail, setLoginEmail] = useState("");
  const [loginPassword, setLoginPassword] = useState("");
  const [password, setPassword] = useState("");
  const [loginName, setLoginName] = useState("");
  const [loginPin, setLoginPin] = useState("");
  const [loginError, setLoginError] = useState("");
  const [loggingIn, setLoggingIn] = useState(false);
  const [timeData, setTimeData] = useState<{ open: { id: string; clockIn: string } | null; entries: { id: string; dayStr: string; inStr: string; outStr: string | null; hours: number | null }[] } | null>(null);
  const [timeMsg, setTimeMsg] = useState("");
  const [team, setTeam] = useState<TeamMember[]>([]);
  const [payFrom, setPayFrom] = useState("");
  const [payTo, setPayTo] = useState("");
  const [payroll, setPayroll] = useState<PayrollRow[] | null>(null);
  const [teamMsg, setTeamMsg] = useState("");
  const [applications, setApplications] = useState<{ id: string; status: string; businessName: string; contactName: string; email: string; phone: string; category: string; products: string; madeByYou: string; links: string; licenses: string; insurance: string; availability: string; boothRequest: string; heardFrom: string; phoneType?: string; notes: string; adminNotes?: string; stage?: string; viewingAt?: string; createdAt: string }[]>([]);
  const [appOpen, setAppOpen] = useState<string | null>(null);
  const [complaints, setComplaints] = useState<{ id: string; status: string; customerName: string; email: string; phone: string; vendor: { code: string; businessName: string } | null; messages: { sender: string; body: string }[] }[]>([]);
  const [reviews, setReviews] = useState<{ id: string; vendor: { code: string; businessName: string } | null; name: string; rating: number; body: string; likes: number; createdAt: string; comments: { id: string; name: string; body: string; createdAt: string }[] }[]>([]);
  const [punchName, setPunchName] = useState("");
  const [punchPin, setPunchPin] = useState("");
  const [punchMsg, setPunchMsg] = useState("");
  const [refundTarget, setRefundTarget] = useState<{ ticket: Ticket; lines: { id: string; name: string; priceCents: number; quantity: number }[]; refunded: Record<string, number> } | null>(null);
  const [refundQty, setRefundQty] = useState<Record<string, number>>({});
  const [refundRestock, setRefundRestock] = useState(true);
  const [refundMsg, setRefundMsg] = useState("");
  const [tab, setTab] = useHashTab(ADMIN_TABS, "register");
  const [busy, setBusy] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const dialog = useDialog();
  const toast = useToast();

  // register / drawer
  const [drawer, setDrawer] = useState<Drawer>(null);
  const [drawerLoaded, setDrawerLoaded] = useState(false);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [empName, setEmpName] = useState("");
  const [empPin, setEmpPin] = useState("");
  const [drawerErr, setDrawerErr] = useState("");
  const [counts, setCounts] = useState<Record<string, string>>({});
  const [closing, setClosing] = useState(false);
  const [closeReport, setCloseReport] = useState<{ employee: string; openTotalCents: number; cashSalesCents: number; expected: number; counted: number; diff: number } | null>(null);

  const [cart, setCart] = useState<CartLine[]>([]);
  const [scan, setScan] = useState("");
  const [scanErr, setScanErr] = useState("");
  const [search, setSearch] = useState("");
  const [openVendor, setOpenVendor] = useState<string | null>(null);
  const [cardName, setCardName] = useState("");
  const [taxRate, setTaxRate] = useState(9.0);
  const [foodTaxRate, setFoodTaxRate] = useState(9.0);
  const [foodTaxInput, setFoodTaxInput] = useState("");
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [autoPrint, setAutoPrint] = useState(true);
  const scanRef = useRef<HTMLInputElement>(null);
  const printRef = useRef<HTMLDivElement>(null);

  // tickets
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [ticketQ, setTicketQ] = useState("");

  // data
  const [overview, setOverview] = useState<Overview | null>(null);
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [contracts, setContracts] = useState<Contract[]>([]);

  // reports
  const [repPeriod, setRepPeriod] = useState("day");
  const [repVendor, setRepVendor] = useState("all");
  const [repFrom, setRepFrom] = useState("");
  const [repTo, setRepTo] = useState("");
  const [report, setReport] = useState<Report | null>(null);

  // bank
  const [bank, setBank] = useState<{ configured: boolean; available?: number; pending?: number; payouts?: { id: string; amount: number; status: string; arrival: string }[]; error?: string } | null>(null);

  // vendor form
  const [vName, setVName] = useState(""); const [vContact, setVContact] = useState("");
  const [vEmail, setVEmail] = useState(""); const [vPhone, setVPhone] = useState("");
  const [vComm, setVComm] = useState("0"); const [vMsg, setVMsg] = useState("");

  // contract form
  const [cVendor, setCVendor] = useState(""); const [cBooth, setCBooth] = useState("");
  const [cRent, setCRent] = useState("150"); const [cStart, setCStart] = useState("");
  const [cW, setCW] = useState("5"); const [cD, setCD] = useState("5");
  const [cMode, setCMode] = useState<"standard" | "custom">("standard");
  const [rentPerSqft, setRentPerSqft] = useState(6);
  const [scPaused, setScPaused] = useState(false);
  const [cardAdj, setCardAdj] = useState("0");
  /* Dollars as typed, not cents — the field is a text input and rounding it on
     every keystroke fights the person using it. */
  const [approvalDollars, setApprovalDollars] = useState("50");
  const [feePercentInput, setFeePercentInput] = useState("0.25");
  const [feeFixedInput, setFeeFixedInput] = useState("0.25");
  const [cardConfirm, setCardConfirm] = useState(false);
  /* Cash used to book the instant you pressed the button — no tender, no
     change, nothing on the receipt saying what was handed over. */
  const [cashConfirm, setCashConfirm] = useState(false);
  const [editV, setEditV] = useState<string | null>(null);
  type RentRoll = {
    committedMonthlyCents: number; committedBooths: number;
    pendingMonthlyCents: number; pendingBooths: number;
    endingMonthlyCents: number; endingBooths: number;
    afterEndingMonthlyCents: number;
    booths: { contractId: string; boothLabel: string; businessName: string; code: string; monthlyRentCents: number; signed: boolean; endDate: string | null; status: string }[];
  };
  const [rentRoll, setRentRoll] = useState<RentRoll | null>(null);
  const [settle, setSettle] = useState<{ vendorId: string; businessName: string; code: string; boothLabel: string; monthlyRentCents: number; balanceCents: number; dueCents: number; feeCents: number; chargeTotalCents: number; cardLast4: string; hasCard: boolean }[] | null>(null);
  const [ledger, setLedger] = useState<RentLedger | null>(null);
  const [upcoming, setUpcoming] = useState<Upcoming | null>(null);
  const [ledgerFilter, setLedgerFilter] = useState<"OWING" | "ALL" | "PAID">("OWING");
  const [showInactive, setShowInactive] = useState(false);
  /* Note: the per-application notes/contract form and its PATCH handler used to
     live here too. That workflow now has its own screen at /admin/applications,
     so this page only needs the read-only pipeline view. */
  const [editF, setEditF] = useState({ businessName: "", contactName: "", email: "", phone: "" });
  /* Presentation-only state for the vendor/contract/application views: which
     record the slide-over is showing, and what's typed in each search box. */
  const [vendorQ, setVendorQ] = useState("");
  const [vendorOpen, setVendorOpen] = useState<string | null>(null);
  const [contractOpen, setContractOpen] = useState<string | null>(null);
  /* Agreements that were backed out never started, so they'd only pad the list
     you actually work from. Kept one click away rather than thrown out. */
  const [contractFilter, setContractFilter] = useState<"ACTIVE" | "WITHDRAWN" | "ALL">("ACTIVE");
  /* Invoice open history. Fetched on demand — the agreements list already
     carries the count, and most agreements never need the detail. */
  const [invoiceLogFor, setInvoiceLogFor] = useState<string | null>(null);
  const [invoiceLog, setInvoiceLog] = useState<InvoiceView[] | null>(null);
  const [invoiceLogLoading, setInvoiceLogLoading] = useState(false);
  const [invoiceLogErr, setInvoiceLogErr] = useState("");
  const [appQ, setAppQ] = useState("");
  const [appFilter, setAppFilter] = useState<"PENDING" | "ACCEPTED" | "DECLINED">("PENDING");
  const [rateMsg, setRateMsg] = useState("");
  const [adminPushDevices, setAdminPushDevices] = useState<number | null>(null);
  const [adminPushKey, setAdminPushKey] = useState("");
  const [adminPushMsg, setAdminPushMsg] = useState("");
  const [cMsg, setCMsg] = useState("");
  /* The one modal behind both "Edit terms" and "Void and send a corrected
     agreement" — same fields, different action on save. */
  const [termsForm, setTermsForm] = useState<{
    id: string; mode: "update_terms" | "void_and_reissue"; businessName: string;
    boothLabel: string; rent: string; startDate: string;
  } | null>(null);
  const [termsErr, setTermsErr] = useState("");

  // settings
  const [settingsMsg, setSettingsMsg] = useState("");
  const [banEnabled, setBanEnabled] = useState(false);
  const [banTitle, setBanTitle] = useState("");
  const [banDate, setBanDate] = useState("");
  const [banMessage, setBanMessage] = useState("");
  const [banMsg, setBanMsg] = useState("");
  const [newEmpName, setNewEmpName] = useState("");
  const [newEmpPin, setNewEmpPin] = useState("");
  const [empMsg, setEmpMsg] = useState("");

  /* Presentation-only state for team / tents / links / settings: which employee
     the slide-over is showing, the document type picked in that slide-over, and
     which single button is mid-request (so only that one shows a spinner). */
  const [teamOpen, setTeamOpen] = useState<string | null>(null);
  const [docKind, setDocKind] = useState("W4");
  const [pending, setPending] = useState("");

  const safeFetch = async (url: string, init?: RequestInit): Promise<{ ok: boolean; status: number; data: Record<string, unknown> }> => {
    try {
      const res = await fetch(url, init);
      let data: Record<string, unknown> = {};
      try { data = await res.json(); } catch { data = { error: `Server error (${res.status}). If you just deployed, check that all the SQL ran in Supabase.` }; }
      return { ok: res.ok, status: res.status, data };
    } catch {
      return { ok: false, status: 0, data: { error: "Network problem — try again." } };
    }
  };

  const loadDrawer = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/drawer");
      if (res.status === 401) { setAuthed(false); return; }
      setAuthed(true);
      let data: { session?: Drawer; error?: string } = {};
      try { data = await res.json(); } catch { data = { error: "Server error." }; }
      if (!res.ok) {
        setDrawerErr(`Register can't reach the drawer system (${data.error || res.status}). If you just deployed, make sure the SQL for Employee + DrawerSession ran in Supabase.`);
      } else {
        setDrawerErr("");
        setDrawer(data.session ?? null);
      }
    } catch {
      setDrawerErr("Network problem loading the register — refresh to retry.");
    } finally {
      setDrawerLoaded(true);
    }
  }, []);

  const loadAll = useCallback(async () => {
    const [o, v, c, s, e] = await Promise.all([
      fetch("/api/admin/overview"), fetch("/api/admin/vendors"),
      fetch("/api/admin/contracts"), fetch("/api/admin/settings"),
      fetch("/api/admin/employees"),
    ]);
    if (o.status === 401) { setAuthed(false); return; }
    setAuthed(true);
    if (o.ok) setOverview(await o.json());
    // 401s here are normal for employee sessions — those tabs are admin-only
    if (v.ok) setVendors((await v.json()).vendors || []);
    if (c.ok) setContracts((await c.json()).contracts || []);
    if (s.ok) { const sd = await s.json(); setTaxRate(sd.taxRatePercent); if (typeof sd.foodTaxRatePercent === "number") { setFoodTaxRate(sd.foodTaxRatePercent); setFoodTaxInput(String(sd.foodTaxRatePercent)); } if (sd.rentPerSqft) setRentPerSqft(sd.rentPerSqft); setScPaused(!!sd.selfCheckoutPaused); if (sd.cardAdjustPercent !== undefined) setCardAdj(String(sd.cardAdjustPercent)); if (typeof sd.refundApprovalCents === "number") setApprovalDollars((sd.refundApprovalCents / 100).toFixed(2).replace(/\.00$/, "")); if (sd.payoutFee) { setFeePercentInput(String(sd.payoutFee.percent)); setFeeFixedInput((sd.payoutFee.fixedCents / 100).toFixed(2)); } }
    if (e.ok) setEmployees((await e.json()).employees || []);
  }, []);

  const loadTickets = useCallback(async (q: string) => {
    const res = await fetch(`/api/admin/tickets?q=${encodeURIComponent(q)}`);
    if (res.ok) setTickets((await res.json()).tickets || []);
  }, []);

  const loadReport = useCallback(async () => {
    const params = new URLSearchParams({ period: repPeriod, vendor: repVendor });
    if (repPeriod === "custom") { if (repFrom) params.set("from", repFrom); if (repTo) params.set("to", repTo); }
    const res = await fetch(`/api/admin/reports?${params}`);
    if (res.ok) setReport(await res.json());
  }, [repPeriod, repVendor, repFrom, repTo]);

  const loadMyAccount = useCallback(async () => {
    const r = await fetch("/api/staff/me");
    if (!r.ok) return;
    const d = await r.json();
    setMyAccount(d.account || null);
    setSharedPasswordSession(d.reason === "shared-password");
    if (d.account) setMeEmail(d.account.email || "");
  }, []);

  const saveMyAccount = async () => {
    setMeErr("");
    const patch: Record<string, unknown> = {};
    if (meEmail.trim() !== (myAccount?.email || "")) patch.email = meEmail.trim();
    if (meNew) { patch.newPassword = meNew; patch.currentPassword = meCurrent; }
    if (!Object.keys(patch).length) { setMeErr("Nothing changed."); return; }
    setBusy(true);
    try {
      const { ok, data } = await safeFetch("/api/staff/me", {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch),
      });
      if (!ok) { setMeErr(String(data.error || "Couldn't save that.")); return; }
      toast.success("Your account is updated", patch.newPassword ? "Use the new password next time you sign in." : undefined);
      setMeOpen(false); setMeCurrent(""); setMeNew("");
      await loadMyAccount();
    } finally { setBusy(false); }
  };

  const probeRole = useCallback(async () => {
    const res = await fetch("/api/admin/whoami");
    if (!res.ok) { setAuthed(false); setRole(null); return; }
    const data = await res.json();
    setRole(data.role); setStaffName(data.name || ""); setAuthed(true);
    /* Fail-safe, not fail-closed, for the owner path: if the capability list is
       ever missing, an ADMIN_PASSWORD session still gets the full set. The
       alternative is an owner staring at a sidebar with no tabs in it, locked
       out of their own market by a serialisation hiccup. The APIs enforce this
       independently, so a wrong guess here grants nothing. */
    const nextAccess = (data.access as Role) || (data.role === "admin" ? "OWNER" : null);
    const nextCaps = (data.capabilities as Capability[] | undefined)
      ?? (nextAccess === "OWNER" ? (["ops", "market", "collections", "money", "financials", "people", "config"] as Capability[]) : []);
    setAccess(nextAccess); setCaps(nextCaps);
    void loadMyAccount();
  }, []);

  const loadTime = useCallback(async () => {
    const res = await fetch("/api/staff/time");
    if (res.ok) setTimeData(await res.json());
  }, []);

  const loadAccess = useCallback(async () => {
    const r = await fetch("/api/admin/team/access");
    if (!r.ok) return;
    const d = await r.json();
    setAccessRows(d.employees || []);
    setAccessMe(d.me || null);
  }, []);

  /* One helper for every change on this card — role, email, password, on/off.
     They share the same guard rails server-side, so they share the same
     error handling here rather than four near-identical copies. */
  const changeAccess = async (employeeId: string, patch: Record<string, unknown>, okMsg: string) => {
    setBusy(true);
    try {
      const { ok, data } = await safeFetch("/api/admin/team/access", {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ employeeId, ...patch }),
      });
      if (!ok) { toast.error("Couldn't make that change", String(data.error || "")); return false; }
      if (data.issuedPassword) {
        const mailed = data.emailed === true;
        const mailNote = data.emailed === false
          ? " We couldn't email it, so this is the only copy."
          : mailed ? " It's also been emailed to them." : " Nobody has an email address on file, so this is the only copy.";
        /* Shown once, in a dialog they have to dismiss, with a copy button.
           It is not stored anywhere readable — a toast that slides away would
           mean generating another one. */
        await dialog.alert({
          title: "New password set",
          body: <>Give this to <b>{String((data.employee as { name?: string })?.name || "them")}</b>.{mailNote} It won&rsquo;t be shown again, and they&rsquo;ll be asked to change it.</>,
          copyable: String(data.issuedPassword),
          confirmLabel: "Done",
        });
      } else {
        toast.success(okMsg, data.warning ? String(data.warning) : undefined);
      }
      if (data.warning && data.issuedPassword) toast.error("Heads up", String(data.warning));
      await loadAccess();
      return true;
    } finally { setBusy(false); }
  };

  const loadTeam = useCallback(async () => {
    const t = await fetch("/api/admin/team");
    if (t.ok) setTeam((await t.json()).employees || []);
  }, []);

  useEffect(() => { probeRole(); loadDrawer(); loadAll(); }, [probeRole, loadDrawer, loadAll]);
  usePulse(() => { loadDrawer(); loadAll(); });
  useEffect(() => { if (authed && tab === "time") loadTime(); }, [authed, tab, loadTime]);
  useEffect(() => { if (authed && allowed("people") && tab === "team") { loadTeam(); loadAccess(); } }, [authed, caps, tab, loadTeam, loadAccess]);
  useEffect(() => {
    if (authed && allowed("market") && tab === "vendors") {
      fetch("/api/admin/complaints").then(async (r) => { if (r.ok) setComplaints((await r.json()).complaints || []); });
      fetch("/api/admin/applications").then(async (r) => { if (r.ok) setApplications((await r.json()).applications || []); });
      fetch("/api/admin/reviews").then(async (r) => { if (r.ok) setReviews((await r.json()).reviews || []); });
    }
  }, [authed, role, tab]);
  useEffect(() => { if (authed && tab === "register") loadTickets(ticketQ); }, [authed, tab, ticketQ, loadTickets]);
  useEffect(() => { if (authed && tab === "reports") loadReport(); }, [authed, tab, loadReport]);
  /* Customers used to hide behind a "load customers" button, so the tab read as
     empty until you found it. It loads on open now, like every other tab, which
     means it needs its own loading and error state. clockBusy keeps the time
     clock's one big button from being double-tapped. */
  const [custLoading, setCustLoading] = useState(false);
  const [custErr, setCustErr] = useState("");
  const [clockBusy, setClockBusy] = useState(false);
  const loadCustomers = useCallback(async () => {
    setCustLoading(true); setCustErr("");
    try {
      const r = await fetch("/api/admin/customers");
      if (!r.ok) { setCustErr("Couldn't load the customer list."); return; }
      setCustomers((await r.json()).customers || []);
    } catch {
      setCustErr("Couldn't reach the server. Check the connection and try again.");
    } finally {
      setCustLoading(false);
    }
  }, []);
  useEffect(() => { if (authed && allowed("market") && tab === "customers") loadCustomers(); }, [authed, caps, tab, loadCustomers]);

  /* ---- sales tax return, activity log, payout runs ---------------------- */

  const [taxReport, setTaxReport] = useState<TaxReport | null>(null);
  const [taxMonth, setTaxMonth] = useState<string>(() => isoDate().slice(0, 7));
  const [taxErr, setTaxErr] = useState("");
  const loadTaxReport = useCallback(async (month: string) => {
    setTaxErr("");
    const r = await fetch(`/api/admin/tax-report?month=${encodeURIComponent(month)}`);
    if (!r.ok) { setTaxErr("Couldn't build the tax report."); return; }
    setTaxReport(await r.json());
  }, []);

  const [audit, setAudit] = useState<AuditRow[]>([]);
  const [auditFilter, setAuditFilter] = useState<string>("MONEY_OUT");
  const [auditDays, setAuditDays] = useState<string>("30");
  const [auditOut, setAuditOut] = useState(0);
  const loadAudit = useCallback(async (action: string, days: string) => {
    const r = await fetch(`/api/admin/audit?days=${encodeURIComponent(days)}${action === "ALL" ? "" : `&action=${encodeURIComponent(action)}`}`);
    if (!r.ok) return;
    const d = await r.json();
    setAudit((d.events || []) as AuditRow[]);
    setAuditOut(Number(d.moneyOutCents) || 0);
  }, []);

  const [pickups, setPickups] = useState<PickupOrder[]>([]);
  const loadPickups = useCallback(async () => {
    const r = await fetch("/api/admin/orders?scope=ready");
    if (!r.ok) return;
    const d = await r.json();
    setPickups((d.orders || []) as PickupOrder[]);
  }, []);

  const handOver = async (o: PickupOrder) => {
    setBusy(true);
    try {
      const { ok, data } = await safeFetch("/api/admin/orders", {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderId: o.id }),
      });
      if (!ok) { toast.error("Couldn't close that one off", String(data.error || "")); await loadPickups(); return; }
      toast.success(`#${o.number} handed over`, `${o.customerName} — ${o.vendorName}.`);
      await loadPickups();
    } finally { setBusy(false); }
  };

  const [recon, setRecon] = useState<Reconcile | null>(null);
  const [reconLoading, setReconLoading] = useState(false);
  const [reconErr, setReconErr] = useState("");
  const loadRecon = useCallback(async () => {
    setReconLoading(true); setReconErr("");
    try {
      const r = await fetch("/api/admin/stripe-reconcile?days=180");
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        setReconErr(String(d.error || "Couldn't read your Stripe payments."));
        return;
      }
      setRecon(await r.json());
    } catch {
      setReconErr("Couldn't reach Stripe just now.");
    } finally { setReconLoading(false); }
  }, []);

  const postMissingPayments = async (ids: string[]) => {
    if (!ids.length) return;
    setBusy(true);
    try {
      const { ok, data } = await safeFetch("/api/admin/stripe-reconcile", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paymentIntentIds: ids }),
      });
      if (!ok) { toast.error("Couldn't post those", String(data.error || "")); return; }
      const postedList = (data.posted as { amountCents: number }[]) || [];
      const total = postedList.reduce((n, p) => n + p.amountCents, 0);
      toast.success(
        `${plural(postedList.length, "payment")} posted`,
        `${money(total)} matched from Stripe into the ledger.`
      );
      await loadRecon();
      const r = await fetch("/api/admin/rent-ledger");
      if (r.ok) setLedger(await r.json());
      await loadAll();
    } finally { setBusy(false); }
  };

  const [payRuns, setPayRuns] = useState<PayoutRunRow[]>([]);
  const [payRunId, setPayRunId] = useState("");
  const [payouts, setPayouts] = useState<PayoutRow[]>([]);
  const [stripeBalance, setStripeBalance] = useState<number | null>(null);
  const [payoutFee, setPayoutFee] = useState<{ percent: number; fixedCents: number }>({ percent: 0.25, fixedCents: 25 });
  const [payFromDate, setPayFromDate] = useState(() => `${isoDate().slice(0, 7)}-01`);
  const [payToDate, setPayToDate] = useState(() => isoDate());
  const [payErr, setPayErr] = useState("");
  const loadPayouts = useCallback(async (runId?: string) => {
    const r = await fetch(`/api/admin/payouts${runId ? `?runId=${encodeURIComponent(runId)}` : ""}`);
    if (!r.ok) return;
    const d = await r.json();
    setPayRuns((d.runs || []) as PayoutRunRow[]);
    setPayRunId(String(d.runId || ""));
    setPayouts((d.payouts || []) as PayoutRow[]);
    setStripeBalance(typeof d.stripeBalanceCents === "number" ? d.stripeBalanceCents : null);
    if (d.fee) setPayoutFee(d.fee as { percent: number; fixedCents: number });
  }, []);

  const loadUpcoming = useCallback(async () => {
    const r = await fetch("/api/admin/upcoming");
    if (r.ok) setUpcoming(await r.json());
  }, []);

  const saveMoneyDates = async (opensAt: string, payoutDay: number) => {
    setBusy(true);
    try {
      const r = await fetch("/api/admin/upcoming", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "settings", marketOpensAt: opensAt, payoutDay }),
      });
      if (!r.ok) { toast.error("Couldn't save those dates"); return; }
      await loadUpcoming();
      toast.success("Dates saved", payoutDay ? `Vendors get paid on the ${payoutDay}th.` : "No fixed payout day.");
    } finally { setBusy(false); }
  };

  /* Moves every affected agreement's prepaid date forward. It changes what
     vendors are billed next month, so it asks with the total in the question
     and it can only be done once. */
  const applyClosedDayCredit = async () => {
    const rows = upcoming?.closedDays.rows || [];
    const yes = await dialog.confirm({
      title: `Credit closed days to ${plural(rows.length, "vendor")}?`,
      body: (
        <>
          <p>
            Each of these agreements started before the market opened, so the full month they paid up front
            covered days there was nothing to sell at. This gives those days back by moving their prepaid date
            forward, which makes the next rent run bill them for that many days fewer.
          </p>
          <p style={{ marginTop: 8 }}>
            About <b>{money(upcoming?.closedDays.estimatedCreditCents || 0)}</b> in total. It changes what they are
            charged, it is recorded in the activity log, and it can only be done once.
          </p>
        </>
      ),
      confirmLabel: "Credit the days",
    });
    if (!yes) return;
    setBusy(true);
    try {
      const r = await fetch("/api/admin/upcoming", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "credit" }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { toast.error("Couldn't apply it", String(d.error || "")); return; }
      await loadUpcoming();
      toast.success(`${plural(d.changed || 0, "agreement")} credited`, "Next month's run reflects it already.");
    } finally { setBusy(false); }
  };

  const loadReviews = useCallback(async () => {
    const r = await fetch("/api/admin/reviews");
    if (r.ok) setReviews((await r.json()).reviews || []);
  }, []);

  /* Taking a review down is permanent and it is visible to the vendor it was
     about, so it asks first and says out loud what gets logged. */
  const removeReview = async (rv: { id: string; name: string; rating: number; body: string; comments: { id: string }[] }) => {
    const yes = await dialog.confirm({
      title: `Remove this ${rv.rating}-star review?`,
      body: (
        <>
          <p style={{ fontStyle: "italic" }}>&ldquo;{rv.body.slice(0, 240)}{rv.body.length > 240 ? "…" : ""}&rdquo;</p>
          <p style={{ marginTop: 8 }}>
            Posted by {rv.name || "someone who left no name"}.
            {rv.comments.length ? ` Its ${plural(rv.comments.length, "reply")} go with it.` : ""}
          </p>
          <p style={{ marginTop: 8 }}>
            It disappears from their public page straight away and can&rsquo;t be restored. The activity log keeps a
            record of what it said and who removed it.
          </p>
        </>
      ),
      confirmLabel: "Remove it",
      tone: "danger",
    });
    if (!yes) return;
    const res = await fetch("/api/admin/reviews", {
      method: "DELETE", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reviewId: rv.id }),
    });
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      toast.error("Couldn't remove it", String(d.error || "Give it another go."));
      return;
    }
    toast.success("Review removed", "It's off their page and in the activity log.");
    await loadReviews();
  };

  const removeReviewComment = async (c: { id: string; name: string; body: string }) => {
    const yes = await dialog.confirm({
      title: "Remove this reply?",
      body: <p style={{ fontStyle: "italic" }}>&ldquo;{c.body.slice(0, 240)}{c.body.length > 240 ? "…" : ""}&rdquo; — {c.name || "no name"}</p>,
      confirmLabel: "Remove it",
      tone: "danger",
    });
    if (!yes) return;
    const res = await fetch("/api/admin/reviews", {
      method: "DELETE", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ commentId: c.id }),
    });
    if (!res.ok) { toast.error("Couldn't remove it"); return; }
    toast.success("Reply removed");
    await loadReviews();
  };

  /** Send one vendor their money by bank transfer. */
  const sendPayout = async (p: PayoutRow) => {
    const yes = await dialog.confirm({
      title: `Send ${money(p.quotedSendCents)} to ${p.vendorName}?`,
      body: (
        <>
          <p>
            They&rsquo;re owed {money(p.netCents)}. {money(p.quotedFeeCents)} comes off as the transfer fee, so
            <b> {money(p.quotedSendCents)}</b> reaches their bank in a day or two.
          </p>
          <p style={{ marginTop: 8 }}>This moves real money out of your Stripe balance and can&rsquo;t be pulled back.</p>
        </>
      ),
      confirmLabel: "Send it",
      tone: "danger",
    });
    if (!yes) return;

    setBusy(true);
    try {
      const { ok, data } = await safeFetch("/api/admin/payouts", {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ payoutId: p.id, method: "STRIPE" }),
      });
      if (!ok) { toast.error(`Couldn't pay ${p.vendorName}`, String(data.error || "")); await loadPayouts(payRunId); return; }
      toast.success(`${p.vendorName} paid`, `${money(Number(data.sentCents) || 0)} on its way to their bank.`);
      await loadPayouts(payRunId);
      await loadAll();
    } finally { setBusy(false); }
  };

  /** The whole run, in one go. */
  const payEveryone = async () => {
    const payable = payouts.filter((p) => p.status === "PENDING" && p.netCents > 0 && p.payoutsEnabled);
    if (!payable.length) { toast.error("Nobody to pay", "No one on this run has a connected bank account."); return; }
    const total = payable.reduce((n, p) => n + p.quotedSendCents, 0);

    const yes = await dialog.confirm({
      title: `Pay ${plural(payable.length, "vendor")}?`,
      body: (
        <p>
          {money(total)} leaves your Stripe balance and lands in their banks in a day or two. Anyone who
          hasn&rsquo;t connected a bank account is skipped and stays on the run.
        </p>
      ),
      confirmLabel: `Send ${money(total)}`,
      tone: "danger",
      typeToConfirm: "PAY",
    });
    if (!yes) return;

    setBusy(true);
    try {
      const { ok, data } = await safeFetch("/api/admin/payouts", {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "pay_all", runId: payRunId }),
      });
      if (!ok) { toast.error("Couldn't run the payouts", String(data.error || "")); return; }
      const failed = (data.failed as { vendorName: string; reason: string }[]) || [];
      toast.success(
        `${plural(Number(data.paidCount) || 0, "vendor")} paid`,
        `${money(Number(data.paidCents) || 0)} sent.${failed.length ? ` ${plural(failed.length, "vendor")} couldn't be paid — see the run.` : ""}`
      );
      if (data.stopped) {
        await dialog.alert({ title: "The run stopped early", body: String(data.stopped), tone: "warn" });
      }
      await loadPayouts(payRunId);
      await loadAll();
    } finally { setBusy(false); }
  };

  useEffect(() => {
    if (authed && allowed("financials") && tab === "reports") { loadTaxReport(taxMonth); loadAudit(auditFilter, auditDays); }
  }, [authed, caps, tab, taxMonth, auditFilter, auditDays, loadTaxReport, loadAudit]);
  useEffect(() => {
    if (authed && allowed("financials") && tab === "bank") { loadPayouts(); loadRecon(); }
  }, [authed, caps, tab, loadPayouts, loadRecon]);
  /* Declared here rather than beside the other register loaders because
     `loadPickups` is defined further down — hoisting the effect above its own
     callback is a build error, not just a lint warning. */
  useEffect(() => { if (authed && tab === "register") void loadPickups(); }, [authed, tab, loadPickups]);

  const buildPayoutRun = async () => {
    setPayErr("");
    setBusy(true);
    try {
      const { ok, data } = await safeFetch("/api/admin/payouts", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ from: payFromDate, to: payToDate }),
      });
      if (!ok) { setPayErr(String(data.error || "Couldn't build the run.")); return; }
      await loadPayouts(String(data.runId || ""));
      toast.success("Payout run built", "Mark each vendor as you pay them.");
    } finally { setBusy(false); }
  };

  const markPayoutPaid = async (p: PayoutRow) => {
    const method = await dialog.choose({
      title: `Pay ${p.vendorName} ${money(p.netCents)}`,
      body: <p>This posts {money(p.netCents)} against their balance. Record how it actually left the market.</p>,
      label: "How was it paid?",
      options: [
        { value: "CASH", label: "Cash", hint: "Out of the drawer or the safe" },
        { value: "CHECK", label: "Check", hint: "You'll be asked for the check number" },
        { value: "ACH", label: "Bank transfer", hint: "Zelle, ACH, anything bank-to-bank" },
        { value: "STRIPE", label: "Stripe", hint: "Sent from the Stripe balance" },
        { value: "RENT_OFFSET", label: "Applied to rent", hint: "Kept against what they owe" },
      ],
      defaultValue: "CHECK",
      confirmLabel: "Next",
    });
    if (!method) return;

    let reference = "";
    if (method === "CHECK" || method === "ACH" || method === "STRIPE") {
      const ref = await dialog.prompt({
        title: "Reference",
        body: <p>Whatever lets you find this on the bank statement later.</p>,
        label: method === "CHECK" ? "Check number" : "Reference",
        placeholder: method === "CHECK" ? "1042" : "Zelle 9/14",
        confirmLabel: "Mark paid",
      });
      if (ref === null) return;
      reference = ref;
    }

    setBusy(true);
    try {
      const { ok, data } = await safeFetch("/api/admin/payouts", {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ payoutId: p.id, method, reference }),
      });
      if (!ok) { toast.error("Couldn't mark it paid", String(data.error || "")); return; }
      await loadPayouts(payRunId);
      await loadAll();
      toast.success(`${p.vendorName} paid`, `${money(p.netCents)} posted to their ledger.`);
    } finally { setBusy(false); }
  };
  useEffect(() => {
    if (authed && tab === "bank") fetch("/api/admin/stripe").then(async (r) => setBank(await r.json()));
    if (authed && tab === "bank") fetch("/api/admin/settlement").then(async (r) => { if (r.ok) { const d = await r.json(); setSettle(d.rows); setRentRoll(d.rentRoll || null); } });
    if (authed && tab === "bank") fetch("/api/admin/rent-ledger").then(async (r) => { if (r.ok) setLedger(await r.json()); });
    if (authed && allowed("financials") && tab === "bank") void loadUpcoming();
  }, [authed, tab]);
  useEffect(() => {
    try { const v = window.localStorage.getItem("nm_autoprint"); if (v !== null) setAutoPrint(v === "1"); } catch {}
  }, []);
  useEffect(() => {
    if (authed && tab === "register" && drawer && !receipt && !closing) scanRef.current?.focus();
  }, [authed, tab, drawer, cart, receipt, closing]);

  const login = async () => {
    setLoginError("");
    if (loginMode === "admin" && !password) { setLoginError("Enter the admin password."); return; }
    if (loginMode === "account" && (!loginEmail.trim() || !loginPassword)) {
      setLoginError("Enter your email and password.");
      return;
    }
    if (loginMode === "staff" && (!loginName.trim() || !loginPin)) {
      setLoginError("Enter both your name and your PIN.");
      return;
    }
    setLoggingIn(true);
    try {
      if (loginMode === "admin") {
        const { ok, status, data } = await safeFetch("/api/admin/login", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ password }),
        });
        if (!ok) {
          // 429 means the server's rate limiter kicked in — say so rather than
          // letting them keep guessing against a lockout.
          setLoginError(status === 429
            ? String(data.error || "Too many attempts. Wait a minute and try again.")
            : "That password isn't right.");
          return;
        }
      } else if (loginMode === "account") {
        const { ok, status, data } = await safeFetch("/api/staff/password-login", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: loginEmail.trim(), password: loginPassword }),
        });
        if (!ok) {
          setLoginError(status === 429
            ? String(data.error || "Too many attempts. Wait a minute and try again.")
            : String(data.error || "Wrong email or password."));
          return;
        }
      } else {
        const { ok, status, data } = await safeFetch("/api/staff/login", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: loginName.trim(), pin: loginPin }),
        });
        if (!ok) {
          setLoginError(status === 429
            ? String(data.error || "Too many attempts. Wait a minute and try again.")
            : "That name or PIN isn't right. Your name has to match exactly what the owner entered.");
          return;
        }
      }
      setPassword(""); setLoginPin(""); setLoginPassword("");
      await probeRole(); await loadDrawer(); await loadAll();
    } finally {
      setLoggingIn(false);
    }
  };

  const staffLogout = async () => {
    await fetch("/api/staff/login", { method: "DELETE" });
    window.location.reload();
  };

  const clock = async (action: "in" | "out") => {
    setTimeMsg("");
    const { ok, data } = await safeFetch("/api/staff/time", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action }),
    });
    if (!ok) { setTimeMsg(String(data.error || "Failed.")); return; }
    await loadTime();
  };

  const patchTeam = async (body: object) => {
    setTeamMsg("");
    const { ok, data } = await safeFetch("/api/admin/team", {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    if (!ok) { setTeamMsg(String(data.error || "Failed.")); return; }
    await loadTeam();
  };

  const addDeduction = async (employeeId: string, employeeName: string) => {
    const name = await dialog.prompt({
      title: "Add a recurring deduction",
      body: `This comes off ${employeeName}'s gross pay every pay period until you remove it.`,
      label: "What is it for?",
      placeholder: "Health insurance",
      hint: "Shows on their payroll breakdown under this name.",
      required: true,
      confirmLabel: "Next",
    });
    if (name === null) return;

    const cents = await dialog.money({
      title: "Amount per pay period",
      body: `Deducted from ${employeeName}'s gross every run.`,
      label: `Amount for "${name}"`,
      confirmLabel: "Add deduction",
    });
    if (cents === null) return;

    const { ok, data } = await safeFetch("/api/admin/team", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ employeeId, name, amountDollars: String(cents / 100) }),
    });
    if (!ok) { toast.error("Couldn't add the deduction", String(data.error || "")); return; }
    toast.success("Deduction added", `${name} — ${money(cents)} per pay period.`);
    await loadTeam();
  };

  const dropDeduction = async (id: string, name: string) => {
    const yes = await dialog.confirm({
      title: "Remove this deduction?",
      body: `"${name}" stops coming out of their pay from the next payroll run on. Runs you've already done aren't changed.`,
      confirmLabel: "Remove deduction",
      tone: "danger",
    });
    if (!yes) return;
    const { ok, data } = await safeFetch(`/api/admin/team?id=${id}`, { method: "DELETE" });
    if (!ok) { toast.error("Couldn't remove it", String(data.error || "")); return; }
    toast.success("Deduction removed");
    await loadTeam();
  };

  const uploadDoc = async (employeeId: string, kind: string, file: File) => {
    setTeamMsg("");
    if (file.size > 5 * 1024 * 1024) { setTeamMsg("File too big — 5 MB max."); return; }
    const dataB64: string = await new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result).split(",")[1] || "");
      r.onerror = () => reject(new Error("read failed"));
      r.readAsDataURL(file);
    });
    const { ok, data } = await safeFetch("/api/admin/team/docs", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ employeeId, kind, filename: file.name, mime: file.type, dataB64 }),
    });
    if (!ok) { setTeamMsg(String(data.error || "Upload failed.")); return; }
    await loadTeam();
  };

  const dropDoc = async (id: string, filename: string) => {
    const yes = await dialog.confirm({
      title: "Delete this document?",
      body: `"${filename}" will be permanently removed from their file. This can't be undone.`,
      confirmLabel: "Delete document",
      tone: "danger",
    });
    if (!yes) return;
    const { ok, data } = await safeFetch(`/api/admin/team/docs/${id}`, { method: "DELETE" });
    if (!ok) { toast.error("Couldn't delete it", String(data.error || "")); return; }
    toast.success("Document deleted");
    await loadTeam();
  };

  /* ---------- onboarding ----------------------------------------------------
     Accepted vendors whose portal is still locked, plus exactly what each one
     is waiting on. Served whole by /api/admin/onboarding — this page does no
     arithmetic on it beyond counting the tiles. */
  type OnbStep = { key: "agreement" | "countersign" | "firstRent"; label: string; done: boolean; detail?: string };
  type OnbContract = {
    id: string; boothLabel: string; monthlyRentCents: number; startDate: string; createdAt: string;
    sent: boolean; signToken?: string; viewedAt: string | null; vendorSignedAt: string | null; marketSignedAt: string | null;
  };
  type OnbRow = {
    vendorId: string; code: string; businessName: string; contactName: string;
    email: string; phone: string; cardLast4: string; createdAt: string;
    contract: OnbContract | null;
    balanceCents: number; owesCents: number;
    steps: OnbStep[];
    nextStep: "agreement" | "countersign" | "firstRent" | null;
    nextStepLabel: string;
    daysWaiting: number;
    publiclyVisible: boolean;
  };
  const [onboarding, setOnboarding] = useState<OnbRow[]>([]);
  const [onbLoading, setOnbLoading] = useState(false);
  const [onbErr, setOnbErr] = useState("");
  const [onbOpen, setOnbOpen] = useState<string | null>(null);

  const loadOnboarding = useCallback(async () => {
    setOnbLoading(true); setOnbErr("");
    try {
      const r = await fetch("/api/admin/onboarding");
      if (!r.ok) { setOnbErr("Couldn't load the onboarding list."); return; }
      setOnboarding((await r.json()).vendors || []);
    } catch {
      setOnbErr("Couldn't reach the server. Check the connection and try again.");
    } finally {
      setOnbLoading(false);
    }
  }, []);
  useEffect(() => { if (authed && allowed("market") && tab === "onboarding") loadOnboarding(); }, [authed, caps, tab, loadOnboarding]);

  /* ---------- calendar ------------------------------------------------------
     Viewings, market days and anything else she needs to remember. The month
     grid is built by hand from plain Dates — no date library, no new package. */
  type CalForm = {
    id: string | null;
    title: string;
    kind: EventKind;
    startAt: string;   // always "YYYY-MM-DDTHH:mm", sent to the API verbatim
    endAt: string;
    allDay: boolean;
    location: string;
    notes: string;
    contactName: string;
    contactPhone: string;
    contactEmail: string;
    notify: boolean;
  };
  type LegacyPreview = {
    dryRun: boolean;
    importedCount: number;
    imported: { businessName: string; when: string }[];
    flagged: { applicationId: string; businessName: string; raw: string; reason: string }[];
  };

  const [calEvents, setCalEvents] = useState<CalEvent[]>([]);
  const [calPending, setCalPending] = useState(0);
  const [calLoading, setCalLoading] = useState(false);
  const [calErr, setCalErr] = useState("");
  const [calMonth, setCalMonth] = useState(() => { const n = new Date(); return new Date(n.getFullYear(), n.getMonth(), 1); });
  const [calView, setCalView] = useState<"month" | "list">("month");
  const [calWhen, setCalWhen] = useState<"upcoming" | "past">("upcoming");
  const [calOpen, setCalOpen] = useState<string | null>(null);      // event slide-over
  const [calDayOpen, setCalDayOpen] = useState<string | null>(null); // one day's list
  const [calForm, setCalForm] = useState<CalForm | null>(null);
  const [calFormErr, setCalFormErr] = useState("");
  const [calImport, setCalImport] = useState<LegacyPreview | null>(null);
  const [calImporting, setCalImporting] = useState(false);

  const loadCalendar = useCallback(async () => {
    setCalLoading(true); setCalErr("");
    try {
      /* A month either side of the one on screen, so the grid's leading and
         trailing days are filled in and the list has something to show. */
      const from = isoDate(new Date(calMonth.getFullYear(), calMonth.getMonth() - 1, 1));
      const to = isoDate(new Date(calMonth.getFullYear(), calMonth.getMonth() + 2, 0));
      const r = await fetch(`/api/admin/calendar?from=${from}&to=${to}`);
      if (!r.ok) { setCalErr("Couldn't load the calendar."); return; }
      const d = await r.json();
      setCalEvents(d.events || []);
      setCalPending(Number(d.pendingImport) || 0);
    } catch {
      setCalErr("Couldn't reach the server. Check the connection and try again.");
    } finally {
      setCalLoading(false);
    }
  }, [calMonth]);
  useEffect(() => { if (authed && allowed("market") && tab === "calendar") loadCalendar(); }, [authed, caps, tab, loadCalendar]);

  const openCalCreate = (day?: Date) => {
    const base = day ? new Date(day) : new Date();
    if (day) {
      base.setHours(10, 0, 0, 0);          // a sensible hour for a day she clicked
    } else {
      base.setMinutes(0, 0, 0);
      base.setHours(base.getHours() + 1);  // the top of the next hour
    }
    setCalFormErr("");
    setCalDayOpen(null);
    setCalForm({
      id: null, title: "", kind: "VIEWING", startAt: localInput(base), endAt: "",
      allDay: false, location: "", notes: "",
      contactName: "", contactPhone: "", contactEmail: "", notify: false,
    });
  };

  const openCalEdit = (e: CalEvent) => {
    setCalFormErr("");
    setCalForm({
      id: e.id,
      title: e.title,
      kind: e.kind,
      startAt: localInput(new Date(e.startAt)),
      endAt: e.endAt ? localInput(new Date(e.endAt)) : "",
      allDay: !!e.allDay,
      location: e.location || "",
      notes: e.notes || "",
      contactName: e.contactName || "",
      contactPhone: e.contactPhone || "",
      contactEmail: e.contactEmail || "",
      notify: false,
    });
  };

  const saveCalEvent = async () => {
    const f = calForm;
    if (!f) return;
    if (!f.title.trim()) { setCalFormErr("Give the event a title."); return; }
    if (!f.startAt) { setCalFormErr("Pick a date and time."); return; }
    /* Both strings are "YYYY-MM-DDTHH:mm", so a plain comparison is a real
       chronological one — and it catches the mistake before the round trip. */
    if (f.endAt && f.endAt < f.startAt) { setCalFormErr("The end time is before the start time. Move one of them."); return; }
    setCalFormErr("");
    setBusy(true);
    const payload: Record<string, unknown> = {
      title: f.title.trim(),
      kind: f.kind,
      startAt: f.startAt,                 // sent raw — toISOString() would shift it
      endAt: f.endAt,
      allDay: f.allDay,
      location: f.location.trim(),
      notes: f.notes.trim(),
      contactName: f.contactName.trim(),
      contactPhone: f.contactPhone.trim(),
      contactEmail: f.contactEmail.trim(),
    };
    if (f.id) payload.id = f.id;
    else if (f.notify) payload.notify = true;

    const { ok, data } = await safeFetch("/api/admin/calendar", {
      method: f.id ? "PATCH" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    setBusy(false);
    if (!ok) { setCalFormErr(String(data.error || "Couldn't save the event.")); return; }
    setCalForm(null);
    toast.success(
      f.id ? "Event updated" : "Event added",
      f.id ? undefined
        : f.notify
          ? (data.emailed
              ? "They've been emailed the details."
              : "Saved, but no email went out — only a viewing linked to an application can be emailed from here.")
          : undefined
    );
    await loadCalendar();
  };

  const setCalEventStatus = async (e: CalEvent, status: EventStatus) => {
    setBusy(true);
    const { ok, data } = await safeFetch("/api/admin/calendar", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: e.id, status }),
    });
    setBusy(false);
    if (!ok) { toast.error("Couldn't change the status", String(data.error || "")); return; }
    toast.success(`Marked ${STATUS_META[status].label.toLowerCase()}`, e.title);
    await loadCalendar();
  };

  const deleteCalEvent = async (e: CalEvent) => {
    const yes = await dialog.confirm({
      title: `Delete "${e.title}"?`,
      body: e.applicationId
        ? "It comes off the calendar and the viewing line on their application is cleared. This can't be undone."
        : "It comes off the calendar for good. This can't be undone.",
      confirmLabel: "Delete event",
      cancelLabel: "Keep it",
      tone: "danger",
    });
    if (!yes) return;
    setBusy(true);
    const { ok, data } = await safeFetch(`/api/admin/calendar?id=${encodeURIComponent(e.id)}`, { method: "DELETE" });
    setBusy(false);
    if (!ok) { toast.error("Couldn't delete it", String(data.error || "")); return; }
    setCalOpen(null);
    toast.success("Event deleted", e.title);
    await loadCalendar();
  };

  /* Legacy viewings were typed as free text on the application form. The dry
     run is shown in full before a single row is written. */
  const previewLegacyImport = async () => {
    setCalImporting(true);
    const { ok, data } = await safeFetch("/api/admin/calendar", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "import_legacy", dryRun: true }),
    });
    setCalImporting(false);
    if (!ok) { toast.error("Couldn't check the old viewings", String(data.error || "")); return; }
    setCalImport({
      dryRun: true,
      importedCount: Number(data.importedCount) || 0,
      imported: (data.imported as LegacyPreview["imported"]) || [],
      flagged: (data.flagged as LegacyPreview["flagged"]) || [],
    });
  };

  const runLegacyImport = async () => {
    setCalImporting(true);
    const { ok, data } = await safeFetch("/api/admin/calendar", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "import_legacy" }),
    });
    setCalImporting(false);
    if (!ok) { toast.error("The import didn't run", String(data.error || "")); return; }
    const flagged = (data.flagged as LegacyPreview["flagged"]) || [];
    const count = Number(data.importedCount) || 0;
    setCalImport(null);
    toast.success(
      count === 0 ? "Nothing left to import" : `Imported ${plural(count, "viewing")}`,
      flagged.length ? `${plural(flagged.length, "viewing")} couldn't be read.` : undefined
    );
    if (flagged.length) {
      await dialog.alert({
        title: `${plural(flagged.length, "viewing")} needs setting by hand`,
        tone: "warn",
        body: (
          <div className="stack g-3">
            <p className="t-sm">
              Nothing was lost — these are still on the applications. The dates just
              couldn&rsquo;t be read, so add them to the calendar yourself.
            </p>
            <ul className="stack g-3" style={{ listStyle: "none", margin: 0, padding: 0 }}>
              {flagged.map((f) => (
                <li key={f.applicationId} className="stack g-1">
                  <b>{f.businessName}</b>
                  <span className="t-sm">They wrote: &ldquo;{f.raw}&rdquo;</span>
                  <span className="t-xs t-muted">{f.reason}</span>
                </li>
              ))}
            </ul>
          </div>
        ),
      });
    }
    await loadCalendar();
  };

  type TentD ={ id: string; date: string; capacity: number; open: boolean; bookings: { id: string; name: string; businessName: string; email: string; phone: string; status: string }[] };
  const [tentDates, setTentDates] = useState<TentD[]>([]);
  const [tentFrom, setTentFrom] = useState("");
  const [tentTo, setTentTo] = useState("");
  const [tentCap, setTentCap] = useState("4");
  const [tentDows, setTentDows] = useState<number[]>([5, 6]); // Fri, Sat default
  const [tentMsg, setTentMsg] = useState("");
  const [tentPaused, setTentPaused] = useState(false);
  const [tentPauseMsg, setTentPauseMsg] = useState("");

  const loadTents = useCallback(async () => {
    const r = await fetch("/api/admin/tents");
    if (r.ok) {
      const d = await r.json();
      setTentDates(d.dates || []);
      if (d.pause) { setTentPaused(!!d.pause.paused); setTentPauseMsg(d.pause.message || ""); }
    }
  }, []);
  useEffect(() => { if (authed && allowed("market") && tab === "tents") loadTents(); }, [authed, caps, tab, loadTents]);

  const tentAct = async (
    body: Record<string, unknown>,
    confirmOpts?: { title: string; body?: string; confirmLabel?: string; tone?: "danger" | "warn" }
  ) => {
    if (confirmOpts) {
      const yes = await dialog.confirm({
        title: confirmOpts.title,
        body: confirmOpts.body,
        confirmLabel: confirmOpts.confirmLabel ?? "Confirm",
        tone: confirmOpts.tone ?? "default",
      });
      if (!yes) return;
    }
    setTentMsg("");
    const { ok, data } = await safeFetch("/api/admin/tents", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    if (!ok) { toast.error("Couldn't update tent days", String(data.error || "")); return; }
    await loadTents();
  };

  const openTentRange = async () => {
    if (!tentFrom || !tentTo) { setTentMsg("Pick a from and to date."); return; }
    const out: string[] = [];
    const d = new Date(tentFrom + "T12:00:00"), end = new Date(tentTo + "T12:00:00");
    while (d <= end && out.length < 62) {
      if (tentDows.includes(d.getDay())) out.push(d.toISOString().slice(0, 10));
      d.setDate(d.getDate() + 1);
    }
    if (out.length === 0) { setTentMsg("No days matched — check the weekday boxes."); return; }
    await tentAct({ action: "openDates", dates: out, capacity: Number(tentCap) || 4 });
    toast.success(
      `Opened ${plural(out.length, "date")}`,
      `Capacity ${tentCap} per day. Vendors can book these now.`
    );
    setTentMsg("");
  };

  const decideApplication = async (id: string, action: "accept" | "decline", businessName: string) => {
    let reason = "";
    if (action === "decline") {
      const r = await dialog.prompt({
        title: `Decline ${businessName}?`,
        body: "They'll get a decline email. Anything you write here is added to it — leave it blank to send the standard message.",
        label: "Note for the email (optional)",
        placeholder: "We're full on bakers right now, but we'd love to revisit in the spring.",
        multiline: true,
        confirmLabel: "Send decline",
        tone: "warn",
      });
      if (r === null) return;
      reason = r;
    } else {
      const yes = await dialog.confirm({
        title: `Accept ${businessName}?`,
        body: "They'll get the welcome email letting them know someone will be calling. You can set up their booth and agreement after that.",
        confirmLabel: "Accept application",
      });
      if (!yes) return;
    }
    setBusy(true);
    try {
      const { ok, data } = await safeFetch(`/api/admin/applications/${id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, reason }),
      });
      if (!ok) { toast.error(`Couldn't ${action} the application`, String(data.error || "")); return; }
      /* Don't claim the email went out when the mailer refused it — the decision
         is saved regardless, and knowing to follow up by phone matters. */
      const emailed = data.emailed !== false;
      toast.success(
        action === "accept" ? `${businessName} accepted` : `${businessName} declined`,
        emailed
          ? action === "accept" ? "Welcome email sent." : "Decline email sent."
          : "Saved — but the email didn't send. Let them know another way."
      );
      const r2 = await fetch("/api/admin/applications");
      if (r2.ok) setApplications((await r2.json()).applications || []);
    } finally { setBusy(false); }
  };

  const punch = async () => {
    setPunchMsg("");
    const { ok, data } = await safeFetch("/api/staff/punch", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: punchName || employees[0]?.name, pin: punchPin }),
    });
    setPunchPin("");
    if (!ok) { setPunchMsg(String(data.error || "Failed.")); return; }
    setPunchMsg(String(data.msg));
  };

  const openRefund = async (t: Ticket) => {
    setRefundMsg("");
    const { ok, data } = await safeFetch(`/api/admin/tickets/${t.id}`);
    if (!ok) { setScanErr(String(data.error || "Couldn't load ticket.")); return; }
    const sale = data.sale as { lines: { id: string; name: string; priceCents: number; quantity: number }[] };
    setRefundTarget({ ticket: t, lines: sale.lines, refunded: (data.refunded as Record<string, number>) || {} });
    setRefundQty({});
    setRefundRestock(true);
  };

  /** The manager-PIN prompt shown when the server asks for authorisation. */
  const askApprovalPin = async (reason: string): Promise<string | null> =>
    dialog.prompt({
      title: "Manager approval needed",
      body: <p>{reason} Have a manager or the owner enter their PIN — their name goes on the record.</p>,
      label: "Manager PIN",
      type: "password",
      placeholder: "••••",
      confirmLabel: "Approve",
      tone: "danger",
      required: true,
    });

  const voidSale = async (t: Ticket) => {
    const yes = await dialog.confirm({
      title: `Void ticket #${t.number}?`,
      body: (
        <>
          <p>This reverses the whole sale — {money(t.totalCents)}. Items go back on the floor,
          the vendors&rsquo; credits reverse, and the ticket drops out of every report.</p>
          <p style={{ marginTop: 8, fontWeight: 580 }}>
            {t.paymentMethod === "CASH"
              ? `Hand back ${money(t.totalCents)} in cash from the drawer.`
              : "Reverse the charge on your card machine — this system only records it."}
          </p>
        </>
      ),
      confirmLabel: "Void the sale",
      tone: "danger",
      // A void is irreversible and moves real money, so make it deliberate.
      typeToConfirm: "VOID",
    });
    if (!yes) return;
    let { ok, data } = await safeFetch("/api/admin/refund", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ saleId: t.id, action: "void" }),
    });
    /* Over the threshold a manager has to authorise it. Asked for only when
       the server says so, so a manager or owner never types their own PIN into
       their own session — that proves nothing and only slows the queue. */
    if (!ok && data.needsApproval) {
      const pin = await askApprovalPin(String(data.error || ""));
      if (pin === null) return;
      ({ ok, data } = await safeFetch("/api/admin/refund", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ saleId: t.id, action: "void", approvalPin: pin }),
      }));
    }
    if (!ok) { toast.error("Void failed", String(data.error || "")); return; }
    toast.success(
      `Ticket #${t.number} voided`,
      t.paymentMethod === "CASH" ? `Hand back ${money(t.totalCents)} cash.` : "Reverse it on the card machine."
    );
    await loadTickets(ticketQ); await loadDrawer(); await loadAll();
  };

  const submitRefund = async () => {
    if (!refundTarget) return;
    setRefundMsg("");
    const lines = Object.entries(refundQty).filter(([, q]) => q > 0).map(([lineId, quantity]) => ({ lineId, quantity }));
    if (!lines.length) { setRefundMsg("Set a quantity on at least one item."); return; }
    let { ok, data } = await safeFetch("/api/admin/refund", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ saleId: refundTarget.ticket.id, action: "refund", lines, restock: refundRestock }),
    });
    if (!ok && data.needsApproval) {
      const pin = await askApprovalPin(String(data.error || ""));
      if (pin === null) { setRefundMsg("Refund cancelled — no manager approval."); return; }
      ({ ok, data } = await safeFetch("/api/admin/refund", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ saleId: refundTarget.ticket.id, action: "refund", lines, restock: refundRestock, approvalPin: pin }),
      }));
    }
    if (!ok) { setRefundMsg(String(data.error || "Refund failed.")); return; }
    const back = Number(data.refundCents) || 0;
    const method = refundTarget.ticket.paymentMethod;
    const num = refundTarget.ticket.number;
    setRefundTarget(null);
    toast.success(
      `Refunded ${money(back)} on #${num}`,
      method === "CASH"
        ? "Hand that back from the drawer."
        : "Reverse it on your card machine — this system only records it."
    );
    await loadTickets(ticketQ); await loadDrawer(); await loadAll();
  };

  const runPayroll = async () => {
    setTeamMsg("");
    if (!payFrom || !payTo) { setTeamMsg("Pick both dates first."); return; }
    const { ok, data } = await safeFetch(`/api/admin/payroll?from=${payFrom}&to=${payTo}`);
    if (!ok) { setTeamMsg(String(data.error || "Failed.")); return; }
    setPayroll(data.rows as PayrollRow[]);
  };

  // ---------- drawer ----------
  const countTotal = () => DENOMS.reduce((t, [k, , cents]) => t + Math.max(0, Math.round(Number(counts[k]) || 0)) * cents, 0);

  const openDrawer = async () => {
    setDrawerErr("");
    setBusy(true);
    try {
      const { ok, data } = await safeFetch("/api/admin/drawer", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ employee: empName || employees[0]?.name, pin: empPin, counts, totalCents: countTotal() }),
      });
      if (!ok) { setDrawerErr(String(data.error || "Couldn't open.")); return; }
      setCounts({}); setEmpPin("");
      await loadDrawer();
    } finally { setBusy(false); }
  };

  const closeDrawer = async () => {
    setBusy(true);
    let res: { ok: boolean; data: Record<string, unknown> };
    try { res = await safeFetch("/api/admin/drawer", {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ counts, countedCents: countTotal() }),
    }); } finally { setBusy(false); }
    const data = res.data as { session?: { employee: string; openTotalCents: number; cashSalesCents: number; countedCents: number; diffCents: number }; expected?: number; error?: string };
    if (!res.ok || !data.session) { setDrawerErr(String(data.error || "Couldn't close.")); return; }
    setCloseReport({
      employee: data.session.employee,
      openTotalCents: data.session.openTotalCents,
      cashSalesCents: data.session.cashSalesCents,
      expected: data.expected || 0,
      counted: data.session.countedCents,
      diff: data.session.diffCents,
    });
    setCounts({}); setClosing(false); setDrawer(null);
  };

  // ---------- register ----------
  const addItemToCart = (item: { id: string; sku: string; name: string; priceCents: number; basePriceCents?: number; vendorName: string; taxClass?: string }) => {
    setScanErr(""); setSearch(""); setOpenVendor(null);
    setCart((c) => {
      const line = c.find((l) => l.sku === item.sku);
      if (line) return c.map((l) => (l.sku === item.sku ? { ...l, quantity: l.quantity + 1 } : l));
      return [...c, { itemId: item.id, sku: item.sku, name: item.name, vendorName: item.vendorName, priceCents: item.priceCents, basePriceCents: item.basePriceCents, quantity: 1, taxClass: item.taxClass }];
    });
  };

  const doScan = async () => {
    const code = scan.trim().toUpperCase();
    setScan("");
    if (!code) return;
    const inCart = cart.find((l) => l.sku === code);
    if (inCart) { addItemToCart({ id: inCart.itemId, sku: inCart.sku, name: inCart.name, priceCents: inCart.priceCents, basePriceCents: inCart.basePriceCents, vendorName: inCart.vendorName, taxClass: inCart.taxClass }); return; }
    const res = await fetch(`/api/admin/lookup?sku=${encodeURIComponent(code)}`);
    const data = await res.json();
    if (!res.ok) { setScanErr(data.error || `Nothing found for ${code}.`); return; }
    addItemToCart({ id: data.item.id, sku: data.item.sku, name: data.item.name, priceCents: data.item.priceCents, basePriceCents: data.item.basePriceCents, vendorName: data.item.vendor.businessName, taxClass: data.item.taxClass });
  };

  const floor = overview?.floor || [];
  const searchHits = search.trim()
    ? floor.filter((i) => i.name.toLowerCase().includes(search.trim().toLowerCase()) || i.sku.toLowerCase().includes(search.trim().toLowerCase())).slice(0, 10)
    : [];

  const subtotal = cart.reduce((n, l) => n + l.priceCents * l.quantity, 0);
  /* Shared with the server and the kiosk — see lib/tax.ts. Food and general
     goods carry different rates, so a ticket total can't come from one
     multiplication any more. */
  const taxRates = { standardPercent: taxRate, foodPercent: foodTaxRate };
  const cartTaxLines = cart.map((l) => ({ amountCents: l.priceCents * l.quantity, taxClass: normalizeTaxClass(l.taxClass) }));
  const taxCents = taxFor(cartTaxLines, taxRates).taxCents;
  const shownTaxRate = displayRate(cartTaxLines, taxRates);
  const total = subtotal + taxCents;

  const printSale = useCallback(async (saleId: string) => {
    const res = await fetch(`/api/admin/tickets/${saleId}`);
    if (!res.ok) return;
    const { sale } = await res.json();
    if (!printRef.current) return;
    printRef.current.innerHTML = `
      <div style="width:280px;margin:0 auto;font-size:12px;line-height:1.5;text-align:center;font-family:'IBM Plex Mono',monospace;color:#000">
        <img src="/logo.png" alt="" style="width:70px;height:70px" />
        <img src="/logo.png" alt="Community Harvest" style="width:100%;max-width:260px;display:block;margin:0 auto 2px" />
        <div>Noble, Oklahoma</div>
        <div style="margin:6px 0;border-top:1px dashed #000;border-bottom:1px dashed #000;padding:4px 0">
          RECEIPT #${sale.number}<br>${new Date(sale.createdAt).toLocaleDateString("en-US", { timeZone: TZ })} ${new Date(sale.createdAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: TZ })}${sale.employee ? "<br>CLERK: " + sale.employee : ""}
        </div>
        <div style="text-align:left">
          ${sale.lines.map((l: { quantity: number; name: string; priceCents: number; basePriceCents?: number }) => `<div style="display:flex;justify-content:space-between"><span>${l.quantity}x ${l.name.slice(0, 26)}</span><span>${money((l.basePriceCents || l.priceCents) * l.quantity)}</span></div>`).join("")}
        </div>
        <div style="border-top:1px dashed #000;margin-top:4px;padding-top:4px;text-align:left">
          <div style="display:flex;justify-content:space-between"><span>SUBTOTAL</span><span>${money(sale.subtotalCents + (sale.saleSavingsCents || 0))}</span></div>
          ${sale.saleSavingsCents ? `<div style="display:flex;justify-content:space-between"><span>SALE SAVINGS</span><span>-${money(sale.saleSavingsCents)}</span></div>` : ""}
          ${sale.cardAdjustCents ? `<div style="display:flex;justify-content:space-between"><span>NON-CASH ADJ</span><span>${money(sale.cardAdjustCents)}</span></div>` : ""}
          ${sale.foodTaxCents && sale.standardTaxCents
            ? `<div style="display:flex;justify-content:space-between"><span>TAX (GENERAL)</span><span>${money(sale.standardTaxCents)}</span></div>
          <div style="display:flex;justify-content:space-between"><span>TAX (FOOD)</span><span>${money(sale.foodTaxCents)}</span></div>`
            : `<div style="display:flex;justify-content:space-between"><span>TAX</span><span>${money(sale.taxCents)}</span></div>`}
          ${sale.discountCents ? `<div style="display:flex;justify-content:space-between"><span>REWARDS</span><span>-${money(sale.discountCents)}</span></div>` : ""}
          <div style="display:flex;justify-content:space-between;font-weight:700;font-size:14px"><span>TOTAL</span><span>${money(sale.totalCents)}</span></div>
          ${sale.cashTenderedCents ? `<div style="display:flex;justify-content:space-between"><span>CASH</span><span>${money(sale.cashTenderedCents)}</span></div>
          <div style="display:flex;justify-content:space-between"><span>CHANGE</span><span>${money(sale.changeCents || 0)}</span></div>` : ""}
          <div>${sale.paymentMethod}${sale.cardName ? " - " + sale.cardName : ""}</div>
        </div>
        <div style="margin-top:8px">THANK YOU!<br>homegrown + homemade</div><div style="margin-top:6px;font-size:10px">ALL SALES FINAL — NO REFUNDS OR EXCHANGES</div>
      </div>`;
    const img = printRef.current.querySelector("img");
    if (img && !img.complete) {
      await new Promise<void>((resolve) => {
        img.onload = () => resolve();
        img.onerror = () => resolve();
        setTimeout(resolve, 1500);
      });
    }
    document.body.classList.add("receiptmode");
    window.print();
    setTimeout(() => document.body.classList.remove("receiptmode"), 400);
  }, []);

  const [customers, setCustomers] = useState<{ id: string; email: string; phone: string; points: number; unsubscribed: boolean; follows: number; createdAt: string; saleCount: number; spentCents: number }[]>([]);
  const [custQ, setCustQ] = useState("");
  const [cust, setCust] = useState<{ id: string; email: string; phone: string; points: number } | null>(null);
  const [redeem, setRedeem] = useState(false);
  const [custMsg, setCustMsg] = useState("");
  const [attachQ, setAttachQ] = useState("");
  const [attachMsg, setAttachMsg] = useState("");

  const attachCustomer = async () => {
    if (!receipt || !attachQ.trim()) return;
    setAttachMsg("");
    const r = await fetch("/api/admin/sale/attach", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ saleId: receipt.id, contact: attachQ.trim() }) });
    const d = await r.json();
    if (!r.ok) { setAttachMsg(d.error || "Couldn't add."); return; }
    setAttachMsg("");
    toast.success(
      `${d.points} points · ${d.contact}`,
      d.contact.includes("@") ? "Receipt emailed." : undefined
    );
  };

  const lookupCust = async () => {
    setCustMsg("");
    if (!custQ.trim()) { setCust(null); return; }
    const r = await fetch(`/api/admin/customer?q=${encodeURIComponent(custQ.trim())}`);
    const d = await r.json();
    if (r.ok && d.customer) { setCust(d.customer); }
    else { setCust(null); setCustMsg("New customer — they'll be enrolled with this sale. \u2b50"); }
  };

  const completeSale = async (paymentMethod: "CASH" | "CARD", cashTenderedCents = 0) => {
    if (!cart.length) return;
    setBusy(true);
    let ok = false; let data: Record<string, unknown> = {};
    try { ({ ok, data } = await safeFetch("/api/admin/sale", {
      method: "POST", headers: { "Content-Type": "application/json" },
      /* customerContact and redeem belong to the SALE, not to each line. They
         were inside the line map — a misplaced bracket — so every ticket rung
         from this screen sent them as properties of an item, the server never
         saw them, and no customer signed up here ever earned or spent a point.
         idemKey makes a retry harmless: if this request is booked but the reply
         is lost, sending it again returns the same ticket instead of a second
         one. */
      body: JSON.stringify({
        paymentMethod, cardName, cashTenderedCents,
        customerContact: custQ.trim(),
        redeem,
        idemKey: newSaleKey(),
        lines: cart.map((l) => ({ itemId: l.itemId, quantity: l.quantity })),
      }),
    })); } finally { setBusy(false); }
    if (!ok) { setScanErr(String(data.error || "Sale failed.")); return; }
    setReceipt({ ...(data.sale as Receipt), paymentMethod, lines: cart });
    setCart([]); setCardName(""); setCashConfirm(false);
    loadDrawer(); loadAll(); loadTickets(ticketQ);
    if (autoPrint) setTimeout(() => printSale((data.sale as { id: string }).id), 250);
  };

  const toggleAutoPrint = () => {
    setAutoPrint((v) => {
      try { window.localStorage.setItem("nm_autoprint", v ? "0" : "1"); } catch {}
      return !v;
    });
  };

  // ---------- vendors ----------
  const addVendor = async () => {
    setVMsg(""); setBusy(true);
    try {
      const { ok, data } = await safeFetch("/api/admin/vendors", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ businessName: vName, contactName: vContact, email: vEmail, phone: vPhone, commissionPercent: vComm }),
      });
      if (!ok) { setVMsg(String(data.error || "Couldn't add vendor.")); return; }
      const v = data.vendor as { businessName: string; code: string };
      setVMsg("");
      // The temp password used to flash past in an alert() — dismiss it and the
      // only recovery was issuing another one. Now it's copyable and deliberate.
      await dialog.alert({
        title: `${v.businessName} added as ${v.code}`,
        body: "This temporary password was emailed to them too. They'll be asked to change it when they first sign in.",
        tone: "success",
        copyable: String(data.tempPassword),
        confirmLabel: "Done",
      });
      setVName(""); setVContact(""); setVEmail(""); setVPhone(""); setVComm("0");
      await loadAll();
    } finally { setBusy(false); }
  };

  const patchVendor = async (id: string, body: object, successMsg?: string) => {
    setBusy(true);
    try {
      const { ok, data } = await safeFetch(`/api/admin/vendors/${id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      if (!ok) { toast.error("Update failed", String(data.error || "")); return; }
      if (data.tempPassword) {
        await dialog.alert({
          title: `New password for ${(data.vendor as { businessName: string }).businessName}`,
          body: "Their old password stopped working. This one was emailed to them as well.",
          tone: "success",
          copyable: String(data.tempPassword),
          confirmLabel: "Done",
        });
      } else if (successMsg) {
        toast.success(successMsg);
      }
      await loadAll();
    } finally { setBusy(false); }
  };

  const ledgerEntry = async (
    v: { id: string; businessName: string; balance: number },
    type: "RENT" | "RENT_PAYMENT" | "PAYOUT" | "ADJUST",
    presetCents?: number
  ) => {
    const copy = {
      RENT:   { title: `Charge rent to ${v.businessName}`, label: "Rent to charge", note: "Booth rent",
                body: "Adds a debit to their account. It shows on their next statement." },
      RENT_PAYMENT: { title: `Record a rent payment from ${v.businessName}`, label: "Amount received", note: "Rent paid",
                body: "Cash, check or bank transfer. Card payments post themselves. This is what marks their invoice paid." },
      PAYOUT: { title: `Pay out ${v.businessName}`, label: "Payout amount", note: "Payout",
                body: `Record money you're handing them. Their balance is currently ${money(v.balance)}.` },
      ADJUST: { title: `Adjust ${v.businessName}'s balance`, label: "Adjustment", note: "",
                body: "Use a minus sign to take money off their balance, no sign to add it. An adjustment is NOT a payment — to mark rent paid, use Record payment." },
    }[type];

    const cents = await dialog.money({
      title: copy.title,
      body: copy.body,
      label: copy.label,
      defaultCents:
        type === "PAYOUT" ? Math.max(0, v.balance)
        : type === "RENT_PAYMENT" ? presetCents
        : undefined,
      allowNegative: type === "ADJUST",
      confirmLabel: "Next",
    });
    if (cents === null) return;

    /* How it arrived, on a payment. It ends up in the statement note, which is
       the only place anyone will look when a vendor says "I paid that in
       cash in October". */
    let how = "";
    if (type === "RENT_PAYMENT") {
      how = (await dialog.choose({
        title: "How did they pay?",
        label: "Method",
        options: [
          { value: "Cash", label: "Cash" },
          { value: "Check", label: "Check" },
          { value: "Bank transfer", label: "Bank transfer", hint: "Zelle, Venmo, ACH" },
          { value: "Other", label: "Other" },
        ],
        defaultValue: "Cash",
        confirmLabel: "Next",
      })) || "";
      if (!how) return;
    }

    const note = await dialog.prompt({
      title: "What should this say on their statement?",
      body: `${money(cents)} — ${copy.title.toLowerCase()}.`,
      label: "Note",
      defaultValue: type === "RENT_PAYMENT" ? `Rent paid — ${how.toLowerCase()}` : copy.note,
      placeholder: "Booth rent for October",
      confirmLabel: "Post to ledger",
    });
    if (note === null) return;

    setBusy(true);
    try {
      const { ok, data } = await safeFetch(`/api/admin/vendors/${v.id}/ledger`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type, amountDollars: String(cents / 100), note }),
      });
      if (!ok) { toast.error("Couldn't post that entry", String(data.error || "")); return; }
      toast.success(`${money(cents)} posted to ${v.businessName}`, note || undefined);
      await loadAll();
    } finally { setBusy(false); }
  };

  // ---------- contracts ----------
  const addContract = async () => {
    setCMsg(""); setBusy(true);
    try {
      const { ok, data } = await safeFetch("/api/admin/contracts", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ vendorId: cVendor, boothLabel: cBooth, monthlyRentDollars: cRent, startDate: cStart }),
      });
      if (!ok) { setCMsg(String(data.error || "Couldn't create it.")); return; }
      setCMsg("");
      toast.success(
        "Agreement created",
        `First month prorates to ${money(Number(data.firstMonthCents) || 0)} and is on their balance. Full rent auto-charges every 1st after that.`
      );
      setCBooth(""); setCStart("");
      await loadAll();
    } finally { setBusy(false); }
  };

  const giveNotice = async (c: Contract) => {
    const d = await dialog.prompt({
      title: `Record 30-day notice — booth ${c.boothLabel}`,
      body: `${c.vendor.businessName} is giving notice. The lease ends 30 days from the date you enter, and their final month's rent prorates to that day.`,
      label: "Date the notice was given",
      type: "date",
      defaultValue: isoDate(),
      required: true,
      confirmLabel: "Record notice",
      tone: "warn",
      validate: (v) => (Number.isNaN(new Date(v).getTime()) ? "Pick a valid date." : null),
    });
    if (d === null) return;
    setBusy(true);
    try {
      const { ok, data } = await safeFetch(`/api/admin/contracts/${c.id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "give_notice", noticeDate: d }),
      });
      if (!ok) { toast.error("Couldn't record the notice", String(data.error || "")); return; }
      await dialog.alert({
        title: "Notice recorded",
        tone: "success",
        body: (
          <DescList
            items={[
              { label: "Vendor", value: c.vendor.businessName },
              { label: "Booth", value: c.boothLabel },
              { label: "Lease ends", value: fmtDate((data.contract as { endDate: string }).endDate) },
              { label: "Final month rent", value: money(Number(data.finalRentCents) || 0) },
            ]}
          />
        ),
      });
      await loadAll();
    } finally { setBusy(false); }
  };

  const finalStatement = async (c: Contract) => {
    const v = vendors.find((x) => x.id === c.vendorId);
    if (!v || !c.endDate) return;
    const end = new Date(c.endDate);
    const dim = new Date(end.getFullYear(), end.getMonth() + 1, 0).getDate();
    const finalRent = Math.round((c.monthlyRentCents * end.getDate()) / dim);
    const net = v.balance - finalRent;
    // Previously an alert() with \n-joined text — the one copy of a document
    // the operator needs at move-out, gone as soon as they hit OK.
    await dialog.alert({
      title: `Final statement — ${v.businessName}`,
      tone: net >= 0 ? "default" : "warn",
      body: (
        <>
          <DescList
            items={[
              { label: "Booth", value: c.boothLabel },
              { label: "Lease ends", value: fmtDate(end) },
              { label: "Current balance", value: money(v.balance) },
              { label: "Final rent (prorated)", value: `−${money(finalRent)}` },
            ]}
          />
          <div
            className="row between mt-4"
            style={{
              padding: "var(--sp-3)",
              borderRadius: "var(--r-md)",
              background: net >= 0 ? "var(--accent-soft)" : "var(--warn-soft)",
              color: net >= 0 ? "var(--accent-text)" : "var(--warn-text)",
              fontWeight: 650,
            }}
          >
            <span>{net >= 0 ? "We owe them" : "They owe us"}</span>
            <span className="num">{money(Math.abs(net))}</span>
          </div>
          <p className="t-xs t-muted mt-3">
            The prorated final rent auto-charges on the 1st. This is a summary, not a posted entry.
          </p>
        </>
      ),
    });
  };

  const contractAction = async (
    id: string,
    action: string,
    confirmOpts: { title: string; body?: ReactNode; confirmLabel: string; tone?: "danger" | "warn"; typeToConfirm?: string },
    successMsg?: string
  ) => {
    const yes = await dialog.confirm({
      title: confirmOpts.title,
      body: confirmOpts.body,
      confirmLabel: confirmOpts.confirmLabel,
      tone: confirmOpts.tone ?? "default",
      typeToConfirm: confirmOpts.typeToConfirm,
    });
    if (!yes) return;
    setBusy(true);
    try {
      const { ok, data } = await safeFetch(`/api/admin/contracts/${id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      // The old version swallowed failures here entirely — the list just
      // reloaded unchanged and the operator had no idea nothing happened.
      if (!ok) { toast.error("That didn't go through", String(data.error || "")); return; }
      if (successMsg) toast.success(successMsg);
      await loadAll();
    } finally { setBusy(false); }
  };

  /* They pulled out before they ever started. That is a different thing from
     voiding an agreement (we reissued a corrected one) and from ending a lease
     that ran its term, and it's the distinction the office keeps asking for.

     Rent only posts once BOTH signatures are in, so the overwhelmingly common
     case — backed out before signing — owes nothing and money never comes up.
     The server tells us when it does. */
  const markWithdrawn = async (c: Contract) => {
    const reason = await dialog.prompt({
      title: `Did ${c.vendor.businessName} back out?`,
      body: (
        <>
          The agreement is marked as backed out and their vendor account is switched off, so
          they drop out of Onboarding and stop getting reminder emails about signing. Nothing is
          deleted &mdash; you can put them back on if they change their mind.
        </>
      ),
      label: "Why did they back out? (optional)",
      hint: "Internal only. Filed on their application so the history stays in one place.",
      placeholder: "Went with another market",
      multiline: true,
      required: false,
      confirmLabel: "Mark as backed out",
      tone: "warn",
    });
    // null is "cancel"; an empty string is a deliberate "no reason to record".
    if (reason === null) return;

    const send = (writeOff?: boolean) =>
      safeFetch(`/api/admin/contracts/${c.id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          typeof writeOff === "boolean"
            ? { action: "mark_withdrawn", reason, writeOff }
            : { action: "mark_withdrawn", reason }
        ),
      });

    setBusy(true);
    try {
      let res = await send();
      if (!res.ok) { toast.error("That didn't go through", String(res.data.error || "")); return; }

      /* Only reached when rent has already posted against them, which means
         they signed and then pulled out. Nothing has changed server-side yet. */
      if (res.data.needsDecision) {
        const owed = Number(res.data.owesCents) || 0;
        const who = String(res.data.businessName || c.vendor.businessName);
        const pick = await dialog.choose({
          title: `${who} still owes ${money(owed)}`,
          body: "Nothing has been marked yet. Rent was charged before they pulled out, so say what happens to it.",
          label: "The outstanding balance",
          options: [
            { value: "writeoff", label: `Write off the ${money(owed)} they owe` },
            { value: "keep", label: `Leave the ${money(owed)} on their account` },
          ],
          confirmLabel: "Mark as backed out",
        });
        if (pick === null) return;
        res = await send(pick === "writeoff");
        if (!res.ok) { toast.error("That didn't go through", String(res.data.error || "")); return; }
      }

      const wroteOff = Number(res.data.wroteOff) || 0;
      const leftOwing = Number(res.data.leftOwing) || 0;
      toast.success(
        `${c.vendor.businessName} marked as backed out`,
        wroteOff > 0
          ? `${money(wroteOff)} written off and their vendor account switched off.`
          : leftOwing > 0
            ? `${money(leftOwing)} stays owing on their account. Their vendor account is switched off.`
            : "Their vendor account is switched off and the signing reminders stop."
      );
      setContractOpen(null);
      await loadAll();
    } finally { setBusy(false); }
  };

  /* Changed their mind back. Undoes the status and the account switch — a
     write-off, being a posted ledger entry, deliberately stays put. */
  const reinstateContract = async (c: Contract) => {
    const yes = await dialog.confirm({
      title: `Put ${c.vendor.businessName} back on?`,
      body: `Booth ${c.boothLabel}'s agreement goes back to active and their vendor account is switched on again. Anything you wrote off stays written off.`,
      confirmLabel: "Put them back on",
      cancelLabel: "Leave it",
    });
    if (!yes) return;
    setBusy(true);
    try {
      const { ok, data } = await safeFetch(`/api/admin/contracts/${c.id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "reinstate" }),
      });
      if (!ok) { toast.error("That didn't go through", String(data.error || "")); return; }
      toast.success(
        `${c.vendor.businessName} is back on`,
        "Their agreement is active again and the vendor account is switched back on."
      );
      await loadAll();
    } finally { setBusy(false); }
  };

  /* Every recorded open of one invoice. Opening this doesn't add to the log —
     admin previews are never recorded server-side — so looking can't change
     what you're looking at. */
  const openInvoiceLog = async (contractId: string) => {
    setInvoiceLogFor(contractId);
    setInvoiceLog(null);
    setInvoiceLogErr("");
    setInvoiceLogLoading(true);
    try {
      const { ok, data } = await safeFetch(`/api/admin/contracts/${contractId}/views`);
      if (!ok) {
        setInvoiceLogErr(String(data.error || "The open history couldn't be loaded."));
        return;
      }
      setInvoiceLog(Array.isArray(data.views) ? (data.views as InvoiceView[]) : []);
    } finally {
      setInvoiceLogLoading(false);
    }
  };

  const closeInvoiceLog = () => {
    setInvoiceLogFor(null);
    setInvoiceLog(null);
    setInvoiceLogErr("");
  };

  /* Nudge one vendor who hasn't signed. The email spells out that the booth
     isn't held for them yet, so the confirm has to say that too — otherwise the
     operator doesn't know what they're about to send. */
  /* The signing link, in a form you can paste into a text message.
     Email is the only way this link has ever left the building, and agreements
     have been landing in junk — so the fastest route to a signature is often a
     text, which needs the link itself rather than a Send button. */
  const signingLinkFor = (token: string) =>
    typeof window === "undefined" ? `/sign/${token}` : `${window.location.origin}/sign/${token}`;

  const copySigningLink = async (token: string, businessName: string) => {
    const url = signingLinkFor(token);
    try {
      await navigator.clipboard.writeText(url);
      toast.success("Signing link copied", `Paste it into a text to ${businessName}.`);
    } catch {
      /* Clipboard access is blocked in plenty of situations — an insecure
         origin, an embedded browser, a locked-down phone. Showing the link in
         a dialog they can select beats a toast saying it didn't work. */
      await dialog.alert({
        title: `Signing link for ${businessName}`,
        body: "Your browser blocked the clipboard, so here it is to copy by hand.",
        copyable: url,
        confirmLabel: "Done",
      });
    }
  };

  const sendAgreementReminder = async (contractId: string, businessName: string) => {
    const yes = await dialog.confirm({
      title: `Remind ${businessName} to sign?`,
      body: "They get their signing link again, in an email that says plainly the booth isn't reserved until the agreement is signed and the first month is paid.",
      confirmLabel: "Send the reminder",
      cancelLabel: "Not now",
    });
    if (!yes) return;
    setBusy(true);
    try {
      const { ok, data } = await safeFetch(`/api/admin/contracts/${contractId}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "send_reminder" }),
      });
      if (!ok) { toast.error("Couldn't send the reminder", String(data.error || "")); return; }
      toast.success("Reminder sent", `Emailed to ${String(data.sentTo || businessName)}.`);
      await loadOnboarding();
      await loadAll();
    } finally { setBusy(false); }
  };

  /* Chase one unpaid invoice from the ledger, without leaving the tab. Re-sends
     the pay link, which is always built from the CURRENT balance rather than
     whatever it said when it first went out. */
  const sendRentLinkFor = async (row: InvoiceRow) => {
    const yes = await dialog.confirm({
      title: `Send ${row.businessName} their invoice again?`,
      body: `They get a pay link for ${money(row.outstandingCents)}, plus the 3% card adjustment. The amount is worked out when they open it, so it stays right even if the balance moves.`,
      confirmLabel: "Send the invoice",
      cancelLabel: "Not now",
    });
    if (!yes) return;
    setBusy(true);
    try {
      const { ok, data } = await safeFetch(`/api/admin/contracts/${row.contractId}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "send_rent_link" }),
      });
      if (!ok) { toast.error("Couldn't send the invoice", String(data.error || "")); return; }
      toast.success("Invoice sent", `Emailed to ${String(data.sentTo || row.businessName)}.`);
      const r = await fetch("/api/admin/rent-ledger");
      if (r.ok) setLedger(await r.json());
    } finally { setBusy(false); }
  };

  /* Bulk nudge. Threshold first, then a count, then the result — three small
     questions beat one dialog nobody reads. */
  const remindAllUnsigned = async () => {
    const pick = await dialog.choose({
      title: "Remind everyone unsigned",
      body: "Only vendors whose agreement still has no signature get an email.",
      label: "Who to remind",
      options: [
        { value: "0", label: "Everyone with an unsigned agreement" },
        { value: "3", label: "Waiting 3 days or more" },
        { value: "7", label: "Waiting 7 days or more" },
        { value: "14", label: "Waiting 14 days or more" },
      ],
      confirmLabel: "Continue",
    });
    if (pick === null) return;
    const minDays = Number(pick) || 0;

    /* Ask the server how many actually qualify. The onboarding list only holds
       vendors who aren't live yet, but the sweep also covers unsigned
       agreements belonging to vendors who already are — a second booth, say —
       so counting locally would understate it. */
    const probe = await safeFetch("/api/admin/onboarding", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "remind_all", minDaysWaiting: minDays, dryRun: true }),
    });
    if (!probe.ok) { toast.error("Couldn't check who's unsigned", String(probe.data.error || "")); return; }
    const willGet = Number(probe.data.eligibleCount) || 0;
    const noEmail = Number(probe.data.missingEmail) || 0;

    if (willGet === 0) {
      toast.info("Nobody to remind", minDays === 0
        ? "Every agreement out there has been signed."
        : `Nobody has been waiting ${minDays} days or more.`);
      return;
    }

    const yes = await dialog.confirm({
      title: `Send ${plural(willGet, "reminder")}?`,
      body: (
        <>
          <p>
            {minDays === 0
              ? "Every vendor sitting on an unsigned agreement"
              : `Every vendor who's been waiting ${minDays} days or more`}{" "}
            gets their signing link again, in an email that says the booth isn&rsquo;t reserved
            until it&rsquo;s signed and the first month is paid.
          </p>
          {noEmail > 0 ? (
            <p style={{ marginTop: 8 }}>
              {plural(noEmail, "of them has", `of them have`)} no email address on file and will be
              skipped — you&rsquo;ll get the list afterwards.
            </p>
          ) : null}
        </>
      ),
      confirmLabel: "Send the reminders",
      cancelLabel: "Not now",
    });
    if (!yes) return;

    setBusy(true);
    try {
      const { ok, data } = await safeFetch("/api/admin/onboarding", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "remind_all", minDaysWaiting: minDays }),
      });
      if (!ok) { toast.error("Couldn't send the reminders", String(data.error || "")); return; }

      const sentCount = Number(data.sentCount) || 0;
      const skipped = Number(data.skipped) || 0;
      const failed = (data.failed as { businessName: string; reason: string }[] | undefined) || [];

      toast.success(
        `${plural(sentCount, "reminder")} sent`,
        failed.length > 0
          ? `${plural(failed.length, "vendor")} couldn't be emailed — details in a moment.`
          : skipped > 0
            ? `${skipped} skipped — they haven't been waiting that long yet.`
            : undefined
      );

      if (failed.length > 0) {
        await dialog.alert({
          title: `${plural(failed.length, "vendor")} didn't get the email`,
          tone: "warn",
          body: (
            <>
              <DescList items={failed.map((f) => ({ label: f.businessName, value: f.reason }))} />
              <p className="t-xs t-muted mt-3">Fix the email address on their vendor record, then send theirs on its own.</p>
            </>
          ),
          confirmLabel: "Done",
        });
      }
      await loadOnboarding();
      await loadAll();
    } finally { setBusy(false); }
  };

  /* One modal serves both "fix the terms" and "void it and send a corrected
     one" — the fields are identical, only the action and the warning differ. */
  const openTerms = (
    c: { id: string; businessName: string; boothLabel: string; monthlyRentCents: number; startDate: string },
    mode: "update_terms" | "void_and_reissue"
  ) => {
    setTermsErr("");
    const d = new Date(c.startDate);
    setTermsForm({
      id: c.id,
      mode,
      businessName: c.businessName,
      boothLabel: c.boothLabel,
      rent: (c.monthlyRentCents / 100).toFixed(2),
      startDate: Number.isNaN(d.getTime()) ? isoDate() : isoDate(d),
    });
  };

  const saveTerms = async () => {
    if (!termsForm) return;
    const booth = termsForm.boothLabel.trim();
    const cents = dollarsToCents(termsForm.rent);
    if (!booth) { setTermsErr("Give the booth a label."); return; }
    if (cents === null || cents < 0) { setTermsErr("Enter the monthly rent as a number, like 150."); return; }
    if (!termsForm.startDate) { setTermsErr("Pick a start date."); return; }

    if (termsForm.mode === "void_and_reissue") {
      const yes = await dialog.confirm({
        title: "Void this agreement and send a corrected one?",
        body: `${termsForm.businessName} has already signed, so this agreement can't be edited. Voiding it keeps the signed copy on file as a record and emails them a fresh agreement on the new terms — they have to sign again before the booth is theirs.`,
        confirmLabel: "Void and send the new one",
        cancelLabel: "Keep the old one",
        tone: "danger",
      });
      if (!yes) return;
    }

    setBusy(true);
    try {
      const { ok, data } = await safeFetch(`/api/admin/contracts/${termsForm.id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: termsForm.mode,
          boothLabel: booth,
          monthlyRentDollars: cents / 100,
          startDate: termsForm.startDate,
        }),
      });
      if (!ok) { setTermsErr(String(data.error || "That didn't go through.")); return; }

      if (termsForm.mode === "void_and_reissue") {
        if (data.emailed) {
          toast.success(
            "Corrected agreement sent",
            `${termsForm.businessName} has a fresh signing link at ${String(data.sentTo || "their email")}.`
          );
        } else {
          // The link is the only copy — never bury it in a toast that vanishes.
          await dialog.alert({
            title: "Agreement reissued — but the email didn't send",
            tone: "warn",
            body: <>Send this signing link to <b>{String(data.sentTo || termsForm.businessName)}</b> yourself.</>,
            copyable: String(data.signUrl || ""),
            confirmLabel: "Done",
          });
        }
        // The old record is voided and the panel was showing it.
        setContractOpen(null);
        setOnbOpen(null);
      } else {
        toast.success("Agreement terms updated", `Booth ${booth} · ${money(cents)}/mo.`);
      }

      setTermsForm(null);
      await loadAll();
      await loadOnboarding();
    } finally { setBusy(false); }
  };

  // ---------- settings ----------
  /* This used to be gated on `role === "admin"`, which stopped matching the
     moment accounts gained roles — an owner ACCOUNT reports role "staff". The
     effect never ran, so the service worker was never registered and the VAPID
     key was never fetched, and the Enable button then awaited
     `serviceWorker.ready` forever. That's the spinner. Gated on the capability
     now, and the worker registers for anyone signed in either way. */
  useEffect(() => {
    if (!authed) return;
    if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
    if (!allowed("market")) return;
    fetch("/api/admin/push").then(async (r) => {
      if (r.ok) { const d = await r.json(); setAdminPushDevices(d.devices); setAdminPushKey(d.publicKey); }
    }).catch(() => {});
  }, [authed, caps]);

  const enableAdminPush = async () => {
    setAdminPushMsg("");
    // Every branch below finishes — nothing here can wait forever. See lib/pushclient.
    const result = await subscribeToPush(adminPushKey);
    if (!result.ok) { setAdminPushMsg(result.message); return; }
    try {
      const res = await fetch("/api/admin/push", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(result.subscription),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        setAdminPushMsg(String(d.error || "The browser said yes but the server wouldn't save it — try again."));
        return;
      }
      setAdminPushDevices((n) => (n || 0) + 1);
      setAdminPushMsg("");
      toast.success("Admin alerts are on for this device");
    } catch {
      setAdminPushMsg("No connection — the browser allowed it but we couldn't save it. Try again.");
    }
  };

  const loadBanner = useCallback(async () => {
    const r = await fetch("/api/public/banner");
    if (r.ok) {
      const b = (await r.json()).banner;
      setBanEnabled(!!b.enabled); setBanTitle(b.title || ""); setBanDate(b.dateLine || ""); setBanMessage(b.message || "");
    }
  }, []);
  useEffect(() => { if (authed && allowed("config") && tab === "settings") loadBanner(); }, [authed, caps, tab, loadBanner]);

  const saveBanner = async () => {
    setBanMsg("");
    const { ok, data } = await safeFetch("/api/admin/settings", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ banner: { enabled: banEnabled, title: banTitle, dateLine: banDate, message: banMessage } }),
    });
    if (ok) { setBanMsg(""); toast.success("Banner saved", "It's live on /apply and /market now."); }
    else setBanMsg(String(data.error || "Couldn't save the banner."));
  };

  const sqft = Math.max(0, (Number(cW) || 0) * (Number(cD) || 0));
  const suggestedRent = Math.round(sqft * rentPerSqft * 100) / 100;

  /* The agreements list, split by whether the vendor pulled out. */
  const withdrawnContracts = contracts.filter((c) => c.status === "WITHDRAWN");
  const workingContracts = contracts.filter((c) => c.status !== "WITHDRAWN");
  const shownContracts =
    contractFilter === "ALL" ? contracts
    : contractFilter === "WITHDRAWN" ? withdrawnContracts
    : workingContracts;

  const saveRate = async () => {
    setRateMsg("");
    const { ok, data } = await safeFetch("/api/admin/settings", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rentPerSqft }),
    });
    if (ok) { setRateMsg(""); toast.success("Booth rent rate saved", `New agreements price at $${rentPerSqft}/sq ft.`); }
    else setRateMsg(String(data.error || "Couldn't save the rate."));
  };

  const saveTax = async () => {
    setSettingsMsg("");
    const res = await fetch("/api/admin/settings", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ taxRatePercent: taxRate }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok) { setSettingsMsg(""); toast.success("Sales tax saved", `The register now charges ${taxRate}%.`); }
    else setSettingsMsg(String(data.error || "Couldn't save the tax rate."));
  };

  const addEmployee = async () => {
    setEmpMsg("");
    const res = await fetch("/api/admin/employees", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: newEmpName, pin: newEmpPin }),
    });
    const data = await res.json();
    if (!res.ok) { setEmpMsg(data.error || "Failed."); return; }
    setEmpMsg("");
    toast.success(`${data.employee.name} can now open the register`);
    setNewEmpName(""); setNewEmpPin("");
    await loadAll();
  };

  const removeEmployee = async (e: Employee) => {
    const yes = await dialog.confirm({
      title: `Remove ${e.name}?`,
      body: "They won't be able to sign in or open a drawer any more. Their past shifts, sales and time entries are kept.",
      confirmLabel: "Remove from register",
      tone: "danger",
    });
    if (!yes) return;
    const { ok, data } = await safeFetch(`/api/admin/employees?id=${e.id}`, { method: "DELETE" });
    if (!ok) { toast.error("Couldn't remove them", String(data.error || "")); return; }
    toast.success(`${e.name} removed`);
    await loadAll();
  };

  /* Cash count grid. Each denomination shows its running subtotal so a
     miscount is visible while counting, not after the drawer is closed. */
  const countForm = (
    <div className="stack g-3">
      <div className="grid-auto" style={{ ["--min" as string]: "150px", gap: "var(--sp-2)" }}>
        {DENOMS.map(([k, label, cents]) => {
          const n = Math.max(0, Math.round(Number(counts[k]) || 0));
          return (
            <Field key={k} label={label}>
              {(p) => (
                <div className="row g-2">
                  <Input
                    {...p}
                    type="number"
                    min="0"
                    step="1"
                    inputMode="numeric"
                    value={counts[k] ?? ""}
                    placeholder="0"
                    style={{ textAlign: "right" }}
                    onChange={(e) => setCounts((c) => ({ ...c, [k]: e.target.value }))}
                  />
                  <span
                    className="t-xs t-muted num shrink0"
                    style={{ width: 62, textAlign: "right" }}
                    aria-hidden
                  >
                    {n > 0 ? money(n * cents) : "—"}
                  </span>
                </div>
              )}
            </Field>
          );
        })}
      </div>
      <div
        className="row between"
        style={{
          background: "var(--n-900)",
          color: "#fff",
          padding: "var(--sp-3) var(--sp-4)",
          borderRadius: "var(--r-lg)",
          alignItems: "baseline",
        }}
      >
        <span className="t-label" style={{ color: "var(--n-400)" }}>Drawer total</span>
        <span className="display" style={{ fontSize: "var(--fs-2xl)" }}>{money(countTotal())}</span>
      </div>
    </div>
  );

  if (!authed) {
    return (
      <main
        className="row center"
        style={{ minHeight: "100dvh", padding: "var(--sp-6) var(--sp-4)" }}
      >
        <div style={{ width: "100%", maxWidth: 380 }}>
          <div style={{ textAlign: "center", marginBottom: "var(--sp-6)" }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/logo.png"
              alt=""
              style={{ width: 88, height: 88, margin: "0 auto var(--sp-3)" }}
            />
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/wordmark.png"
              alt="Community Harvest"
              style={{ width: 190, maxWidth: "70%", height: "auto", margin: "0 auto" }}
            />
            <p className="t-label mt-2">Food and Craft Market</p>
            <p className="t-sm t-muted mt-1">Register &amp; management</p>
          </div>

          <div className="card card-pad">
            {/* A real labelled tablist — the old version was two look-alike
                buttons with no indication which was selected to a screen reader. */}
            <div className="segmented mb-4" style={{ display: "flex", width: "100%" }} role="tablist" aria-label="Sign in as">
              <button
                type="button"
                role="tab"
                aria-selected={loginMode === "staff"}
                style={{ flex: 1 }}
                onClick={() => { setLoginMode("staff"); setLoginError(""); }}
              >
                Employee
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={loginMode === "account"}
                style={{ flex: 1 }}
                onClick={() => { setLoginMode("account"); setLoginError(""); }}
              >
                Owner or manager
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={loginMode === "admin"}
                style={{ flex: 1 }}
                onClick={() => { setLoginMode("admin"); setLoginError(""); }}
              >
                Admin password
              </button>
            </div>

            <form
              className="stack g-4"
              onSubmit={(e) => { e.preventDefault(); void login(); }}
            >
              {loginMode === "account" ? (
                <>
                  <Field label="Email" required>
                    {(p) => (
                      <Input
                        {...p}
                        type="email"
                        inputMode="email"
                        autoComplete="username"
                        autoCapitalize="none"
                        value={loginEmail}
                        onChange={(e) => { setLoginEmail(e.target.value); setLoginError(""); }}
                      />
                    )}
                  </Field>
                  <Field label="Password" required>
                    {(p) => (
                      <Input
                        {...p}
                        type="password"
                        autoComplete="current-password"
                        value={loginPassword}
                        onChange={(e) => { setLoginPassword(e.target.value); setLoginError(""); }}
                      />
                    )}
                  </Field>
                </>
              ) : loginMode === "admin" ? (
                <Field label="Admin password" hint="The shared password from your Vercel settings. Use your own owner account instead where you can." required>
                  {(p) => (
                    <Input
                      {...p}
                      type="password"
                      autoComplete="current-password"
                      value={password}
                      onChange={(e) => { setPassword(e.target.value); setLoginError(""); }}
                    />
                  )}
                </Field>
              ) : (
                <>
                  <Field
                    label="Your name"
                    hint="Exactly as the owner entered it when they added you."
                    required
                  >
                    {(p) => (
                      <Input
                        {...p}
                        autoComplete="username"
                        autoCapitalize="words"
                        value={loginName}
                        onChange={(e) => { setLoginName(e.target.value); setLoginError(""); }}
                      />
                    )}
                  </Field>
                  <Field label="PIN" required>
                    {(p) => (
                      <Input
                        {...p}
                        type="password"
                        inputMode="numeric"
                        autoComplete="current-password"
                        value={loginPin}
                        onChange={(e) => { setLoginPin(e.target.value); setLoginError(""); }}
                      />
                    )}
                  </Field>
                </>
              )}

              {loginError ? <Note tone="error">{loginError}</Note> : null}

              <Button type="submit" variant="primary" size="lg" block loading={loggingIn} icon="unlock">
                {loggingIn ? "Signing in…" : "Sign in"}
              </Button>
            </form>
          </div>

          <p className="t-xs t-muted mt-4" style={{ textAlign: "center" }}>
            Employees sign in with a name and PIN. Owners and office managers use their email and
            password. Trouble getting in? Ask the owner to reset it on the Team page.
          </p>
        </div>
      </main>
    );
  }

  const visibleTabs = ADMIN_TABS.filter((t) => allowed(TAB_CAP[t]));
  const meta = TAB_META[tab];
  /* A cashier deep-linking to #settings shouldn't land on a blank screen. */
  const tabReachable = (visibleTabs as readonly string[]).includes(tab);

  const go = (t: AdminTab) => { setTab(t); setReceipt(null); setMoreOpen(false); };

  /* Counts that need the operator's attention, shown on the nav itself so
     pending work is visible without opening every tab. */
  const pendingApps = applications.filter((a) => a.status === "PENDING").length;
  const openComplaints = complaints.filter((c) => c.status !== "CLOSED").length;
  /* Keyed by string, not AdminTab: the Applications entry links to its own
     page and has no tab id. The pending count moves with it — it was never
     really about the Vendors tab. */
  const navBadge: Record<string, number | undefined> = {
    applications: pendingApps,
    vendors: openComplaints,
    onboarding: onboarding.length,
  };

  /* One tile per thing a vendor can be stuck on, so the row of stats reads as
     "here's the queue, and here's whose move it is". */
  const onbWaitingSignature = onboarding.filter((o) => o.nextStep === "agreement").length;
  const onbWaitingCountersign = onboarding.filter((o) => o.nextStep === "countersign").length;
  const onbWaitingRent = onboarding.filter((o) => o.nextStep === "firstRent").length;
  const onbUnsigned = onboarding.filter((o) => o.contract && !o.contract.vendorSignedAt).length;
  const onbStuck = onboarding.filter((o) => o.daysWaiting > 14).length;

  /* Calendar derivations. One pass buckets events by local day so the month
     grid and the day sheet read from the same map instead of re-filtering. */
  const calByDay = new Map<string, CalEvent[]>();
  for (const e of calEvents) {
    const k = isoDate(new Date(e.startAt));
    const bucket = calByDay.get(k);
    if (bucket) bucket.push(e); else calByDay.set(k, [e]);
  }
  for (const bucket of calByDay.values()) {
    bucket.sort((a, b) =>
      a.allDay === b.allDay
        ? new Date(a.startAt).getTime() - new Date(b.startAt).getTime()
        : a.allDay ? -1 : 1
    );
  }
  const calGrid = monthGrid(calMonth);
  const calTodayKey = isoDate(new Date());
  const calMonthIndex = calMonth.getMonth();
  /* Today's events count as upcoming until the market's day is over — not the
     viewer's, so checking from another timezone doesn't retire today early. */
  const calCutoff = centralDayStart().getTime();
  const calListRows = calEvents
    .filter((e) => (calWhen === "upcoming"
      ? new Date(e.startAt).getTime() >= calCutoff
      : new Date(e.startAt).getTime() < calCutoff))
    .sort((a, b) => {
      const d = new Date(a.startAt).getTime() - new Date(b.startAt).getTime();
      return calWhen === "upcoming" ? d : -d;
    });
  const calSelected = calEvents.find((e) => e.id === calOpen) ?? null;
  const calMonthPrefix = cellKey(calMonth).slice(0, 7); // "YYYY-MM"
  const calMonthCount = calEvents.filter(
    (e) => isoDate(new Date(e.startAt)).startsWith(calMonthPrefix)
  ).length;

  /* Phones get the five most-used destinations plus a "More" sheet, rather
     than a twelve-button wrap that pushed content below the fold. */
  /* Filtered against what this account can actually open, so a manager's phone
     bar doesn't offer Reports and an employee's doesn't offer Vendors. */
  const primaryMobile: AdminTab[] = (
    allowed("financials")
      ? (["register", "calendar", "vendors", "reports"] as AdminTab[])
      : allowed("market")
        ? (["register", "calendar", "vendors", "time"] as AdminTab[])
        : (["register", "time", "floor"] as AdminTab[])
  ).filter((t) => visibleTabs.includes(t));
  /* The "More" sheet is built from NAV, the same list the desktop sidebar
     uses — not from the tab list.
     THE BUG THIS FIXES: two entries in NAV are LINKS to their own pages rather
     than tabs — the Applications workspace and the kiosk. The sheet used to be
     built from tabs alone, so on a phone those two simply did not exist in the
     navigation. Everything about applications lives on that page: call notes,
     booking a viewing, raising an agreement, sending it, chasing the
     signature. On the PWA there was no way to reach any of it.
     Sharing NAV means the two can never drift apart again. */
  const moreGroups = NAV.map((g) => ({
    group: g.group,
    items: g.items.filter((i) =>
      i.href
        ? !i.cap || allowed(i.cap)
        : (visibleTabs as readonly string[]).includes(i.id) && !(primaryMobile as readonly string[]).includes(i.id)
    ),
  })).filter((g) => g.items.length > 0);

  /* For marking the More button as current when a section inside it is open. */
  const moreTabIds = moreGroups.flatMap((g) => g.items.filter((i) => !i.href).map((i) => i.id));
  /* Anything waiting inside the sheet, so the phone shows a count without
     needing the sidebar's per-row badges. */
  const moreCount = moreGroups
    .flatMap((g) => g.items)
    .reduce((n, i) => n + (navBadge[i.id] || 0), 0);

  return (
    <div className="shell">
      <a href="#main-content" className="btn btn-primary btn-sm sr-only">Skip to content</a>

      {/* ---------------------------------------------------------- sidebar */}
      <nav className="sidebar no-print" aria-label="Admin sections">
        <div className="sidebar-brand">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/logo.png" alt="" style={{ width: 30, height: 30, flex: "0 0 auto" }} />
          <div style={{ minWidth: 0 }}>
            <div className="t-card truncate">Community Harvest</div>
            <div className="t-xs t-muted truncate">
              {staffName ? `${staffName} · ${access ? ROLE_LABEL[access] : ""}` : access ? ROLE_LABEL[access] : ""}
            </div>
          </div>
        </div>

        <div className="sidebar-nav">
          {NAV.map((group) => {
            /* Link entries aren't tabs, so visibleTabs can't speak for them.
               They carry their own `owner` flag instead — Applications is the
               owner's, the kiosk is deliberately not, since a cashier is
               exactly who needs it. */
            const items = group.items.filter((i) =>
              i.href ? (!i.cap || allowed(i.cap)) : (visibleTabs as readonly string[]).includes(i.id)
            );
            if (items.length === 0) return null;
            return (
              <div key={group.group}>
                <div className="nav-group-label">{group.group}</div>
                <div className="stack" style={{ gap: 2 }}>
                  {items.map((i) =>
                    i.href ? (
                      <a key={i.id} className="nav-item" href={i.href}>
                        <Icon name={i.icon} size={16} />
                        <span className="truncate">{i.label}</span>
                        {navBadge[i.id] ? (
                          <span className="nav-item-count">{navBadge[i.id]}</span>
                        ) : null}
                      </a>
                    ) : (
                      <button
                        key={i.id}
                        type="button"
                        className="nav-item"
                        aria-current={tab === i.id ? "page" : undefined}
                        onClick={() => go(i.id as AdminTab)}
                      >
                        <Icon name={i.icon} size={16} />
                        <span className="truncate">{i.label}</span>
                        {navBadge[i.id] ? (
                          <span className="nav-item-count">{navBadge[i.id]}</span>
                        ) : null}
                      </button>
                    )
                  )}
                </div>
              </div>
            );
          })}
        </div>

        <div className="sidebar-foot stack g-2">
          {drawer ? (
            <div
              className="stack"
              style={{
                padding: "var(--sp-2) var(--sp-3)",
                borderRadius: "var(--r-md)",
                background: "var(--accent-soft)",
                color: "var(--accent-text)",
              }}
            >
              <span className="t-label" style={{ color: "inherit", opacity: 0.8 }}>Drawer open</span>
              <span className="t-sm truncate" style={{ fontWeight: 600 }}>{drawer.employee}</span>
              <span className="num t-sm">{money(drawer.openTotalCents + drawer.cashSalesCents)}</span>
            </div>
          ) : null}
          {/* Everyone with a real account can change their own email and
              password without going through the team roster — a manager can't
              reach that page, and an owner shouldn't have to. */}
          {myAccount ? (
            <Button size="sm" variant="ghost" icon="user" onClick={() => { setMeOpen(true); setMeErr(""); }} block>
              My account
            </Button>
          ) : null}
          <Button size="sm" variant="ghost" icon="logout" onClick={staffLogout} block>
            Sign out
          </Button>
        </div>
      </nav>

      {/* ------------------------------------------------------------- main */}
      <div className="shell-main">
        <header className="topbar no-print">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/logo.png"
            alt=""
            style={{ width: 28, height: 28, flex: "0 0 auto" }}
            className="topbar-logo"
          />
          <div className="grow" style={{ minWidth: 0 }}>
            <div className="t-card truncate">{meta.label}</div>
          </div>
          {overview ? (
            <div className="row g-3 shrink0">
              <div style={{ textAlign: "right" }}>
                <div className="t-label">Today</div>
                <div className="num t-sm" style={{ fontWeight: 650 }}>
                  {money(overview.today.totalCents)}
                  <span className="t-muted" style={{ fontWeight: 400 }}>
                    {" "}· {plural(overview.today.count, "sale")}
                  </span>
                </div>
              </div>
            </div>
          ) : null}
        </header>

        <main className="content" id="main-content">
          <style>{`
            @media (min-width: 901px) { .topbar-logo { display: none; } }
          `}</style>

          {!tabReachable ? (
            <Card>
              <EmptyState
                icon="lock"
                title="That section is owner-only"
                body="Your employee sign-in covers the register, the time clock and floor stock."
                action={<Button variant="primary" icon="register" onClick={() => go("register")}>Go to the register</Button>}
              />
            </Card>
          ) : (
            <>
              <PageHeader title={meta.label} subtitle={meta.sub} />

      {/* Collections waiting at the counter. Shown on the register screen
          because that is where the customer walks up and asks for them. */}
      {tab === "register" && pickups.length > 0 && (
        <Card
          title={`${plural(pickups.length, "online order")} waiting for collection`}
          subtitle="Packed by the vendor and sitting here. Find it, hand it over, tap the button."
          className="mb-4"
        >
          <div className="stack g-3">
            {pickups.map((o) => (
              <div key={o.id} className="row between g-3 wrap" style={{ padding: "var(--sp-2) 0", borderBottom: "1px solid var(--border)" }}>
                <div className="stack g-1" style={{ minWidth: 0 }}>
                  <span className="row g-2" style={{ alignItems: "center" }}>
                    <b>#{o.number}</b>
                    <span className="truncate">{o.customerName}</span>
                  </span>
                  <span className="t-xs t-muted truncate">
                    {o.vendorName} · {o.lines.map((l) => `${l.quantity}× ${l.name}`).join(", ")}
                  </span>
                  {o.readyAt ? <span className="t-xs t-muted">Ready {relTime(o.readyAt)}</span> : null}
                </div>
                <Button size="sm" icon="check" disabled={busy} onClick={() => void handOver(o)}>
                  Handed over
                </Button>
              </div>
            ))}
            <p className="t-xs t-muted" style={{ margin: 0 }}>
              Already paid online — take nothing at the till. If it isn&rsquo;t on the shelf, the vendor hasn&rsquo;t
              brought it in yet.
            </p>
          </div>
        </Card>
      )}

      {tab === "register" && !drawer && drawerErr && (
        <div className="mb-4"><Note tone="error" title="The register can't reach the drawer system">{drawerErr}</Note></div>
      )}
      {tab === "register" && closeReport && (
        <Card
          title="Drawer closed — count report"
          subtitle="This count is saved with the shift, so over/shorts keep a paper trail."
          footer={
            <Button variant="primary" icon="check" onClick={() => setCloseReport(null)}>
              Done
            </Button>
          }
        >
          <div className="stack g-4">
            <DescList
              items={[
                { label: "Employee", value: closeReport.employee },
                { label: "Opening drawer", value: <span className="num">{money(closeReport.openTotalCents)}</span> },
                { label: "Cash sales this shift", value: <span className="num">+ {money(closeReport.cashSalesCents)}</span> },
                { label: "Expected in drawer", value: <b className="num">{money(closeReport.expected)}</b> },
                { label: "Counted at close", value: <span className="num">{money(closeReport.counted)}</span> },
              ]}
            />
            {closeReport.diff === 0 ? (
              <Note tone="success" title="Balanced">
                The count matches what the register expected to the penny.
              </Note>
            ) : (
              <Note
                tone={closeReport.diff > 0 ? "warn" : "error"}
                title={`${closeReport.diff > 0 ? "Over" : "Short"} by ${money(Math.abs(closeReport.diff))}`}
              >
                {closeReport.diff > 0
                  ? "There's more cash in the drawer than the register expected."
                  : "There's less cash in the drawer than the register expected."}
              </Note>
            )}
          </div>
        </Card>
      )}

      {tab === "register" && !closeReport && !drawerLoaded && (
        <Card title="Register">
          <div className="stack g-3" aria-busy="true">
            <Skeleton width="45%" height={18} />
            <Skeleton height={13} />
            <Skeleton width="70%" height={13} />
            <Skeleton height={44} />
          </div>
        </Card>
      )}

      {tab === "register" && !closeReport && drawerLoaded && !drawer && (
        <Card
          title="Open the register"
          subtitle="Locked until an employee signs in and counts the starting drawer."
        >
          {employees.length === 0 ? (
            <EmptyState
              icon="users"
              title="No employees on the register yet"
              body="Add yourself in Settings first — a name and a PIN — then come back to open the drawer."
              action={
                allowed("people")
                  ? <Button variant="primary" icon="settings" onClick={() => go("team")}>Add the team</Button>
                  : undefined
              }
            />
          ) : (
            <div className="stack g-5">
              <div className="grid-auto" style={{ ["--min" as string]: "200px" }}>
                <Field label="Employee">
                  {(p) => (
                    <Select
                      {...p}
                      value={empName || employees[0]?.name}
                      onChange={(e) => setEmpName(e.target.value)}
                    >
                      {employees.map((e) => <option key={e.id}>{e.name}</option>)}
                    </Select>
                  )}
                </Field>
                <Field label="PIN" required>
                  {(p) => (
                    <Input
                      {...p}
                      type="password"
                      inputMode="numeric"
                      autoComplete="off"
                      value={empPin}
                      onChange={(e) => setEmpPin(e.target.value)}
                    />
                  )}
                </Field>
              </div>

              <div className="stack g-3">
                <h3 className="t-section">Count the starting drawer</h3>
                {countForm}
              </div>

              {drawerErr ? <Note tone="error">{drawerErr}</Note> : null}

              <div>
                <Button variant="primary" size="lg" icon="unlock" loading={busy} onClick={openDrawer}>
                  Sign in and open the drawer
                </Button>
              </div>
            </div>
          )}
        </Card>
      )}

      {tab === "register" && !closeReport && drawer && closing && (
        <Card
          title="Close the drawer — count what's in it"
          subtitle={`${drawer.employee}'s shift · opening ${money(drawer.openTotalCents)} + cash sales ${money(drawer.cashSalesCents)} → expected ${money(drawer.openTotalCents + drawer.cashSalesCents)}`}
          footer={
            <div className="row end wrap g-2">
              <Button
                variant="ghost"
                icon="arrowLeft"
                onClick={() => { setClosing(false); setCounts({}); }}
              >
                Back to selling
              </Button>
              <Button variant="primary" size="lg" icon="lock" loading={busy} onClick={closeDrawer}>
                Finish count and close
              </Button>
            </div>
          }
        >
          <div className="stack g-4">
            {countForm}
            {drawerErr ? <Note tone="error">{drawerErr}</Note> : null}
          </div>
        </Card>
      )}

      {tab === "register" && !closeReport && drawer && !closing && receipt && (
        <Card
          title={`Sale complete — ticket #${receipt.number}`}
          subtitle={`Vendors notified, inventory updated.${autoPrint ? " Receipt sent to the printer." : ""}`}
          actions={<Badge tone="success" icon="checkCircle">Paid · {receipt.paymentMethod === "CASH" ? "Cash" : "Card"}</Badge>}
          footer={
            <div className="row end wrap g-2">
              <Button variant="ghost" icon="print" onClick={() => printSale(receipt.id)}>
                Reprint receipt
              </Button>
              <Button
                variant="primary"
                size="lg"
                iconRight="arrowRight"
                onClick={() => { setReceipt(null); setCustQ(""); setCust(null); setRedeem(false); setCustMsg(""); setAttachQ(""); setAttachMsg(""); setCardConfirm(false); }}
              >
                Next customer
              </Button>
            </div>
          }
        >
          <div className="stack g-4 content-narrow" style={{ margin: "0 auto" }}>
            <div className="stack g-1">
              {receipt.lines.map((l) => (
                <div key={l.sku} className="row between g-3 t-body">
                  <span className="truncate">{l.quantity}× {l.name}</span>
                  <b className="num shrink0">{money((l.basePriceCents || l.priceCents) * l.quantity)}</b>
                </div>
              ))}
            </div>

            <hr className="divider" />

            <div className="stack g-1 t-body">
              <div className="row between g-3">
                <span>Subtotal</span>
                <b className="num">{money(receipt.subtotalCents + (receipt.saleSavingsCents || 0))}</b>
              </div>
              {typeof receipt.saleSavingsCents === "number" && receipt.saleSavingsCents > 0 && (
                <div className="row between g-3 t-danger">
                  <span className="row g-1"><Icon name="tag" size={13} />Sale savings</span>
                  <b className="num">&minus;{money(receipt.saleSavingsCents)}</b>
                </div>
              )}
              {typeof receipt.cardAdjustCents === "number" && receipt.cardAdjustCents > 0 && (
                <div className="row between g-3">
                  <span>Non-cash adjustment</span>
                  <b className="num">{money(receipt.cardAdjustCents)}</b>
                </div>
              )}
              <div className="row between g-3">
                <span>Tax ({receipt.taxRate}%)</span>
                <b className="num">{money(receipt.taxCents)}</b>
              </div>
              <div className="row between g-3 mt-2" style={{ alignItems: "baseline" }}>
                <span className="t-label">
                  Total · {receipt.paymentMethod === "CASH" ? "Cash" : "Card"}
                  {receipt.cardName ? ` · ${receipt.cardName}` : ""}
                </span>
                <span className="display num" style={{ fontSize: "var(--fs-2xl)" }}>{money(receipt.totalCents)}</span>
              </div>
            </div>

            {typeof receipt.discountCents === "number" && receipt.discountCents > 0 && (
              <Note tone="success" title="Reward applied">$5 came off this sale for 100 points.</Note>
            )}

            {receipt.customerContact ? (
              <Note tone="success" title={`${receipt.customerPoints} points`}>
                {receipt.customerContact}
                {receipt.customerContact.includes("@") ? " · receipt emailed" : ""}
              </Note>
            ) : (
              <div className="stack g-2">
                <Field
                  label="Receipt and rewards"
                  hint="Optional — an email gets the receipt, either one earns points."
                >
                  {(p) => (
                    <div className="row g-2">
                      <Input
                        {...p}
                        className="grow"
                        placeholder="Email or phone"
                        value={attachQ}
                        onChange={(e) => setAttachQ(e.target.value)}
                        onKeyDown={(e) => { if (e.key === "Enter") attachCustomer(); }}
                      />
                      <Button variant="secondary" icon="star" onClick={attachCustomer} disabled={!attachQ.trim()}>
                        Add
                      </Button>
                    </div>
                  )}
                </Field>
                {attachMsg ? (
                  <Note tone="error">{attachMsg}</Note>
                ) : null}
              </div>
            )}
          </div>
        </Card>
      )}

      {tab === "register" && !closeReport && drawer && !closing && !receipt && (
        <div className="stack g-4">
          <div className="grid-auto" style={{ ["--min" as string]: "220px" }}>
            <Stat
              label="Signed in"
              value={drawer.employee}
              sub={`Drawer opened ${fmtTime(drawer.openedAt)}`}
              icon="user"
            />
            <Stat
              feature
              label="In the drawer now"
              value={money(drawer.openTotalCents + drawer.cashSalesCents)}
              sub={`${money(drawer.openTotalCents)} start + ${money(drawer.cashSalesCents)} cash sales`}
              icon="cash"
            />
          </div>

          <Card
            title="Time clock"
            subtitle="Punch a shift in or out without leaving the register."
            actions={
              <Button
                variant="secondary"
                icon="lock"
                onClick={() => { setClosing(true); setCounts({}); }}
              >
                Close drawer (count out)
              </Button>
            }
          >
            <div className="stack g-3">
              <div className="row wrap g-2" style={{ alignItems: "flex-end" }}>
                <Field label="Who's punching" className="grow">
                  {(p) => (
                    <Select
                      {...p}
                      value={punchName || employees[0]?.name || ""}
                      onChange={(e) => setPunchName(e.target.value)}
                    >
                      {employees.map((e) => <option key={e.id}>{e.name}</option>)}
                    </Select>
                  )}
                </Field>
                <Field label="PIN" className="shrink0">
                  {(p) => (
                    <Input
                      {...p}
                      type="password"
                      inputMode="numeric"
                      autoComplete="off"
                      value={punchPin}
                      style={{ width: 120 }}
                      onChange={(e) => setPunchPin(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter") punch(); }}
                    />
                  )}
                </Field>
                <Button variant="secondary" icon="clock" onClick={punch}>Punch</Button>
              </div>
              {punchMsg ? (
                <Note tone={punchMsg.includes("clocked") ? "success" : "error"}>{punchMsg}</Note>
              ) : null}
            </div>
          </Card>

          <Card title="Ring up items" subtitle="Scan, search, or tap a vendor's line.">
            <div className="stack g-5">
              <Field
                label="Scan or type a code, then press Enter"
                error={scanErr || undefined}
                hint="The cursor stays here between items, so a scanner just works."
              >
                {(p) => (
                  <Input
                    {...p}
                    ref={scanRef}
                    className="mono"
                    value={scan}
                    autoComplete="off"
                    placeholder="V01-0001"
                    style={{ height: 64, fontSize: "var(--fs-xl)", letterSpacing: "0.04em" }}
                    onChange={(e) => setScan(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") doScan(); }}
                  />
                )}
              </Field>

              <div className="stack g-2">
                <Field label="No scanner? Search by item name or code">
                  {(p) => (
                    <SearchInput
                      {...p}
                      value={search}
                      onValueChange={setSearch}
                      placeholder="honey / V02 / cutting board"
                      aria-label="Search the floor by item name or code"
                    />
                  )}
                </Field>
                {search.trim() ? (
                  !overview ? (
                    <div className="row wrap g-2" aria-busy="true">
                      {[0, 1, 2].map((i) => <Skeleton key={i} width={180} height={44} radius="var(--r-md)" />)}
                    </div>
                  ) : searchHits.length === 0 ? (
                    <EmptyState
                      icon="search"
                      title="No matches on the floor"
                      body="Try part of the item name, or the vendor code like V02."
                    />
                  ) : (
                    <div className="row wrap g-2">
                      {searchHits.map((i) => (
                        <Button
                          key={i.id}
                          variant="secondary"
                          size="lg"
                          icon="plus"
                          onClick={() => addItemToCart({ id: i.id, sku: i.sku, name: i.name, priceCents: i.priceCents, basePriceCents: i.basePriceCents, vendorName: i.vendorName, taxClass: i.taxClass })}
                        >
                          <span className="mono t-xs">{i.sku}</span>
                          <span className="truncate">{i.name}</span>
                          <span className="num">{money(i.priceCents)}</span>
                          {i.quantity === 0 ? <Badge tone="warn">Out</Badge> : null}
                        </Button>
                      ))}
                    </div>
                  )
                ) : null}
              </div>

              <div className="stack g-2">
                <span className="t-label">Or browse a vendor&rsquo;s whole line</span>
                {!overview ? (
                  <div className="row wrap g-2" aria-busy="true">
                    {[0, 1, 2, 3].map((i) => <Skeleton key={i} width={140} height={40} radius="var(--r-md)" />)}
                  </div>
                ) : floor.length === 0 ? (
                  <EmptyState
                    icon="grid"
                    title="Nothing on the floor yet"
                    body="Once vendors have stock checked in, their lines show up here to tap."
                  />
                ) : (
                  <div className="row wrap g-2">
                    {[...new Map(floor.map((i) => [i.vendorCode, i.vendorName])).entries()].map(([code, name]) => (
                      <Button
                        key={code}
                        variant={openVendor === code ? "primary" : "secondary"}
                        icon="store"
                        aria-pressed={openVendor === code}
                        onClick={() => setOpenVendor(openVendor === code ? null : code)}
                      >
                        <span className="mono t-xs">{code}</span>
                        <span className="truncate">{name}</span>
                      </Button>
                    ))}
                  </div>
                )}
                {openVendor ? (
                  floor.filter((i) => i.vendorCode === openVendor).length === 0 ? (
                    <EmptyState
                      icon="box"
                      title="This vendor has nothing on the floor"
                      body="Everything of theirs is sold or checked out."
                    />
                  ) : (
                    <div className="row wrap g-2">
                      {floor.filter((i) => i.vendorCode === openVendor).map((i) => (
                        <Button
                          key={i.id}
                          variant="secondary"
                          size="lg"
                          icon="plus"
                          onClick={() => addItemToCart({ id: i.id, sku: i.sku, name: i.name, priceCents: i.priceCents, basePriceCents: i.basePriceCents, vendorName: i.vendorName, taxClass: i.taxClass })}
                        >
                          <span className="truncate">{i.name}</span>
                          <span className="num">{money(i.priceCents)}</span>
                          {i.quantity === 0 ? <Badge tone="warn">Out</Badge> : null}
                        </Button>
                      ))}
                    </div>
                  )
                ) : null}
              </div>
            </div>
          </Card>

          <Card
            title="Ticket"
            subtitle={cart.length ? `${plural(cart.reduce((n, l) => n + l.quantity, 0), "item")} on this sale` : undefined}
            actions={
              cart.length > 0 ? (
                <Button
                  variant="dangerSoft"
                  icon="trash"
                  onClick={() => { setCart([]); setCardConfirm(false); }}
                >
                  Clear ticket
                </Button>
              ) : undefined
            }
          >
            {cart.length === 0 ? (
              <EmptyState
                icon="receipt"
                title="Ticket is empty"
                body="Scan a tag, search by name, or tap a vendor's line above to start the sale."
              />
            ) : (
              <div className="stack g-4">
                <div className="stack">
                  {cart.map((l) => {
                    const each = l.basePriceCents || l.priceCents;
                    const onSale = each > l.priceCents;
                    return (
                      <div
                        key={l.sku}
                        className="row between wrap g-3"
                        style={{ padding: "var(--sp-3) 0", borderBottom: "1px solid var(--border-subtle)" }}
                      >
                        <div className="grow">
                          <div className="t-card truncate">{l.name}</div>
                          <div className="t-xs t-muted row wrap g-1">
                            <span>{l.vendorName}</span>
                            <span aria-hidden>·</span>
                            <span className="mono">{l.sku}</span>
                            <span aria-hidden>·</span>
                            <span className="num">{money(each)} each</span>
                            {onSale ? (
                              <Badge tone="danger" icon="tag">
                                On sale &minus;{money(each - l.priceCents)} each
                              </Badge>
                            ) : null}
                          </div>
                        </div>
                        <div className="row g-2 shrink0">
                          <IconButton
                            icon="minus"
                            label={`One fewer ${l.name}`}
                            variant="secondary"
                            onClick={() => setCart((c) => c.map((x) => x.sku === l.sku ? { ...x, quantity: Math.max(1, x.quantity - 1) } : x))}
                          />
                          <b className="num" style={{ minWidth: 40, textAlign: "center", fontSize: "var(--fs-md)" }}>
                            {l.quantity}
                          </b>
                          <IconButton
                            icon="plus"
                            label={`One more ${l.name}`}
                            variant="secondary"
                            onClick={() => setCart((c) => c.map((x) => x.sku === l.sku ? { ...x, quantity: x.quantity + 1 } : x))}
                          />
                          <b className="num" style={{ minWidth: 76, textAlign: "right" }}>
                            {money(each * l.quantity)}
                          </b>
                          <IconButton
                            icon="trash"
                            label={`Remove ${l.name} from the ticket`}
                            variant="dangerSoft"
                            onClick={() => setCart((c) => c.filter((x) => x.sku !== l.sku))}
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>

                <div className="stack g-1" style={{ alignItems: "flex-end" }}>
                  {(() => { const sv = cart.reduce((n, l) => n + Math.max(0, ((l.basePriceCents || l.priceCents) - l.priceCents)) * l.quantity, 0); return sv > 0 ? (
                    <>
                      <div className="t-body">Subtotal <b className="num">{money(subtotal + sv)}</b></div>
                      <div className="t-body t-danger row g-1">
                        <Icon name="tag" size={13} />Sale discount <b className="num">&minus;{money(sv)}</b>
                      </div>
                    </>
                  ) : (
                    <div className="t-body">Subtotal <b className="num">{money(subtotal)}</b></div>
                  ); })()}
                  <div className="t-body">Tax{shownTaxRate === null ? " (mixed)" : ` (${shownTaxRate}%)`} <b className="num">{money(taxCents)}</b></div>
                  <div className="row g-3 mt-1" style={{ alignItems: "baseline" }}>
                    <span className="t-label">Total</span>
                    <span className="display num" style={{ fontSize: "var(--fs-4xl)" }}>{money(total)}</span>
                  </div>
                </div>

                <div className="card card-pad-sm stack g-3">
                  <span className="t-label row g-1"><Icon name="star" size={12} />Rewards and email receipt — optional</span>
                  <Field label="Customer email or phone">
                    {(p) => (
                      <div className="row g-2">
                        <Input
                          {...p}
                          className="grow"
                          placeholder="them@example.com or 405 555 0134"
                          value={custQ}
                          onChange={(e) => { setCustQ(e.target.value); setCust(null); setRedeem(false); }}
                          onKeyDown={(e) => { if (e.key === "Enter") lookupCust(); }}
                        />
                        <Button variant="secondary" icon="search" onClick={lookupCust} disabled={!custQ.trim()}>
                          Look up
                        </Button>
                      </div>
                    )}
                  </Field>
                  {cust ? (
                    <div className="stack g-2">
                      <div className="row wrap g-2">
                        <Badge tone="success" icon="star">{cust.points} points</Badge>
                        {cust.email ? <span className="t-sm t-muted truncate">{cust.email}</span> : null}
                        {cust.phone ? <span className="t-sm t-muted">{fmtPhone(cust.phone)}</span> : null}
                      </div>
                      {cust.points >= 100 && (
                        <Checkbox
                          checked={redeem}
                          onCheckedChange={setRedeem}
                          label="Redeem $5 off"
                          hint="Spends 100 of their points on this sale."
                        />
                      )}
                    </div>
                  ) : null}
                  {custMsg ? <p className="t-xs t-muted">{custMsg}</p> : null}
                </div>

                <div className="grid-auto" style={{ ["--min" as string]: "200px" }}>
                  <Button
                    variant="primary"
                    size="xl"
                    block
                    icon="cash"
                    disabled={busy || cardConfirm || cashConfirm}
                    onClick={() => { setCashConfirm(true); setCardConfirm(false); }}
                  >
                    Cash
                  </Button>
                  <Button
                    variant="dark"
                    size="xl"
                    block
                    icon="card"
                    disabled={busy || cardConfirm || cashConfirm}
                    onClick={() => { setCardConfirm(true); setCashConfirm(false); }}
                  >
                    Card
                  </Button>
                </div>

                {/* Same component the kiosk uses, so change is worked out by one
                    implementation rather than two that can drift. */}
                {cashConfirm ? (
                  <CashTender
                    totalCents={redeem ? Math.max(0, total - 500) : total}
                    busy={busy}
                    onCancel={() => setCashConfirm(false)}
                    onConfirm={(tendered) => completeSale("CASH", tendered)}
                  />
                ) : null}

                {cardConfirm && (() => {
                  const adjPct = Number(cardAdj) || 0;
                  const adj = Math.round((subtotal * adjPct) / 100);
                  const t = taxFor(cartTaxLines, taxRates, adj).taxCents;
                  const disc = redeem ? Math.min(500, subtotal + adj + t) : 0;
                  const chargeTotal = subtotal + adj + t - disc;
                  return (
                    <div
                      className="card card-pad stack g-3"
                      style={{ background: "var(--accent-soft)", borderColor: "var(--accent-border)" }}
                    >
                      <div className="stack g-1">
                        <span className="t-label t-accent">Charge the card terminal</span>
                        <span className="display num" style={{ fontSize: "var(--fs-4xl)" }}>{money(chargeTotal)}</span>
                        {adj > 0 ? (
                          <span className="t-xs t-muted">Includes {money(adj)} non-cash adjustment.</span>
                        ) : null}
                        {disc > 0 ? (
                          <span className="t-xs t-accent row g-1"><Icon name="star" size={12} />$5 reward applied.</span>
                        ) : null}
                      </div>

                      <Field
                        label="Approval code or last 4"
                        hint="Optional, but it's the only record tying this ticket to the terminal — worth typing."
                      >
                        {(p) => (
                          <Input
                            {...p}
                            className="mono"
                            value={cardName}
                            placeholder="APPR 004571 · 4242"
                            autoComplete="off"
                            onChange={(e) => setCardName(e.target.value)}
                          />
                        )}
                      </Field>

                      <Note tone="info">
                        Run the card on the terminal first. Nothing is recorded here until you book it.
                      </Note>

                      <div className="row wrap g-2">
                        <Button
                          variant="primary"
                          size="xl"
                          className="grow"
                          icon="checkCircle"
                          loading={busy}
                          onClick={async () => { await completeSale("CARD"); setCardConfirm(false); }}
                        >
                          Payment approved — book the sale
                        </Button>
                        <Button variant="ghost" size="lg" icon="close" disabled={busy} onClick={() => setCardConfirm(false)}>
                          Declined or go back
                        </Button>
                      </div>
                    </div>
                  );
                })()}
              </div>
            )}
          </Card>

          {refundTarget && (
            <Modal
              open
              onClose={() => setRefundTarget(null)}
              width="lg"
              title={`Refund ticket #${refundTarget.ticket.number}`}
              description={`Paid by ${refundTarget.ticket.paymentMethod === "CASH" ? "cash" : "card"} · ${money(refundTarget.ticket.totalCents)} · ${refundTarget.ticket.dateStr} ${refundTarget.ticket.timeStr}`}
              footer={
                <>
                  <Button variant="ghost" onClick={() => setRefundTarget(null)}>Keep the sale</Button>
                  <Button
                    variant="danger"
                    icon="refresh"
                    disabled={!Object.values(refundQty).some((q) => q > 0)}
                    onClick={submitRefund}
                  >
                    Record the refund
                  </Button>
                </>
              }
            >
              <div className="stack g-4">
                <DataTable
                  rows={refundTarget.lines}
                  rowKey={(l) => l.id}
                  mobileCards
                  caption={`Items on ticket #${refundTarget.ticket.number}`}
                  columns={[
                    {
                      key: "item",
                      header: "Item",
                      primary: true,
                      cell: (l) => (
                        <span>
                          {l.name} <span className="t-muted num">· {money(l.priceCents)}</span>
                        </span>
                      ),
                    },
                    { key: "sold", header: "Sold", align: "right", cell: (l) => l.quantity },
                    {
                      key: "already",
                      header: "Already refunded",
                      align: "right",
                      cell: (l) => refundTarget.refunded[l.id] || 0,
                    },
                    {
                      key: "qty",
                      header: "Refund qty",
                      align: "right",
                      cell: (l) => {
                        const left = l.quantity - (refundTarget.refunded[l.id] || 0);
                        if (left <= 0) return <span className="t-muted">—</span>;
                        return (
                          <Field label={<span className="sr-only">Refund quantity for {l.name}</span>}>
                            {(p) => (
                              <Input
                                {...p}
                                type="number"
                                min={0}
                                max={left}
                                inputMode="numeric"
                                value={refundQty[l.id] ?? 0}
                                style={{ width: 88, textAlign: "right", marginLeft: "auto" }}
                                onChange={(e) => setRefundQty((q) => ({ ...q, [l.id]: Math.max(0, Math.min(left, Math.round(Number(e.target.value) || 0))) }))}
                              />
                            )}
                          </Field>
                        );
                      },
                    },
                  ]}
                  empty={
                    <EmptyState
                      icon="receipt"
                      title="Nothing left to refund"
                      body="Every line on this ticket has already been refunded."
                    />
                  }
                />

                <Checkbox
                  checked={refundRestock}
                  onCheckedChange={setRefundRestock}
                  label="Put the items back on the floor"
                  hint="Uncheck if they came back damaged or unsellable."
                />

                <Note tone="warn">
                  {refundTarget.ticket.paymentMethod === "CASH"
                    ? "You'll hand the money back out of the drawer — this only records it."
                    : "You'll reverse the charge on the card machine — this only records it."}
                </Note>

                {refundMsg ? <Note tone="error">{refundMsg}</Note> : null}
              </div>
            </Modal>
          )}

          <Card
            title="Tickets"
            subtitle="Every sale rung up in the last 30 days"
            actions={
              <Button
                variant="ghost"
                icon="print"
                aria-pressed={autoPrint}
                onClick={toggleAutoPrint}
              >
                Auto-print {autoPrint ? "on" : "off"}
              </Button>
            }
          >
            <div className="stack g-4">
              <Field
                label="Search tickets"
                hint="By receipt number, date, vendor, or the name on the card."
              >
                {(p) => (
                  <SearchInput
                    {...p}
                    value={ticketQ}
                    onValueChange={setTicketQ}
                    placeholder="1041 / Sep 8 / honey / Whitaker"
                    aria-label="Search tickets"
                  />
                )}
              </Field>

              <DataTable
                rows={tickets}
                rowKey={(t) => t.id}
                loading={!overview && tickets.length === 0}
                skeletonRows={6}
                mobileCards
                defaultSort={{ key: "number", dir: "desc" }}
                caption="Tickets from the last 30 days"
                columns={[
                  {
                    key: "number",
                    header: "Ticket",
                    primary: true,
                    sortBy: (t) => t.number,
                    cell: (t) => (
                      <span className="row g-2">
                        <span
                          className="num"
                          style={{ fontWeight: 620, textDecoration: t.status === "VOIDED" ? "line-through" : undefined }}
                        >
                          #{t.number}
                        </span>
                        {t.status !== "COMPLETE" ? (
                          <Badge tone={t.status === "VOIDED" ? "danger" : "warn"}>
                            {t.status === "VOIDED" ? "Voided" : t.status === "REFUNDED" ? "Refunded" : "Part refunded"}
                          </Badge>
                        ) : null}
                      </span>
                    ),
                  },
                  {
                    key: "date",
                    header: "Date",
                    cell: (t) => <span className="t-sm">{t.dateStr} {t.timeStr}</span>,
                  },
                  {
                    key: "pay",
                    header: "Paid by",
                    sortBy: (t) => t.paymentMethod,
                    cell: (t) => (
                      <span className="row g-2 wrap">
                        <Badge tone="neutral" icon={t.paymentMethod === "CASH" ? "cash" : "card"}>
                          {t.paymentMethod === "CASH" ? "Cash" : "Card"}
                        </Badge>
                        {t.cardName ? <span className="t-sm t-muted truncate">{t.cardName}</span> : null}
                      </span>
                    ),
                  },
                  {
                    key: "vendors",
                    header: "Vendors",
                    cell: (t) => <span className="mono t-xs">{t.vendorCodes.join(" ")}</span>,
                  },
                  {
                    key: "total",
                    header: "Total",
                    align: "right",
                    sortBy: (t) => t.totalCents,
                    cell: (t) => money(t.totalCents),
                  },
                  {
                    key: "actions",
                    header: <span className="sr-only">Actions</span>,
                    align: "right",
                    cell: (t) => (
                      <span className="row end g-1 wrap">
                        <IconButton icon="print" label={`Reprint ticket #${t.number}`} size="sm" onClick={() => printSale(t.id)} />
                        {t.status !== "VOIDED" && t.status !== "REFUNDED" ? (
                          <>
                            <Button variant="ghost" size="sm" icon="refresh" onClick={() => openRefund(t)}>Refund</Button>
                            <Button variant="dangerSoft" size="sm" icon="close" onClick={() => voidSale(t)}>Void</Button>
                          </>
                        ) : null}
                      </span>
                    ),
                  },
                ]}
                empty={
                  ticketQ.trim() ? (
                    <EmptyState
                      icon="search"
                      title="No tickets match that search"
                      body="Try just the receipt number, or a vendor code like V02."
                      action={<Button variant="secondary" icon="close" onClick={() => setTicketQ("")}>Clear the search</Button>}
                    />
                  ) : (
                    <EmptyState
                      icon="receipt"
                      title="No sales in the last 30 days"
                      body="Tickets show up here the moment you ring one up."
                    />
                  )
                }
              />
            </div>
          </Card>
        </div>
      )}

      {tab === "time" && (
        <div className="stack g-4">
          {role === "admin" && !staffName ? (
            <Card title="Time clock" subtitle="Hours for the whole team">
              <Note tone="info" title="Punches happen under each employee's own sign-in">
                Staff clock in and out from their own sign-in on this page. Hours, punch fixes, and
                payroll live in Team &amp; payroll.
              </Note>
            </Card>
          ) : (
            <>
              {/* The shift state is the whole point of this screen, so it leads —
                  one tile you can read across the room and one big button. */}
              <div className="grid-auto" style={{ ["--min" as string]: "220px" }}>
                <Stat
                  feature
                  label={timeData?.open ? "On the clock" : "Not clocked in"}
                  value={timeData?.open ? fmtTime(timeData.open.clockIn) : "—"}
                  sub={timeData?.open ? "Shift started" : "Punch in when you start your shift"}
                  icon="clock"
                />
                <Stat
                  label="Last 14 days"
                  value={`${(timeData?.entries || []).reduce((s, e) => s + (e.hours || 0), 0).toFixed(2)} hrs`}
                  sub={`Across ${plural((timeData?.entries || []).length, "punch", "punches")}`}
                  icon="chart"
                />
              </div>

              <Card
                title={staffName ? `Time clock — ${staffName}` : "Time clock"}
                subtitle="One tap in, one tap out. Your hours roll straight into payroll."
              >
                <div className="stack g-3">
                  {timeData?.open ? (
                    <Button
                      size="xl"
                      block
                      variant="danger"
                      icon="clock"
                      loading={clockBusy}
                      onClick={async () => {
                        setClockBusy(true);
                        try { await clock("out"); } finally { setClockBusy(false); }
                      }}
                    >
                      Clock out
                    </Button>
                  ) : (
                    <Button
                      size="xl"
                      block
                      variant="primary"
                      icon="clock"
                      loading={clockBusy}
                      onClick={async () => {
                        setClockBusy(true);
                        try { await clock("in"); } finally { setClockBusy(false); }
                      }}
                    >
                      Clock in
                    </Button>
                  )}
                  {timeMsg ? <Note tone="error">{timeMsg}</Note> : null}
                </div>
              </Card>

              <Card
                title="Recent shifts"
                subtitle="The last 14 days of punches"
                flush
                footer={<span className="t-xs t-muted">Forgot a punch? Tell the admin — they can fix it in Team &amp; payroll.</span>}
              >
                <DataTable
                  rows={timeData?.entries || []}
                  columns={[
                    { key: "day", header: "Day", primary: true, sortBy: (e) => e.dayStr, cell: (e) => <b>{e.dayStr}</b> },
                    { key: "in", header: "In", sortBy: (e) => e.inStr, cell: (e) => e.inStr },
                    {
                      key: "out",
                      header: "Out",
                      cell: (e) => (e.outStr ? e.outStr : <Badge tone="warn" dot>Still open</Badge>),
                    },
                    {
                      key: "hours",
                      header: "Hours",
                      align: "right",
                      sortBy: (e) => e.hours ?? -1,
                      cell: (e) => <span className="num">{e.hours !== null ? e.hours.toFixed(2) : "—"}</span>,
                    },
                  ]}
                  rowKey={(e) => e.id}
                  loading={!timeData}
                  skeletonRows={4}
                  mobileCards
                  caption="Your punches over the last 14 days"
                  empty={
                    <EmptyState
                      icon="clock"
                      title="No punches yet"
                      body="Clock in above and your shift shows up here."
                    />
                  }
                />
              </Card>
            </>
          )}
        </div>
      )}

      {tab === "team" && allowed("people") && (
        <>
          <Card
            className="mb-4"
            title="Who can get in"
            subtitle="What each person's account can reach, and how they sign in."
          >
            <div className="stack g-4">
              {/* The shared password isn't a person, so there's no row for it
                  here and nothing to edit under My account. Say what to do
                  about that rather than leaving it to be discovered. */}
              {sharedPasswordSession ? (
                <Note tone="warn" title="You're signed in with the shared admin password">
                  That password isn&rsquo;t an account — it has no email, no personal password, and nothing
                  to change under My account. Add yourself to the team below (name and PIN), then set your
                  role here to <b>Owner</b> and give yourself an email and a password. After that you sign
                  in as yourself, and the shared password goes back to being the spare key.
                </Note>
              ) : null}

              <div className="stack g-2">
                {(["OWNER", "MANAGER", "EMPLOYEE"] as Role[]).map((r) => (
                  <div key={r} className="row g-2" style={{ alignItems: "baseline" }}>
                    <Badge tone={r === "OWNER" ? "solid" : r === "MANAGER" ? "info" : "neutral"}>{ROLE_LABEL[r]}</Badge>
                    <span className="t-xs t-muted">{ROLE_BLURB[r]}</span>
                  </div>
                ))}
              </div>

              <DataTable
                rows={accessRows || []}
                loading={!accessRows}
                skeletonRows={3}
                rowKey={(r) => r.id}
                mobileCards
                caption="Staff accounts, their role, and whether they can sign in"
                columns={[
                  {
                    key: "name",
                    header: "Person",
                    primary: true,
                    sortBy: (r) => r.name,
                    cell: (r) => (
                      <span className="stack g-1">
                        <span style={{ fontWeight: 600 }}>
                          {r.name}{r.id === accessMe ? <span className="t-xs t-muted"> · you</span> : null}
                        </span>
                        <span className="t-xs t-muted">{r.email || "No email"}</span>
                      </span>
                    ),
                  },
                  {
                    key: "role",
                    header: "Can reach",
                    sortBy: (r) => r.role,
                    cell: (r) => (
                      <Select
                        value={r.role}
                        aria-label={`Role for ${r.name}`}
                        disabled={busy || r.id === accessMe}
                        title={r.id === accessMe ? "You can't change your own role." : undefined}
                        onChange={(e) => void changeAccess(r.id, { role: e.target.value }, `${r.name} is now ${ROLE_LABEL[e.target.value as Role]}`)}
                      >
                        {(["OWNER", "MANAGER", "EMPLOYEE"] as Role[]).map((x) => (
                          <option key={x} value={x}>{ROLE_LABEL[x]}</option>
                        ))}
                      </Select>
                    ),
                  },
                  {
                    key: "signin",
                    header: "Sign-in",
                    cell: (r) =>
                      r.role === "EMPLOYEE" ? (
                        <span className="t-xs t-muted">Name + PIN</span>
                      ) : r.email && r.hasPassword ? (
                        <Badge tone="success" dot>Email + password</Badge>
                      ) : (
                        <Badge tone="warn" dot>Can&rsquo;t sign in yet</Badge>
                      ),
                  },
                  {
                    key: "act",
                    header: "",
                    align: "right",
                    cell: (r) => (
                      <span className="row wrap g-1 end">
                        <Button
                          size="sm" variant="ghost" icon="mail" disabled={busy}
                          onClick={async () => {
                            const addr = await dialog.prompt({
                              title: `Email for ${r.name}`,
                              body: "They sign in with this. Leave it empty to remove it.",
                              label: "Email",
                              defaultValue: r.email,
                              placeholder: "them@example.com",
                              confirmLabel: "Save email",
                            });
                            if (addr === null) return;
                            await changeAccess(r.id, { email: addr }, `Email saved for ${r.name}`);
                          }}
                        >
                          Email
                        </Button>
                        <Button
                          size="sm" variant="secondary" icon="lock" disabled={busy}
                          onClick={async () => {
                            const yes = await dialog.confirm({
                              title: `New password for ${r.name}?`,
                              body: "A fresh password is generated and shown to you once. Any password they have now stops working immediately.",
                              confirmLabel: "Generate it",
                            });
                            if (!yes) return;
                            await changeAccess(r.id, { generatePassword: true }, "");
                          }}
                        >
                          {r.hasPassword ? "Reset password" : "Set password"}
                        </Button>
                        <Button
                          size="sm" variant={r.active ? "dangerSoft" : "secondary"}
                          icon={r.active ? "lock" : "unlock"}
                          disabled={busy || r.id === accessMe}
                          onClick={async () => {
                            const yes = await dialog.confirm({
                              title: r.active ? `Switch off ${r.name}'s account?` : `Switch ${r.name}'s account back on?`,
                              body: r.active
                                ? "They can't sign in until it's switched back on. Their hours, sales and history are kept."
                                : "They'll be able to sign in again with whatever they had before.",
                              tone: r.active ? "warn" : undefined,
                              confirmLabel: r.active ? "Switch it off" : "Switch it on",
                            });
                            if (!yes) return;
                            await changeAccess(r.id, { active: !r.active }, r.active ? `${r.name} switched off` : `${r.name} switched back on`);
                          }}
                        >
                          {r.active ? "Off" : "On"}
                        </Button>
                      </span>
                    ),
                  },
                ]}
                empty={
                  <EmptyState
                    icon="users"
                    title="Nobody on the team yet"
                    body="Add people below, then come back here to say what their account can reach."
                  />
                }
              />

              <Note tone="info">
                Passwords are emailed automatically when you generate one, and shown here once as a backup.
                There&rsquo;s no way to re-send an existing password — it&rsquo;s hashed the moment it&rsquo;s
                made and never stored readable — so if someone loses theirs, generate a new one. Role changes
                take effect on their next page load: the role is read fresh on every request rather than
                stored in their sign-in, so switching an account off locks it out straight away.
              </Note>
            </div>
          </Card>

          <Card
            className="mb-4"
            title="Payroll run"
            subtitle="Hours come straight off the time clock. Pick the period you're paying for."
          >
            <div className="stack g-4">
              <div className="grid-auto" style={{ ["--min" as string]: "180px" }}>
                <Field label="From" hint="First day of the pay period.">
                  {(p) => <Input {...p} type="date" value={payFrom} onChange={(e) => setPayFrom(e.target.value)} />}
                </Field>
                <Field label="To" hint="Last day, counted in full.">
                  {(p) => <Input {...p} type="date" value={payTo} onChange={(e) => setPayTo(e.target.value)} />}
                </Field>
              </div>

              <div className="row wrap g-2">
                <Button
                  icon="chart"
                  loading={pending === "payroll"}
                  onClick={async () => {
                    setPending("payroll");
                    try { await runPayroll(); } finally { setPending(""); }
                  }}
                >
                  Run payroll report
                </Button>
                {payroll ? (
                  <Button variant="ghost" icon="close" onClick={() => { setPayroll(null); setTeamMsg(""); }}>
                    Clear results
                  </Button>
                ) : null}
              </div>

              {teamMsg ? <Note tone="error" title="That didn't go through">{teamMsg}</Note> : null}

              {payroll ? (
                <div className="stack g-3">
                  <DataTable
                    rows={payroll}
                    columns={[
                      {
                        key: "name",
                        header: "Employee",
                        primary: true,
                        sortBy: (r) => r.name,
                        cell: (r) => (
                          <div className="stack g-1" style={{ minWidth: 0 }}>
                            <b className="truncate">{r.name}</b>
                            {r.openEntries > 0 ? (
                              <Badge tone="warn" dot>Still clocked in</Badge>
                            ) : null}
                          </div>
                        ),
                      },
                      { key: "hours", header: "Hours", align: "right", sortBy: (r) => r.hours, cell: (r) => <span className="num">{r.hours.toFixed(2)}</span> },
                      { key: "rate", header: "Rate", align: "right", hideBelow: 760, sortBy: (r) => r.payRateCents, cell: (r) => <span className="num">{money(r.payRateCents)}/hr</span> },
                      { key: "gross", header: "Gross", align: "right", sortBy: (r) => r.grossCents, cell: (r) => <span className="num">{money(r.grossCents)}</span> },
                      { key: "ded", header: "Deductions", align: "right", sortBy: (r) => r.dedCents, cell: (r) => <span className="num">{r.dedCents > 0 ? `− ${money(r.dedCents)}` : "—"}</span> },
                      { key: "net", header: "Net", align: "right", sortBy: (r) => r.netCents, cell: (r) => <b className="num">{money(r.netCents)}</b> },
                    ]}
                    rowKey={(r) => r.id}
                    loading={pending === "payroll"}
                    skeletonRows={4}
                    mobileCards
                    caption={`Payroll ${payFrom} to ${payTo}`}
                    defaultSort={{ key: "net", dir: "desc" }}
                    empty={
                      <EmptyState
                        icon="clock"
                        title="Nobody worked in that range"
                        body="No clocked hours fell between those two dates. Try a wider period."
                      />
                    }
                  />

                  {payroll.length > 0 ? (
                    <div className="row between wrap g-3" style={{ padding: "var(--sp-3) 0 0", borderTop: "1px solid var(--border)" }}>
                      <span className="t-label">
                        Totals — {plural(payroll.length, "person", "people")}
                      </span>
                      <span className="row wrap g-4">
                        <span className="t-sm">
                          <span className="t-muted">Hours </span>
                          <b className="num">{payroll.reduce((s, r) => s + r.hours, 0).toFixed(2)}</b>
                        </span>
                        <span className="t-sm">
                          <span className="t-muted">Gross </span>
                          <b className="num">{money(payroll.reduce((s, r) => s + r.grossCents, 0))}</b>
                        </span>
                        <span className="t-sm">
                          <span className="t-muted">Deductions </span>
                          <b className="num">{money(payroll.reduce((s, r) => s + r.dedCents, 0))}</b>
                        </span>
                        <span className="t-sm">
                          <span className="t-muted">Net </span>
                          <b className="num">{money(payroll.reduce((s, r) => s + r.netCents, 0))}</b>
                        </span>
                      </span>
                    </div>
                  ) : null}

                  <Note tone="info" title="This is the timesheet side only">
                    Gross = hours × rate. Net = gross − the recurring deductions on each person&rsquo;s record.
                    Withholding is yours to compute at Eldridge.
                  </Note>
                </div>
              ) : null}
            </div>
          </Card>

          {/* The roster used to print every person's whole file inline, so the
              page was a wall of forms. It's a list now; the detail lives in a
              slide-over, one person at a time. */}
          <Card
            title="Team"
            subtitle={team.length > 0 ? `${plural(team.length, "person", "people")} on payroll` : undefined}
          >
            <DataTable
              rows={team}
              columns={[
                {
                  key: "name",
                  header: "Employee",
                  primary: true,
                  sortBy: (m) => m.name,
                  cell: (m) => (
                    <div className="stack g-1" style={{ minWidth: 0 }}>
                      <b className="truncate">{m.name}</b>
                      <span className="t-xs t-muted truncate">
                        {m.w4.filingStatus || "No W-4 filing status on file"}
                      </span>
                    </div>
                  ),
                },
                {
                  key: "rate",
                  header: "Pay rate",
                  align: "right",
                  sortBy: (m) => m.payRateCents,
                  cell: (m) =>
                    m.payRateCents > 0
                      ? <span className="num">{money(m.payRateCents)}/hr</span>
                      : <Badge tone="warn" dot>Not set</Badge>,
                },
                {
                  key: "deductions",
                  header: "Deductions",
                  align: "right",
                  hideBelow: 760,
                  sortBy: (m) => m.deductions.reduce((s, d) => s + d.amountCents, 0),
                  cell: (m) =>
                    m.deductions.length === 0
                      ? <span className="t-muted">None</span>
                      : <span className="num">{money(m.deductions.reduce((s, d) => s + d.amountCents, 0))}</span>,
                },
                {
                  key: "docs",
                  header: "Documents",
                  align: "right",
                  hideBelow: 900,
                  sortBy: (m) => m.docs.length,
                  cell: (m) =>
                    m.docs.length === 0
                      ? <Badge tone="warn" dot>Nothing on file</Badge>
                      : <span className="num">{plural(m.docs.length, "file")}</span>,
                },
              ]}
              rowKey={(m) => m.id}
              loading={!overview && team.length === 0}
              skeletonRows={4}
              mobileCards
              caption="Employees, pay rates, deductions and documents"
              onRowClick={(m) => { setDocKind("W4"); setTeamOpen(m.id); }}
              empty={
                <EmptyState
                  icon="users"
                  title="Nobody on the team yet"
                  body="Add someone under Settings → Register employees. They show up here with their pay rate, W-4 and documents."
                />
              }
            />
          </Card>

          {/* Employee detail slide-over — pay rate, W-4, deductions, documents. */}
          {(() => {
            const m = team.find((x) => x.id === teamOpen);
            if (!m) return null;
            const dedTotal = m.deductions.reduce((s, d) => s + d.amountCents, 0);
            return (
              <Panel
                open
                onClose={() => setTeamOpen(null)}
                title={m.name}
                subtitle={m.payRateCents > 0 ? `${money(m.payRateCents)} an hour` : "No pay rate set yet"}
              >
                <div className="stack g-5">
                  {teamMsg ? <Note tone="error" title="That didn't go through">{teamMsg}</Note> : null}

                  <div className="stack g-2">
                    <p className="t-label">Pay rate</p>
                    <div className="row between wrap g-2">
                      <span className="t-body num">
                        {m.payRateCents > 0 ? `${money(m.payRateCents)} / hour` : "Not set"}
                      </span>
                      <Button
                        size="sm"
                        icon="edit"
                        loading={pending === `rate-${m.id}`}
                        onClick={async () => {
                          const cents = await dialog.money({
                            title: `Hourly pay rate for ${m.name}`,
                            body: "Payroll multiplies this by the hours on their time clock.",
                            label: "Rate per hour",
                            defaultCents: m.payRateCents,
                            confirmLabel: "Save rate",
                          });
                          if (cents === null) return;
                          setPending(`rate-${m.id}`);
                          try {
                            await patchTeam({ employeeId: m.id, payRateDollars: String(cents / 100) });
                          } finally { setPending(""); }
                        }}
                      >
                        Change rate
                      </Button>
                    </div>
                  </div>

                  <div className="stack g-3">
                    <div className="stack g-1">
                      <p className="t-label">W-4 on file</p>
                      <p className="t-xs t-muted">
                        Saved for your records. Nothing here changes what payroll calculates.
                      </p>
                    </div>
                    <Field label="Filing status" hint="From step 1(c) of their W-4.">
                      {(p) => (
                        <Select
                          {...p}
                          value={m.w4.filingStatus || ""}
                          onChange={(e) => patchTeam({ employeeId: m.id, w4: { ...m.w4, filingStatus: e.target.value } })}
                        >
                          <option value="">Not recorded</option>
                          <option>Single or MFS</option>
                          <option>Married filing jointly</option>
                          <option>Head of household</option>
                        </Select>
                      )}
                    </Field>
                    <div className="grid-auto" style={{ ["--min" as string]: "160px" }}>
                      <Field label="Step 3 dependents ($)" hint="Total claimed on step 3.">
                        {(p) => (
                          <Input
                            {...p}
                            key={`dep-${m.id}`}
                            inputMode="decimal"
                            defaultValue={m.w4.dependentsDollars || ""}
                            placeholder="0"
                            onBlur={(e) => patchTeam({ employeeId: m.id, w4: { ...m.w4, dependentsDollars: e.target.value } })}
                          />
                        )}
                      </Field>
                      <Field label="Step 4(c) extra withholding ($)" hint="Extra they asked to hold per period.">
                        {(p) => (
                          <Input
                            {...p}
                            key={`extra-${m.id}`}
                            inputMode="decimal"
                            defaultValue={m.w4.extraWithholdingDollars || ""}
                            placeholder="0"
                            onBlur={(e) => patchTeam({ employeeId: m.id, w4: { ...m.w4, extraWithholdingDollars: e.target.value } })}
                          />
                        )}
                      </Field>
                    </div>
                  </div>

                  <div className="stack g-2">
                    <div className="row between wrap g-2">
                      <p className="t-label">Recurring deductions</p>
                      <Button size="sm" variant="ghost" icon="plus" onClick={() => addDeduction(m.id, m.name)}>
                        Add deduction
                      </Button>
                    </div>
                    {m.deductions.length === 0 ? (
                      <EmptyState
                        icon="minus"
                        title="No deductions"
                        body="Anything you add comes off this person's gross every pay period."
                      />
                    ) : (
                      <>
                        <ul className="stack g-1" style={{ listStyle: "none", margin: 0, padding: 0 }}>
                          {m.deductions.map((d) => (
                            <li
                              key={d.id}
                              className="row between g-2"
                              style={{ padding: "var(--sp-2) 0", borderBottom: "1px solid var(--border)" }}
                            >
                              <span className="t-sm truncate">{d.name}</span>
                              <span className="row g-2 shrink0">
                                <span className="num t-sm">{money(d.amountCents)}</span>
                                <IconButton
                                  icon="trash"
                                  label={`Remove the ${d.name} deduction`}
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => dropDeduction(d.id, d.name)}
                                />
                              </span>
                            </li>
                          ))}
                        </ul>
                        <p className="t-xs t-muted">
                          {money(dedTotal)} comes off every pay period.
                        </p>
                      </>
                    )}
                  </div>

                  <div className="stack g-2">
                    <div className="stack g-1">
                      <p className="t-label">Documents</p>
                      <p className="t-xs t-muted">W-4, I-9, photo ID — anything you need to keep on file.</p>
                    </div>
                    {m.docs.length === 0 ? (
                      <EmptyState
                        icon="clipboard"
                        title="Nothing uploaded"
                        body="Add their W-4 and I-9 here so they're in one place."
                      />
                    ) : (
                      <ul className="stack g-1" style={{ listStyle: "none", margin: 0, padding: 0 }}>
                        {m.docs.map((d) => (
                          <li
                            key={d.id}
                            className="row between g-2"
                            style={{ padding: "var(--sp-2) 0", borderBottom: "1px solid var(--border)" }}
                          >
                            <span className="stack g-1" style={{ minWidth: 0 }}>
                              <span className="t-sm truncate">{d.filename}</span>
                              <span className="t-xs t-muted">{d.kind} · added {fmtDate(d.createdAt)}</span>
                            </span>
                            <span className="row g-1 shrink0">
                              <LinkButton
                                href={`/api/admin/team/docs/${d.id}`}
                                variant="ghost"
                                size="sm"
                                icon="eye"
                                external
                              >
                                View
                              </LinkButton>
                              <IconButton
                                icon="trash"
                                label={`Delete ${d.filename}`}
                                variant="ghost"
                                size="sm"
                                onClick={() => dropDoc(d.id, d.filename)}
                              />
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}

                    <div className="grid-auto mt-2" style={{ ["--min" as string]: "160px" }}>
                      <Field label="Document type" hint="Filed under this label.">
                        {(p) => (
                          <Select {...p} value={docKind} onChange={(e) => setDocKind(e.target.value)}>
                            <option value="W4">W-4</option>
                            <option value="I9">I-9</option>
                            <option value="ID">Photo ID</option>
                            <option value="OTHER">Other</option>
                          </Select>
                        )}
                      </Field>
                      <Field label="File" hint="Image or PDF, 5 MB max.">
                        {(p) => (
                          <Input
                            {...p}
                            type="file"
                            accept="image/*,application/pdf"
                            onChange={(e) => {
                              const f = e.target.files?.[0];
                              if (f) uploadDoc(m.id, docKind || "OTHER", f);
                              e.target.value = "";
                            }}
                          />
                        )}
                      </Field>
                    </div>
                  </div>
                </div>
              </Panel>
            );
          })()}
        </>
      )}

      {tab === "reports" && (
        <div className="stack g-4">
          {/* Controls first, then the numbers they produce. The old screen
              buried the period buttons in a wall of tables. */}
          <Card
            title="Sales reports"
            subtitle="Pick a period and a scope — every number below moves together."
            actions={
              <Button
                size="sm"
                variant="secondary"
                icon="download"
                disabled={!report}
                onClick={() => {
                  if (!report) return;
                  const scope = repVendor === "all"
                    ? "Whole shop"
                    : (() => {
                        const v = vendors.find((x) => x.id === repVendor);
                        return v ? `${v.code} — ${v.businessName}` : "Vendor";
                      })();
                  try {
                    downloadReportCsv(report, scope);
                    toast.success("Report exported", "The CSV is in your downloads folder.");
                  } catch (e) {
                    toast.error("Couldn't build the export", e instanceof Error ? e.message : "Try again.");
                  }
                }}
              >
                Export CSV
              </Button>
            }
          >
            <div className="stack g-4">
              <Segmented
                label="Reporting period"
                value={repPeriod}
                onChange={setRepPeriod}
                options={[
                  { value: "day", label: "Today" },
                  { value: "week", label: "Week" },
                  { value: "month", label: "Month" },
                  { value: "quarter", label: "Quarter" },
                  { value: "year", label: "Year" },
                  { value: "custom", label: "Custom" },
                ]}
              />

              {repPeriod === "custom" ? (
                <div className="row wrap g-3">
                  <Field label="From" className="grow">
                    {(p) => <Input {...p} type="date" value={repFrom} onChange={(e) => setRepFrom(e.target.value)} />}
                  </Field>
                  <Field label="To" className="grow">
                    {(p) => <Input {...p} type="date" value={repTo} onChange={(e) => setRepTo(e.target.value)} />}
                  </Field>
                </div>
              ) : null}

              <Field label="Scope" hint="The whole shop, or one vendor's slice of it.">
                {(p) => (
                  <Select {...p} value={repVendor} onChange={(e) => setRepVendor(e.target.value)}>
                    <option value="all">Whole shop</option>
                    {vendors.map((v) => <option key={v.id} value={v.id}>{v.code} — {v.businessName}</option>)}
                  </Select>
                )}
              </Field>

              {report ? (
                <p className="t-xs t-muted">
                  Covering {fmtDate(report.start)} – {fmtDate(report.end)}.
                </p>
              ) : null}
            </div>
          </Card>

          {!report ? (
            <SkeletonStats count={4} />
          ) : (
            <>
              <div className="grid-auto" style={{ ["--min" as string]: "180px" }}>
                {repVendor === "all" ? (
                  <>
                    <Stat feature label="Gross sales" value={money(report.gross)} sub="Before tax" icon="dollar" />
                    <Stat label="Tax collected" value={money(report.tax)} sub="Remit to the OTC" icon="receipt" />
                    <Stat label="Cash taken" value={money(report.cash)} sub="Drawer + bank" icon="cash" />
                    <Stat label="Card taken" value={money(report.card)} sub="Net of refunds" icon="card" />
                    <Stat label="Tickets" value={String(report.tickets)} sub="Sales rung up" icon="receipt" />
                    <Stat label="Units sold" value={String(report.units)} sub="Items off the floor" icon="box" />
                    <Stat label="Vendor net" value={money(report.vNet)} sub={`${money(report.vGross)} gross, after commission`} icon="store" />
                    {(report.refundTotal || 0) > 0 ? (
                      <Stat label="Refunds given back" value={`−${money(report.refundTotal || 0)}`} sub="Already deducted above" icon="refresh" />
                    ) : null}
                  </>
                ) : (
                  <>
                    <Stat feature label="Vendor gross" value={money(report.vGross)} sub="Before commission" icon="dollar" />
                    <Stat label="Their net" value={money(report.vNet)} sub="After commission" icon="store" />
                    <Stat label="Units sold" value={String(report.units)} icon="box" />
                    <Stat label="Tickets" value={String(report.tickets)} sub="Containing their items" icon="receipt" />
                  </>
                )}
              </div>

              {repVendor === "all" ? (
                <Card
                  title="By vendor"
                  subtitle="Gross sales and each vendor's share of the floor"
                  flush
                >
                  <DataTable
                    rows={report.byVendor}
                    columns={[
                      {
                        key: "vendor",
                        header: "Vendor",
                        primary: true,
                        sortBy: (r) => r.vendor?.businessName || "",
                        cell: (r) => (
                          <div className="stack g-1" style={{ minWidth: 0 }}>
                            <b className="truncate">{r.vendor?.businessName || "Unknown vendor"}</b>
                            <span className="t-xs t-muted mono">{r.vendor?.code}</span>
                          </div>
                        ),
                      },
                      {
                        key: "gross",
                        header: "Gross",
                        align: "right",
                        sortBy: (r) => r.cents,
                        cell: (r) => <span className="num">{money(r.cents)}</span>,
                      },
                      {
                        key: "share",
                        header: "Share",
                        align: "right",
                        sortBy: (r) => r.cents,
                        cell: (r) => (
                          <span className="num t-muted">{report.vGross ? Math.round((r.cents / report.vGross) * 100) : 0}%</span>
                        ),
                      },
                    ]}
                    rowKey={(r) => r.vendor?.code || r.vendor?.businessName || String(r.cents)}
                    defaultSort={{ key: "gross", dir: "desc" }}
                    mobileCards
                    caption="Gross sales by vendor for the selected period"
                    empty={
                      <EmptyState
                        icon="store"
                        title="No vendor sales in this period"
                        body="Try a wider period, or check that sales were rung up against a vendor code."
                      />
                    }
                  />
                </Card>
              ) : null}

              <Card title="By item" subtitle="What actually moved" flush>
                <DataTable
                  rows={report.byItem}
                  columns={[
                    {
                      key: "name",
                      header: "Item",
                      primary: true,
                      sortBy: (r) => r.name,
                      cell: (r) => <span className="truncate">{r.name}</span>,
                    },
                    {
                      key: "units",
                      header: "Units",
                      align: "right",
                      sortBy: (r) => r.q,
                      cell: (r) => <span className="num">{r.q}</span>,
                    },
                    {
                      key: "gross",
                      header: "Gross",
                      align: "right",
                      sortBy: (r) => r.c,
                      cell: (r) => <span className="num">{money(r.c)}</span>,
                    },
                  ]}
                  rowKey={(r) => r.name}
                  defaultSort={{ key: "gross", dir: "desc" }}
                  mobileCards
                  caption="Units and gross sales by item for the selected period"
                  empty={
                    <EmptyState
                      icon="box"
                      title="Nothing sold in this period"
                      body="Once items ring up at the register they're listed here, best sellers first."
                    />
                  }
                />
              </Card>

              <Card title="By hour" subtitle="When the money came through the door">
                {(() => {
                  /* A hand-rolled bar chart: 14 divs with percentage heights.
                     A charting library would be 100× the weight of this. */
                  const hours = Array.from({ length: 14 }, (_, k) => k + 7);
                  const bars = hours.map((hh) => ({ hh, cents: report.byHour[String(hh)] || 0 }));
                  const peak = bars.reduce((m, b) => Math.max(m, b.cents), 0);
                  if (!peak) {
                    return (
                      <EmptyState
                        icon="clock"
                        title="No hourly sales yet"
                        body="Nothing was rung up during opening hours in this period."
                      />
                    );
                  }
                  const busiest = bars.reduce((a, b) => (b.cents > a.cents ? b : a), bars[0]);
                  return (
                    <div className="stack g-3">
                      <div
                        className="row g-1"
                        style={{ height: "11rem", alignItems: "flex-end" }}
                        aria-hidden="true"
                      >
                        {bars.map((b) => (
                          <div
                            key={b.hh}
                            className="stack g-1 grow"
                            title={`${hourLabel(b.hh)} — ${money(b.cents)}`}
                            style={{ height: "100%", justifyContent: "flex-end", alignItems: "center" }}
                          >
                            <span className="t-xs t-muted num truncate">{b.cents ? money(b.cents) : ""}</span>
                            <div
                              style={{
                                width: "100%",
                                height: `${b.cents ? Math.max(3, Math.round((b.cents / peak) * 100)) : 1}%`,
                                minHeight: 2,
                                borderRadius: "var(--r-sm)",
                                background: b.cents ? "var(--accent)" : "var(--border)",
                              }}
                            />
                            <span className="t-xs t-muted">{hourShort(b.hh)}</span>
                          </div>
                        ))}
                      </div>
                      {/* Text alternative — screen readers get the numbers, not the bars. */}
                      <table className="sr-only">
                        <caption>Gross sales by hour for the selected period</caption>
                        <tbody>
                          {bars.filter((b) => b.cents > 0).map((b) => (
                            <tr key={b.hh}>
                              <th scope="row">{hourLabel(b.hh)}</th>
                              <td>{money(b.cents)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      <p className="t-xs t-muted">
                        Busiest hour: <b>{hourLabel(busiest.hh)}</b> at {money(busiest.cents)}. Bars are
                        scaled against that hour.
                      </p>
                    </div>
                  );
                })()}
              </Card>
            </>
          )}

          {/* ---- what actually goes on the sales tax return ---------------- */}
          <Card
            title="Sales tax return"
            subtitle="The figures the Oklahoma return asks for, split the way it splits them."
            actions={
              <Button
                size="sm"
                variant="secondary"
                icon="download"
                disabled={!taxReport}
                onClick={() => { window.location.href = `/api/admin/tax-report?month=${encodeURIComponent(taxMonth)}&format=csv`; }}
              >
                Export CSV
              </Button>
            }
          >
            <div className="stack g-4">
              <Field label="Filing month" hint="Sales count in the month they were rung; refunds in the month they were given back.">
                {(p) => (
                  <Select {...p} value={taxMonth} onChange={(e) => setTaxMonth(e.target.value)} style={{ maxWidth: 260 }}>
                    {(taxReport?.months.length ? taxReport.months.map((m) => m.month) : [taxMonth]).map((m) => (
                      <option key={m} value={m}>{taxReport?.months.find((x) => x.month === m)?.label || m}</option>
                    ))}
                  </Select>
                )}
              </Field>

              {taxErr ? <Note tone="error">{taxErr}</Note> : null}

              {taxReport ? (
                <>
                  {!taxReport.rates.splitConfigured ? (
                    <Note tone="warn" title="Food rate isn't set">
                      Groceries are still being taxed at the full {taxReport.rates.standardPercent}%. Set the food
                      rate in Settings and the split below starts filling in from the next sale.
                    </Note>
                  ) : null}

                  <div className="stats">
                    <Stat
                      feature
                      label="Tax collected"
                      value={money(taxReport.current.taxCollectedCents)}
                      sub={taxReport.current.label}
                      icon="dollar"
                    />
                    <Stat label="Gross sales" value={money(taxReport.current.grossSalesCents)} sub={`${taxReport.current.tickets} tickets`} />
                    <Stat
                      label="Taxable — general"
                      value={money(taxReport.current.stateTaxableCents)}
                      sub={`at ${taxReport.rates.standardPercent}%`}
                    />
                    <Stat
                      label="Food (state-exempt)"
                      value={money(taxReport.current.exemptFromStateCents)}
                      sub={`local only, ${taxReport.rates.foodPercent}%`}
                    />
                  </div>

                  <DescList
                    items={[
                      { label: "Gross receipts", value: money(taxReport.current.grossSalesCents) },
                      {
                        label: "Less food & food ingredients (exempt from the state portion)",
                        value: money(taxReport.current.exemptFromStateCents),
                      },
                      { label: "Net taxable at the full rate", value: <b>{money(taxReport.current.stateTaxableCents)}</b> },
                      { label: "Taxable for the local portion (everything)", value: money(taxReport.current.localTaxableCents) },
                      { label: `Tax collected — general (${taxReport.rates.standardPercent}%)`, value: money(taxReport.current.standardTaxCents) },
                      { label: `Tax collected — food (${taxReport.rates.foodPercent}%)`, value: money(taxReport.current.foodTaxCents) },
                      { label: "Total tax collected", value: <b>{money(taxReport.current.taxCollectedCents)}</b> },
                      {
                        label: "Refunds and voids given back this month",
                        value: `${money(taxReport.current.returnedSalesCents)} + ${money(taxReport.current.returnedTaxCents)} tax`,
                      },
                    ]}
                  />

                  {taxReport.current.preSplitTickets > 0 ? (
                    <Note tone="info">
                      {plural(taxReport.current.preSplitTickets, "ticket")} this month {taxReport.current.preSplitTickets === 1 ? "was" : "were"} rung
                      before the food rate was set, so {taxReport.current.preSplitTickets === 1 ? "it counts" : "they count"} as
                      general-rate sales — which is what was actually collected at the till.
                    </Note>
                  ) : null}

                  <DataTable
                    rows={taxReport.months}
                    rowKey={(m) => m.month}
                    mobileCards
                    columns={[
                      { key: "month", header: "Month", cell: (m) => m.label, primary: true },
                      { key: "gross", header: "Gross", align: "right", cell: (m) => money(m.grossSalesCents) },
                      { key: "general", header: "General", align: "right", cell: (m) => money(m.stateTaxableCents) },
                      { key: "food", header: "Food", align: "right", cell: (m) => money(m.foodSalesCents) },
                      { key: "tax", header: "Tax collected", align: "right", cell: (m) => <b>{money(m.taxCollectedCents)}</b> },
                      { key: "returns", header: "Returned", align: "right", cell: (m) => (m.returnedSalesCents ? money(m.returnedSalesCents + m.returnedTaxCents) : "—") },
                    ]}
                    empty={<EmptyState title="No sales yet" body="Once tickets are rung, the months build up here." />}
                  />

                  <p className="t-xs t-muted">
                    Figures come from the tax actually charged on each ticket, not from today&rsquo;s rates — changing a
                    rate in Settings can&rsquo;t move a month you&rsquo;ve already filed.
                  </p>
                </>
              ) : (
                <Skeleton />
              )}
            </div>
          </Card>

          {/* ---- who did what to the money ---------------------------------- */}
          <Card
            title="Activity"
            subtitle="Voids, refunds, balance changes, payouts and access changes — with a name on each one."
          >
            <div className="stack g-4">
              <div className="row wrap g-3">
                <Field label="Show" className="grow">
                  {(p) => (
                    <Select {...p} value={auditFilter} onChange={(e) => setAuditFilter(e.target.value)}>
                      <option value="MONEY_OUT">Money going out</option>
                      <option value="ALL">Everything</option>
                      <option value="SALE_VOID">Voids</option>
                      <option value="SALE_REFUND">Refunds</option>
                      <option value="VENDOR_LEDGER">Balance changes</option>
                      <option value="PAYOUT_PAID">Payouts</option>
                      <option value="DRAWER_CLOSE">Drawers that didn&rsquo;t balance</option>
                      <option value="EMPLOYEE_CHANGE">Staff access</option>
                      <option value="SETTING_CHANGE">Settings</option>
                    </Select>
                  )}
                </Field>
                <Field label="Period" className="grow">
                  {(p) => (
                    <Select {...p} value={auditDays} onChange={(e) => setAuditDays(e.target.value)}>
                      <option value="7">Last 7 days</option>
                      <option value="30">Last 30 days</option>
                      <option value="90">Last 90 days</option>
                      <option value="365">Last year</option>
                    </Select>
                  )}
                </Field>
              </div>

              {auditFilter === "MONEY_OUT" && audit.length ? (
                <Note tone={auditOut > 0 ? "warn" : "info"}>
                  <b>{money(auditOut)}</b> handed back or paid out in this period, across {plural(audit.length, "entry", "entries")}.
                </Note>
              ) : null}

              <DataTable
                rows={audit}
                rowKey={(e) => e.id}
                mobileCards
                columns={[
                  { key: "at", header: "When", cell: (e) => <span title={fmtDateTime(e.at)}>{relTime(e.at)}</span> },
                  {
                    key: "what",
                    header: "What happened",
                    primary: true,
                    cell: (e) => (
                      <div>
                        <div style={{ fontWeight: 560 }}>{auditLabel(e.action)}</div>
                        <div className="t-xs t-muted">{e.detail || e.targetLabel}</div>
                      </div>
                    ),
                  },
                  {
                    key: "who",
                    header: "Who",
                    cell: (e) => (
                      <div>
                        <div>{actorLabel(e)}</div>
                        {e.approvedBy ? <div className="t-xs t-muted">approved by {e.approvedBy}</div> : null}
                      </div>
                    ),
                  },
                  {
                    key: "amount",
                    header: "Amount",
                    align: "right",
                    cell: (e) => (e.amountCents > 0 ? <b>{money(e.amountCents)}</b> : e.amountCents < 0 ? <span className="t-muted">{money(-e.amountCents)} in</span> : "—"),
                  },
                ]}
                empty={
                  <EmptyState
                    title="Nothing logged yet"
                    body="Voids, refunds, payouts and account changes will appear here from now on. It starts empty — there's no history to backfill."
                  />
                }
              />
            </div>
          </Card>
        </div>
      )}

      {/* Top of the money page, in the order the questions get asked: what is
          coming into the bank and when, then who has paid their rent and who
          has not. Both used to sit below four other cards. */}
      {tab === "bank" && (
        <div className="stack g-4" style={{ marginBottom: "var(--sp-4)" }}>
          <MoneyAtAGlance bank={bank} ledger={ledger} payouts={payouts} />

          {allowed("financials") ? (
            <UpcomingMoney
              data={upcoming}
              busy={busy}
              onSave={(opensAt, day) => void saveMoneyDates(opensAt, day)}
              onCredit={() => void applyClosedDayCredit()}
            />
          ) : null}

          <RentLedgerCards
            ledger={ledger}
            filter={ledgerFilter}
            onFilter={setLedgerFilter}
            busy={busy}
            onSendLink={(row) => sendRentLinkFor(row)}
            onRecordPayment={async (row) => {
              await ledgerEntry(
                { id: row.vendorId, businessName: row.businessName, balance: row.balanceCents },
                "RENT_PAYMENT",
                row.rentDueCents
              );
              const r = await fetch("/api/admin/rent-ledger");
              if (r.ok) setLedger(await r.json());
            }}
          />
        </div>
      )}

      {tab === "bank" && (() => {
        const owing = (settle || []).filter((r) => r.dueCents > 0);
        const covered = (settle || []).filter((r) => r.dueCents === 0);
        /* Real money leaves the market's Stripe account here, so the confirm
           itemises rent and the processing fee before anything is charged. */
        const chargeCard = async (r: NonNullable<typeof settle>[number]) => {
          const yes = await dialog.confirm({
            title: `Charge ${r.businessName}'s card?`,
            body: (
              <div className="stack g-3">
                <p>
                  This bills the card ending {r.cardLast4} straight away for booth {r.boothLabel}&rsquo;s
                  outstanding rent, settles their balance, and emails them an itemised statement.
                </p>
                <DescList
                  items={[
                    { label: "Rent due", value: <span className="num">{money(r.dueCents)}</span> },
                    { label: "Card processing (3%)", value: <span className="num">{money(r.feeCents)}</span> },
                    { label: "Total charged", value: <b className="num">{money(r.chargeTotalCents)}</b> },
                  ]}
                />
                <p className="t-xs t-muted">Refunds have to be done in Stripe, so check the amount first.</p>
              </div>
            ),
            confirmLabel: `Charge ${money(r.chargeTotalCents)}`,
            cancelLabel: "Don't charge",
            tone: "warn",
          });
          if (!yes) return;
          setBusy(true);
          try {
            const res = await fetch("/api/admin/settlement", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ vendorId: r.vendorId }) });
            const d = await res.json();
            if (res.ok) {
              toast.success(
                `Charged ${money(d.chargeTotalCents)}`,
                `${r.businessName}'s balance is settled, the statement is updated, and they've been emailed.`
              );
            } else {
              toast.error("The card wasn't charged", String(d.error || "Stripe rejected the charge. Nothing has been billed."));
            }
            const rr = await fetch("/api/admin/settlement");
            if (rr.ok) setSettle((await rr.json()).rows);
          } catch (e) {
            toast.error("The card wasn't charged", e instanceof Error ? e.message : "Network error — nothing has been billed.");
          } finally { setBusy(false); }
        };
        return (
          <Card
            className="mb-4"
            title="Rent settlement"
            subtitle="Vendors whose sales balance doesn't cover their rent"
            flush
            footer={
              <div className="stack g-2">
                <span className="t-xs t-muted">
                  Charging bills the card on file for the amount due <b>plus a 3% card-processing
                  adjustment on the charged amount only</b> — both itemised on their statement and
                  emailed to them. No card on file? They add one in their portal under Money.
                </span>
                {covered.length > 0 ? (
                  <span className="t-xs t-muted">Covered: {covered.map((r) => r.code).join(", ")}</span>
                ) : null}
              </div>
            }
          >
            <DataTable
              rows={owing}
              columns={[
                {
                  key: "booth",
                  header: "Booth",
                  primary: true,
                  sortBy: (r) => r.boothLabel,
                  cell: (r) => (
                    <div className="stack g-1" style={{ minWidth: 0 }}>
                      <b className="truncate">Booth {r.boothLabel} · {r.businessName}</b>
                      <span className="t-xs t-muted mono">{r.code}</span>
                    </div>
                  ),
                },
                {
                  key: "rent",
                  header: "Rent",
                  align: "right",
                  hideBelow: 900,
                  sortBy: (r) => r.monthlyRentCents,
                  cell: (r) => <span className="num">{money(r.monthlyRentCents)}/mo</span>,
                },
                {
                  key: "balance",
                  header: "Balance",
                  align: "right",
                  hideBelow: 760,
                  sortBy: (r) => r.balanceCents,
                  cell: (r) => <span className="num t-danger">{money(r.balanceCents)}</span>,
                },
                {
                  key: "charge",
                  header: "To charge",
                  align: "right",
                  sortBy: (r) => r.chargeTotalCents,
                  cell: (r) => (
                    <div className="stack g-1" style={{ alignItems: "flex-end" }}>
                      <b className="num">{money(r.chargeTotalCents)}</b>
                      <span className="t-xs t-muted num">{money(r.dueCents)} rent + {money(r.feeCents)} fee</span>
                    </div>
                  ),
                },
                {
                  key: "card",
                  header: "Card",
                  sortBy: (r) => (r.hasCard ? 0 : 1),
                  cell: (r) =>
                    r.hasCard ? (
                      <Badge tone="success" dot>Card on file ····{r.cardLast4}</Badge>
                    ) : (
                      <Badge tone="warn" dot>No card on file</Badge>
                    ),
                },
                {
                  key: "action",
                  header: "",
                  align: "right",
                  mobileLabel: "Action",
                  cell: (r) =>
                    r.hasCard ? (
                      <Button size="sm" icon="card" disabled={busy} onClick={() => chargeCard(r)}>
                        Charge card
                      </Button>
                    ) : (
                      <span className="t-xs t-muted">Waiting on their card</span>
                    ),
                },
              ]}
              rowKey={(r) => r.vendorId}
              loading={!settle}
              skeletonRows={3}
              mobileCards
              caption="Vendors with rent outstanding and the amount that would be charged"
              empty={
                <EmptyState
                  icon="checkCircle"
                  title="Everyone's covered"
                  body="No vendor is behind on rent right now — nothing to charge."
                />
              }
            />
          </Card>
        );
      })()}

      {tab === "bank" && (
        <div className="stack g-4">
          {/* ---- Stripe vs the books --------------------------------------- */}
          {(() => {
            const missing = (recon?.rows || []).filter((r) => r.verdict === "MISSING");
            /* The card is only worth the space when there is something to say:
               money Stripe took that never landed, or a safety net that isn't
               switched on. A reconciled account should not nag. */
            if (!recon && !reconLoading && !reconErr) return null;
            if (recon && missing.length === 0 && recon.webhookConfigured) return null;
            return (
              <Card
                title="Stripe payments vs your books"
                subtitle="Rent Stripe collected, matched against what the ledger recorded."
                actions={
                  <Button size="sm" variant="secondary" icon="refresh" loading={reconLoading} onClick={() => void loadRecon()}>
                    Re-check
                  </Button>
                }
              >
                <div className="stack g-4">
                  {reconErr ? <Note tone="error">{reconErr}</Note> : null}
                  {reconLoading && !recon ? <Skeleton height={80} /> : null}

                  {recon && !recon.webhookConfigured ? (
                    <Note tone="error" title="Stripe can't tell the app when someone pays">
                      A payment only reaches the ledger if the vendor&rsquo;s browser makes it back to the
                      success page — pay and close the tab, and the money is in Stripe and the invoice still
                      says unpaid. Fixing it is two steps: add a webhook in Stripe pointing at{" "}
                      <span className="mono">market.dailybreadbaked.com/api/stripe/webhook</span> listening for{" "}
                      <span className="mono">checkout.session.completed</span>, then put its signing secret in
                      Vercel as <span className="mono">STRIPE_WEBHOOK_SECRET</span> and redeploy.
                    </Note>
                  ) : null}

                  {recon && missing.length > 0 ? (
                    <>
                      <div className="stats">
                        <Stat
                          feature
                          label="Taken by Stripe, not in the books"
                          value={money(recon.missingCents)}
                          sub={`${plural(missing.length, "payment")} · last ${recon.days} days`}
                          icon="alert"
                        />
                        <Stat label="Payments checked" value={String(recon.checkedCount)} sub="Succeeded rent charges in Stripe" />
                      </div>

                      <DataTable
                        rows={missing}
                        rowKey={(r) => r.paymentIntentId}
                        mobileCards
                        columns={[
                          {
                            key: "vendor",
                            header: "Vendor",
                            primary: true,
                            cell: (r) => (
                              <span className="stack g-1">
                                <span style={{ fontWeight: 600 }}>{r.businessName}</span>
                                <span className="t-xs t-muted">{r.code}{r.last4 ? ` · ····${r.last4}` : ""}</span>
                              </span>
                            ),
                          },
                          { key: "when", header: "Paid", cell: (r) => fmtDate(r.paidAt) },
                          { key: "amt", header: "Rent", align: "right", cell: (r) => <b className="num">{money(r.dueCents)}</b> },
                          {
                            key: "act",
                            header: "",
                            align: "right",
                            cell: (r) => (
                              <Button size="sm" disabled={busy} onClick={() => void postMissingPayments([r.paymentIntentId])}>
                                Post to ledger
                              </Button>
                            ),
                          },
                        ]}
                      />

                      <div className="row wrap g-2">
                        <Button
                          icon="check"
                          disabled={busy}
                          onClick={() => void postMissingPayments(missing.map((r) => r.paymentIntentId))}
                        >
                          Post all {plural(missing.length, "payment")} ({money(recon.missingCents)})
                        </Button>
                      </div>

                      <p className="t-xs t-muted">
                        Each one is matched by its Stripe payment id, so posting it twice isn&rsquo;t possible —
                        anything already on the ledger is skipped.
                      </p>
                    </>
                  ) : recon && recon.webhookConfigured ? (
                    <Note tone="success">Every rent payment Stripe has taken is on the ledger.</Note>
                  ) : null}
                </div>
              </Card>
            );
          })()}

          {/* ---- paying the vendors --------------------------------------- */}
          <Card
            title="Vendor payouts"
            subtitle="Build a run for the period, then mark each one as you actually pay them."
            actions={
              payRuns.length ? (
                <Select
                  value={payRunId}
                  onChange={(e) => { setPayRunId(e.target.value); loadPayouts(e.target.value); }}
                  aria-label="Payout run"
                  style={{ maxWidth: 260 }}
                >
                  {payRuns.map((r) => (
                    <option key={r.id} value={r.id}>
                      {fmtDateShort(r.periodStart)} – {fmtDateShort(r.periodEnd)} · {money(r.totalCents)}
                      {r.pendingCount ? ` · ${r.pendingCount} to pay` : " · done"}
                    </option>
                  ))}
                </Select>
              ) : null
            }
          >
            <div className="stack g-4">
              <div className="row wrap g-3 items-end">
                <Field label="Period start" className="grow">
                  {(p) => <Input {...p} type="date" value={payFromDate} onChange={(e) => setPayFromDate(e.target.value)} />}
                </Field>
                <Field label="Period end" className="grow">
                  {(p) => <Input {...p} type="date" value={payToDate} onChange={(e) => setPayToDate(e.target.value)} />}
                </Field>
                <Button icon="plus" disabled={busy} onClick={buildPayoutRun}>Build payout run</Button>
              </div>

              {payErr ? <Note tone="error">{payErr}</Note> : null}

              <Note tone="info">
                The amount paid is each vendor&rsquo;s <b>current balance</b>, not the period&rsquo;s sales — so rent
                they owe, refunds since, and anything you&rsquo;ve already paid them are all netted off first. The
                dates decide what the statement covers.
              </Note>

              {payouts.length ? (
                <>
                  <div className="stats">
                    <Stat
                      feature
                      label="Still to pay"
                      value={money(payouts.filter((p) => p.status === "PENDING").reduce((n, p) => n + p.netCents, 0))}
                      sub={`${payouts.filter((p) => p.status === "PENDING").length} vendors`}
                      icon="dollar"
                    />
                    {/* Transfers come out of this, and cash taken at the
                        register never reaches it. Worth seeing before you
                        press pay, not after a transfer bounces. */}
                    <Stat
                      label="Stripe balance"
                      value={stripeBalance === null ? "—" : money(stripeBalance)}
                      sub="What you can send today"
                      icon="bank"
                    />
                    <Stat
                      label="Paid on this run"
                      value={money(payouts.filter((p) => p.status === "PAID").reduce((n, p) => n + p.netCents, 0))}
                      sub={`${payouts.filter((p) => p.status === "PAID").length} vendors`}
                    />
                    <Stat
                      label="Owing the market"
                      value={money(payouts.reduce((n, p) => n + (p.balanceCents < 0 ? -p.balanceCents : 0), 0))}
                      sub={`${payouts.filter((p) => p.balanceCents < 0).length} vendors behind`}
                    />
                  </div>

                  {(() => {
                    const pending = payouts.filter((p) => p.status === "PENDING" && p.netCents > 0);
                    const ready = pending.filter((p) => p.payoutsEnabled);
                    const notConnected = pending.filter((p) => !p.payoutsEnabled);
                    const needed = ready.reduce((n, p) => n + p.quotedSendCents, 0);
                    const short = stripeBalance !== null && needed > stripeBalance;
                    return (
                      <div className="stack g-3">
                        {short ? (
                          <Note tone="warn" title="Your Stripe balance won't cover this run">
                            {money(needed)} to send, {money(stripeBalance || 0)} available. Card sales and card rent
                            payments fund that balance — cash taken at the register doesn&rsquo;t. Add funds in Stripe,
                            or pay the difference from the till and mark those by hand.
                          </Note>
                        ) : null}

                        {notConnected.length ? (
                          <Note tone="info">
                            {plural(notConnected.length, "vendor")} can&rsquo;t be paid by bank yet — they haven&rsquo;t
                            finished connecting an account in their portal. They&rsquo;ll be skipped and stay on the run.
                          </Note>
                        ) : null}

                        {ready.length ? (
                          <div className="row wrap g-2">
                            <Button size="lg" icon="bank" disabled={busy} onClick={payEveryone}>
                              Pay {plural(ready.length, "vendor")} — {money(needed)}
                            </Button>
                            <span className="t-xs t-muted" style={{ alignSelf: "center" }}>
                              Fee of {payoutFee.percent}% + {money(payoutFee.fixedCents)} per vendor comes off their payout.
                            </span>
                          </div>
                        ) : null}
                      </div>
                    );
                  })()}

                  <DataTable
                    rows={payouts}
                    rowKey={(p) => p.id}
                    mobileCards
                    defaultSort={{ key: "net", dir: "desc" }}
                    columns={[
                      {
                        key: "vendor",
                        header: "Vendor",
                        primary: true,
                        sortBy: (p) => p.vendorName,
                        cell: (p) => (
                          <div>
                            <div style={{ fontWeight: 560 }}>{p.vendorName}</div>
                            <div className="t-xs t-muted">{p.vendorCode}</div>
                          </div>
                        ),
                      },
                      { key: "sold", header: "Sold this period", align: "right", sortBy: (p) => p.grossCents, cell: (p) => money(p.grossCents) },
                      { key: "commission", header: "Commission", align: "right", cell: (p) => (p.commissionCents ? `-${money(p.commissionCents)}` : "—") },
                      {
                        key: "net",
                        header: "To pay",
                        align: "right",
                        sortBy: (p) => p.netCents,
                        cell: (p) =>
                          p.netCents > 0
                            ? <b>{money(p.netCents)}</b>
                            : <span className="t-muted">{p.balanceCents < 0 ? `owes ${money(-p.balanceCents)}` : "—"}</span>,
                      },
                      {
                        key: "status",
                        header: "Status",
                        cell: (p) => (
                          <span className="stack g-1">
                            {p.status === "PAID" ? (
                              <Badge tone="success" dot>
                                {p.method === "STRIPE" ? "Sent to bank"
                                  : p.method === "CHECK" && p.reference ? `Check ${p.reference}`
                                  : "Paid"}
                              </Badge>
                            ) : p.status === "SKIPPED" ? (
                              <Badge tone="neutral">Nothing owed</Badge>
                            ) : p.status === "SENDING" ? (
                              <Badge tone="info" dot>Sending…</Badge>
                            ) : p.payoutsEnabled ? (
                              <Badge tone="warn" dot>Ready to send</Badge>
                            ) : p.hasAccount ? (
                              <Badge tone="neutral" dot>Bank setup unfinished</Badge>
                            ) : (
                              <Badge tone="neutral" dot>No bank connected</Badge>
                            )}
                            {p.status === "PAID" && (p.feeCents || 0) > 0 ? (
                              <span className="t-xs t-muted">less {money(p.feeCents || 0)} fee</span>
                            ) : null}
                            {p.failureReason ? <span className="t-xs t-danger">{p.failureReason}</span> : null}
                            {p.status === "PENDING" && !p.payoutsEnabled && p.accountNote ? (
                              <span className="t-xs t-muted">{p.accountNote}</span>
                            ) : null}
                          </span>
                        ),
                      },
                      {
                        key: "action",
                        header: "",
                        align: "right",
                        cell: (p) =>
                          p.status === "PENDING" ? (
                            <span className="row wrap g-2 end">
                              {p.payoutsEnabled ? (
                                <Button size="sm" icon="bank" disabled={busy} onClick={() => void sendPayout(p)}>
                                  Send {money(p.quotedSendCents)}
                                </Button>
                              ) : null}
                              {/* Cash and checks stay possible, just not the
                                  default — some vendor will always refuse to
                                  hand their bank details to anyone. */}
                              <Button size="sm" variant="ghost" disabled={busy} onClick={() => markPayoutPaid(p)}>
                                By hand
                              </Button>
                            </span>
                          ) : p.status === "PAID" ? (
                            <span className="t-xs t-muted">{p.paidBy ? `by ${p.paidBy}` : ""} {p.paidAt ? fmtDateShort(p.paidAt) : ""}</span>
                          ) : null,
                      },
                    ]}
                  />
                </>
              ) : (
                <EmptyState
                  title="No payout run yet"
                  body="Pick the period you're paying for and build a run. It freezes what each vendor is owed so the batch still makes sense a month later."
                />
              )}
            </div>
          </Card>

          {/* Deliberately OUTSIDE the Stripe checks below. Who owes you rent is
              a question about your own ledger, not about Stripe — it must still
              answer when Stripe is misconfigured or refusing to talk. */}
          {/* What the booths are contracted to bring in, before anything about
              who has actually paid. */}
          <Card
            title="Monthly rent roll"
            subtitle="What your booths are contracted for each month — not what's been collected."
          >
            {!rentRoll ? (
              <div className="stack g-2" aria-busy="true"><Skeleton height={64} /><Skeleton height={80} /></div>
            ) : (
              <div className="stack g-4">
                <div className="grid-auto" style={{ ["--min" as string]: "200px" }}>
                  <Stat
                    feature
                    label="Signed and committed"
                    value={money(rentRoll.committedMonthlyCents)}
                    sub={`${plural(rentRoll.committedBooths, "booth")} every month`}
                    icon="contract"
                  />
                  <Stat
                    label="Waiting on signatures"
                    value={money(rentRoll.pendingMonthlyCents)}
                    sub={rentRoll.pendingBooths ? `${plural(rentRoll.pendingBooths, "agreement")} out, unsigned` : "Nothing outstanding"}
                    icon="alert"
                  />
                  {rentRoll.endingBooths > 0 ? (
                    <Stat
                      label="Under notice"
                      value={money(rentRoll.endingMonthlyCents)}
                      sub={`${plural(rentRoll.endingBooths, "booth")} leaving`}
                      icon="warning"
                    />
                  ) : null}
                </div>

                {rentRoll.pendingBooths > 0 ? (
                  <Note tone="warn">
                    {money(rentRoll.pendingMonthlyCents)} of that is on agreements nobody has signed yet. Rent
                    doesn&rsquo;t post until both names are on the paper, so it isn&rsquo;t money you have —
                    it&rsquo;s money you might.
                  </Note>
                ) : null}

                {rentRoll.endingBooths > 0 ? (
                  <Note tone="info">
                    Once the booths under notice are gone you&rsquo;re at{" "}
                    <b>{money(rentRoll.afterEndingMonthlyCents)}</b> a month unless they&rsquo;re re-let.
                  </Note>
                ) : null}

                <DataTable
                  rows={rentRoll.booths}
                  rowKey={(b) => b.contractId}
                  mobileCards
                  defaultSort={{ key: "rent", dir: "desc" }}
                  caption="Every booth and what it's contracted for each month"
                  columns={[
                    {
                      key: "booth",
                      header: "Booth",
                      primary: true,
                      sortBy: (b) => b.boothLabel,
                      cell: (b) => (
                        <span className="stack g-1">
                          <span style={{ fontWeight: 600 }}>Booth {b.boothLabel}</span>
                          <span className="t-xs t-muted">{b.businessName}</span>
                        </span>
                      ),
                    },
                    {
                      key: "state",
                      header: "Status",
                      sortBy: (b) => (b.signed ? 0 : 1),
                      cell: (b) =>
                        !b.signed ? <Badge tone="warn" dot>Unsigned</Badge>
                        : b.status === "TERMINATING" ? (
                          <Badge tone="danger" dot>Ends {b.endDate ? fmtDate(b.endDate) : "soon"}</Badge>
                        ) : <Badge tone="success" dot>Signed</Badge>,
                    },
                    {
                      key: "rent",
                      header: "Monthly rent",
                      align: "right",
                      sortBy: (b) => b.monthlyRentCents,
                      cell: (b) => (
                        <span className={`num ${b.signed ? "" : "t-muted"}`}>{money(b.monthlyRentCents)}</span>
                      ),
                    },
                  ]}
                  empty={
                    <EmptyState
                      icon="contract"
                      title="No booth agreements yet"
                      body="Once agreements are signed, what they're worth each month shows up here."
                    />
                  }
                />
              </div>
            )}
          </Card>

          {!bank ? (
            /* A table's worth of skeleton now, not two stat tiles — the tiles
               that used to sit here moved to the summary at the top. */
            <div className="stack g-2" aria-busy="true"><Skeleton height={16} /><Skeleton height={48} /><Skeleton height={48} /></div>
          ) : !bank.configured ? (
            <Note tone="info" title="Stripe isn't connected yet">
              Add <b>STRIPE_SECRET_KEY</b> (from your Daily Bread Stripe account) to this project&rsquo;s
              Vercel environment variables and redeploy. Once the Stripe card reader lands in phase 2,
              this tab shows exactly what&rsquo;s on its way to the bank.
            </Note>
          ) : bank.error ? (
            <Note tone="error" title="Stripe wouldn't answer">{bank.error}</Note>
          ) : (
            <>
              <Card
                title="Deposits already made"
                subtitle="Money Stripe has finished sending. Anything still on its way is at the top of this page."
                flush
                footer={
                  <span className="t-xs t-muted">
                    Heads up: this reads the shared Stripe account, so until the market gets its own
                    card reader these numbers include Daily Bread&rsquo;s card money too.
                  </span>
                }
              >
                <DataTable
                  /* Only what has landed (or failed). The ones still coming
                     are the whole point of the card at the top, and having
                     them in both places is how you end up counting a deposit
                     twice. */
                  rows={(bank.payouts || []).filter((p) => !isIncoming(p))}
                  columns={[
                    {
                      key: "arrival",
                      header: "Landed",
                      primary: true,
                      sortBy: (p) => p.arrival,
                      cell: (p) => <b>{fmtDate(p.arrival)}</b>,
                    },
                    {
                      key: "status",
                      header: "Status",
                      sortBy: (p) => p.status,
                      cell: (p) =>
                        p.status === "paid" ? (
                          <Badge tone="success" dot>Paid</Badge>
                        ) : p.status === "failed" || p.status === "canceled" ? (
                          <Badge tone="danger" dot>{p.status === "failed" ? "Failed" : "Cancelled"}</Badge>
                        ) : (
                          <Badge tone="info" dot>{p.status === "in_transit" ? "In transit" : "Pending"}</Badge>
                        ),
                    },
                    {
                      key: "amount",
                      header: "Amount",
                      align: "right",
                      sortBy: (p) => p.amount,
                      cell: (p) => <span className="num">{money(p.amount)}</span>,
                    },
                  ]}
                  rowKey={(p) => p.id}
                  defaultSort={{ key: "arrival", dir: "desc" }}
                  mobileCards
                  caption="Stripe payouts to the market's bank account"
                  empty={
                    <EmptyState
                      icon="bank"
                      title="Nothing deposited yet"
                      body="Once a deposit finishes landing in the bank, it moves here from the top of the page."
                    />
                  }
                />
              </Card>
            </>
          )}
        </div>
      )}

      {tab === "floor" && (
        <FloorStockCard
          items={overview?.floor || []}
          loading={!overview}
          month={overview?.month}
        />
      )}

      {tab === "vendors" && (
        <>
          {/* The list used to carry ten buttons on every row, which made it
              unreadable and impossible to scan. Actions now live in the
              slide-over; the table is just the facts, sortable. */}
          <Card
            className="mb-4"
            title="Vendors"
            subtitle={`${plural(vendors.filter((v) => v.active).length, "active vendor")}${vendors.filter((v) => !v.active).length > 0 ? ` · ${vendors.filter((v) => !v.active).length} deactivated` : ""}`}
            actions={vendors.some((v) => !v.active) ? (
              <Button size="sm" variant="ghost" icon="eye" onClick={() => setShowInactive((x) => !x)}>
                {showInactive ? "Hide deactivated" : `Show deactivated (${vendors.filter((v) => !v.active).length})`}
              </Button>
            ) : undefined}
          >
            <div className="toolbar">
              <SearchInput
                className="grow"
                value={vendorQ}
                onValueChange={setVendorQ}
                placeholder="Search code, business, contact, or email…"
                aria-label="Search vendors"
              />
            </div>
            <DataTable
              rows={[...vendors]
                .filter((v) => v.active || showInactive)
                .filter((v) => {
                  const q = vendorQ.trim().toLowerCase();
                  if (!q) return true;
                  return `${v.code} ${v.businessName} ${v.contactName || ""} ${v.email} ${v.phone || ""}`.toLowerCase().includes(q);
                })
                .sort((a, b) => Number(!!a.active) - Number(!!b.active) || Number(!!b.portalLocked) - Number(!!a.portalLocked))}
              columns={[
                {
                  key: "code",
                  header: "Code",
                  width: "84px",
                  sortBy: (v) => v.code,
                  cell: (v) => <span className="mono">{v.code}</span>,
                },
                {
                  key: "business",
                  header: "Business",
                  primary: true,
                  sortBy: (v) => v.businessName,
                  cell: (v) => (
                    <div className="stack g-1" style={{ minWidth: 0 }}>
                      <b className="truncate">{v.businessName}</b>
                      <span className="t-xs t-muted truncate">
                        {[v.contactName, v.email].filter(Boolean).join(" · ")}
                      </span>
                    </div>
                  ),
                },
                {
                  key: "commission",
                  header: "Commission",
                  align: "right",
                  hideBelow: 900,
                  sortBy: (v) => v.commissionPercent,
                  cell: (v) => <span className="num">{v.commissionPercent}%</span>,
                },
                {
                  key: "balance",
                  header: "Balance",
                  align: "right",
                  sortBy: (v) => v.balance,
                  cell: (v) => (
                    <span className={`num ${v.balance >= 0 ? "t-accent" : "t-danger"}`}>{money(v.balance)}</span>
                  ),
                },
                {
                  key: "status",
                  header: "Status",
                  sortBy: (v) => (!v.active ? 2 : v.portalLocked ? 1 : 0),
                  cell: (v) =>
                    !v.active ? (
                      <Badge tone="neutral" dot>Deactivated</Badge>
                    ) : v.portalLocked ? (
                      <Badge tone="warn" dot>Onboarding</Badge>
                    ) : (
                      <Badge tone="success" dot>Active</Badge>
                    ),
                },
              ]}
              rowKey={(v) => v.id}
              loading={!overview && vendors.length === 0}
              skeletonRows={5}
              mobileCards
              caption="Vendors, balances, and account status"
              onRowClick={(v) => { setVendorOpen(v.id); setEditV(null); }}
              empty={
                vendorQ.trim() ? (
                  <EmptyState
                    icon="search"
                    title="No vendors match that search"
                    body="Try a vendor code, business name, contact, or email address."
                    action={<Button variant="secondary" onClick={() => setVendorQ("")}>Clear search</Button>}
                  />
                ) : (
                  <EmptyState
                    icon="store"
                    title="No vendors yet"
                    body="Add your first vendor below — they'll get a welcome email with a temporary password."
                  />
                )
              }
            />
          </Card>

          {/* Vendor detail slide-over — everything you can do to one vendor. */}
          {(() => {
            const v = vendors.find((x) => x.id === vendorOpen);
            if (!v) return null;
            return (
              <Panel
                open
                onClose={() => { setVendorOpen(null); setEditV(null); }}
                title={v.businessName}
                subtitle={`${v.code} · ${v.commissionPercent}% commission`}
                actions={v.applicationId ? (
                  <a className="btn btn-ghost btn-sm" href={`/admin/applications/${v.applicationId}/print`} target="_blank" rel="noopener">
                    <Icon name="clipboard" size={14} /> Application
                  </a>
                ) : undefined}
              >
                <div className="stack g-5">
                  <div className="row wrap g-2">
                    {v.active ? <Badge tone="success" dot>Active</Badge> : <Badge tone="neutral" dot>Deactivated</Badge>}
                    {v.portalLocked ? <Badge tone="warn" dot>Onboarding</Badge> : null}
                    <Badge tone={v.allowSelfCheckout ? "info" : "neutral"} dot>
                      {v.allowSelfCheckout ? "Self-checkout on" : "Self-checkout off"}
                    </Badge>
                  </div>

                  {v.portalLocked ? (
                    <Note tone="warn" title="Their portal is locked until onboarding finishes">
                      {!v.hasSignedContract
                        ? "Their booth agreement still needs a signature."
                        : "Their first month's rent hasn't been paid yet."}{" "}
                      The lock lifts on its own once that's done.
                    </Note>
                  ) : null}

                  <DescList
                    items={[
                      { label: "Code", value: <span className="mono">{v.code}</span> },
                      { label: "Contact", value: v.contactName || "—" },
                      { label: "Commission", value: `${v.commissionPercent}%` },
                      {
                        label: "Balance",
                        value: <span className={`num ${v.balance >= 0 ? "t-accent" : "t-danger"}`}>{money(v.balance)}</span>,
                      },
                    ]}
                  />

                  {/* Left-aligned in its own block rather than squeezed into the
                      right-hand column of the list — these are buttons, not values. */}
                  <div className="stack g-2">
                    <p className="t-label">Get hold of them</p>
                    <EmailAction email={v.email} name={v.contactName || v.businessName} />
                    <PhoneActions phone={v.phone} name={v.contactName || v.businessName} />
                  </div>

                  <div className="stack g-2">
                    <p className="t-label">Ledger</p>
                    <div className="row wrap g-2">
                      <Button size="sm" icon="receipt" disabled={busy} onClick={() => ledgerEntry(v, "RENT")}>Charge rent</Button>
                      <Button size="sm" icon="checkCircle" disabled={busy} onClick={() => ledgerEntry(v, "RENT_PAYMENT", Math.max(0, -v.balance))}>Record payment</Button>
                      <Button size="sm" icon="cash" disabled={busy} onClick={() => ledgerEntry(v, "PAYOUT")}>Record payout</Button>
                      <Button size="sm" icon="edit" disabled={busy} onClick={() => ledgerEntry(v, "ADJUST")}>Adjust balance</Button>
                    </div>
                  </div>

                  <div className="stack g-2">
                    <p className="t-label">Account</p>
                    <div className="row wrap g-2">
                      <Button
                        size="sm"
                        icon="tag"
                        disabled={busy}
                        onClick={async () => {
                          const c = await dialog.prompt({
                            title: `Commission for ${v.businessName}`,
                            body: "The market's share of each of their sales. New sales use the new rate; sales already rung up keep the rate they were sold at.",
                            label: "Commission %",
                            type: "number",
                            defaultValue: String(v.commissionPercent),
                            required: true,
                            confirmLabel: "Save commission",
                            validate: (x) => {
                              const n = Number(x);
                              return !Number.isFinite(n) || n < 0 || n > 50 ? "Enter a number between 0 and 50." : null;
                            },
                          });
                          if (c !== null) patchVendor(v.id, { commissionPercent: c }, `Commission set to ${c}%`);
                        }}
                      >
                        Change commission
                      </Button>
                      <Button
                        size="sm"
                        icon="scan"
                        disabled={busy}
                        onClick={() => patchVendor(
                          v.id,
                          { allowSelfCheckout: !v.allowSelfCheckout },
                          v.allowSelfCheckout ? "Self-checkout turned off" : "Self-checkout turned on"
                        )}
                      >
                        {v.allowSelfCheckout ? "Turn off self-checkout" : "Turn on self-checkout"}
                      </Button>
                      <Button
                        size="sm"
                        icon="refresh"
                        disabled={busy}
                        onClick={async () => {
                          const yes = await dialog.confirm({
                            title: `Reset ${v.businessName}'s password?`,
                            body: "Their current password stops working straight away. A new temporary one is emailed to them and shown to you once.",
                            confirmLabel: "Reset password",
                            cancelLabel: "Keep it",
                            tone: "warn",
                          });
                          if (yes) patchVendor(v.id, { resetPassword: true });
                        }}
                      >
                        Reset password
                      </Button>
                      <Button
                        size="sm"
                        icon="edit"
                        disabled={busy}
                        onClick={() => {
                          if (editV === v.id) { setEditV(null); return; }
                          setEditV(v.id);
                          setEditF({ businessName: v.businessName, contactName: v.contactName || "", email: v.email, phone: v.phone || "" });
                        }}
                      >
                        {editV === v.id ? "Cancel editing" : "Edit details"}
                      </Button>
                      {v.active ? (
                        <Button
                          size="sm"
                          variant="danger"
                          icon="lock"
                          disabled={busy}
                          onClick={async () => {
                            const yes = await dialog.confirm({
                              title: `Deactivate ${v.businessName}?`,
                              body: "They lose access to the vendor portal and drop off the list of sellable vendors. Their sales history, balance and items all stay — you can reactivate them any time.",
                              confirmLabel: "Deactivate vendor",
                              cancelLabel: "Leave active",
                              tone: "danger",
                            });
                            if (yes) patchVendor(v.id, { active: false }, `${v.businessName} deactivated`);
                          }}
                        >
                          Deactivate
                        </Button>
                      ) : (
                        <Button
                          size="sm"
                          icon="unlock"
                          disabled={busy}
                          onClick={() => patchVendor(v.id, { active: true }, `${v.businessName} reactivated`)}
                        >
                          Reactivate
                        </Button>
                      )}
                    </div>
                  </div>

                  {editV === v.id ? (
                    <div className="stack g-3">
                      <p className="t-label">Edit details</p>
                      <Field label="Business name">
                        {(p) => <Input {...p} value={editF.businessName} onChange={(e) => setEditF((f) => ({ ...f, businessName: e.target.value }))} />}
                      </Field>
                      <Field label="Contact name">
                        {(p) => <Input {...p} value={editF.contactName} onChange={(e) => setEditF((f) => ({ ...f, contactName: e.target.value }))} />}
                      </Field>
                      <Field label="Email" hint="Their login, and where agreements, guides and alerts go.">
                        {(p) => <Input {...p} type="email" value={editF.email} onChange={(e) => setEditF((f) => ({ ...f, email: e.target.value }))} />}
                      </Field>
                      <Field label="Phone">
                        {(p) => <Input {...p} type="tel" value={editF.phone} onChange={(e) => setEditF((f) => ({ ...f, phone: e.target.value }))} />}
                      </Field>
                      <div className="row g-2">
                        <Button
                          variant="primary"
                          loading={busy}
                          onClick={async () => {
                            await patchVendor(v.id, { businessName: editF.businessName.trim(), contactName: editF.contactName.trim(), email: editF.email.trim(), phone: editF.phone.trim() }, "Vendor details saved");
                            setEditV(null);
                          }}
                        >
                          Save changes
                        </Button>
                        <Button variant="ghost" onClick={() => setEditV(null)}>Cancel</Button>
                      </div>
                    </div>
                  ) : null}
                </div>
              </Panel>
            );
          })()}

          {/* Applications as a pipeline: pick a stage, scan the list, open one
              to read it in full and decide. */}
          <Card
            className="mb-4"
            title="Vendor applications"
            subtitle="Hopefuls apply at market.dailybreadbaked.com/apply. Call notes, viewings and agreements live in the full workspace."
            actions={
              <a className="btn btn-secondary btn-sm" href="/admin/applications">
                <Icon name="inbox" size={14} /> Open workspace
                {applications.filter((a) => a.status === "PENDING").length > 0
                  ? ` (${applications.filter((a) => a.status === "PENDING").length} pending)`
                  : ""}
              </a>
            }
          >
            <div className="toolbar">
              <Segmented
                value={appFilter}
                onChange={setAppFilter}
                label="Application status"
                options={[
                  { value: "PENDING", label: `Pending (${applications.filter((a) => a.status === "PENDING").length})` },
                  { value: "ACCEPTED", label: `Accepted (${applications.filter((a) => a.status === "ACCEPTED").length})` },
                  { value: "DECLINED", label: `Declined (${applications.filter((a) => a.status === "DECLINED").length})` },
                ]}
              />
              <SearchInput
                className="grow"
                value={appQ}
                onValueChange={setAppQ}
                placeholder="Search business, contact, email, or category…"
                aria-label="Search applications"
              />
            </div>
            <DataTable
              rows={applications
                .filter((a) => a.status === appFilter)
                .filter((a) => {
                  const q = appQ.trim().toLowerCase();
                  if (!q) return true;
                  return `${a.businessName} ${a.contactName} ${a.email} ${a.phone} ${a.category} ${a.products}`.toLowerCase().includes(q);
                })}
              columns={[
                {
                  key: "business",
                  header: "Business",
                  primary: true,
                  sortBy: (a) => a.businessName,
                  cell: (a) => (
                    <div className="stack g-1" style={{ minWidth: 0 }}>
                      <b className="truncate">{a.businessName}</b>
                      <span className="t-xs t-muted truncate">{[a.contactName, a.email].filter(Boolean).join(" · ")}</span>
                    </div>
                  ),
                },
                {
                  key: "category",
                  header: "Category",
                  hideBelow: 900,
                  sortBy: (a) => a.category,
                  cell: (a) => a.category || "—",
                },
                {
                  key: "applied",
                  header: "Applied",
                  sortBy: (a) => a.createdAt,
                  cell: (a) => <span title={fmtDateTime(a.createdAt)}>{relTime(a.createdAt)}</span>,
                },
                {
                  key: "status",
                  header: "Status",
                  sortBy: (a) => a.status,
                  cell: (a) =>
                    a.status === "PENDING" ? (
                      <Badge tone="warn" dot>Pending</Badge>
                    ) : a.status === "ACCEPTED" ? (
                      <Badge tone="success" dot>Accepted</Badge>
                    ) : (
                      <Badge tone="neutral" dot>Declined</Badge>
                    ),
                },
              ]}
              rowKey={(a) => a.id}
              loading={!overview && applications.length === 0}
              skeletonRows={3}
              mobileCards
              caption="Vendor applications by status"
              defaultSort={{ key: "applied", dir: "desc" }}
              onRowClick={(a) => setAppOpen(a.id)}
              empty={
                appQ.trim() ? (
                  <EmptyState
                    icon="search"
                    title="No applications match that search"
                    body="Try a business name, contact, email, or category."
                    action={<Button variant="secondary" onClick={() => setAppQ("")}>Clear search</Button>}
                  />
                ) : (
                  <EmptyState
                    icon="inbox"
                    title={
                      appFilter === "PENDING"
                        ? "Nothing waiting on you"
                        : appFilter === "ACCEPTED"
                          ? "No accepted applications yet"
                          : "No declined applications"
                    }
                    body={
                      appFilter === "PENDING"
                        ? "New applications from market.dailybreadbaked.com/apply land here."
                        : "Switch stages above to see the rest of the pipeline."
                    }
                  />
                )
              }
            />
          </Card>

          {/* Full application, with the decision at the bottom where it belongs. */}
          {(() => {
            const a = applications.find((x) => x.id === appOpen);
            if (!a) return null;
            return (
              <Panel
                open
                onClose={() => setAppOpen(null)}
                title={a.businessName}
                subtitle={`Applied ${fmtDate(a.createdAt)}`}
                actions={
                  <a className="btn btn-ghost btn-sm" href={`/admin/applications/${a.id}/print`} target="_blank" rel="noopener">
                    <Icon name="print" size={14} /> Print
                  </a>
                }
                footer={a.status === "PENDING" ? (
                  <>
                    <Button variant="dangerSoft" disabled={busy} onClick={() => decideApplication(a.id, "decline", a.businessName)}>
                      Decline
                    </Button>
                    <Button variant="primary" icon="check" disabled={busy} onClick={() => decideApplication(a.id, "accept", a.businessName)}>
                      Accept application
                    </Button>
                  </>
                ) : undefined}
              >
                <div className="stack g-5">
                  <div className="row wrap g-2">
                    {a.status === "PENDING" ? (
                      <Badge tone="warn" dot>Pending</Badge>
                    ) : a.status === "ACCEPTED" ? (
                      <Badge tone="success" dot>Accepted</Badge>
                    ) : (
                      <Badge tone="neutral" dot>Declined</Badge>
                    )}
                    {a.stage ? <Badge tone="info" dot>Stage: {a.stage.charAt(0) + a.stage.slice(1).toLowerCase()}</Badge> : null}
                  </div>

                  <DescList
                    items={[
                      { label: "Contact", value: a.contactName || "—" },
                      { label: "Category", value: a.category || "—" },
                      { label: "Booth request", value: a.boothRequest || "—" },
                      { label: "Availability", value: a.availability || "—" },
                      { label: "Heard from", value: a.heardFrom || "—" },
                      { label: "Viewing", value: a.viewingAt || "Not booked" },
                    ]}
                  />

                  <div className="stack g-2">
                    <p className="t-label">Get hold of them</p>
                    <EmailAction email={a.email} name={a.contactName || a.businessName} />
                    <PhoneActions phone={a.phone} name={a.contactName || a.businessName} />
                    {a.phone && a.phoneType ? (
                      <span className="t-xs t-muted">That&rsquo;s a {a.phoneType.toLowerCase()} number.</span>
                    ) : null}
                  </div>

                  <div className="stack g-3">
                    <p className="t-label">What they sell</p>
                    <p className="t-sm">{a.products || "—"}</p>
                    <DescList
                      items={[
                        { label: "Made by them", value: a.madeByYou || "—" },
                        { label: "Links", value: a.links || "—" },
                        { label: "Licences", value: a.licenses || "—" },
                        { label: "Insurance", value: a.insurance || "—" },
                      ]}
                    />
                  </div>

                  {a.notes ? (
                    <div className="stack g-2">
                      <p className="t-label">Their notes</p>
                      <p className="t-sm">{a.notes}</p>
                    </div>
                  ) : null}

                  {a.adminNotes ? (
                    <div className="stack g-2">
                      <p className="t-label">Your notes</p>
                      <p className="t-sm">{a.adminNotes}</p>
                    </div>
                  ) : null}

                  {a.status === "PENDING" ? (
                    <Note tone="info">
                      Accepting emails them a welcome note; declining emails them too, with anything you write in the box.
                    </Note>
                  ) : null}
                </div>
              </Panel>
            );
          })()}

          <Card
            className="mb-4"
            title="Complaints"
            subtitle="Every complaint filed against any vendor, newest first. Vendors handle the replies; this is your oversight view."
          >
            {!overview && complaints.length === 0 ? (
              <div className="stack g-3">
                <Skeleton height={14} width="45%" />
                <Skeleton height={14} width="70%" />
                <Skeleton height={14} width="60%" />
              </div>
            ) : complaints.length === 0 ? (
              <EmptyState
                icon="message"
                title="No complaints on file"
                body="Anything a customer files against a vendor shows up here."
              />
            ) : (
              <ul className="stack g-4" style={{ listStyle: "none" }}>
                {complaints.map((c) => (
                  <li key={c.id} className="stack g-2" style={{ paddingBottom: "var(--sp-4)", borderBottom: "1px solid var(--border)" }}>
                    <div className="row between wrap g-2">
                      <b>{c.vendor ? `${c.vendor.code} · ${c.vendor.businessName}` : "Unknown vendor"}</b>
                      <Badge tone={c.status === "CLOSED" ? "neutral" : "warn"} dot>
                        {c.status.charAt(0) + c.status.slice(1).toLowerCase()}
                      </Badge>
                    </div>
                    <div className="stack g-2">
                      <p className="t-xs t-muted">From {c.customerName}</p>
                      {/* The customer who complained is the one person you most
                          want to reach, so reaching them is one tap. */}
                      <div className="row wrap g-3">
                        <EmailAction email={c.email} name={c.customerName} />
                        <PhoneActions phone={c.phone} name={c.customerName} />
                      </div>
                    </div>
                    {c.messages.map((m, i) => (
                      <p key={i} className="t-sm" style={{ paddingLeft: "var(--sp-3)", borderLeft: "2px solid var(--border)" }}>
                        <b>{m.sender === "CUSTOMER" ? c.customerName : "Vendor"}:</b> {m.body}
                      </p>
                    ))}
                  </li>
                ))}
              </ul>
            )}
          </Card>

          {/* Reviews, with the ability to take one down. There was no way to do
              this at all before — a review posted to a vendor's public page was
              permanent, whatever it said. Vendors deliberately can't reach
              this: a vendor who deletes their own bad reviews makes every other
              rating on the site worthless. */}
          <Card
            className="mb-4"
            title="Reviews"
            subtitle="Every review left on any vendor's page, newest first. Removing one is permanent and goes in the activity log."
            actions={
              <Button size="sm" variant="ghost" icon="refresh" onClick={() => void loadReviews()}>
                Refresh
              </Button>
            }
          >
            {reviews.length === 0 ? (
              <EmptyState
                icon="star"
                title="No reviews yet"
                body="Anything a shopper leaves on a vendor's page turns up here."
              />
            ) : (
              <ul className="stack g-4" style={{ listStyle: "none" }}>
                {reviews.map((rv) => (
                  <li key={rv.id} className="stack g-2" style={{ paddingBottom: "var(--sp-4)", borderBottom: "1px solid var(--border)" }}>
                    <div className="row between wrap g-2">
                      <b>{rv.vendor ? `${rv.vendor.code} · ${rv.vendor.businessName}` : "Unknown vendor"}</b>
                      <Badge tone={rv.rating <= 2 ? "danger" : rv.rating === 3 ? "warn" : "success"}>
                        {rv.rating}/5
                      </Badge>
                    </div>
                    <p className="t-xs t-muted">
                      {rv.name || "No name given"} · {relTime(rv.createdAt)}
                      {rv.likes ? ` · ${plural(rv.likes, "like")}` : ""}
                    </p>
                    <p className="t-sm" style={{ paddingLeft: "var(--sp-3)", borderLeft: "2px solid var(--border)" }}>
                      {rv.body}
                    </p>

                    {rv.comments.map((c) => (
                      <div key={c.id} className="row between wrap g-2" style={{ paddingLeft: "var(--sp-5)" }}>
                        <p className="t-sm t-muted grow" style={{ margin: 0 }}>
                          <b>{c.name || "No name"}:</b> {c.body}
                        </p>
                        <Button size="sm" variant="ghost" onClick={() => void removeReviewComment(c)}>
                          Remove reply
                        </Button>
                      </div>
                    ))}

                    <div className="row g-2">
                      <Button size="sm" variant="danger" icon="trash" onClick={() => void removeReview(rv)}>
                        Remove review
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card title="Add a vendor" subtitle="They get a welcome email with a temporary password as soon as you save.">
            <div className="stack g-4 content-narrow">
              <Field label="Business name" required>
                {(p) => <Input {...p} value={vName} onChange={(e) => setVName(e.target.value)} placeholder="Prairie Rose Candle Co." />}
              </Field>
              <Field label="Contact name">
                {(p) => <Input {...p} value={vContact} onChange={(e) => setVContact(e.target.value)} />}
              </Field>
              <Field label="Email" hint="Their login — the welcome email goes here." required>
                {(p) => <Input {...p} type="email" value={vEmail} onChange={(e) => setVEmail(e.target.value)} />}
              </Field>
              <Field label="Phone">
                {(p) => <Input {...p} type="tel" value={vPhone} onChange={(e) => setVPhone(e.target.value)} />}
              </Field>
              <Field label="Commission %" hint="0 for none — you can change this any time.">
                {(p) => <Input {...p} value={vComm} onChange={(e) => setVComm(e.target.value)} type="number" min="0" max="50" step="0.5" />}
              </Field>
              {vMsg ? <Note tone={vMsg.includes("Added") ? "success" : "error"}>{vMsg}</Note> : null}
              <div>
                <Button variant="primary" icon="plus" loading={busy} onClick={addVendor}>
                  Add vendor and send welcome email
                </Button>
              </div>
            </div>
          </Card>
        </>
      )}

      {tab === "onboarding" && allowed("market") && (
        <>
          {/* Said plainly and up front, because "accepted" and "live" are not
              the same thing and the difference is invisible from this screen. */}
          <Note tone="info" title="Nobody on this list is live to shoppers yet">
            Vendors here don&rsquo;t appear on the market page, their vendor page, or self-checkout.
            They go live automatically once the agreement is signed and the first month is paid.
          </Note>

          <div className="grid-auto mt-4" style={{ ["--min" as string]: "200px" }}>
            <Stat
              feature
              label="Onboarding"
              value={String(onboarding.length)}
              sub={onbStuck > 0 ? `${onbStuck} waiting over 2 weeks` : "Accepted, not live yet"}
              icon="user"
            />
            <Stat
              label="Waiting on a signature"
              value={String(onbWaitingSignature)}
              sub="Their move"
              icon="contract"
            />
            <Stat
              label="Waiting on you"
              value={String(onbWaitingCountersign)}
              sub="Signed — needs countersigning"
              icon="edit"
            />
            <Stat
              label="Waiting on first rent"
              value={String(onbWaitingRent)}
              sub="Executed, not paid"
              icon="dollar"
            />
          </div>

          <Card
            className="mt-4"
            title="Waiting to go live"
            subtitle="Oldest first. Open anyone to see the checklist and chase them."
            actions={
              <Button
                size="sm"
                icon="mail"
                disabled={busy || onbUnsigned === 0}
                title={onbUnsigned === 0 ? "Nobody is sitting on an unsigned agreement" : undefined}
                onClick={remindAllUnsigned}
              >
                Remind everyone unsigned
              </Button>
            }
          >
            {/* When the list is empty the error lives in the empty state, so this
                only covers a failed refresh over rows that are already on screen. */}
            {onbErr && onboarding.length > 0 ? (
              <div className="mb-4">
                <Note
                  tone="error"
                  title="This list may be out of date"
                  action={<Button size="sm" variant="secondary" icon="refresh" onClick={loadOnboarding}>Try again</Button>}
                >
                  {onbErr}
                </Note>
              </div>
            ) : null}

            <DataTable
              rows={onboarding}
              columns={[
                {
                  key: "vendor",
                  header: "Vendor",
                  primary: true,
                  sortBy: (o) => o.businessName,
                  cell: (o) => (
                    <div className="stack g-1" style={{ minWidth: 0 }}>
                      <b className="truncate">{o.businessName}</b>
                      <span className="t-xs t-muted truncate">{o.code}{o.contactName ? ` · ${o.contactName}` : ""}</span>
                    </div>
                  ),
                },
                {
                  key: "booth",
                  header: "Booth",
                  sortBy: (o) => o.contract?.boothLabel || "",
                  cell: (o) =>
                    o.contract
                      ? <span>Booth {o.contract.boothLabel}</span>
                      : <span className="t-muted">Not assigned</span>,
                },
                {
                  key: "waiting",
                  header: "Waiting",
                  sortBy: (o) => o.daysWaiting,
                  cell: (o) =>
                    o.daysWaiting > 14 ? (
                      <Badge tone="warn" icon="warning">{plural(o.daysWaiting, "day")}</Badge>
                    ) : (
                      <span className="num t-muted">{plural(o.daysWaiting, "day")}</span>
                    ),
                },
                {
                  key: "next",
                  header: "Waiting on",
                  sortBy: (o) => o.nextStepLabel,
                  cell: (o) => (
                    <Badge
                      tone={
                        o.nextStep === null ? "success"
                          : o.daysWaiting > 14 ? "warn"
                            : o.nextStep === "countersign" ? "info"
                              : "neutral"
                      }
                      dot
                    >
                      {o.nextStepLabel}
                    </Badge>
                  ),
                },
              ]}
              rowKey={(o) => o.vendorId}
              loading={onbLoading && onboarding.length === 0}
              skeletonRows={4}
              mobileCards
              defaultSort={{ key: "waiting", dir: "desc" }}
              caption="Accepted vendors who aren't live yet, and what each is waiting on"
              onRowClick={(o) => setOnbOpen(o.vendorId)}
              empty={
                onbErr ? (
                  <EmptyState
                    icon="alert"
                    title="The list didn't load"
                    body="Nothing here is missing — the server just didn't answer. Try again."
                    action={<Button variant="secondary" icon="refresh" onClick={loadOnboarding}>Try again</Button>}
                  />
                ) : (
                  <EmptyState
                    icon="checkCircle"
                    title="Everyone's live"
                    body="No accepted vendor is waiting on a signature, a countersignature, or a first month's rent."
                  />
                )
              }
            />
          </Card>

          {/* Onboarding detail slide-over — who they are, what's left, what to send. */}
          {(() => {
            const o = onboarding.find((x) => x.vendorId === onbOpen);
            if (!o) return null;
            const c = o.contract;
            return (
              <Panel
                open
                onClose={() => setOnbOpen(null)}
                title={o.businessName}
                subtitle={`${o.code}${c ? ` · booth ${c.boothLabel}` : " · no booth yet"}`}
                actions={c ? (
                  <a className="btn btn-ghost btn-sm" href={`/contract/${c.id}/packet`} target="_blank" rel="noopener">
                    <Icon name="print" size={14} /> Packet
                  </a>
                ) : undefined}
              >
                <div className="stack g-5">
                  <div className="row wrap g-2">
                    <Badge
                      tone={
                        o.nextStep === null ? "success"
                          : o.daysWaiting > 14 ? "warn"
                            : o.nextStep === "countersign" ? "info"
                              : "neutral"
                      }
                      dot
                    >
                      {o.nextStepLabel}
                    </Badge>
                    <Badge tone={o.daysWaiting > 14 ? "warn" : "neutral"} dot>
                      {plural(o.daysWaiting, "day")} waiting
                    </Badge>
                    <Badge tone="neutral" dot>Not live to shoppers</Badge>
                  </div>

                  <div className="stack g-2">
                    <EmailAction email={o.email} name={o.contactName || o.businessName} />
                    <PhoneActions phone={o.phone} name={o.contactName || o.businessName} />
                    {o.contactName ? (
                      <span className="row g-2 t-sm t-muted" style={{ minHeight: 32 }}>
                        <Icon name="user" size={14} />{o.contactName}
                      </span>
                    ) : null}
                  </div>

                  {/* The whole point of the tab: three steps, in order, with the
                      reason each one is still open written underneath it. */}
                  <div className="stack g-2">
                    <p className="t-label">What&rsquo;s left</p>
                    <ol className="stack g-3" style={{ listStyle: "none", margin: 0, padding: 0 }}>
                      {o.steps.map((s) => (
                        <li key={s.key} className="row-top g-3">
                          {s.done ? (
                            <span className="shrink0 t-accent" style={{ display: "flex", marginTop: 1 }}>
                              <Icon name="checkCircle" size={18} />
                            </span>
                          ) : (
                            <span
                              aria-hidden
                              className="shrink0"
                              style={{
                                display: "block", width: 18, height: 18, marginTop: 1,
                                borderRadius: "50%", border: "2px solid var(--border)",
                              }}
                            />
                          )}
                          <div className="stack g-1" style={{ minWidth: 0 }}>
                            <span className={`t-sm${s.done ? " t-muted" : ""}`} style={{ fontWeight: s.done ? 400 : 600 }}>
                              {s.label}
                            </span>
                            <span className="sr-only">{s.done ? "Done" : "Not done yet"}</span>
                            {s.detail ? <span className="t-xs t-muted">{s.detail}</span> : null}
                          </div>
                        </li>
                      ))}
                    </ol>
                  </div>

                  <DescList
                    items={[
                      { label: "Accepted", value: fmtDate(o.createdAt) },
                      { label: "Booth", value: c ? `Booth ${c.boothLabel}` : "Not assigned yet" },
                      { label: "Monthly rent", value: c ? <span className="num">{money(c.monthlyRentCents)}</span> : "—" },
                      { label: "Starts", value: c ? fmtDate(c.startDate) : "—" },
                      { label: "Agreement sent", value: c ? (c.sent ? "Yes" : "Not sent yet") : "No agreement yet" },
                      ...(c && !c.vendorSignedAt
                        ? [{
                            label: "Opened by vendor",
                            /* Date AND time — "they opened it" is only useful
                               if you can see whether that was an hour ago or
                               three weeks ago. */
                            value: c.viewedAt ? (
                              <span>
                                {fmtDateTime(c.viewedAt)}
                                <span className="t-muted"> · {relTime(c.viewedAt)}</span>
                              </span>
                            ) : "Not opened yet",
                          }]
                        : []),
                      { label: "They signed", value: c?.vendorSignedAt ? fmtDate(c.vendorSignedAt) : "Not yet" },
                      { label: "You signed", value: c?.marketSignedAt ? fmtDate(c.marketSignedAt) : "Not yet" },
                      {
                        label: "Owes",
                        value: <span className={`num ${o.owesCents > 0 ? "t-danger" : "t-accent"}`}>{money(o.owesCents)}</span>,
                      },
                      { label: "Card on file", value: o.cardLast4 ? `•••• ${o.cardLast4}` : "None" },
                    ]}
                  />

                  <div className="stack g-2">
                    <p className="t-label">Actions</p>
                    {c ? (
                      <div className="row wrap g-2">
                        {!c.vendorSignedAt ? (
                          <>
                            <Button
                              size="sm"
                              variant="primary"
                              icon="mail"
                              disabled={busy}
                              onClick={() => sendAgreementReminder(c.id, o.businessName)}
                            >
                              Send reminder
                            </Button>
                            {c.signToken ? (
                              <Button
                                size="sm"
                                variant="secondary"
                                icon="copy"
                                disabled={busy}
                                onClick={() => copySigningLink(c.signToken || "", o.businessName)}
                              >
                                Copy signing link
                              </Button>
                            ) : null}
                            <Button
                              size="sm"
                              icon="edit"
                              disabled={busy}
                              onClick={() => openTerms(
                                { id: c.id, businessName: o.businessName, boothLabel: c.boothLabel, monthlyRentCents: c.monthlyRentCents, startDate: c.startDate },
                                "update_terms"
                              )}
                            >
                              Edit terms
                            </Button>
                          </>
                        ) : null}
                        <Button
                          size="sm"
                          variant="ghost"
                          icon="contract"
                          onClick={() => { setOnbOpen(null); go("contracts"); setContractOpen(c.id); }}
                        >
                          Open the agreement
                        </Button>
                      </div>
                    ) : (
                      <Note tone="warn" title="No agreement yet">
                        Nothing has been sent to {o.businessName} to sign. Create their booth agreement
                        under Agreements — they get the signing link as soon as you do.
                      </Note>
                    )}
                  </div>
                </div>
              </Panel>
            );
          })()}
        </>
      )}

      {tab === "calendar" && allowed("market") && (
        <>
          {/* The month grid is hand-built, so its geometry lives here rather
              than in globals.css — nothing else in the app renders a calendar.
              Under 700px the chips collapse to dots: seven readable columns
              won't fit on a phone, but seven tappable ones will. */}
          <style>{`
            .cal-grid { display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); gap: 4px; }
            .cal-dow {
              text-align: center; padding: var(--sp-1) 0;
              font-size: var(--fs-xs); font-weight: 600; color: var(--text-muted);
            }
            .cal-cell {
              position: relative; min-height: 122px; overflow: hidden;
              border: 1px solid var(--border-subtle); border-radius: var(--r-md);
              background: var(--surface);
            }
            .cal-cell[data-out="true"] { background: var(--bg-sunken); }
            .cal-cell[data-out="true"] .cal-daynum { color: var(--text-muted); opacity: 0.6; }
            .cal-cell[data-today="true"] {
              background: var(--accent-soft);
              border-color: transparent;
              box-shadow: inset 0 0 0 2px var(--accent);
            }
            .cal-cell[data-today="true"] .cal-daynum { color: var(--accent-text); font-weight: 800; }
            .cal-add {
              position: absolute; inset: 0; width: 100%; height: 100%;
              border: 0; background: none; cursor: pointer; border-radius: inherit;
            }
            .cal-add:hover { background: var(--surface-hover); }
            .cal-cell[data-today="true"] .cal-add:hover { background: transparent; }
            .cal-add:focus-visible { outline: 2px solid var(--accent); outline-offset: -3px; }
            .cal-body {
              position: relative; pointer-events: none;
              display: flex; flex-direction: column; gap: 3px;
              padding: 4px; height: 100%;
            }
            .cal-daynum {
              padding: 0 2px; font-size: var(--fs-xs); font-weight: 600;
              color: var(--text-secondary); font-variant-numeric: tabular-nums;
            }
            .cal-chips { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
            .cal-chip, .cal-more {
              pointer-events: auto; cursor: pointer; font-family: inherit;
              display: flex; align-items: center; gap: 4px;
              width: 100%; min-width: 0; min-height: 21px;
              padding: 2px 4px; border: 0; border-radius: var(--r-sm);
              font-size: var(--fs-xs); line-height: 1.25; text-align: left;
            }
            .cal-chip:focus-visible, .cal-more:focus-visible,
            .cal-dots:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
            .cal-chip[data-off="true"] { text-decoration: line-through; opacity: 0.55; }
            .cal-chip-time { flex: 0 0 auto; font-variant-numeric: tabular-nums; opacity: 0.85; }
            .cal-more {
              background: none; color: var(--text-secondary); font-weight: 600;
            }
            .cal-more:hover { background: var(--surface-active); }
            .cal-dots { display: none; }
            @media (max-width: 700px) {
              .cal-grid { gap: 3px; }
              .cal-cell { min-height: 60px; }
              .cal-chips { display: none; }
              .cal-dots {
                pointer-events: auto; cursor: pointer;
                display: flex; flex-wrap: wrap; align-items: center; gap: 3px;
                width: 100%; min-height: 28px; padding: 2px;
                border: 0; background: none; border-radius: var(--r-sm);
              }
              .cal-dot { display: block; flex: 0 0 auto; width: 6px; height: 6px; border-radius: var(--r-full); }
              .cal-dotnum { font-size: var(--fs-xs); font-weight: 700; color: var(--text-secondary); }
            }
          `}</style>

          {/* Free-text viewings from before this screen existed. Offered once,
              at the top, rather than hidden behind a settings page. */}
          {calPending > 0 ? (
            <div className="mb-4">
              <Note
                tone="warn"
                title="Some viewings aren't on this calendar yet"
                action={
                  <Button
                    size="sm"
                    variant="primary"
                    icon="download"
                    loading={calImporting}
                    onClick={previewLegacyImport}
                  >
                    Import them
                  </Button>
                }
              >
                {plural(calPending, "viewing")} {calPending === 1 ? "was" : "were"} typed
                as free text before this calendar existed.
              </Note>
            </div>
          ) : null}

          {/* When there's nothing on screen the error lives in the empty state,
              so this only covers a failed refresh over events already shown. */}
          {calErr && calEvents.length > 0 ? (
            <div className="mb-4">
              <Note
                tone="error"
                title="This calendar may be out of date"
                action={<Button size="sm" variant="secondary" icon="refresh" onClick={loadCalendar}>Try again</Button>}
              >
                {calErr}
              </Note>
            </div>
          ) : null}

          <Card
            title={
              calView === "month"
                ? calMonth.toLocaleDateString("en-US", { month: "long", year: "numeric" })
                : calWhen === "upcoming" ? "Coming up" : "Already happened"
            }
            subtitle={
              calView === "month"
                ? `${plural(calMonthCount, "event")} this month`
                : `Loaded around ${calMonth.toLocaleDateString("en-US", { month: "long", year: "numeric" })} — use the arrows for other months.`
            }
            actions={
              <div className="row wrap g-2">
                <div className="row g-1 shrink0">
                  <IconButton
                    icon="chevronLeft"
                    label="Previous month"
                    size="sm"
                    onClick={() => setCalMonth((m) => new Date(m.getFullYear(), m.getMonth() - 1, 1))}
                  />
                  <Button
                    size="sm"
                    onClick={() => { const n = new Date(); setCalMonth(new Date(n.getFullYear(), n.getMonth(), 1)); }}
                  >
                    Today
                  </Button>
                  <IconButton
                    icon="chevronRight"
                    label="Next month"
                    size="sm"
                    onClick={() => setCalMonth((m) => new Date(m.getFullYear(), m.getMonth() + 1, 1))}
                  />
                </div>
                <Segmented
                  value={calView}
                  onChange={setCalView}
                  options={[{ value: "month", label: "Month" }, { value: "list", label: "List" }]}
                  label="Calendar view"
                />
                <Button size="sm" variant="primary" icon="plus" onClick={() => openCalCreate()}>
                  Add event
                </Button>
              </div>
            }
          >
            {calLoading && calEvents.length === 0 ? (
              <div className="stack g-3" aria-busy>
                <span className="sr-only">Loading the calendar</span>
                <Skeleton height={16} width="35%" />
                <Skeleton height={240} />
              </div>
            ) : calErr && calEvents.length === 0 ? (
              <EmptyState
                icon="alert"
                title="The calendar didn't load"
                body="Nothing is missing — the server just didn't answer. Try again."
                action={<Button variant="secondary" icon="refresh" onClick={loadCalendar}>Try again</Button>}
              />
            ) : calView === "month" ? (
              <div className="stack g-3">
                <div className="cal-grid" aria-hidden>
                  {WEEKDAYS.map((w) => <div key={w} className="cal-dow">{w}</div>)}
                </div>

                <div className="cal-grid">
                  {calGrid.map((d) => {
                    const key = cellKey(d);
                    const evs = calByDay.get(key) ?? [];
                    const isToday = key === calTodayKey;
                    const outside = d.getMonth() !== calMonthIndex;
                    const shown = evs.slice(0, 3);
                    const extra = evs.length - shown.length;
                    return (
                      <div
                        key={key}
                        className="cal-cell"
                        data-today={isToday ? "true" : undefined}
                        data-out={outside ? "true" : undefined}
                      >
                        {/* Sits behind the chips and fills the cell, so tapping
                            anywhere empty starts a new event on that day. */}
                        <button
                          type="button"
                          className="cal-add"
                          aria-label={`Add an event on ${longDay(d)}`}
                          onClick={() => openCalCreate(d)}
                        />
                        <div className="cal-body">
                          <span className="cal-daynum">
                            {isToday ? <span className="sr-only">Today, </span> : null}
                            {d.getDate()}
                          </span>

                          <div className="cal-chips">
                            {shown.map((e) => {
                              const k = KIND_META[e.kind];
                              return (
                                <button
                                  key={e.id}
                                  type="button"
                                  className="cal-chip"
                                  data-off={e.status === "CANCELED" || e.status === "NO_SHOW" ? "true" : undefined}
                                  style={{ background: k.bg, color: k.fg }}
                                  title={`${e.title} — ${eventWhen(e)}`}
                                  onClick={() => setCalOpen(e.id)}
                                >
                                  <Icon name={k.icon} size={12} />
                                  {!e.allDay ? <span className="cal-chip-time">{fmtTime(e.startAt)}</span> : null}
                                  <span className="truncate">{e.title}</span>
                                </button>
                              );
                            })}
                            {extra > 0 ? (
                              <button type="button" className="cal-more" onClick={() => setCalDayOpen(key)}>
                                +{extra} more
                                <span className="sr-only"> on {longDay(d)}</span>
                              </button>
                            ) : null}
                          </div>

                          {/* The phone version of the same information. */}
                          {evs.length > 0 ? (
                            <button
                              type="button"
                              className="cal-dots"
                              aria-label={`${plural(evs.length, "event")} on ${longDay(d)}`}
                              onClick={() => setCalDayOpen(key)}
                            >
                              {evs.slice(0, 4).map((e) => (
                                <span
                                  key={e.id}
                                  aria-hidden
                                  className="cal-dot"
                                  style={{ background: KIND_META[e.kind].dot }}
                                />
                              ))}
                              <span aria-hidden className="cal-dotnum">{evs.length}</span>
                            </button>
                          ) : null}
                        </div>
                      </div>
                    );
                  })}
                </div>

                {calMonthCount === 0 ? (
                  <p className="t-sm t-muted">
                    Nothing on the calendar this month. Pick any day to put something in it.
                  </p>
                ) : (
                  <p className="t-xs t-muted">
                    Pick an empty day to add something; pick an event to open it.
                  </p>
                )}

                <div className="row wrap g-3">
                  {KIND_ORDER.map((k) => (
                    <span key={k} className="row g-1 t-xs t-muted">
                      <span
                        aria-hidden
                        style={{
                          display: "block", width: 8, height: 8, flex: "0 0 auto",
                          borderRadius: "var(--r-full)", background: KIND_META[k].dot,
                        }}
                      />
                      <Icon name={KIND_META[k].icon} size={12} />
                      {KIND_META[k].label}
                    </span>
                  ))}
                </div>
              </div>
            ) : (
              <div>
                {/* .toolbar carries its own bottom margin, so no stack gap here. */}
                <div className="toolbar">
                  <Segmented
                    value={calWhen}
                    onChange={setCalWhen}
                    options={[{ value: "upcoming", label: "Upcoming" }, { value: "past", label: "Past" }]}
                    label="Which events to show"
                  />
                  <span className="t-xs t-muted">
                    {plural(calListRows.length, "event")} in the months loaded
                  </span>
                </div>

                <DataTable
                  rows={calListRows}
                  columns={[
                    {
                      key: "when",
                      header: "When",
                      primary: true,
                      sortBy: (e) => new Date(e.startAt).getTime(),
                      cell: (e) => {
                        const start = new Date(e.startAt);
                        const end = e.endAt ? new Date(e.endAt) : null;
                        return (
                          <div className="stack g-1" style={{ minWidth: 0 }}>
                            <b className="truncate">
                              {start.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: TZ })}
                            </b>
                            <span className="t-xs t-muted num">
                              {e.allDay
                                ? "All day"
                                : `${fmtTime(start)}${end && end.toDateString() === start.toDateString() ? `–${fmtTime(end)}` : ""}`}
                            </span>
                          </div>
                        );
                      },
                    },
                    {
                      key: "event",
                      header: "Event",
                      sortBy: (e) => e.title,
                      cell: (e) => (
                        <div className="stack g-1" style={{ minWidth: 0 }}>
                          <span className="truncate">{e.title}</span>
                          {e.location || e.contactName ? (
                            <span className="t-xs t-muted truncate">
                              {[e.location, e.contactName].filter(Boolean).join(" · ")}
                            </span>
                          ) : null}
                        </div>
                      ),
                    },
                    {
                      key: "kind",
                      header: "Type",
                      sortBy: (e) => KIND_META[e.kind].label,
                      cell: (e) => (
                        <Badge tone={KIND_META[e.kind].tone} icon={KIND_META[e.kind].icon}>
                          {KIND_META[e.kind].label}
                        </Badge>
                      ),
                    },
                    {
                      key: "status",
                      header: "Status",
                      sortBy: (e) => STATUS_META[e.status].label,
                      cell: (e) => (
                        <Badge tone={STATUS_META[e.status].tone} icon={STATUS_META[e.status].icon}>
                          {STATUS_META[e.status].label}
                        </Badge>
                      ),
                    },
                  ]}
                  rowKey={(e) => e.id}
                  loading={calLoading && calEvents.length === 0}
                  skeletonRows={5}
                  mobileCards
                  caption={calWhen === "upcoming" ? "Upcoming events, soonest first" : "Past events, most recent first"}
                  onRowClick={(e) => setCalOpen(e.id)}
                  empty={
                    <EmptyState
                      icon="calendar"
                      title={calWhen === "upcoming" ? "Nothing coming up" : "Nothing in the past here"}
                      body={
                        calWhen === "upcoming"
                          ? "No viewings, market days or reminders in the months loaded. Add one and it shows up here."
                          : "Nothing has happened yet in the months loaded. Use the arrows to look further back."
                      }
                      action={
                        calWhen === "upcoming"
                          ? <Button variant="primary" icon="plus" onClick={() => openCalCreate()}>Add an event</Button>
                          : undefined
                      }
                    />
                  }
                />
              </div>
            )}
          </Card>

          {/* One day at a time — opened by "+N more" on a desktop and by the
              dot row on a phone, so both routes land somewhere thumb-sized. */}
          {(() => {
            if (!calDayOpen) return null;
            const evs = calByDay.get(calDayOpen) ?? [];
            const day = new Date(`${calDayOpen}T12:00:00`);
            return (
              <Modal
                open
                onClose={() => setCalDayOpen(null)}
                title={longDay(day)}
                description={plural(evs.length, "event")}
                width="sm"
                footer={
                  <>
                    <Button variant="ghost" onClick={() => setCalDayOpen(null)}>Close</Button>
                    <Button variant="primary" icon="plus" onClick={() => openCalCreate(day)}>Add an event</Button>
                  </>
                }
              >
                {evs.length === 0 ? (
                  <EmptyState
                    icon="calendar"
                    title="Nothing on this day"
                    body="Add something and it appears on the grid straight away."
                  />
                ) : (
                  <div className="stack g-1">
                    {evs.map((e) => (
                      <button
                        key={e.id}
                        type="button"
                        className="nav-item"
                        style={{ minHeight: 52, textAlign: "left" }}
                        onClick={() => { setCalDayOpen(null); setCalOpen(e.id); }}
                      >
                        <Icon name={KIND_META[e.kind].icon} size={16} />
                        <span className="stack g-1 grow" style={{ minWidth: 0 }}>
                          <b className="truncate">{e.title}</b>
                          <span className="t-xs t-muted truncate">
                            {e.allDay ? "All day" : fmtTime(e.startAt)} · {KIND_META[e.kind].label} · {STATUS_META[e.status].label}
                          </span>
                        </span>
                        <Icon name="chevronRight" size={14} />
                      </button>
                    ))}
                  </div>
                )}
              </Modal>
            );
          })()}

          {/* Event slide-over — everything about one event, and every action. */}
          {calSelected ? (() => {
            const e = calSelected;
            const k = KIND_META[e.kind];
            const s = STATUS_META[e.status];
            return (
              <Panel
                open
                onClose={() => setCalOpen(null)}
                title={e.title}
                subtitle={eventWhen(e)}
                actions={
                  <IconButton
                    icon="edit"
                    label="Edit this event"
                    size="sm"
                    onClick={() => { setCalOpen(null); openCalEdit(e); }}
                  />
                }
                footer={
                  <div className="row between wrap g-2" style={{ width: "100%" }}>
                    <Button variant="danger" icon="trash" disabled={busy} onClick={() => deleteCalEvent(e)}>
                      Delete
                    </Button>
                    <Button variant="primary" icon="edit" onClick={() => { setCalOpen(null); openCalEdit(e); }}>
                      Edit
                    </Button>
                  </div>
                }
              >
                <div className="stack g-5">
                  <div className="row wrap g-2">
                    <Badge tone={k.tone} icon={k.icon}>{k.label}</Badge>
                    <Badge tone={s.tone} icon={s.icon}>{s.label}</Badge>
                    {e.allDay ? <Badge tone="neutral" dot>All day</Badge> : null}
                  </div>

                  <div className="stack g-2">
                    <p className="t-label">Mark it</p>
                    <Segmented
                      value={e.status}
                      onChange={(v) => setCalEventStatus(e, v)}
                      options={STATUS_CHOICES.map((st) => ({ value: st, label: STATUS_META[st].label }))}
                      label="Event status"
                    />
                    {e.status === "SCHEDULED" ? (
                      <p className="t-xs t-muted">Still just scheduled — nothing marked yet.</p>
                    ) : null}
                  </div>

                  <DescList
                    items={[
                      { label: "When", value: eventWhen(e) },
                      { label: "Type", value: k.label },
                      { label: "Where", value: e.location || "Not set" },
                      { label: "Contact", value: e.contactName || "—" },
                      { label: "Added", value: fmtDate(e.createdAt) },
                      ...(e.remindedAt ? [{ label: "Reminder sent", value: fmtDateTime(e.remindedAt) }] : []),
                    ]}
                  />

                  <div className="stack g-2">
                    <p className="t-label">Get hold of them</p>
                    <PhoneActions phone={e.contactPhone} name={e.contactName || undefined} />
                    <EmailAction email={e.contactEmail} name={e.contactName || undefined} />
                  </div>

                  {e.notes ? (
                    <div className="stack g-2">
                      <p className="t-label">Notes</p>
                      <p className="t-sm" style={{ whiteSpace: "pre-wrap" }}>{e.notes}</p>
                    </div>
                  ) : null}

                  {e.applicationId ? (
                    <div className="stack g-2">
                      <p className="t-label">Where this came from</p>
                      <p className="t-sm t-muted">
                        This event is tied to a vendor application — changing the date here
                        updates the viewing line on it.
                      </p>
                      <div>
                        <LinkButton href="/admin/applications" variant="secondary" icon="inbox">
                          Open applications
                        </LinkButton>
                      </div>
                    </div>
                  ) : null}
                </div>
              </Panel>
            );
          })() : null}

          {/* One modal for both adding and editing. */}
          <Modal
            open={!!calForm}
            onClose={() => { setCalForm(null); setCalFormErr(""); }}
            title={calForm?.id ? "Edit event" : "Add to the calendar"}
            description={
              calForm?.id
                ? "Saved changes show on the grid straight away."
                : "Viewings, market days, move-ins — anything you'd otherwise write on a sticky note."
            }
            width="md"
            footer={
              <>
                <Button variant="ghost" onClick={() => { setCalForm(null); setCalFormErr(""); }}>Cancel</Button>
                <Button variant="primary" icon="check" loading={busy} onClick={saveCalEvent}>
                  {calForm?.id ? "Save changes" : "Add event"}
                </Button>
              </>
            }
          >
            {calForm ? (
              <div className="stack g-4">
                <Field label="What is it?" required>
                  {(p) => (
                    <Input
                      {...p}
                      value={calForm.title}
                      placeholder="Viewing — Prairie Rose Candle Co."
                      onChange={(ev) => setCalForm({ ...calForm, title: ev.target.value })}
                    />
                  )}
                </Field>

                <div className="grid-2">
                  <Field label="Type">
                    {(p) => (
                      <Select
                        {...p}
                        value={calForm.kind}
                        onChange={(ev) => setCalForm({ ...calForm, kind: ev.target.value as EventKind })}
                      >
                        {KIND_ORDER.map((k) => (
                          <option key={k} value={k}>{KIND_META[k].label}</option>
                        ))}
                      </Select>
                    )}
                  </Field>
                  <Field label="Where" hint="Optional — booth number, address, anything.">
                    {(p) => (
                      <Input
                        {...p}
                        value={calForm.location}
                        onChange={(ev) => setCalForm({ ...calForm, location: ev.target.value })}
                      />
                    )}
                  </Field>
                </div>

                <div className="grid-2">
                  <Field label="Starts" required>
                    {(p) => (
                      <Input
                        {...p}
                        type="datetime-local"
                        value={calForm.startAt}
                        onChange={(ev) => setCalForm({ ...calForm, startAt: ev.target.value })}
                      />
                    )}
                  </Field>
                  <Field label="Ends" hint="Leave it blank if you don't know yet.">
                    {(p) => (
                      <Input
                        {...p}
                        type="datetime-local"
                        value={calForm.endAt}
                        onChange={(ev) => setCalForm({ ...calForm, endAt: ev.target.value })}
                      />
                    )}
                  </Field>
                </div>

                <Checkbox
                  checked={calForm.allDay}
                  onCheckedChange={(v) => setCalForm({ ...calForm, allDay: v })}
                  label="All day"
                  hint="Hides the time on the grid — for market days and anything without a set hour."
                />

                <div className="divider" />

                <div className="stack g-4">
                  <p className="t-label">Who it&rsquo;s with</p>
                  <div className="grid-2">
                    <Field label="Name">
                      {(p) => (
                        <Input
                          {...p}
                          value={calForm.contactName}
                          onChange={(ev) => setCalForm({ ...calForm, contactName: ev.target.value })}
                        />
                      )}
                    </Field>
                    <Field label="Phone" hint="You can call or text them from the event later.">
                      {(p) => (
                        <Input
                          {...p}
                          type="tel"
                          inputMode="tel"
                          autoComplete="tel"
                          value={calForm.contactPhone}
                          onChange={(ev) => setCalForm({ ...calForm, contactPhone: ev.target.value })}
                        />
                      )}
                    </Field>
                  </div>
                  <Field label="Email">
                    {(p) => (
                      <Input
                        {...p}
                        type="email"
                        autoComplete="email"
                        value={calForm.contactEmail}
                        onChange={(ev) => setCalForm({ ...calForm, contactEmail: ev.target.value })}
                      />
                    )}
                  </Field>
                  {!calForm.id && calForm.kind === "VIEWING" && calForm.contactEmail.trim() ? (
                    <Checkbox
                      checked={calForm.notify}
                      onCheckedChange={(v) => setCalForm({ ...calForm, notify: v })}
                      label="Email them the details"
                      hint="Sends the date and time to that address when you save. Only works for a viewing that came from an application."
                    />
                  ) : null}
                </div>

                <Field label="Notes" hint="Anything you'll want in front of you on the day.">
                  {(p) => (
                    <Textarea
                      {...p}
                      rows={3}
                      value={calForm.notes}
                      onChange={(ev) => setCalForm({ ...calForm, notes: ev.target.value })}
                    />
                  )}
                </Field>

                {calFormErr ? <Note tone="error">{calFormErr}</Note> : null}
              </div>
            ) : null}
          </Modal>

          {/* Dry run first: she sees every row before anything is written. */}
          {calImport ? (
            <Modal
              open
              onClose={() => setCalImport(null)}
              title="Import the old viewings"
              description="This is a preview — nothing has been written yet."
              width="md"
              footer={
                <>
                  <Button variant="ghost" onClick={() => setCalImport(null)}>Not now</Button>
                  <Button
                    variant="primary"
                    icon="download"
                    loading={calImporting}
                    disabled={calImport.importedCount === 0}
                    onClick={runLegacyImport}
                  >
                    {calImport.importedCount === 0
                      ? "Nothing to import"
                      : `Import ${plural(calImport.importedCount, "viewing")}`}
                  </Button>
                </>
              }
            >
              <div className="stack g-5">
                <div className="stack g-2">
                  <p className="t-label">Will be added ({calImport.imported.length})</p>
                  {calImport.imported.length === 0 ? (
                    <p className="t-sm t-muted">
                      None of the old viewings could be read as a date, so there&rsquo;s nothing to add.
                    </p>
                  ) : (
                    <ul className="stack g-2" style={{ listStyle: "none", margin: 0, padding: 0 }}>
                      {calImport.imported.map((i, idx) => (
                        <li key={`${i.businessName}-${idx}`} className="row between wrap g-2">
                          <b className="truncate">{i.businessName}</b>
                          <span className="t-sm t-muted num">{fmtDateTime(i.when)}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>

                {calImport.flagged.length > 0 ? (
                  <div className="stack g-3">
                    <Note tone="warn" title={`${plural(calImport.flagged.length, "viewing")} can't be read`}>
                      These stay on their applications untouched — you&rsquo;ll need to put them
                      on the calendar by hand.
                    </Note>
                    <ul className="stack g-3" style={{ listStyle: "none", margin: 0, padding: 0 }}>
                      {calImport.flagged.map((f) => (
                        <li key={f.applicationId} className="stack g-1">
                          <b>{f.businessName}</b>
                          <span className="t-sm">They wrote: &ldquo;{f.raw}&rdquo;</span>
                          <span className="t-xs t-muted">{f.reason}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </div>
            </Modal>
          ) : null}
        </>
      )}

      {tab === "contracts" && (
        <>
          <Card
            className="mb-4"
            title="Booth agreements"
            subtitle="Rent auto-charges on the 1st of every month at midnight — first and final months prorate by day. Nothing for you to remember."
          >
            <div className="stack g-3">
            {/* Backed-out agreements are hidden by default: they never started,
                so leaving them in the working list is just noise. */}
            <Segmented
              label="Which agreements to show"
              value={contractFilter}
              onChange={setContractFilter}
              options={[
                { value: "ACTIVE", label: `Active (${workingContracts.length})` },
                { value: "WITHDRAWN", label: `Backed out (${withdrawnContracts.length})` },
                { value: "ALL", label: `All (${contracts.length})` },
              ]}
            />
            <DataTable
              rows={shownContracts}
              columns={[
                {
                  key: "booth",
                  header: "Booth",
                  primary: true,
                  sortBy: (c) => c.boothLabel,
                  cell: (c) => (
                    <div className="stack g-1" style={{ minWidth: 0 }}>
                      <b className="truncate">Booth {c.boothLabel}</b>
                      <span className="t-xs t-muted truncate">{c.vendor.businessName}</span>
                    </div>
                  ),
                },
                {
                  key: "rent",
                  header: "Rent",
                  align: "right",
                  sortBy: (c) => c.monthlyRentCents,
                  cell: (c) => <span className="num">{money(c.monthlyRentCents)}/mo</span>,
                },
                {
                  key: "started",
                  header: "Started",
                  hideBelow: 900,
                  sortBy: (c) => c.startDate,
                  cell: (c) => fmtDate(c.startDate),
                },
                {
                  key: "signing",
                  header: "Where it's at",
                  mobileLabel: "Agreement",
                  /* Sort by how much attention it needs: stale first, then
                     furthest from signed. */
                  sortBy: (c) => {
                    const d = c.delivery;
                    if (!d) return 9;
                    const rank = { DRAFT: 1, SENT: 2, OPENED: 3, SIGNED: 0, EXECUTED: 8 }[d.state];
                    return d.stale ? rank - 0.5 : rank;
                  },
                  /* Delivery first, then — once both names are on it — whether
                     they've opened the invoice that followed. One column, so
                     the mobile card doesn't gain a row that's blank for most
                     agreements. */
                  cell: (c) => (
                    <div className="stack g-1" style={{ minWidth: 0 }}>
                      <DeliveryCell d={c.delivery} />
                      {c.vendorSignedAt && c.marketSignedAt ? (
                        <InvoiceOpensCell
                          v={c.invoiceViews}
                          owes={Math.max(0, -(c.vendorBalanceCents ?? 0))}
                          rentDue={c.rentDueCents ?? 0}
                          rentCharged={c.rentChargedCents ?? 0}
                        />
                      ) : null}
                    </div>
                  ),
                },
                {
                  key: "status",
                  header: "Status",
                  sortBy: (c) => c.status,
                  cell: (c) => <ContractStatusBadge status={c.status} endDate={c.endDate} />,
                },
              ]}
              rowKey={(c) => c.id}
              loading={!overview && contracts.length === 0}
              skeletonRows={4}
              mobileCards
              caption="Booth agreements, rent, and signing status"
              onRowClick={(c) => setContractOpen(c.id)}
              empty={
                contractFilter === "WITHDRAWN" ? (
                  <EmptyState
                    icon="checkCircle"
                    title="Nobody has backed out"
                    body="Every agreement you've raised is still going. Vendors you mark as backed out land here."
                  />
                ) : contractFilter === "ACTIVE" && contracts.length > 0 ? (
                  <EmptyState
                    icon="contract"
                    title="Nothing currently running"
                    body="Every agreement on file has been backed out — switch to Backed out or All to see them."
                  />
                ) : (
                  <EmptyState
                    icon="contract"
                    title="No agreements yet"
                    body="Create the first booth agreement below — the vendor gets a link to sign it."
                  />
                )
              }
            />
            </div>
          </Card>

          {/* Agreement detail slide-over — signing, emails, rent, and ending. */}
          {(() => {
            const c = contracts.find((x) => x.id === contractOpen);
            if (!c) return null;
            const settled = (c.vendorBalanceCents ?? 0) >= 0 && !!c.vendor.cardLast4;
            const executed = !!(c.vendorSignedAt && c.marketSignedAt);
            const iv = c.invoiceViews ?? { count: 0, lastAt: null };
            const sendMail = async (action: string, what: string) => {
              setBusy(true);
              try {
                const r = await fetch(`/api/admin/contracts/${c.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action }) });
                const d = await r.json().catch(() => ({}));
                if (r.ok) toast.success(`${what} sent`, `Emailed to ${d.sentTo}.`);
                else toast.error(`Couldn't send the ${what.toLowerCase()}`, String(d.error || `Error ${r.status}.`));
              } catch (e) {
                toast.error(`Couldn't send the ${what.toLowerCase()}`, e instanceof Error ? e.message : "Network error.");
              } finally {
                setBusy(false);
              }
            };
            return (
              <Panel
                open
                onClose={() => setContractOpen(null)}
                title={`Booth ${c.boothLabel}`}
                subtitle={c.vendor.businessName}
                actions={
                  <a className="btn btn-ghost btn-sm" href={`/contract/${c.id}/packet`} target="_blank" rel="noopener">
                    <Icon name="print" size={14} /> Packet
                  </a>
                }
              >
                <div className="stack g-5">
                  <div className="row wrap g-2">
                    <ContractStatusBadge status={c.status} endDate={c.endDate} />
                    {c.vendorSignedAt && c.marketSignedAt ? (
                      <Badge tone="success" dot>Fully executed</Badge>
                    ) : c.vendorSignedAt ? (
                      <Badge tone="warn" dot>Awaiting your signature</Badge>
                    ) : c.marketSignedAt ? (
                      <Badge tone="warn" dot>Awaiting vendor</Badge>
                    ) : (
                      <Badge tone="neutral" dot>Unsigned</Badge>
                    )}
                  </div>

                  <DescList
                    items={[
                      { label: "Vendor", value: `${c.vendor.code} · ${c.vendor.businessName}` },
                      { label: "Monthly rent", value: <span className="num">{money(c.monthlyRentCents)}</span> },
                      { label: "Started", value: fmtDate(c.startDate) },
                      ...(c.noticeGivenAt ? [{ label: "Notice given", value: fmtDate(c.noticeGivenAt) }] : []),
                      /* Backing out stamps endDate too, but "Lease ends" would be
                         the wrong word for a lease that never began. */
                      ...(c.endDate
                        ? [{ label: c.status === "WITHDRAWN" ? "Backed out" : "Lease ends", value: fmtDate(c.endDate) }]
                        : []),
                      { label: "Vendor signed", value: c.vendorSignedAt ? fmtDate(c.vendorSignedAt) : "Not yet" },
                      { label: "Market signed", value: c.marketSignedAt ? fmtDate(c.marketSignedAt) : "Not yet" },
                      ...(!c.vendorSignedAt
                        ? [{
                            label: "Opened by vendor",
                            /* Date AND time — "they opened it" is only useful
                               if you can see whether that was an hour ago or
                               three weeks ago. */
                            value: c.viewedAt ? (
                              <span>
                                {fmtDateTime(c.viewedAt)}
                                <span className="t-muted"> · {relTime(c.viewedAt)}</span>
                              </span>
                            ) : "Not opened yet",
                          }]
                        : []),
                      { label: "Card on file", value: c.vendor.cardLast4 ? `•••• ${c.vendor.cardLast4}` : "None" },
                    ]}
                  />

                  <div className="stack g-2">
                    <p className="t-label">Send to the vendor</p>
                    <div className="row wrap g-2">
                      <Button size="sm" icon="mail" disabled={busy} onClick={() => sendMail("send_for_signature", "Signing link")}>
                        Send for signature
                      </Button>
                      {/* Only while there's something to sign. Handing out a
                          signing link for an executed agreement invites someone
                          to sign it a second time. */}
                      {c.signToken && !c.vendorSignedAt && c.status !== "ENDED" && c.status !== "WITHDRAWN" ? (
                        <>
                          <Button
                            size="sm"
                            variant="secondary"
                            icon="copy"
                            disabled={busy}
                            onClick={() => copySigningLink(c.signToken || "", c.vendor.businessName)}
                          >
                            Copy signing link
                          </Button>
                          <LinkButton
                            href={`/sign/${c.signToken}`}
                            size="sm"
                            variant="ghost"
                            icon="external"
                            external
                          >
                            Open it
                          </LinkButton>
                        </>
                      ) : null}
                      {!c.vendorSignedAt && c.status !== "ENDED" && c.status !== "WITHDRAWN" ? (
                        <Button
                          size="sm"
                          icon="bell"
                          disabled={busy}
                          onClick={() => sendAgreementReminder(c.id, c.vendor.businessName)}
                        >
                          Send reminder
                        </Button>
                      ) : null}
                      <Button size="sm" icon="clipboard" disabled={busy} onClick={() => sendMail("send_setup_guide", "Setup guide")}>
                        Resend setup guide
                      </Button>
                      <Button
                        size="sm"
                        icon="dollar"
                        disabled={busy || settled}
                        title={settled ? "Rent covered and card on file — nothing to send" : undefined}
                        onClick={() => sendMail("send_rent_link", "Rent payment link")}
                      >
                        Send rent payment link
                      </Button>
                    </div>
                    {settled ? (
                      <p className="t-xs t-muted">Rent is covered and a card is on file — there's nothing to collect.</p>
                    ) : null}
                  </div>

                  {/* The invoice only exists once both names are on the
                      agreement, so this whole section stays out of the way
                      until there's something to open. */}
                  {executed ? (
                    <div className="stack g-2">
                      <p className="t-label">Invoice</p>
                      {c.signToken ? (
                        <>
                          <div className="row wrap g-2">
                            <LinkButton external href={`/rent/${c.signToken}`} icon="receipt">
                              View their invoice
                            </LinkButton>
                          </div>
                          <p className="t-xs t-muted">
                            Opening it yourself isn&rsquo;t counted and doesn&rsquo;t notify them — only{" "}
                            {c.vendor.businessName}&rsquo;s own opens are recorded.
                          </p>
                        </>
                      ) : (
                        <p className="t-xs t-muted">No invoice link yet.</p>
                      )}
                      <p className="t-sm">
                        {iv.count === 0 ? (
                          <span className="t-muted">
                            {iv.tracked === false
                              ? "Their invoice was sent before open-tracking existed, so there's nothing recorded either way."
                              : (c.rentChargedCents ?? 0) === 0
                                ? "Nothing has been billed to them yet."
                                : (c.rentDueCents ?? 0) <= 0
                                  ? "Paid in full — they never needed to open it."
                                  : "They haven\u2019t opened it yet."}
                          </span>
                        ) : (
                          <>
                            Opened {plural(iv.count, "time")}
                            {iv.lastAt ? (
                              <span className="t-muted">
                                , most recently {relTime(iv.lastAt)} ({fmtDateTime(iv.lastAt)})
                              </span>
                            ) : null}
                            {/* Opens without this read as a complaint about a
                                vendor who has already paid. */}
                            {(c.rentChargedCents ?? 0) > 0 ? (
                              <span className="t-muted">
                                {" "}— {(c.rentDueCents ?? 0) <= 0
                                  ? "and it's paid."
                                  : `and ${money(c.rentDueCents ?? 0)} of rent is still outstanding.`}
                              </span>
                            ) : null}
                          </>
                        )}
                      </p>
                      <div className="row wrap g-2">
                        <Button size="sm" icon="eye" onClick={() => openInvoiceLog(c.id)}>
                          See every open
                        </Button>
                      </div>
                    </div>
                  ) : null}

                  {/* Terms are editable right up until they sign, locked the
                      moment they do, and fixed for good once both names are on
                      it. Each of those three states gets its own answer here. */}
                  <div className="stack g-2">
                    <p className="t-label">Terms</p>
                    {c.status === "WITHDRAWN" ? (
                      <p className="t-xs t-muted">
                        They backed out of this one. Put them back on below, or write a fresh
                        agreement if they return on different terms.
                      </p>
                    ) : c.status === "ENDED" ? (
                      <p className="t-xs t-muted">
                        This agreement is closed. Create a new one if they&rsquo;re coming back.
                      </p>
                    ) : !c.vendorSignedAt ? (
                      <div className="row wrap g-2">
                        <Button
                          size="sm"
                          icon="edit"
                          disabled={busy}
                          onClick={() => openTerms(
                            { id: c.id, businessName: c.vendor.businessName, boothLabel: c.boothLabel, monthlyRentCents: c.monthlyRentCents, startDate: c.startDate },
                            "update_terms"
                          )}
                        >
                          Edit terms
                        </Button>
                      </div>
                    ) : !c.marketSignedAt ? (
                      <>
                        <Note tone="warn" title="They&rsquo;ve signed — the terms are locked">
                          {c.vendor.businessName} put their name to this on {fmtDate(c.vendorSignedAt)}.
                          Changing the booth, the rent or the start date now would change something they&rsquo;ve
                          already agreed to, so the only honest fix is a corrected agreement they sign again.
                        </Note>
                        <div className="row wrap g-2">
                          <Button
                            size="sm"
                            variant="dangerSoft"
                            icon="refresh"
                            disabled={busy}
                            onClick={() => openTerms(
                              { id: c.id, businessName: c.vendor.businessName, boothLabel: c.boothLabel, monthlyRentCents: c.monthlyRentCents, startDate: c.startDate },
                              "void_and_reissue"
                            )}
                          >
                            Void and send a corrected agreement
                          </Button>
                        </div>
                      </>
                    ) : (
                      <p className="t-xs t-muted">
                        Both names are on this agreement, so the terms are fixed. To change them, end it
                        with 30-day notice and write a new one.
                      </p>
                    )}
                  </div>

                  {/* An ended agreement has nothing left to do to it, so the
                      heading doesn't sit there over an empty row. */}
                  {c.status !== "ENDED" ? (
                  <div className="stack g-2">
                    <p className="t-label">Lease</p>
                    {/* Someone who backed out has one move left — coming back.
                        Notice periods and final statements are for leases that
                        actually ran. */}
                    {c.status === "WITHDRAWN" ? (
                      <>
                        <div className="row wrap g-2">
                          <Button size="sm" icon="refresh" disabled={busy} onClick={() => reinstateContract(c)}>
                            They&rsquo;re back on
                          </Button>
                        </div>
                        <p className="t-xs t-muted">
                          This puts the agreement back to active and switches their vendor account
                          on again.
                        </p>
                      </>
                    ) : (
                      <div className="row wrap g-2">
                        {c.status === "ACTIVE" ? (
                          <Button size="sm" icon="calendar" disabled={busy} onClick={() => giveNotice(c)}>
                            Enter 30-day notice
                          </Button>
                        ) : null}
                        {c.status === "TERMINATING" ? (
                          <Button size="sm" icon="receipt" disabled={busy} onClick={() => finalStatement(c)}>
                            Final statement
                          </Button>
                        ) : null}
                        <Button
                          size="sm"
                          variant="dangerSoft"
                          icon="close"
                          disabled={busy}
                          onClick={() => markWithdrawn(c)}
                        >
                          They backed out
                        </Button>
                        <Button
                          size="sm"
                          variant="danger"
                          icon="close"
                          disabled={busy}
                          onClick={() => contractAction(
                            c.id,
                            "end_now",
                            {
                              title: `End booth ${c.boothLabel} today?`,
                              body: `${c.vendor.businessName}'s lease closes immediately — no 30-day notice, no further rent charges. Their balance and history stay as they are.`,
                              confirmLabel: "End the agreement",
                              tone: "danger",
                              typeToConfirm: "END",
                            },
                            `Booth ${c.boothLabel} agreement ended`
                          )}
                        >
                          End now
                        </Button>
                      </div>
                    )}
                  </div>
                  ) : null}
                </div>
              </Panel>
            );
          })()}

          {/* Every recorded open of one invoice. Device is deliberately coarse
              — "iPhone" is all the raw user-agent string honestly supports. */}
          <Modal
            open={!!invoiceLogFor}
            onClose={closeInvoiceLog}
            title="Invoice opens"
            description="Newest first. Your own previews are never recorded."
            width="md"
            footer={<Button variant="ghost" onClick={closeInvoiceLog}>Close</Button>}
          >
            {invoiceLogErr ? (
              <Note tone="error" title="The open history couldn't be loaded">
                {invoiceLogErr}
              </Note>
            ) : (
              <DataTable
                rows={invoiceLog ?? []}
                columns={[
                  {
                    key: "when",
                    header: "Opened",
                    primary: true,
                    cell: (v) => (
                      <div className="stack g-1" style={{ minWidth: 0 }}>
                        <b className="truncate">{fmtDateTime(v.viewedAt)}</b>
                        <span className="t-xs t-muted">{relTime(v.viewedAt)}</span>
                      </div>
                    ),
                  },
                  {
                    key: "device",
                    header: "Device",
                    cell: (v) => deviceFromUA(v.userAgent),
                  },
                ]}
                rowKey={(v) => v.id}
                loading={invoiceLogLoading}
                skeletonRows={4}
                mobileCards
                caption="Invoice opens, newest first"
                empty={
                  <EmptyState
                    icon="eye"
                    title="Not opened yet"
                    body="Nobody has opened this invoice. Your own previews wouldn't show up here anyway."
                  />
                }
              />
            )}
          </Modal>

          <Card title="New booth agreement" subtitle="The first month prorates from the start date; full rent charges on the 1st after that.">
            <div className="stack g-4 content-narrow">
              <Field label="Vendor" required>
                {(p) => (
                  <Select {...p} value={cVendor} onChange={(e) => setCVendor(e.target.value)}>
                    <option value="">Choose a vendor…</option>
                    {vendors.filter((v) => v.active).map((v) => (
                      <option key={v.id} value={v.id}>{v.code} — {v.businessName}</option>
                    ))}
                  </Select>
                )}
              </Field>

              <Field label="Booth" hint="However you label it on the floor — A3, 5, NW corner." required>
                {(p) => <Input {...p} value={cBooth} onChange={(e) => setCBooth(e.target.value)} />}
              </Field>

              <div className="stack g-2">
                <Segmented
                  label="Booth size"
                  value={cMode}
                  onChange={(m) => {
                    if (m === "standard") {
                      setCMode("standard"); setCW("5"); setCD("5"); setCRent(String(Math.round(25 * rentPerSqft * 100) / 100));
                    } else {
                      setCMode("custom");
                    }
                  }}
                  options={[
                    { value: "standard", label: `Standard 5×5 — ${money(Math.round(25 * rentPerSqft * 100))}/mo` },
                    { value: "custom", label: "Custom size" },
                  ]}
                />
                <p className="t-xs t-muted">Rent prices by the square foot at {money(Math.round(rentPerSqft * 100))}/sqft.</p>
              </div>

              {cMode === "custom" ? (
                <div className="stack g-2">
                  <div className="row wrap g-2">
                    <Field label="Width (ft)" className="shrink0">
                      {(p) => (
                        <Input
                          {...p}
                          value={cW}
                          onChange={(e) => { setCW(e.target.value); const w = Number(e.target.value) || 0, d = Number(cD) || 0; if (w > 0 && d > 0) setCRent(String(Math.round(w * d * rentPerSqft * 100) / 100)); }}
                          type="number"
                          min="1"
                          step="1"
                          style={{ width: 96 }}
                        />
                      )}
                    </Field>
                    <Field label="Depth (ft)" className="shrink0">
                      {(p) => (
                        <Input
                          {...p}
                          value={cD}
                          onChange={(e) => { setCD(e.target.value); const d = Number(e.target.value) || 0, w = Number(cW) || 0; if (w > 0 && d > 0) setCRent(String(Math.round(w * d * rentPerSqft * 100) / 100)); }}
                          type="number"
                          min="1"
                          step="1"
                          style={{ width: 96 }}
                        />
                      )}
                    </Field>
                  </div>
                  <p className="t-sm">
                    {sqft} sqft → <b className="num">{money(Math.round(suggestedRent * 100))}</b>/mo at {money(Math.round(rentPerSqft * 100))}/sqft
                  </p>
                </div>
              ) : null}

              <Field label="Monthly rent" hint="Auto-filled from the size — change it freely for deals.">
                {(p) => <Input {...p} value={cRent} onChange={(e) => setCRent(e.target.value)} type="number" min="0" step="5" />}
              </Field>

              <Field label="Lease start date" hint="The first month prorates from this day." required>
                {(p) => <Input {...p} value={cStart} onChange={(e) => setCStart(e.target.value)} type="date" />}
              </Field>

              {cMsg ? <Note tone={cMsg.includes("created") ? "success" : "error"}>{cMsg}</Note> : null}

              <div>
                <Button variant="primary" icon="contract" loading={busy} onClick={addContract}>
                  Create agreement
                </Button>
              </div>
            </div>
          </Card>
        </>
      )}

      {tab === "tents" && allowed("market") && (
        <div>
          <Card
            className="mb-4"
            title="Booking pause"
            subtitle="The master switch for the public tent page."
            actions={<Badge tone={tentPaused ? "warn" : "success"} dot>{tentPaused ? "Paused" : "Taking bookings"}</Badge>}
          >
            <div className="stack g-3">
              <Checkbox
                checked={tentPaused}
                onCheckedChange={setTentPaused}
                label="Pause tent bookings"
                hint="While this is on, /tents hides every date and takes no bookings. The dates you've opened stay saved — turn it back off on opening day."
              />
              <Field
                label="Message shown while paused"
                hint="Vendors see this in place of the date list."
              >
                {(p) => (
                  <Input
                    {...p}
                    value={tentPauseMsg}
                    onChange={(e) => setTentPauseMsg(e.target.value)}
                    placeholder="Tent bookings open with the market — October 15!"
                  />
                )}
              </Field>
              <div>
                <Button
                  icon="check"
                  loading={pending === "tent-pause"}
                  onClick={async () => {
                    setPending("tent-pause");
                    try {
                      await tentAct({ action: "pause", paused: tentPaused, message: tentPauseMsg });
                      toast.success(tentPaused ? "Tent bookings paused" : "Tent bookings are open");
                    } finally { setPending(""); }
                  }}
                >
                  Save
                </Button>
              </div>
            </div>
          </Card>

          <Card
            className="mb-4"
            title="Open tent dates"
            subtitle="$25 a day — a $12.50 deposit books the spot online, the other $12.50 is collected at the front desk at setup."
          >
            <div className="stack g-4">
              <div className="grid-auto" style={{ ["--min" as string]: "160px" }}>
                <Field label="From" hint="First day to consider.">
                  {(p) => <Input {...p} type="date" value={tentFrom} onChange={(e) => setTentFrom(e.target.value)} />}
                </Field>
                <Field label="To" hint="Last day to consider.">
                  {(p) => <Input {...p} type="date" value={tentTo} onChange={(e) => setTentTo(e.target.value)} />}
                </Field>
                <Field label="Spots per day" hint="How many tents fit.">
                  {(p) => (
                    <Input
                      {...p}
                      type="number"
                      min="1"
                      max="20"
                      inputMode="numeric"
                      value={tentCap}
                      onChange={(e) => setTentCap(e.target.value)}
                    />
                  )}
                </Field>
              </div>

              <div className="stack g-2">
                <p className="t-label">Which weekdays in that range</p>
                <div className="row wrap g-2">
                  {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d, i) => (
                    <ToggleTile
                      key={d}
                      on={tentDows.includes(i)}
                      onToggle={() => setTentDows((x) => x.includes(i) ? x.filter((n) => n !== i) : [...x, i])}
                    >
                      {d}
                    </ToggleTile>
                  ))}
                </div>
                <p className="t-xs t-muted">
                  Only the ticked weekdays inside the range get opened, up to 62 dates at a time.
                  Vendors book them at <span className="mono">/tents</span>.
                </p>
              </div>

              <div>
                <Button
                  icon="plus"
                  loading={pending === "tent-open"}
                  onClick={async () => {
                    setPending("tent-open");
                    try { await openTentRange(); } finally { setPending(""); }
                  }}
                >
                  Open these dates
                </Button>
              </div>

              {tentMsg ? <Note tone="error" title="Nothing was opened">{tentMsg}</Note> : null}
            </div>
          </Card>

          {!overview && tentDates.length === 0 ? (
            <Card>
              <div className="stack g-3" aria-hidden>
                <Skeleton width="40%" height={18} />
                <Skeleton width="100%" height={13} />
                <Skeleton width="70%" height={13} />
              </div>
            </Card>
          ) : tentDates.length === 0 ? (
            <Card>
              <EmptyState
                icon="tent"
                title="No tent dates opened yet"
                body="Pick a range above and choose the weekdays you want to sell. Vendors can only book dates you've opened."
              />
            </Card>
          ) : (
            tentDates.map((d) => {
              const taken = d.bookings.filter((b) => ["PAID_DEPOSIT", "CHECKED_IN"].includes(b.status)).length;
              const live = d.bookings.filter((b) => !["CANCELED", "CREDIT_USED"].includes(b.status));
              const left = Math.max(0, d.capacity - taken);
              return (
                <Card
                  key={d.id}
                  className="mb-3"
                  title={new Date(d.date + "T12:00:00").toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}
                  subtitle={`${taken} of ${plural(d.capacity, "spot")} booked`}
                  actions={
                    <>
                      {!d.open ? (
                        <Badge tone="neutral" dot>Closed</Badge>
                      ) : left === 0 ? (
                        <Badge tone="warn" dot>Full</Badge>
                      ) : (
                        <Badge tone="success" dot>{plural(left, "spot")} left</Badge>
                      )}
                      <Button
                        size="sm"
                        variant="ghost"
                        icon={d.open ? "lock" : "unlock"}
                        onClick={() => tentAct({ action: "toggle", dateId: d.id, open: !d.open })}
                      >
                        {d.open ? "Close" : "Re-open"}
                      </Button>
                      <Button
                        size="sm"
                        variant="dangerSoft"
                        icon="warning"
                        onClick={() => tentAct(
                          { action: "weatherDay", dateId: d.id },
                          {
                            title: "Call a weather day?",
                            body: "Every paid booking on this date turns into a credit toward a future date and the vendor gets an email about it. The date closes too.",
                            confirmLabel: "Call a weather day",
                            tone: "warn",
                          }
                        )}
                      >
                        Weather day
                      </Button>
                    </>
                  }
                >
                  {live.length === 0 ? (
                    <EmptyState
                      icon="tent"
                      title="No bookings yet"
                      body={d.open ? "Vendors can book this date right now." : "This date is closed, so nobody can book it."}
                    />
                  ) : (
                    <ul className="stack g-1" style={{ listStyle: "none", margin: 0, padding: 0 }}>
                      {live.map((b) => (
                        <li
                          key={b.id}
                          className="row-top between wrap g-2"
                          style={{ padding: "var(--sp-3) 0", borderTop: "1px solid var(--border)" }}
                        >
                          <span className="stack g-1 grow" style={{ minWidth: 0 }}>
                            <b className="truncate">{b.businessName || b.name}</b>
                            <span className="t-xs t-muted truncate">{b.name}</span>
                            {/* A tent vendor who hasn't turned up is a phone call,
                                not a note to self. */}
                            <span className="row wrap g-2 t-sm">
                              <PhoneActions phone={b.phone} name={b.name} />
                            </span>
                            <span>
                              {b.status === "PAID_DEPOSIT" ? (
                                <Badge tone="info" dot>Deposit paid · $12.50 due at the desk</Badge>
                              ) : b.status === "CHECKED_IN" ? (
                                <Badge tone="success" dot>Checked in</Badge>
                              ) : b.status === "WEATHER_CREDIT" ? (
                                <Badge tone="warn" dot>Weather credit issued</Badge>
                              ) : (
                                <Badge tone="neutral" dot>
                                  {b.status.charAt(0) + b.status.slice(1).toLowerCase().replace(/_/g, " ")}
                                </Badge>
                              )}
                            </span>
                          </span>
                          <span className="row wrap g-2 shrink0">
                            {b.status === "PAID_DEPOSIT" && (
                              <Button
                                size="sm"
                                icon="check"
                                onClick={() => tentAct({ action: "checkin", bookingId: b.id })}
                              >
                                Check in ($12.50)
                              </Button>
                            )}
                            {["PAID_DEPOSIT", "RESERVED"].includes(b.status) && (
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => tentAct(
                                  { action: "cancelBooking", bookingId: b.id },
                                  {
                                    title: `Cancel ${b.businessName || b.name}'s booking?`,
                                    body: "The spot frees up right away. No refund is sent automatically — if they're owed one, refund it in Stripe.",
                                    confirmLabel: "Cancel booking",
                                    tone: "danger",
                                  }
                                )}
                              >
                                Cancel
                              </Button>
                            )}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </Card>
              );
            })
          )}
        </div>
      )}

      {tab === "customers" && allowed("market") && (
        <CustomersCard
          customers={customers}
          loading={custLoading}
          error={custErr}
          onRefresh={loadCustomers}
        />
      )}

      {tab === "links" && allowed("config") && (
        (() => {
          type LinkRow = { path: string; body: ReactNode; open?: boolean; qr?: string };

          const copyLink = async (path: string) => {
            const url = typeof window === "undefined" ? path : `${window.location.origin}${path}`;
            try {
              await navigator.clipboard.writeText(url);
              toast.success("Copied", url);
            } catch {
              toast.error("Couldn't copy", "Your browser blocked the clipboard — select the address and copy it by hand.");
            }
          };

          const linkList = (rows: LinkRow[]) => (
            <ul className="stack" style={{ listStyle: "none", margin: 0, padding: 0 }}>
              {rows.map((r, i) => (
                <li
                  key={r.path}
                  className="row-top between wrap g-3"
                  style={{ padding: "var(--sp-3) 0", borderTop: i === 0 ? undefined : "1px solid var(--border)" }}
                >
                  <span className="stack g-1 grow" style={{ minWidth: 0 }}>
                    <span className="mono t-sm truncate">{r.path}</span>
                    <span className="t-xs t-muted">{r.body}</span>
                  </span>
                  <span className="row wrap g-1 shrink0">
                    {r.open ? (
                      <>
                        <Button size="sm" variant="ghost" icon="copy" onClick={() => copyLink(r.path)}>
                          Copy
                        </Button>
                        <LinkButton href={r.path} size="sm" variant="secondary" icon="external" external>
                          Open
                        </LinkButton>
                      </>
                    ) : (
                      <Badge tone="neutral">Not typed by hand</Badge>
                    )}
                    {r.qr ? (
                      <LinkButton href={r.qr} size="sm" variant="ghost" icon="scan" external>
                        QR card
                      </LinkButton>
                    ) : null}
                  </span>
                </li>
              ))}
            </ul>
          );

          const activeVendors = vendors.filter((v) => v.active);

          return (
            <>
              <Card
                className="mb-4"
                title="Public — share these"
                subtitle="Anyone can open these without signing in."
              >
                {linkList([
                  { path: "/market", open: true, body: "Shopper directory — every vendor and what's on the floor right now. Put this on your website and socials." },
                  { path: "/apply", open: true, body: "Vendor application." },
                  { path: "/tents", open: true, body: "Outdoor tent booking — $12.50 deposit online, $12.50 at the desk." },
                  { path: "/rules", open: true, body: "Market rules and booth standards — part of every vendor agreement. Edits post instantly." },
                  { path: "/shop", open: true, body: "Self-checkout — shoppers scan and pay by card, no cashier." },
                  { path: "/shop/sign", open: true, body: "Printable self-checkout signs for the doors and tables." },
                ])}
              </Card>

              <Card
                className="mb-4"
                title="Vendor pages"
                subtitle="One public page per vendor — reviews and messaging. Their table QR points here."
              >
                {!overview && activeVendors.length === 0 ? (
                  <div className="stack g-3" aria-hidden>
                    <Skeleton width="30%" height={14} />
                    <Skeleton width="80%" height={13} />
                    <Skeleton width="60%" height={13} />
                  </div>
                ) : activeVendors.length === 0 ? (
                  <EmptyState
                    icon="store"
                    title="No active vendors yet"
                    body="Every vendor you add gets a page at /v/ plus their code."
                  />
                ) : (
                  linkList(
                    activeVendors.map((v) => ({
                      path: `/v/${v.code}`,
                      open: true,
                      qr: "/vendor/qr",
                      body: v.businessName,
                    }))
                  )
                )}
              </Card>

              <Card
                className="mb-4"
                title="For vendors"
                subtitle="Behind the vendor login — give out the first one, the rest are buttons inside."
              >
                {linkList([
                  { path: "/", open: true, body: "Vendor login — the address you give every vendor." },
                  { path: "/vendor", body: "Their dashboard: items, balance, inbox, alerts. Where login lands." },
                  { path: "/vendor/labels", body: "Their barcode label picker." },
                  { path: "/vendor/qr", qr: "/vendor/qr", body: "Their printable table QR card." },
                ])}
              </Card>

              <Card className="mb-4" title="Yours" subtitle="Staff and owner pages.">
                {linkList([
                  { path: "/register", open: true, body: "Kiosk register — PIN pad, selling, and the drawer, and nothing else. This is the one to bookmark on the till and leave open all day. Locks itself after 5 minutes idle." },
                  { path: "/admin", open: true, body: "This whole system. Employees sign in here too, with the employee button." },
                  { path: "/admin/applications", open: true, body: "Applications pipeline — call notes, viewings, and creating an agreement from an application." },
                  { path: "/admin/contracts/…/print", body: "Printable booth agreement — reached from the print action on any agreement." },
                ])}
              </Card>

              <Card
                className="mb-4"
                title="Automatic"
                subtitle="Secret links the system emails out. Nobody types these."
              >
                {linkList([
                  { path: "/t/…", body: "A customer's private message thread." },
                  { path: "/pay/…", body: "A customer's pre-order payment page." },
                ])}
              </Card>

              <Note tone="info" title="Only four are worth memorizing">
                The bare domain for vendor login, <span className="mono">/market</span> for shoppers,
                <span className="mono">/apply</span> for hopefuls, and <span className="mono">/register</span>{" "}
                on the till. Everything else is a button or an email.
              </Note>
            </>
          );
        })()
      )}

      {tab === "settings" && (
        (() => {
          /* The old screen decided whether a save had worked by searching the
             message string for a check mark. Successes are toasts now, so these
             state variables only ever hold an error — if one is set, it failed. */

          return (
            <>
              <Card
                className="mb-4"
                title="Food tax rate"
                subtitle="Oklahoma dropped the state's 4.5% on food and food ingredients in August 2024 but kept the local portion, so groceries are taxed — just lower."
              >
                <div className="stack g-3">
                  <Field
                    label="Food rate (%)"
                    hint="Your local-only rate. Leave this equal to the general rate and nothing changes; set it lower and anything a vendor ticked as food is taxed at this rate instead."
                  >
                    {(p) => (
                      <Input
                        {...p}
                        type="number" min="0" max="15" step="0.01" inputMode="decimal"
                        style={{ maxWidth: 160 }}
                        value={foodTaxInput}
                        placeholder={String(taxRate)}
                        onChange={(e) => setFoodTaxInput(e.target.value)}
                      />
                    )}
                  </Field>
                  <Note tone="warn">
                    Confirm this against your own filing before you change it. Until it&rsquo;s set, food is
                    taxed at the general rate exactly as it is today — nothing changes by deploying.
                  </Note>
                  <div>
                    <Button
                      variant="primary"
                      icon="check"
                      disabled={busy || !foodTaxInput.trim()}
                      onClick={async () => {
                        const v = Number(foodTaxInput);
                        if (!Number.isFinite(v) || v < 0 || v > 15) { toast.error("That's not a rate", "Enter a number between 0 and 15."); return; }
                        setBusy(true);
                        try {
                          const { ok, data } = await safeFetch("/api/admin/settings", {
                            method: "POST", headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ foodTaxRatePercent: v }),
                          });
                          if (!ok) { toast.error("Couldn't save that", String(data.error || "")); return; }
                          setFoodTaxRate(v);
                          toast.success("Food tax rate saved", `Food items now charge ${v}%.`);
                        } finally { setBusy(false); }
                      }}
                    >
                      Save food rate
                    </Button>
                  </div>
                </div>
              </Card>

              <Card
                className="mb-4"
                title="Sales tax"
                subtitle="Charged on every register and self-checkout sale."
              >
                <div className="stack g-3">
                  <Field
                    label="Rate (%)"
                    hint="Combined state, county and city rate for Noble. New sales use this; tickets already rung keep the rate they were rung at."
                  >
                    {(p) => (
                      <Input
                        {...p}
                        type="number"
                        min="0"
                        max="15"
                        step="0.125"
                        inputMode="decimal"
                        value={taxRate}
                        onChange={(e) => setTaxRate(Number(e.target.value))}
                      />
                    )}
                  </Field>
                  <div>
                    <Button
                      icon="check"
                      loading={pending === "tax"}
                      onClick={async () => {
                        setPending("tax");
                        try { await saveTax(); } finally { setPending(""); }
                      }}
                    >
                      Save tax rate
                    </Button>
                  </div>
                  {settingsMsg ? (
                    <Note tone="error" title="Couldn't save the tax rate">{settingsMsg}</Note>
                  ) : null}
                  <Note tone="info">
                    Check Noble&rsquo;s current combined rate with the Oklahoma Tax Commission before opening day.
                  </Note>
                </div>
              </Card>

              <Card
                className="mb-4"
                title="Vendor payout fee"
                subtitle="What each vendor is charged when their balance is sent to their bank."
              >
                <div className="stack g-3">
                  <div className="row wrap g-3">
                    <Field label="Percent of the payout" className="grow">
                      {(p) => (
                        <Input {...p} type="number" min="0" max="5" step="0.05" inputMode="decimal"
                          value={feePercentInput} onChange={(e) => setFeePercentInput(e.target.value)} />
                      )}
                    </Field>
                    <Field label="Plus, per payout ($)" className="grow">
                      {(p) => (
                        <Input {...p} type="number" min="0" max="10" step="0.05" inputMode="decimal"
                          value={feeFixedInput} onChange={(e) => setFeeFixedInput(e.target.value)} />
                      )}
                    </Field>
                  </div>
                  <Button
                    icon="check"
                    loading={pending === "payoutfee"}
                    onClick={async () => {
                      setPending("payoutfee");
                      try {
                        const r = await fetch("/api/admin/settings", {
                          method: "POST", headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({
                            payoutFeePercent: Number(feePercentInput),
                            payoutFeeFixedCents: Math.round(Number(feeFixedInput) * 100),
                          }),
                        });
                        if (!r.ok) {
                          const d = await r.json().catch(() => ({}));
                          toast.error("Couldn't save the payout fee", String(d.error || ""));
                          return;
                        }
                        toast.success("Payout fee saved", "It comes off each vendor's payout and shows on their statement.");
                      } finally { setPending(""); }
                    }}
                  >
                    Save payout fee
                  </Button>
                  <Note tone="info">
                    Stripe charges you 0.25% + $0.25 per payout, plus $2 a month per vendor you actually pay that
                    month. The default here passes on the per-payout part and absorbs the $2.
                  </Note>
                </div>
              </Card>

              <Card
                className="mb-4"
                title="Refund approval"
                subtitle="How much an employee can hand back before a manager has to stand there."
              >
                <div className="stack g-3">
                  <Field
                    label="Needs a manager's PIN at or above"
                    hint="Applies to refunds and voids rung by an employee. Managers and owners authorise their own. $0 turns the check off."
                  >
                    {(p) => (
                      <Input
                        {...p}
                        type="number"
                        min="0"
                        max="1000"
                        step="5"
                        inputMode="decimal"
                        value={approvalDollars}
                        onChange={(e) => setApprovalDollars(e.target.value)}
                      />
                    )}
                  </Field>
                  <Button
                    icon="check"
                    loading={pending === "approval"}
                    onClick={async () => {
                      setPending("approval");
                      try {
                        const cents = Math.round(Number(approvalDollars) * 100);
                        const r = await fetch("/api/admin/settings", {
                          method: "POST", headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({ refundApprovalCents: cents }),
                        });
                        if (!r.ok) {
                          const d = await r.json().catch(() => ({}));
                          toast.error("Couldn't save the threshold", String(d.error || ""));
                          return;
                        }
                        toast.success(
                          "Approval threshold saved",
                          cents === 0
                            ? "Employees can refund any amount on their own."
                            : `Refunds of $${(cents / 100).toFixed(2)} or more now need a manager's PIN.`
                        );
                      } finally { setPending(""); }
                    }}
                  >
                    Save threshold
                  </Button>
                  <Note tone="info">
                    Every void, refund and payout is recorded with who did it — and who approved it — under
                    Reports → Activity.
                  </Note>
                </div>
              </Card>

              <Card
                className="mb-4"
                title="Card adjustment"
                subtitle="Dual pricing — posted prices are card prices, cash customers pay less."
              >
                <div className="stack g-3">
                  <Field
                    label="Non-cash adjustment (%)"
                    hint="Added automatically at the register when a sale is paid by card. 0 turns it off, and the card networks cap it at 4%."
                  >
                    {(p) => (
                      <Input
                        {...p}
                        type="number"
                        min="0"
                        max="4"
                        step="0.5"
                        inputMode="decimal"
                        value={cardAdj}
                        onChange={(e) => setCardAdj(e.target.value)}
                      />
                    )}
                  </Field>
                  <div className="row wrap g-2">
                    <Button
                      icon="check"
                      loading={pending === "cardadj"}
                      onClick={async () => {
                        setPending("cardadj");
                        try {
                          const r = await fetch("/api/admin/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cardAdjustPercent: Number(cardAdj) }) });
                          if (!r.ok) {
                            const d = await r.json().catch(() => ({}));
                            toast.error("Couldn't save the card adjustment", String(d.error || ""));
                            return;
                          }
                          toast.success(
                            "Card adjustment saved",
                            Number(cardAdj) > 0
                              ? `Card sales add ${cardAdj}% at the register.`
                              : "Card and cash prices are the same again."
                          );
                        } finally { setPending(""); }
                      }}
                    >
                      Save adjustment
                    </Button>
                    <LinkButton href="/admin/dual-pricing-sign" variant="secondary" icon="print" external>
                      Print the disclosure sign
                    </LinkButton>
                  </div>
                  <Note tone="warn" title="The sign has to be up">
                    Because cash customers skip the adjustment, the disclosure sign belongs at the door and at the register.
                  </Note>
                </div>
              </Card>

              <Card
                className="mb-4"
                title="Self-checkout"
                subtitle="The scan-and-pay page at /shop."
                actions={<Badge tone={scPaused ? "warn" : "success"} dot>{scPaused ? "Paused" : "On"}</Badge>}
              >
                <Checkbox
                  checked={!scPaused}
                  onCheckedChange={async () => {
                    const r = await fetch("/api/admin/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ selfCheckoutPaused: !scPaused }) });
                    if (r.ok) {
                      setScPaused((p) => !p);
                      toast.success(
                        scPaused ? "Self-checkout is on" : "Self-checkout paused",
                        scPaused ? "Shoppers can scan and pay at /shop." : "Shoppers are sent to the register instead."
                      );
                    } else {
                      toast.error("Couldn't change self-checkout", "Nothing was saved — try again in a moment.");
                    }
                  }}
                  label="Let shoppers scan and pay themselves"
                  hint="Turning this off hides the whole page and tells shoppers to pay at the register. Individual vendors are switched on their own row under Vendors."
                />
              </Card>

              <Card
                className="mb-4"
                title="Booth rent rate"
                subtitle="Every booth prices at this rate times its square footage."
              >
                <div className="stack g-3">
                  <Field
                    label="Rate ($ per square foot per month)"
                    hint="$6 a square foot makes the standard 5 × 5 exactly $150. Changing it only affects rents you set from here on."
                  >
                    {(p) => (
                      <Input
                        {...p}
                        type="number"
                        min="0.5"
                        step="0.25"
                        inputMode="decimal"
                        value={rentPerSqft}
                        onChange={(e) => setRentPerSqft(Number(e.target.value))}
                      />
                    )}
                  </Field>
                  <DescList
                    items={[
                      { label: "4 × 4", value: <span className="num">{money(Math.round(16 * rentPerSqft * 100))}/mo</span> },
                      { label: "5 × 5", value: <span className="num">{money(Math.round(25 * rentPerSqft * 100))}/mo</span> },
                      { label: "5 × 10", value: <span className="num">{money(Math.round(50 * rentPerSqft * 100))}/mo</span> },
                      { label: "10 × 10", value: <span className="num">{money(Math.round(100 * rentPerSqft * 100))}/mo</span> },
                    ]}
                  />
                  <div>
                    <Button
                      icon="check"
                      loading={pending === "rate"}
                      onClick={async () => {
                        setPending("rate");
                        try { await saveRate(); } finally { setPending(""); }
                      }}
                    >
                      Save rate
                    </Button>
                  </div>
                  {rateMsg ? (
                    <Note tone="error" title="Couldn't save the rate">{rateMsg}</Note>
                  ) : null}
                </div>
              </Card>

              <Card
                className="mb-4"
                title="Public banner"
                subtitle="The announcement box on /apply and /market."
                actions={<Badge tone={banEnabled ? "success" : "neutral"} dot>{banEnabled ? "Showing" : "Hidden"}</Badge>}
              >
                <div className="stack g-3">
                  <Checkbox
                    checked={banEnabled}
                    onCheckedChange={setBanEnabled}
                    label="Show the banner"
                    hint="Untick and save to take it down. Nothing else on the public pages changes."
                  />
                  <Field label="Big line" hint="The headline — two or three words.">
                    {(p) => <Input {...p} value={banTitle} onChange={(e) => setBanTitle(e.target.value)} placeholder="Coming soon" />}
                  </Field>
                  <Field label="Second line" hint="A date reads well here.">
                    {(p) => <Input {...p} value={banDate} onChange={(e) => setBanDate(e.target.value)} placeholder="Expected grand opening — October 15, 2026 · 8:00 AM" />}
                  </Field>
                  <Field label="Small line" hint="One sentence telling people what to do next.">
                    {(p) => <Input {...p} value={banMessage} onChange={(e) => setBanMessage(e.target.value)} placeholder="Apply to get on the vendor list before the doors open." />}
                  </Field>
                  <div>
                    <Button
                      icon="check"
                      loading={pending === "banner"}
                      onClick={async () => {
                        setPending("banner");
                        try { await saveBanner(); } finally { setPending(""); }
                      }}
                    >
                      Save banner
                    </Button>
                  </div>
                  {banMsg ? (
                    <Note tone="error" title="Couldn't save the banner">{banMsg}</Note>
                  ) : null}
                </div>
              </Card>

              <Card
                className="mb-4"
                title="Register employees"
                subtitle="Anyone who can sign in and open or close the cash drawer."
              >
                <div className="stack g-4">
                  {!overview && employees.length === 0 ? (
                    <div className="stack g-2" aria-hidden>
                      <Skeleton width="45%" height={14} />
                      <Skeleton width="35%" height={14} />
                    </div>
                  ) : employees.length === 0 ? (
                    <EmptyState
                      icon="users"
                      title="Nobody can open the register yet"
                      body="Add yourself first — you'll need a name and a PIN to sign in at the register."
                    />
                  ) : (
                    <ul className="stack g-1" style={{ listStyle: "none", margin: 0, padding: 0 }}>
                      {employees.map((e) => (
                        <li
                          key={e.id}
                          className="row between g-2"
                          style={{ padding: "var(--sp-2) 0", borderBottom: "1px solid var(--border)" }}
                        >
                          <b className="truncate">{e.name}</b>
                          <Button size="sm" variant="ghost" icon="trash" onClick={() => removeEmployee(e)}>
                            Remove
                          </Button>
                        </li>
                      ))}
                    </ul>
                  )}

                  <div className="stack g-3">
                    <p className="t-label">Add or update someone</p>
                    <div className="grid-auto" style={{ ["--min" as string]: "180px" }}>
                      <Field label="Name" hint="Exactly how they'll type it at sign-in.">
                        {(p) => <Input {...p} value={newEmpName} onChange={(e) => setNewEmpName(e.target.value)} placeholder="Kalie" />}
                      </Field>
                      <Field label="PIN" hint="4 to 6 digits. Entering an existing name resets that person's PIN.">
                        {(p) => (
                          <Input
                            {...p}
                            value={newEmpPin}
                            onChange={(e) => setNewEmpPin(e.target.value)}
                            inputMode="numeric"
                            autoComplete="off"
                          />
                        )}
                      </Field>
                    </div>
                    <div>
                      <Button
                        icon="plus"
                        loading={pending === "employee"}
                        onClick={async () => {
                          setPending("employee");
                          try { await addEmployee(); } finally { setPending(""); }
                        }}
                      >
                        Save employee
                      </Button>
                    </div>
                    {empMsg ? (
                      <Note tone="error" title="Couldn't save that employee">{empMsg}</Note>
                    ) : null}
                  </div>
                </div>
              </Card>

              <Card
                title="Admin notifications"
                subtitle={adminPushDevices !== null ? `${plural(adminPushDevices, "device")} set up` : undefined}
              >
                <div className="stack g-3">
                  <p className="t-sm t-secondary">
                    Get a push on this device when a vendor application comes in, a complaint is filed,
                    a tent gets booked, or a pre-order is paid.
                  </p>
                  <div>
                    <Button
                      icon="bell"
                      loading={pending === "push"}
                      onClick={async () => {
                        setPending("push");
                        try { await enableAdminPush(); } finally { setPending(""); }
                      }}
                    >
                      Enable on this device
                    </Button>
                  </div>
                  {adminPushMsg ? (
                    <Note tone="warn" title="Not turned on here">{adminPushMsg}</Note>
                  ) : null}
                  <Note tone="info" title="On an iPhone">
                    Share → Add to Home Screen, open the admin app from that icon, then enable. iOS 16.4 or newer.
                  </Note>
                </div>
              </Card>
            </>
          );
        })()
      )}

            </>
          )}
        </main>
      </div>

      {/* --------------------------------------------------- mobile tab bar */}
      <nav className="tabbar no-print" aria-label="Admin sections">
        {primaryMobile.map((t) => (
          <button
            key={t}
            type="button"
            className="tabbar-item"
            aria-current={tab === t ? "page" : undefined}
            onClick={() => go(t)}
          >
            <span style={{ position: "relative", display: "block" }}>
              <Icon name={TAB_META[t].icon} size={20} />
              {navBadge[t] ? (
                <span
                  aria-hidden
                  style={{
                    position: "absolute", top: -3, right: -6,
                    minWidth: 15, height: 15, padding: "0 3px",
                    borderRadius: "var(--r-full)", background: "var(--danger)",
                    color: "#fff", fontSize: 9, fontWeight: 700,
                    display: "flex", alignItems: "center", justifyContent: "center",
                  }}
                >
                  {navBadge[t]}
                </span>
              ) : null}
            </span>
            <span>{TAB_META[t].label}</span>
          </button>
        ))}
        {moreGroups.length > 0 ? (
          <button
            type="button"
            className="tabbar-item"
            aria-expanded={moreOpen}
            aria-current={moreTabIds.includes(tab) ? "page" : undefined}
            onClick={() => setMoreOpen(true)}
          >
            <span style={{ position: "relative", display: "block" }}>
              <Icon name="more" size={20} />
              {moreCount > 0 ? (
                <span
                  aria-hidden
                  style={{
                    position: "absolute", top: -3, right: -6,
                    minWidth: 15, height: 15, padding: "0 3px",
                    borderRadius: "var(--r-full)", background: "var(--danger)",
                    color: "#fff", fontSize: 9, fontWeight: 700,
                    display: "flex", alignItems: "center", justifyContent: "center",
                  }}
                >
                  {moreCount}
                </span>
              ) : null}
            </span>
            <span>More</span>
          </button>
        ) : null}
      </nav>

      <Modal
        open={moreOpen}
        onClose={() => setMoreOpen(false)}
        title="All sections"
        width="sm"
      >
        <div className="stack g-3">
          {moreGroups.map((g) => (
            <div key={g.group}>
              <div className="nav-group-label">{g.group}</div>
              <div className="stack" style={{ gap: 2 }}>
                {g.items.map((i) =>
                  i.href ? (
                    /* A link, not a tab — the Applications workspace and the
                       kiosk are their own pages. Both were missing here. */
                    <a
                      key={i.id}
                      className="nav-item"
                      style={{ minHeight: 46 }}
                      href={i.href}
                      onClick={() => setMoreOpen(false)}
                    >
                      <Icon name={i.icon} size={17} />
                      <span className="truncate">{i.label}</span>
                      {navBadge[i.id] ? <span className="nav-item-count">{navBadge[i.id]}</span> : null}
                    </a>
                  ) : (
                    <button
                      key={i.id}
                      type="button"
                      className="nav-item"
                      style={{ minHeight: 46 }}
                      aria-current={tab === i.id ? "page" : undefined}
                      onClick={() => go(i.id as AdminTab)}
                    >
                      <Icon name={i.icon} size={17} />
                      <span className="truncate">{i.label}</span>
                      {navBadge[i.id] ? <span className="nav-item-count">{navBadge[i.id]}</span> : null}
                    </button>
                  )
                )}
              </div>
            </div>
          ))}
          <div className="divider mt-2 mb-2" />
          <button type="button" className="nav-item" style={{ minHeight: 46 }} onClick={staffLogout}>
            <Icon name="logout" size={17} />
            <span>Sign out</span>
          </button>
        </div>
      </Modal>

      {/* Agreement terms — reachable from both the Agreements panel and the
          Onboarding panel, so it lives outside the tab switch. */}
      <Modal
        open={!!termsForm}
        onClose={() => { setTermsForm(null); setTermsErr(""); }}
        title={termsForm?.mode === "void_and_reissue" ? "Send a corrected agreement" : "Edit agreement terms"}
        description={
          termsForm
            ? termsForm.mode === "void_and_reissue"
              ? `${termsForm.businessName} signs the corrected agreement — the old one is voided and kept on file.`
              : `${termsForm.businessName} hasn't signed yet, so these can still change.`
            : undefined
        }
        width="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => { setTermsForm(null); setTermsErr(""); }}>Cancel</Button>
            <Button
              variant={termsForm?.mode === "void_and_reissue" ? "danger" : "primary"}
              icon={termsForm?.mode === "void_and_reissue" ? "mail" : "check"}
              loading={busy}
              onClick={saveTerms}
            >
              {termsForm?.mode === "void_and_reissue" ? "Void and reissue" : "Save terms"}
            </Button>
          </>
        }
      >
        {termsForm ? (
          <div className="stack g-4">
            <Field label="Booth" hint="However you label it on the floor — A3, 5, NW corner." required>
              {(p) => (
                <Input
                  {...p}
                  value={termsForm.boothLabel}
                  onChange={(e) => setTermsForm((f) => f && ({ ...f, boothLabel: e.target.value }))}
                />
              )}
            </Field>

            <Field label="Monthly rent" hint="Charged on the 1st of every month." required>
              {(p) => (
                <MoneyInput
                  {...p}
                  value={termsForm.rent}
                  onChange={(e) => setTermsForm((f) => f && ({ ...f, rent: e.target.value }))}
                />
              )}
            </Field>

            <Field label="Start date" hint="The first month prorates from this day." required>
              {(p) => (
                <Input
                  {...p}
                  type="date"
                  value={termsForm.startDate}
                  onChange={(e) => setTermsForm((f) => f && ({ ...f, startDate: e.target.value }))}
                />
              )}
            </Field>

            {termsForm.mode === "void_and_reissue" ? (
              <Note tone="warn" title="This replaces the agreement they signed">
                Saving voids the signed agreement and emails {termsForm.businessName} a fresh one on these
                terms. Their booth isn&rsquo;t theirs again until they sign it.
              </Note>
            ) : null}

            {termsErr ? <Note tone="error">{termsErr}</Note> : null}
          </div>
        ) : null}
      </Modal>

      <Modal
        open={meOpen}
        onClose={() => setMeOpen(false)}
        title="My account"
        description={myAccount ? `${myAccount.name} · ${myAccount.roleLabel}` : undefined}
        footer={
          <div className="row wrap g-2">
            <Button variant="primary" icon="check" loading={busy} onClick={() => void saveMyAccount()}>Save</Button>
            <Button variant="ghost" onClick={() => setMeOpen(false)}>Cancel</Button>
          </div>
        }
      >
        <div className="stack g-4">
          {myAccount?.mustChangePassword ? (
            <Note tone="warn" title="Set your own password">
              You&rsquo;re still using the one that was generated for you. Anyone who saw that email can
              sign in as you until you change it.
            </Note>
          ) : null}

          <Field label="Email" hint="This is what you sign in with.">
            {(p) => (
              <Input
                {...p}
                type="email"
                inputMode="email"
                autoCapitalize="none"
                autoComplete="username"
                value={meEmail}
                onChange={(e) => { setMeEmail(e.target.value); setMeErr(""); }}
              />
            )}
          </Field>

          {myAccount?.hasPassword ? (
            <Field label="Current password" hint="Only needed if you're changing your password.">
              {(p) => (
                <Input
                  {...p}
                  type="password"
                  autoComplete="current-password"
                  value={meCurrent}
                  onChange={(e) => { setMeCurrent(e.target.value); setMeErr(""); }}
                />
              )}
            </Field>
          ) : null}

          <Field label="New password" hint="At least 8 characters. Leave blank to keep the one you have.">
            {(p) => (
              <Input
                {...p}
                type="password"
                autoComplete="new-password"
                value={meNew}
                onChange={(e) => { setMeNew(e.target.value); setMeErr(""); }}
              />
            )}
          </Field>

          {meErr ? <Note tone="error">{meErr}</Note> : null}
        </div>
      </Modal>

      <div id="printzone" ref={printRef}></div>
    </div>
  );
}

/* ==========================================================================
   Report export + hour labels
   The CSV is built from the report already in state — no new API surface,
   no server round-trip, and it matches exactly what's on screen.
   ========================================================================== */

function hourShort(hh: number) {
  return `${((hh + 11) % 12) + 1}${hh >= 12 ? "p" : "a"}`;
}

function hourLabel(hh: number) {
  return `${((hh + 11) % 12) + 1} ${hh >= 12 ? "PM" : "AM"}`;
}

function csvCell(v: string | number) {
  const s = String(v ?? "");
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function downloadReportCsv(r: Report, scopeLabel: string) {
  const d = (cents: number) => (cents / 100).toFixed(2);
  const rows: (string | number)[][] = [
    ["Sales report"],
    ["Scope", scopeLabel],
    ["Period start", r.start],
    ["Period end", r.end],
    [],
    ["Summary", "Amount"],
    ["Gross sales (pre-tax)", d(r.gross)],
    ["Tax collected", d(r.tax)],
    ["Cash taken", d(r.cash)],
    ["Card taken", d(r.card)],
    ["Refunds given back", d(r.refundTotal || 0)],
    ["Tickets", r.tickets],
    ["Units sold", r.units],
    ["Vendor gross", d(r.vGross)],
    ["Vendor net (after commission)", d(r.vNet)],
    [],
    ["By vendor", "Code", "Gross"],
    ...r.byVendor.map((v) => [v.vendor?.businessName || "Unknown vendor", v.vendor?.code || "", d(v.cents)]),
    [],
    ["By item", "Units", "Gross"],
    ...r.byItem.map((i) => [i.name, i.q, d(i.c)]),
    [],
    ["By hour", "Gross"],
    ...Object.keys(r.byHour || {})
      .sort((a, b) => Number(a) - Number(b))
      .map((h) => [hourLabel(Number(h)), d(r.byHour[h] || 0)]),
  ];
  const csv = rows.map((row) => row.map(csvCell).join(",")).join("\r\n");
  // The BOM keeps Excel from mangling the dashes in vendor names.
  const blob = new Blob([`\uFEFF${csv}`], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `sales-report-${r.start}-to-${r.end}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/* ==========================================================================
   Floor stock
   Owns its own search box so the filter state lives next to the table that
   uses it rather than in the page-level pile of hooks.
   ========================================================================== */

/**
 * Low stock is off unless a vendor turned it on, so there is no market-wide
 * threshold any more — only whatever each vendor asked for. A fixed rule
 * flagged every item of anyone selling one-of-a-kind work, where a quantity of
 * one is simply how it is.
 */
const isLow = (i: FloorItem): boolean => {
  const at = i.lowStockAt ?? 0;
  return at > 0 && i.quantity > 0 && i.quantity <= at;
};

function FloorStockCard({
  items,
  loading,
  month,
}: {
  items: FloorItem[];
  loading: boolean;
  month?: { count: number; totalCents: number; taxCents: number };
}) {
  const [q, setQ] = useState("");
  const query = q.trim().toLowerCase();
  const rows = query
    ? items.filter((i) => `${i.sku} ${i.name} ${i.vendorCode} ${i.vendorName}`.toLowerCase().includes(query))
    : items;

  const outCount = items.filter((i) => i.quantity === 0).length;
  const lowCount = items.filter(isLow).length;
  const unitCount = items.reduce((s, i) => s + i.quantity, 0);

  const columns: Column<FloorItem>[] = [
    {
      key: "item",
      header: "Item",
      primary: true,
      sortBy: (i) => i.name,
      cell: (i) => (
        <div className="stack g-1" style={{ minWidth: 0 }}>
          <b className="truncate">{i.name}</b>
          <span className="t-xs t-muted mono truncate">{i.sku}</span>
        </div>
      ),
    },
    {
      key: "vendor",
      header: "Vendor",
      hideBelow: 760,
      sortBy: (i) => i.vendorName,
      cell: (i) => (
        <span className="truncate">
          <span className="mono t-muted">{i.vendorCode}</span> {i.vendorName}
        </span>
      ),
    },
    {
      key: "price",
      header: "Price",
      align: "right",
      sortBy: (i) => i.priceCents,
      cell: (i) => <span className="num">{money(i.priceCents)}</span>,
    },
    {
      key: "qty",
      header: "On hand",
      align: "right",
      sortBy: (i) => i.quantity,
      cell: (i) =>
        i.quantity === 0 ? (
          <Badge tone="danger" dot>Out of stock</Badge>
        ) : isLow(i) ? (
          <Badge tone="warn" dot>Only {i.quantity} left</Badge>
        ) : (
          <span className="num">{i.quantity}</span>
        ),
    },
  ];

  return (
    <Card
      title="Everything on the floor"
      subtitle={loading ? "Loading…" : `${plural(items.length, "item")} · ${plural(unitCount, "unit")} on hand`}
      actions={
        outCount > 0 || lowCount > 0 ? (
          <>
            {lowCount > 0 ? <Badge tone="warn" dot>{lowCount} running low</Badge> : null}
            {outCount > 0 ? <Badge tone="danger" dot>{outCount} out of stock</Badge> : null}
          </>
        ) : undefined
      }
      footer={
        month ? (
          <span className="t-xs t-muted">
            This month: {money(month.totalCents)} across {plural(month.count, "sale")} · tax collected{" "}
            <b>{money(month.taxCents)}</b>
          </span>
        ) : undefined
      }
    >
      <div className="toolbar">
        <SearchInput
          className="grow"
          value={q}
          onValueChange={setQ}
          placeholder="Search item, code, or vendor…"
          aria-label="Search floor stock"
        />
      </div>
      <DataTable
        rows={rows}
        columns={columns}
        rowKey={(i) => i.id}
        loading={loading}
        skeletonRows={6}
        mobileCards
        caption="Every item on the market floor, with price and quantity on hand"
        empty={
          query ? (
            <EmptyState
              icon="search"
              title="Nothing matches that search"
              body="Try part of an item name, a product code, or a vendor code."
              action={<Button variant="secondary" onClick={() => setQ("")}>Clear search</Button>}
            />
          ) : (
            <EmptyState
              icon="grid"
              title="Nothing on the floor yet"
              body="Vendors add their own items from their portal — anything they list shows up here."
            />
          )
        }
      />
    </Card>
  );
}

/* ==========================================================================
   Customers
   ========================================================================== */

type CustomerRow = {
  id: string; email: string; phone: string; points: number; unsubscribed: boolean;
  follows: number; createdAt: string; saleCount: number; spentCents: number;
};

function CustomersCard({
  customers,
  loading,
  error,
  onRefresh,
}: {
  customers: CustomerRow[];
  loading: boolean;
  error: string;
  onRefresh: () => void;
}) {
  const [q, setQ] = useState("");
  const query = q.trim().toLowerCase();
  const rows = query
    ? customers.filter((c) => `${c.email || ""} ${c.phone || ""}`.toLowerCase().includes(query))
    : customers;

  const columns: Column<CustomerRow>[] = [
    {
      key: "contact",
      header: "Contact",
      primary: true,
      sortBy: (c) => c.email || c.phone || "",
      cell: (c) => (
        <div className="stack g-1" style={{ minWidth: 0 }}>
          <b className="truncate">{c.email || (c.phone ? fmtPhone(c.phone) : "—")}</b>
          {c.email && c.phone ? <span className="t-xs t-muted truncate">{fmtPhone(c.phone)}</span> : null}
        </div>
      ),
    },
    {
      key: "points",
      header: "Points",
      align: "right",
      sortBy: (c) => c.points,
      cell: (c) => (
        <span className={`num ${c.points >= 100 ? "t-accent" : ""}`}>
          <b>{c.points}</b>
        </span>
      ),
    },
    {
      key: "sales",
      header: "Sales",
      align: "right",
      hideBelow: 760,
      sortBy: (c) => c.saleCount,
      cell: (c) => <span className="num">{c.saleCount}</span>,
    },
    {
      key: "spent",
      header: "Spent",
      align: "right",
      sortBy: (c) => c.spentCents,
      cell: (c) => <span className="num">{money(c.spentCents)}</span>,
    },
    {
      key: "follows",
      header: "Follows",
      align: "right",
      hideBelow: 900,
      sortBy: (c) => c.follows,
      cell: (c) => <span className="num">{c.follows}</span>,
    },
    {
      key: "alerts",
      header: "Alerts",
      sortBy: (c) => (c.unsubscribed ? 1 : 0),
      cell: (c) =>
        c.unsubscribed ? <Badge tone="neutral" dot>Unsubscribed</Badge> : <Badge tone="success" dot>Subscribed</Badge>,
    },
  ];

  return (
    <Card
      title="Customers"
      subtitle={`${plural(customers.length, "rewards member")} · 1 point per $2, $5 off at 100 points`}
      actions={
        <Button size="sm" variant="ghost" icon="refresh" loading={loading} onClick={onRefresh}>
          Refresh
        </Button>
      }
      footer={
        <span className="t-xs t-muted">
          Everyone who&rsquo;s given an email or phone — at the register, at self-checkout, on a
          pre-order, or by following a vendor. Points are redeemed at the register.
        </span>
      }
    >
      {error ? (
        <div className="mb-4">
          <Note
            tone="error"
            title="Couldn't load customers"
            action={<Button size="sm" variant="secondary" icon="refresh" onClick={onRefresh}>Try again</Button>}
          >
            {error}
          </Note>
        </div>
      ) : null}
      <div className="toolbar">
        <SearchInput
          className="grow"
          value={q}
          onValueChange={setQ}
          placeholder="Search email or phone…"
          aria-label="Search customers"
        />
      </div>
      <DataTable
        rows={rows}
        columns={columns}
        rowKey={(c) => c.id}
        loading={loading && customers.length === 0}
        skeletonRows={6}
        defaultSort={{ key: "spent", dir: "desc" }}
        mobileCards
        caption="Rewards members, their points, and what they've spent"
        empty={
          query ? (
            <EmptyState
              icon="search"
              title="No customers match that search"
              body="Try part of an email address or a phone number."
              action={<Button variant="secondary" onClick={() => setQ("")}>Clear search</Button>}
            />
          ) : (
            <EmptyState
              icon="star"
              title="No customers yet"
              body="Anyone who leaves an email or phone at the register, at self-checkout, or on a pre-order is enrolled automatically."
            />
          )
        }
      />
    </Card>
  );
}
