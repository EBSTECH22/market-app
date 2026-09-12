const RESEND_URL = "https://api.resend.com/emails";
const FROM = process.env.EMAIL_FROM || "Community Harvest <orders@dailybreadbaked.com>";

function baseUrl() {
  return process.env.NEXT_PUBLIC_BASE_URL || "https://market.dailybreadbaked.com";
}

async function send(to: string, subject: string, html: string) {
  if (!process.env.RESEND_API_KEY) {
    console.warn("RESEND_API_KEY not set — email skipped:", subject);
    return;
  }
  const res = await fetch(RESEND_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ from: FROM, to, subject, html }),
  });
  if (!res.ok) console.error("Resend error", res.status, await res.text());
}

function shell(inner: string) {
  const name = process.env.MARKET_NAME || "Community Harvest";
  return `
  <div style="background:#f3f4f6;padding:28px 12px;font-family:-apple-system,'Segoe UI',Helvetica,Arial,sans-serif;color:#111827;">
    <div style="max-width:480px;margin:0 auto;background:#ffffff;border:1px solid #e5e7eb;border-radius:16px;padding:32px 28px;text-align:center;box-shadow:0 1px 3px rgba(0,0,0,0.06);">
      <img src="${baseUrl()}/wordmark-email.png" alt="${name}" width="210" style="width:210px;max-width:74%;height:auto;margin:0 auto 8px;display:block;" />
      <div style="font-weight:600;font-size:10px;letter-spacing:.16em;color:#9ca3af;margin-bottom:22px;">FOOD AND CRAFT MARKET \u00b7 NOBLE, OK</div>
      ${inner}
    </div>
    <div style="max-width:480px;margin:14px auto 0;text-align:center;font-size:11px;color:#9ca3af;">
      ${name} \u00b7 Main St, Noble, Oklahoma \ud83c\udf3e
    </div>
  </div>`;
}

export async function sendSaleEmail(
  vendor: { email: string; businessName: string },
  lines: { name: string; quantity: number; priceCents: number; vendorNetCents: number }[]
) {
  const rows = lines
    .map((l) => `${l.quantity}&times; ${l.name} &mdash; $${((l.priceCents * l.quantity) / 100).toFixed(2)}`)
    .join("<br>");
  const net = lines.reduce((n, l) => n + l.vendorNetCents, 0);
  const inner = `
    <h2 style="font-size:20px;font-weight:800;color:#111827;margin:0 0 8px;letter-spacing:-0.02em;">You made a sale! 🎉</h2>
    <div style="text-align:left;background:#fafafa;border:1px solid #e5e7eb;border-radius:12px;padding:16px 18px;margin-bottom:12px;">
      <div style="font-weight:600;font-size:14px;color:#111827;">${rows}</div>
      <div style="font-size:14px;font-weight:700;color:#111827;margin-top:8px;">Your net: $${(net / 100).toFixed(2)}</div>
    </div>
    <p style="font-size:12px;color:#9ca3af;margin:0;">Log in to see your live inventory and balance: <a href="${baseUrl()}">${baseUrl().replace("https://", "")}</a></p>`;
  await send(vendor.email, `You made a sale! ${lines[0].name}${lines.length > 1 ? " + more" : ""}`, shell(inner));
}

function installBlock(phoneType: string): string {
  const iphone = `
    <div style="text-align:left;background:#fafafa;border:1px solid #e5e7eb;border-radius:12px;padding:16px 18px;margin:10px 0;">
      <div style="font-weight:800;font-size:14px;margin-bottom:6px;">\ud83d\udcf1 Put the vendor app on your iPhone</div>
      <div style="font-size:13px;line-height:1.7;">
        1. Open <b>Safari</b> and go to <a href="${baseUrl()}">market.dailybreadbaked.com</a><br>
        2. Tap the <b>Share</b> button (square with the up arrow, bottom center)<br>
        3. Scroll down, tap <b>&ldquo;Add to Home Screen&rdquo;</b>, then <b>Add</b><br>
        4. Open the new icon and log in<br>
        5. For sale alerts: <b>\u2699\ufe0f SETTINGS \u2192 SALE ALERTS \u2192 TURN ON</b> (iOS 16.4+, from the icon only)
      </div>
    </div>`;
  const android = `
    <div style="text-align:left;background:#fafafa;border:1px solid #e5e7eb;border-radius:12px;padding:16px 18px;margin:10px 0;">
      <div style="font-weight:800;font-size:14px;margin-bottom:6px;">\ud83e\udd16 Put the vendor app on your Android</div>
      <div style="font-size:13px;line-height:1.7;">
        1. Open <b>Chrome</b> and go to <a href="${baseUrl()}">market.dailybreadbaked.com</a><br>
        2. Tap the <b>\u22ee menu</b> (top right)<br>
        3. Tap <b>&ldquo;Add to Home screen&rdquo;</b> (or <b>&ldquo;Install app&rdquo;</b>), then confirm<br>
        4. Open the new icon and log in<br>
        5. For sale alerts: <b>\u2699\ufe0f SETTINGS \u2192 SALE ALERTS \u2192 TURN ON</b>
      </div>
    </div>`;
  if (phoneType === "IPHONE") return iphone;
  if (phoneType === "ANDROID") return android;
  return `<p style="font-size:13px;color:#374151;">Want the portal as an app icon on your phone, with sale notifications? Follow the 2-minute guide: <a href="${baseUrl()}/guide"><b>${baseUrl().replace("https://", "")}/guide</b></a></p>`;
}

export async function sendWelcomeEmail(
  vendor: { email: string; businessName: string; code: string },
  tempPassword: string
) {
  const inner = `
    <h2 style="font-size:20px;font-weight:800;color:#111827;margin:0 0 8px;letter-spacing:-0.02em;">Welcome, ${vendor.businessName}!</h2>
    <p style="font-size:14px;color:#6b7280;">Your vendor account is ready. Log in to add items, set prices, and print your barcode labels.</p>
    <div style="text-align:left;background:#fafafa;border:1px solid #e5e7eb;border-radius:12px;padding:16px 18px;margin:10px 0;">
      <div style="font-size:14px;"><b>Login:</b> ${vendor.email}</div>
      <div style="font-size:14px;"><b>Temporary password:</b> ${tempPassword}</div>
      <div style="font-size:14px;"><b>Vendor code:</b> ${vendor.code}</div>
    </div>
    <br>
    <a href="${baseUrl()}" style="display:inline-block;background:#111827;color:#ffffff;font-weight:600;font-size:14px;padding:13px 26px;border-radius:10px;text-decoration:none;">Log in</a>
    <p style="font-size:12px;color:#9ca3af;margin-top:12px;">Please change your password after your first login.</p>`;
  await send(vendor.email, "Your vendor account is ready", shell(inner));
}

export async function sendPasswordResetEmail(
  vendor: { email: string; businessName: string },
  tempPassword: string
) {
  const inner = `
    <h2 style="font-size:20px;font-weight:800;color:#111827;margin:0 0 8px;letter-spacing:-0.02em;">Password reset</h2>
    <p style="font-size:14px;color:#6b7280;">Hi ${vendor.businessName} &mdash; here&rsquo;s your new temporary password for the vendor portal.</p>
    <div style="text-align:left;background:#fafafa;border:1px solid #e5e7eb;border-radius:12px;padding:16px 18px;margin:10px 0;">
      <div style="font-size:14px;"><b>Login:</b> ${vendor.email}</div>
      <div style="font-size:14px;"><b>Temporary password:</b> ${tempPassword}</div>
    </div>
    <br>
    <a href="${baseUrl()}" style="display:inline-block;background:#111827;color:#ffffff;font-weight:600;font-size:14px;padding:13px 26px;border-radius:10px;text-decoration:none;">Log in</a>
    <p style="font-size:12px;color:#9ca3af;margin-top:12px;">Please change it after you sign in.</p>`;
  await send(vendor.email, "Your password was reset", shell(inner));
}

export async function sendDailySummaryEmail(
  vendor: { email: string; businessName: string },
  day: string,
  lines: { name: string; quantity: number; grossCents: number }[],
  grossCents: number,
  netCents: number,
  refundNoteCents: number
) {
  const rows = lines
    .map((l) => `${l.quantity}&times; ${l.name} &mdash; $${(l.grossCents / 100).toFixed(2)}`)
    .join("<br>");
  const inner = `
    <h2 style="font-size:20px;font-weight:800;color:#111827;margin:0 0 8px;letter-spacing:-0.02em;">Your sales today &mdash; ${day}</h2>
    <div style="text-align:left;background:#fafafa;border:1px solid #e5e7eb;border-radius:12px;padding:16px 18px;margin-bottom:12px;">
      <div style="font-weight:600;font-size:14px;color:#111827;">${rows}</div>
      <div style="font-size:14px;color:#111827;margin-top:8px;border-top:1px solid #e5e7eb;padding-top:6px;">Gross: $${(grossCents / 100).toFixed(2)}</div>
      ${refundNoteCents > 0 ? `<div style="font-size:13px;color:#111827;">Refunds today: &minus;$${(refundNoteCents / 100).toFixed(2)}</div>` : ""}
      <div style="font-size:15px;font-weight:700;color:#111827;">Your net: $${(netCents / 100).toFixed(2)}</div>
    </div>
    <p style="font-size:12px;color:#9ca3af;margin:0;">Full detail and your running balance: <a href="${baseUrl()}">${baseUrl().replace("https://", "")}</a><br>Want instant alerts instead of this email? Log in and turn on Sale Alerts.</p>`;
  await send(vendor.email, `Your sales today at Community Harvest`, shell(inner));
}

const THREAD_LABEL: Record<string, string> = { PREORDER: "pre-order", REQUEST: "request", COMPLAINT: "complaint" };

export async function sendThreadLinkEmail(
  to: string, customerName: string, vendorName: string, type: string, token: string, isReply: boolean
) {
  const label = THREAD_LABEL[type] || "message";
  const url = `${baseUrl()}/t/${token}`;
  const inner = `
    <h2 style="font-size:20px;font-weight:800;color:#111827;margin:0 0 8px;letter-spacing:-0.02em;">${isReply ? `${vendorName} replied` : `Your ${label.toLowerCase()} was sent`}</h2>
    <p style="font-size:14px;color:#6b7280;">Hi ${customerName} &mdash; ${isReply ? `there&rsquo;s a new reply on your ${label} to ${vendorName}.` : `your ${label} went to ${vendorName}. Replies land on your private page:`}</p>
    <br>
    <a href="${url}" style="display:inline-block;background:#111827;color:#ffffff;font-weight:600;font-size:14px;padding:13px 26px;border-radius:10px;text-decoration:none;">View the conversation</a>
    <p style="font-size:12px;color:#9ca3af;margin-top:12px;">Keep this email &mdash; the link is your key to the conversation.</p>`;
  await send(to, isReply ? `${vendorName} replied to your ${label}` : `Your ${label} to ${vendorName}`, shell(inner));
}

export async function sendVendorInboxEmail(
  vendor: { email: string; businessName: string }, type: string, customerName: string
) {
  const label = THREAD_LABEL[type] || "message";
  const inner = `
    <h2 style="font-size:20px;font-weight:800;color:#111827;margin:0 0 8px;letter-spacing:-0.02em;">New ${label.toLowerCase()} 📩</h2>
    <p style="font-size:14px;color:#6b7280;">${customerName} sent you a ${label}. Reply from your vendor portal inbox.</p>
    <br>
    <a href="${baseUrl()}" style="display:inline-block;background:#111827;color:#ffffff;font-weight:600;font-size:14px;padding:13px 26px;border-radius:10px;text-decoration:none;">Open your inbox</a>`;
  await send(vendor.email, `New ${label} from ${customerName}`, shell(inner));
}

export async function sendPreorderAcceptedEmail(
  to: string, customerName: string, vendorName: string,
  description: string, totalCents: number, expectedDate: string, payToken: string, threadToken: string
) {
  const payUrl = `${baseUrl()}/pay/${payToken}`;
  const inner = `
    <h2 style="font-size:20px;font-weight:800;color:#111827;margin:0 0 8px;letter-spacing:-0.02em;">Pre-order accepted ✅</h2>
    <p style="font-size:14px;color:#6b7280;">Hi ${customerName} &mdash; ${vendorName} accepted your pre-order.</p>
    <div style="text-align:left;background:#fafafa;border:1px solid #e5e7eb;border-radius:12px;padding:16px 18px;margin:10px 0;">
      <div style="font-size:14px;">${description}</div>
      <div style="font-size:14px;margin-top:6px;"><b>Total (tax included): $${(totalCents / 100).toFixed(2)}</b></div>
      <div style="font-size:13px;">Ready/expected: <b>${expectedDate}</b></div>
    </div>
    <br>
    <a href="${payUrl}" style="display:inline-block;background:#111827;color:#ffffff;font-weight:600;font-size:14px;padding:13px 26px;border-radius:10px;text-decoration:none;">Pay now &mdash; secure online</a>
    <p style="font-size:12px;color:#9ca3af;margin-top:12px;">Card payment is handled by Stripe. Conversation: <a href="${baseUrl()}/t/${threadToken}">reply here</a>.</p>`;
  await send(to, `Pre-order accepted by ${vendorName} — pay online`, shell(inner));
}

export async function sendPreorderPaidEmail(
  to: string, customerName: string, vendorName: string,
  description: string, totalCents: number, expectedDate: string, threadToken: string
) {
  const inner = `
    <h2 style="font-size:20px;font-weight:800;color:#111827;margin:0 0 8px;letter-spacing:-0.02em;">Payment received ✅</h2>
    <p style="font-size:14px;color:#6b7280;">Thanks ${customerName} &mdash; your pre-order with ${vendorName} is paid and confirmed.</p>
    <div style="text-align:left;background:#fafafa;border:1px solid #e5e7eb;border-radius:12px;padding:16px 18px;margin:10px 0;">
      <div style="font-size:14px;">${description}</div>
      <div style="font-size:14px;margin-top:6px;"><b>Paid: $${(totalCents / 100).toFixed(2)}</b> (tax included)</div>
      <div style="font-size:13px;">Ready/expected: <b>${expectedDate}</b></div>
    </div>
    <p style="font-size:12px;color:#9ca3af;">Questions? <a href="${baseUrl()}/t/${threadToken}">Message ${vendorName} here</a>. Pick up at Community Harvest, Noble OK.</p>`;
  await send(to, `Paid ✓ — your pre-order with ${vendorName}`, shell(inner));
}

export async function sendApplicationReceivedEmail(to: string, contactName: string, businessName: string) {
  const inner = `
    <h2 style="font-size:20px;font-weight:800;color:#111827;margin:0 0 8px;letter-spacing:-0.02em;">Application received ✅</h2>
    <p style="font-size:14px;color:#6b7280;">Hi ${contactName} &mdash; we got your vendor application for <b>${businessName}</b>. We review every application personally and you&rsquo;ll hear back from us soon.</p>`;
  await send(to, "We got your vendor application — Community Harvest", shell(inner));
}

export async function sendApplicationDecisionEmail(to: string, contactName: string, businessName: string, accepted: boolean, reason: string) {
  const inner = accepted
    ? `
    <h2 style="font-size:20px;font-weight:800;color:#111827;margin:0 0 8px;letter-spacing:-0.02em;">Welcome to Community Harvest 🎉</h2>
    <p style="font-size:14px;color:#6b7280;">Hi ${contactName} &mdash; great news: <b>${businessName}</b> has been accepted as a vendor!</p>
    <div style="text-align:left;background:#fafafa;border:1px solid #e5e7eb;border-radius:12px;padding:16px 18px;margin:10px 0;">
      <b style="font-size:14px;">What happens next</b>
      <div style="font-size:13.5;margin-top:4px;">Someone from the market will be <b>calling you shortly</b> to get you set up with next steps &mdash; your booth, your vendor account, barcode labels, and your first market day.</div>
    </div>
    <p style="font-size:12px;color:#9ca3af;">Community Harvest — Food and Craft Market · Noble, Oklahoma</p>`
    : `
    <h2 style="font-size:20px;font-weight:800;color:#111827;margin:0 0 8px;letter-spacing:-0.02em;">About your application</h2>
    <p style="font-size:14px;color:#6b7280;">Hi ${contactName} &mdash; thank you for applying to Community Harvest with <b>${businessName}</b>. After careful review we aren&rsquo;t able to offer a booth right now.${reason ? `<br><br>${reason}` : ""}</p>
    <p style="font-size:13px;color:#6b7280;">Our vendor mix changes through the year &mdash; you&rsquo;re welcome to apply again down the road.</p>`;
  await send(to, accepted ? "You're in! Next steps — Community Harvest" : "Your Community Harvest application", shell(inner));
}

export async function sendTentConfirmEmail(to: string, name: string, date: string, token: string, viaCredit: boolean) {
  const inner = `
    <h2 style="font-size:20px;font-weight:800;color:#111827;margin:0 0 8px;letter-spacing:-0.02em;">Tent spot confirmed ⛺</h2>
    <p style="font-size:14px;color:#6b7280;">Hi ${name} &mdash; your outdoor tent spot at Community Harvest is booked for:</p>
    <div style="display:inline-block;background:#fafafa;border:1px solid #e5e7eb;border-radius:12px;padding:14px 20px;margin:8px 0;">
      <div style="font-size:17px;font-weight:900;">${date}</div>
      <div style="font-size:13px;margin-top:4px;">${viaCredit ? "Booked with your weather credit &mdash; deposit already covered." : "Deposit paid: $12.50"}</div>
      <div style="font-size:13px;"><b>Balance due at the front desk when you set up: $12.50</b> (day rate $25 total)</div>
    </div>
    <p style="font-size:12.5px;color:#6b7280;"><b>Bring your own tent and tables</b> &mdash; the market doesn&rsquo;t supply them. Your tent must be manned by you all day &mdash; outdoor sales are yours, hand to hand.
    Weather looking bad? If we call a weather day, your deposit converts to a credit good for any future date.</p>
    <p style="font-size:11px;color:#9ca3af;">Keep this email &mdash; your booking link: ${baseUrl()}/tents?manage=${token}</p>`;
  await send(to, `Tent spot confirmed — ${date}`, shell(inner));
}

export async function sendTentWeatherCreditEmail(to: string, name: string, date: string, token: string) {
  const inner = `
    <h2 style="font-size:20px;font-weight:800;color:#111827;margin:0 0 8px;letter-spacing:-0.02em;">Weather day — your deposit is safe ⛈</h2>
    <p style="font-size:14px;color:#6b7280;">Hi ${name} &mdash; we called a weather day for <b>${date}</b>, so outdoor tents are off.
    Your $12.50 deposit is now a <b>credit good for any future tent date</b> &mdash; pick a new day and it books with no new deposit:</p>
    <br>
    <a href="${baseUrl()}/tents?credit=${token}" style="display:inline-block;background:#111827;color:#ffffff;font-weight:600;font-size:14px;padding:13px 26px;border-radius:10px;text-decoration:none;">Pick a new date</a>`;
  await send(to, `Weather day — your tent deposit became a credit`, shell(inner));
}

export async function sendSelfCheckoutReceiptEmail(
  to: string, number: number,
  lines: { name: string; quantity: number; priceCents: number }[],
  subtotalCents: number, taxCents: number, totalCents: number
) {
  const rows = lines.map((l) => `<div style="display:flex;justify-content:space-between;font-size:13.5px;padding:3px 0;"><span>${l.quantity}&times; ${l.name}</span><b>$${((l.priceCents * l.quantity) / 100).toFixed(2)}</b></div>`).join("");
  const inner = `
    <h2 style="font-size:20px;font-weight:800;color:#111827;margin:0 0 8px;letter-spacing:-0.02em;">Receipt #${number} ✅</h2>
    <p style="font-size:14px;color:#6b7280;">Thanks for shopping Community Harvest! Here&rsquo;s your self-checkout receipt.</p>
    <div style="text-align:left;background:#fafafa;border:1px solid #e5e7eb;border-radius:12px;padding:16px 18px;margin:8px 0;min-width:240px;">
      ${rows}
      <div style="border-top:1px solid #e5e7eb;margin-top:6px;padding-top:6px;font-size:13.5px;display:flex;justify-content:space-between;"><span>Subtotal</span><b>$${(subtotalCents / 100).toFixed(2)}</b></div>
      <div style="font-size:13.5px;display:flex;justify-content:space-between;"><span>Sales tax</span><b>$${(taxCents / 100).toFixed(2)}</b></div>
      <div style="font-size:15px;display:flex;justify-content:space-between;"><span><b>TOTAL</b></span><b>$${(totalCents / 100).toFixed(2)}</b></div>
    </div>
    <p style="font-size:12px;color:#9ca3af;">Community Harvest — Food and Craft Market · Noble, Oklahoma</p>`;
  await send(to, `Receipt #${number} — Community Harvest`, shell(inner));
}

export async function sendContractSignEmail(to: string, businessName: string, link: string) {
  const inner = `
    <h2 style="font-size:20px;font-weight:800;color:#111827;margin:0 0 8px;letter-spacing:-0.02em;">Your booth contract is ready \u270d\ufe0f</h2>
    <p style="font-size:14px;color:#374151;">Hi ${businessName} — your Community Harvest booth rental agreement is ready to review and sign. The packet includes your agreement, your application, and the Market Rules.</p>
    <p style="margin:18px 0;"><a href="${link}" style="background:#111827;color:#ffffff;padding:13px 26px;text-decoration:none;font-weight:600;font-size:14px;border-radius:10px;display:inline-block;">Review &amp; sign</a></p>
    <p style="font-size:12px;color:#9ca3af;">Sign right on your phone with your finger. This link is private to you — don&rsquo;t forward it. Questions? Just reply to this email.</p>`;
  await send(to, "Your booth contract is ready to sign — Community Harvest", shell(inner));
}

export async function sendExecutedContractEmail(to: string, businessName: string, link: string, phoneType: string = "") {
  const inner = `
    <h2 style="font-size:20px;font-weight:800;color:#111827;margin:0 0 8px;letter-spacing:-0.02em;">Your contract is fully signed \u2705</h2>
    <p style="font-size:14px;color:#374151;">Hi ${businessName} — both you and Community Harvest have signed your booth rental agreement. It&rsquo;s official! Your copy (agreement, application, and Market Rules, with both signatures) is at the link below — open it anytime, and use the print button to save a PDF for your records.</p>
    <p style="margin:18px 0;"><a href="${link}" style="background:#111827;color:#ffffff;padding:13px 26px;text-decoration:none;font-weight:600;font-size:14px;border-radius:10px;display:inline-block;">View &amp; print my signed contract</a></p>
    <p style="font-size:12px;color:#9ca3af;">Welcome to the vendor family. \ud83c\udf3e</p>
    ${installBlock(phoneType)}
    <p style="font-size:12px;color:#9ca3af;">Full guide for either phone, anytime: <a href="${baseUrl()}/guide">${baseUrl().replace("https://", "")}/guide</a></p>`;
  await send(to, "Fully signed — your Community Harvest booth contract \u2705", shell(inner));
}

export async function sendSetupGuideEmail(to: string, businessName: string, phoneType: string = "") {
  const inner = `
    <h2 style="font-size:20px;font-weight:800;color:#111827;margin:0 0 8px;letter-spacing:-0.02em;">Your vendor setup guide \ud83c\udf3e</h2>
    <p style="font-size:14px;color:#374151;">Hi ${businessName} — here&rsquo;s your Community Harvest setup guide again: how to put the vendor app on your phone, add products, print barcode labels, and run your booth.</p>
    <p style="margin:14px 0 4px;"><a href="${baseUrl()}" style="background:#111827;color:#ffffff;padding:13px 26px;text-decoration:none;font-weight:600;font-size:14px;border-radius:10px;display:inline-block;">🔑 Open your vendor portal</a></p>
    ${installBlock(phoneType)}
    <p style="margin:16px 0;"><a href="${baseUrl()}/guide" style="background:#111827;color:#ffffff;padding:13px 26px;text-decoration:none;font-weight:600;font-size:14px;border-radius:10px;display:inline-block;">Open the full guide</a></p>
    <p style="font-size:12px;color:#9ca3af;">Covers everything: products, labels (and which sticker sheets to buy), restocking, pre-orders, your public page, and getting paid. Stuck? Just reply to this email.</p>`;
  await send(to, "Your vendor setup guide — Community Harvest", shell(inner));
}

export async function sendCustomerReceiptEmail(
  to: string, number: number,
  lines: { name: string; quantity: number; priceCents: number }[],
  subtotalCents: number, taxCents: number, discountCents: number, totalCents: number, points: number, saleSavingsCents: number = 0
) {
  const rows = lines.map((l) => `<div style="display:flex;justify-content:space-between;font-size:13.5px;padding:3px 0;"><span>${l.quantity}&times; ${l.name}</span><b>$${((l.priceCents * l.quantity) / 100).toFixed(2)}</b></div>`).join("");
  const toGo = Math.max(0, 100 - (points % 100));
  const inner = `
    <h2 style="font-size:20px;font-weight:800;color:#111827;margin:0 0 8px;letter-spacing:-0.02em;">Receipt #${number} \u2705</h2>
    <p style="font-size:14px;color:#6b7280;margin:0 0 14px;">Thanks for shopping local!</p>
    <div style="text-align:left;background:#fafafa;border:1px solid #e5e7eb;border-radius:12px;padding:16px 18px;margin-bottom:14px;">
      ${rows}
      <div style="border-top:1px solid #e5e7eb;margin-top:8px;padding-top:8px;font-size:13.5px;display:flex;justify-content:space-between;"><span>Subtotal</span><b>$${((subtotalCents + saleSavingsCents) / 100).toFixed(2)}</b></div>
      ${saleSavingsCents > 0 ? `<div style="font-size:13.5px;display:flex;justify-content:space-between;color:#b91c1c;"><span>\ud83c\udff7\ufe0f Sale savings</span><b>\u2212$${(saleSavingsCents / 100).toFixed(2)}</b></div>` : ""}
      <div style="font-size:13.5px;display:flex;justify-content:space-between;"><span>Sales tax</span><b>$${(taxCents / 100).toFixed(2)}</b></div>
      ${discountCents > 0 ? `<div style="font-size:13.5px;display:flex;justify-content:space-between;color:#15803d;"><span>Rewards discount</span><b>\u2212$${(discountCents / 100).toFixed(2)}</b></div>` : ""}
      <div style="font-size:15px;display:flex;justify-content:space-between;"><span><b>Total</b></span><b>$${(totalCents / 100).toFixed(2)}</b></div>
    </div>
    <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:12px;padding:12px 16px;">
      <div style="font-size:14px;color:#15803d;"><b>\u2b50 You have ${points} reward points</b></div>
      <div style="font-size:12px;color:#374151;margin-top:2px;">${points >= 100 ? "You&rsquo;ve earned $5 off — just say so at the register!" : `${toGo} more points and $5 comes off your next visit. You earn 1 point per $2.`}</div>
    </div>`;
  await send(to, `Receipt #${number} — Community Harvest`, shell(inner));
}

export async function sendFollowConfirmEmail(to: string, businessName: string, code: string, token: string) {
  const inner = `
    <div style="font-size:34px;line-height:1;">\ud83d\udd14</div>
    <h2 style="font-size:20px;font-weight:800;color:#111827;margin:6px 0 8px;letter-spacing:-0.02em;">You&rsquo;re following ${businessName}</h2>
    <p style="font-size:14px;color:#6b7280;margin:0 0 16px;">We&rsquo;ll email you when they restock at Community Harvest — at most one heads-up a day, only when there&rsquo;s something on the shelf.</p>
    <a href="${baseUrl()}/v/${code}" style="display:inline-block;background:#111827;color:#ffffff;font-weight:600;font-size:14px;padding:13px 26px;border-radius:10px;text-decoration:none;">See their booth</a>
    <p style="font-size:11px;color:#9ca3af;margin:16px 0 0;"><a href="${baseUrl()}/u/${token}" style="color:#9ca3af;">Unsubscribe from all alerts</a></p>`;
  await send(to, `Following ${businessName} — Community Harvest`, shell(inner));
}

export async function sendRestockAlertEmail(to: string, businessName: string, code: string, items: { name: string; priceCents: number }[], token: string) {
  const rows = items.map((i) => `<div style="font-size:13.5px;padding:3px 0;display:flex;justify-content:space-between;"><span>${i.name}</span><b>$${(i.priceCents / 100).toFixed(2)}</b></div>`).join("");
  const inner = `
    <div style="font-size:34px;line-height:1;">\ud83c\udf3e</div>
    <h2 style="font-size:20px;font-weight:800;color:#111827;margin:6px 0 8px;letter-spacing:-0.02em;">${businessName} just restocked!</h2>
    <p style="font-size:14px;color:#6b7280;margin:0 0 14px;">Fresh on the shelf right now at Community Harvest, Mon&ndash;Sat 8&ndash;6:</p>
    <div style="text-align:left;background:#fafafa;border:1px solid #e5e7eb;border-radius:12px;padding:16px 18px;margin-bottom:16px;">${rows}</div>
    <a href="${baseUrl()}/v/${code}" style="display:inline-block;background:#111827;color:#ffffff;font-weight:600;font-size:14px;padding:13px 26px;border-radius:10px;text-decoration:none;">See what&rsquo;s on their shelf</a>
    <p style="font-size:11px;color:#9ca3af;margin:16px 0 0;"><a href="${baseUrl()}/u/${token}" style="color:#9ca3af;">Unsubscribe</a></p>`;
  await send(to, `${businessName} just restocked \ud83c\udf3e`, shell(inner));
}
