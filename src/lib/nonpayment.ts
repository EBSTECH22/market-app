/**
 * The non-payment notice — wording and phone plumbing.
 *
 * Pure on purpose: the admin screen builds the text message in the browser and
 * the server builds the email, and both import from here so the two can never
 * disagree about the amount, the deadline or the words. A vendor who gets an
 * email saying Wednesday and a text saying Thursday has a genuine argument.
 *
 * WHY EMAIL AND TEXT. Section 13 of the vendor agreement says written notice is
 * effective when sent by email to the address on file, or hand-delivered. A
 * text is not notice under the agreement — it is the heads-up that makes sure
 * the notice gets read. So the email is the record and the text is the nudge,
 * and the admin screen always does both.
 */

export const DEADLINE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * "11:59 PM on Wednesday, September 23".
 *
 * 11:59 PM rather than "midnight on the 23rd", because half of people read
 * midnight on the 23rd as the moment the 23rd begins, and that is exactly the
 * argument you don't want at 12:30 AM.
 *
 * Parsed at noon UTC and formatted in UTC so the weekday can't slide a day
 * either side depending on where the code runs.
 */
export function deadlineLabel(ymd: string): string {
  if (!DEADLINE_RE.test(ymd)) return ymd;
  const [y, m, d] = ymd.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d, 12));
  const day = date.toLocaleDateString("en-US", {
    weekday: "long", month: "long", day: "numeric", timeZone: "UTC",
  });
  return `11:59 PM on ${day}`;
}

/** The last instant of that day, Central, for "is this deadline already gone". */
export function deadlinePassed(ymd: string, now = new Date()): boolean {
  if (!DEADLINE_RE.test(ymd)) return true;
  const today = now.toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
  return ymd < today;
}

export function firstName(contactName: string, fallback: string): string {
  const first = String(contactName || "").trim().split(/\s+/)[0];
  return first || fallback;
}

const dollars = (cents: number) =>
  `$${(cents / 100).toFixed(2).replace(/\.00$/, "")}`;

export function payUrl(base: string, token: string): string {
  return `${base.replace(/\/$/, "")}/rent/${token}`;
}

/**
 * The text message. Kept under two SMS segments where it can be, because a
 * long text arrives in pieces on some phones and the pay link is the piece that
 * gets split.
 */
export function smsBody(opts: {
  contactName: string;
  businessName: string;
  amountCents: number;
  deadline: string;
  link: string;
  signer: string;
}): string {
  const who = firstName(opts.contactName, opts.businessName);
  /* The link sits on its own line: a URL run straight into the next sentence,
     or followed by a full stop, is how phones end up linking to the wrong
     address. */
  return (
    `Hi ${who}, it's ${opts.signer} with Community Harvest. ` +
    `Your booth agreement is signed, but we haven't received your payment of ${dollars(opts.amountCents)}. ` +
    `Please pay by ${deadlineLabel(opts.deadline)} to keep your space:\n` +
    `${opts.link}\n\n` +
    `After that I'll need to offer it to the next vendor on our waiting list. ` +
    `I've emailed you this notice too. If something's come up, just reply.`
  );
}

/**
 * A phone number a messaging app will accept: +1 and ten digits for US numbers,
 * digits only otherwise. Empty when there's nothing usable.
 */
export function smsNumber(raw: string): string {
  const d = String(raw || "").replace(/\D/g, "");
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d.startsWith("1")) return `+${d}`;
  return d.length >= 7 ? d : "";
}

/**
 * An sms: link that opens Messages with the number and text filled in.
 *
 * iPhones want `&body=`, Android wants `?body=`. Getting it wrong doesn't fail
 * loudly — the thread opens with an empty box — so it's picked per platform
 * rather than trusting either form everywhere.
 */
export function smsHref(number: string, body: string, isApple: boolean): string {
  const sep = isApple ? "&" : "?";
  return `sms:${number}${sep}body=${encodeURIComponent(body)}`;
}
