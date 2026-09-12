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
  <div style="background:#f2f2f2;padding:30px 12px;font-family:'Courier New',monospace;color:#000;">
    <div style="max-width:480px;margin:0 auto;background:#fff;border:1px solid #000;padding:28px 24px;text-align:center;">
      <img src="${baseUrl()}/logo.png" alt="" width="96" height="96" style="width:96px;height:96px;margin-bottom:8px;" />
      <div style="font-weight:700;font-size:21px;letter-spacing:.01em;">${name.toUpperCase()}</div>
      <div style="font-weight:700;font-size:10px;letter-spacing:.14em;border-bottom:2px solid #000;padding-bottom:12px;margin-bottom:16px;">FOOD AND CRAFT MARKET</div>
      ${inner}
    </div>
    <div style="max-width:480px;margin:10px auto 0;text-align:center;font-size:11px;color:#555;">
      ${name} · Noble, Oklahoma
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
    <h2 style="font-size:19px;font-weight:900;color:#000;margin:0 0 8px;">YOU MADE A SALE! 🎉</h2>
    <div style="display:inline-block;text-align:left;background:#fff;border:1px dashed #000;padding:12px 18px;margin-bottom:12px;">
      <div style="font-weight:600;font-size:14px;color:#000;">${rows}</div>
      <div style="font-size:14px;font-weight:700;color:#000;margin-top:8px;">Your net: $${(net / 100).toFixed(2)}</div>
    </div>
    <p style="font-size:12px;color:#777;margin:0;">Log in to see your live inventory and balance: <a href="${baseUrl()}">${baseUrl().replace("https://", "")}</a></p>`;
  await send(vendor.email, `You made a sale! ${lines[0].name}${lines.length > 1 ? " + more" : ""}`, shell(inner));
}

function installBlock(phoneType: string): string {
  const iphone = `
    <div style="text-align:left;background:#fff;border:1px dashed #000;padding:12px 18px;margin:10px 0;">
      <div style="font-weight:800;font-size:14px;margin-bottom:6px;">\ud83d\udcf1 PUT THE VENDOR APP ON YOUR IPHONE</div>
      <div style="font-size:13px;line-height:1.7;">
        1. Open <b>Safari</b> and go to <a href="${baseUrl()}">market.dailybreadbaked.com</a><br>
        2. Tap the <b>Share</b> button (square with the up arrow, bottom center)<br>
        3. Scroll down, tap <b>&ldquo;Add to Home Screen&rdquo;</b>, then <b>Add</b><br>
        4. Open the new icon and log in<br>
        5. For sale alerts: <b>\u2699\ufe0f SETTINGS \u2192 SALE ALERTS \u2192 TURN ON</b> (iOS 16.4+, from the icon only)
      </div>
    </div>`;
  const android = `
    <div style="text-align:left;background:#fff;border:1px dashed #000;padding:12px 18px;margin:10px 0;">
      <div style="font-weight:800;font-size:14px;margin-bottom:6px;">\ud83e\udd16 PUT THE VENDOR APP ON YOUR ANDROID</div>
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
  return `<p style="font-size:13px;color:#333;">Want the portal as an app icon on your phone, with sale notifications? Follow the 2-minute guide: <a href="${baseUrl()}/install"><b>${baseUrl().replace("https://", "")}/install</b></a></p>`;
}

export async function sendWelcomeEmail(
  vendor: { email: string; businessName: string; code: string },
  tempPassword: string
) {
  const inner = `
    <h2 style="font-size:19px;font-weight:900;color:#000;margin:0 0 8px;">WELCOME, ${vendor.businessName.toUpperCase()}!</h2>
    <p style="font-size:14px;color:#555;">Your vendor account is ready. Log in to add items, set prices, and print your barcode labels.</p>
    <div style="display:inline-block;text-align:left;background:#fff;border:1px dashed #000;padding:12px 18px;margin:10px 0;">
      <div style="font-size:14px;"><b>Login:</b> ${vendor.email}</div>
      <div style="font-size:14px;"><b>Temporary password:</b> ${tempPassword}</div>
      <div style="font-size:14px;"><b>Vendor code:</b> ${vendor.code}</div>
    </div>
    <br>
    <a href="${baseUrl()}" style="display:inline-block;background:#000;color:#fff;font-weight:800;font-size:15px;padding:14px 26px;border-radius:0;text-decoration:none;">LOG IN</a>
    <p style="font-size:12px;color:#999;margin-top:12px;">Please change your password after your first login.</p>`;
  await send(vendor.email, "Your vendor account is ready", shell(inner));
}

export async function sendPasswordResetEmail(
  vendor: { email: string; businessName: string },
  tempPassword: string
) {
  const inner = `
    <h2 style="font-size:19px;font-weight:900;color:#000;margin:0 0 8px;">PASSWORD RESET</h2>
    <p style="font-size:14px;color:#555;">Hi ${vendor.businessName} &mdash; here&rsquo;s your new temporary password for the vendor portal.</p>
    <div style="display:inline-block;text-align:left;background:#fff;border:1px dashed #000;padding:12px 18px;margin:10px 0;">
      <div style="font-size:14px;"><b>Login:</b> ${vendor.email}</div>
      <div style="font-size:14px;"><b>Temporary password:</b> ${tempPassword}</div>
    </div>
    <br>
    <a href="${baseUrl()}" style="display:inline-block;background:#000;color:#fff;font-weight:800;font-size:15px;padding:14px 26px;border-radius:0;text-decoration:none;">LOG IN</a>
    <p style="font-size:12px;color:#999;margin-top:12px;">Please change it after you sign in.</p>`;
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
    <h2 style="font-size:19px;font-weight:900;color:#000;margin:0 0 8px;">YOUR SALES TODAY &mdash; ${day}</h2>
    <div style="display:inline-block;text-align:left;background:#fff;border:1px dashed #000;padding:12px 18px;margin-bottom:12px;">
      <div style="font-weight:600;font-size:14px;color:#000;">${rows}</div>
      <div style="font-size:14px;color:#000;margin-top:8px;border-top:1px solid #000;padding-top:6px;">Gross: $${(grossCents / 100).toFixed(2)}</div>
      ${refundNoteCents > 0 ? `<div style="font-size:13px;color:#000;">Refunds today: &minus;$${(refundNoteCents / 100).toFixed(2)}</div>` : ""}
      <div style="font-size:15px;font-weight:700;color:#000;">Your net: $${(netCents / 100).toFixed(2)}</div>
    </div>
    <p style="font-size:12px;color:#777;margin:0;">Full detail and your running balance: <a href="${baseUrl()}">${baseUrl().replace("https://", "")}</a><br>Want instant alerts instead of this email? Log in and turn on Sale Alerts.</p>`;
  await send(vendor.email, `Your sales today at Community Harvest`, shell(inner));
}

const THREAD_LABEL: Record<string, string> = { PREORDER: "pre-order", REQUEST: "request", COMPLAINT: "complaint" };

export async function sendThreadLinkEmail(
  to: string, customerName: string, vendorName: string, type: string, token: string, isReply: boolean
) {
  const label = THREAD_LABEL[type] || "message";
  const url = `${baseUrl()}/t/${token}`;
  const inner = `
    <h2 style="font-size:19px;font-weight:900;color:#000;margin:0 0 8px;">${isReply ? `${vendorName} REPLIED` : `YOUR ${label.toUpperCase()} WAS SENT`}</h2>
    <p style="font-size:14px;color:#555;">Hi ${customerName} &mdash; ${isReply ? `there&rsquo;s a new reply on your ${label} to ${vendorName}.` : `your ${label} went to ${vendorName}. Replies land on your private page:`}</p>
    <br>
    <a href="${url}" style="display:inline-block;background:#000;color:#fff;font-weight:800;font-size:15px;padding:14px 26px;border-radius:0;text-decoration:none;">VIEW THE CONVERSATION</a>
    <p style="font-size:12px;color:#999;margin-top:12px;">Keep this email &mdash; the link is your key to the conversation.</p>`;
  await send(to, isReply ? `${vendorName} replied to your ${label}` : `Your ${label} to ${vendorName}`, shell(inner));
}

export async function sendVendorInboxEmail(
  vendor: { email: string; businessName: string }, type: string, customerName: string
) {
  const label = THREAD_LABEL[type] || "message";
  const inner = `
    <h2 style="font-size:19px;font-weight:900;color:#000;margin:0 0 8px;">NEW ${label.toUpperCase()} 📩</h2>
    <p style="font-size:14px;color:#555;">${customerName} sent you a ${label}. Reply from your vendor portal inbox.</p>
    <br>
    <a href="${baseUrl()}" style="display:inline-block;background:#000;color:#fff;font-weight:800;font-size:15px;padding:14px 26px;border-radius:0;text-decoration:none;">OPEN YOUR INBOX</a>`;
  await send(vendor.email, `New ${label} from ${customerName}`, shell(inner));
}

export async function sendPreorderAcceptedEmail(
  to: string, customerName: string, vendorName: string,
  description: string, totalCents: number, expectedDate: string, payToken: string, threadToken: string
) {
  const payUrl = `${baseUrl()}/pay/${payToken}`;
  const inner = `
    <h2 style="font-size:19px;font-weight:900;color:#000;margin:0 0 8px;">PRE-ORDER ACCEPTED ✅</h2>
    <p style="font-size:14px;color:#555;">Hi ${customerName} &mdash; ${vendorName} accepted your pre-order.</p>
    <div style="display:inline-block;text-align:left;background:#fff;border:1px dashed #000;padding:12px 18px;margin:10px 0;">
      <div style="font-size:14px;">${description}</div>
      <div style="font-size:14px;margin-top:6px;"><b>Total (tax included): $${(totalCents / 100).toFixed(2)}</b></div>
      <div style="font-size:13px;">Ready/expected: <b>${expectedDate}</b></div>
    </div>
    <br>
    <a href="${payUrl}" style="display:inline-block;background:#000;color:#fff;font-weight:800;font-size:15px;padding:14px 26px;border-radius:0;text-decoration:none;">PAY NOW &mdash; SECURE ONLINE</a>
    <p style="font-size:12px;color:#999;margin-top:12px;">Card payment is handled by Stripe. Conversation: <a href="${baseUrl()}/t/${threadToken}">reply here</a>.</p>`;
  await send(to, `Pre-order accepted by ${vendorName} — pay online`, shell(inner));
}

export async function sendPreorderPaidEmail(
  to: string, customerName: string, vendorName: string,
  description: string, totalCents: number, expectedDate: string, threadToken: string
) {
  const inner = `
    <h2 style="font-size:19px;font-weight:900;color:#000;margin:0 0 8px;">PAYMENT RECEIVED ✅</h2>
    <p style="font-size:14px;color:#555;">Thanks ${customerName} &mdash; your pre-order with ${vendorName} is paid and confirmed.</p>
    <div style="display:inline-block;text-align:left;background:#fff;border:1px dashed #000;padding:12px 18px;margin:10px 0;">
      <div style="font-size:14px;">${description}</div>
      <div style="font-size:14px;margin-top:6px;"><b>Paid: $${(totalCents / 100).toFixed(2)}</b> (tax included)</div>
      <div style="font-size:13px;">Ready/expected: <b>${expectedDate}</b></div>
    </div>
    <p style="font-size:12px;color:#999;">Questions? <a href="${baseUrl()}/t/${threadToken}">Message ${vendorName} here</a>. Pick up at Community Harvest, Noble OK.</p>`;
  await send(to, `Paid ✓ — your pre-order with ${vendorName}`, shell(inner));
}

export async function sendApplicationReceivedEmail(to: string, contactName: string, businessName: string) {
  const inner = `
    <h2 style="font-size:19px;font-weight:900;color:#000;margin:0 0 8px;">APPLICATION RECEIVED ✅</h2>
    <p style="font-size:14px;color:#555;">Hi ${contactName} &mdash; we got your vendor application for <b>${businessName}</b>. We review every application personally and you&rsquo;ll hear back from us soon.</p>`;
  await send(to, "We got your vendor application — Community Harvest", shell(inner));
}

export async function sendApplicationDecisionEmail(to: string, contactName: string, businessName: string, accepted: boolean, reason: string) {
  const inner = accepted
    ? `
    <h2 style="font-size:19px;font-weight:900;color:#000;margin:0 0 8px;">WELCOME TO COMMUNITY HARVEST 🎉</h2>
    <p style="font-size:14px;color:#555;">Hi ${contactName} &mdash; great news: <b>${businessName}</b> has been accepted as a vendor!</p>
    <div style="display:inline-block;text-align:left;background:#fff;border:1px dashed #000;padding:12px 18px;margin:10px 0;">
      <b style="font-size:14px;">What happens next</b>
      <div style="font-size:13.5;margin-top:4px;">Someone from the market will be <b>calling you shortly</b> to get you set up with next steps &mdash; your booth, your vendor account, barcode labels, and your first market day.</div>
    </div>
    <p style="font-size:12px;color:#999;">Community Harvest — Food and Craft Market · Noble, Oklahoma</p>`
    : `
    <h2 style="font-size:19px;font-weight:900;color:#000;margin:0 0 8px;">ABOUT YOUR APPLICATION</h2>
    <p style="font-size:14px;color:#555;">Hi ${contactName} &mdash; thank you for applying to Community Harvest with <b>${businessName}</b>. After careful review we aren&rsquo;t able to offer a booth right now.${reason ? `<br><br>${reason}` : ""}</p>
    <p style="font-size:13px;color:#555;">Our vendor mix changes through the year &mdash; you&rsquo;re welcome to apply again down the road.</p>`;
  await send(to, accepted ? "You're in! Next steps — Community Harvest" : "Your Community Harvest application", shell(inner));
}

export async function sendTentConfirmEmail(to: string, name: string, date: string, token: string, viaCredit: boolean) {
  const inner = `
    <h2 style="font-size:19px;font-weight:900;color:#000;margin:0 0 8px;">TENT SPOT CONFIRMED ⛺</h2>
    <p style="font-size:14px;color:#555;">Hi ${name} &mdash; your outdoor tent spot at Community Harvest is booked for:</p>
    <div style="display:inline-block;background:#fff;border:1px dashed #000;padding:12px 20px;margin:8px 0;">
      <div style="font-size:17px;font-weight:900;">${date}</div>
      <div style="font-size:13px;margin-top:4px;">${viaCredit ? "Booked with your weather credit &mdash; deposit already covered." : "Deposit paid: $12.50"}</div>
      <div style="font-size:13px;"><b>Balance due at the front desk when you set up: $12.50</b> (day rate $25 total)</div>
    </div>
    <p style="font-size:12.5px;color:#555;"><b>Bring your own tent and tables</b> &mdash; the market doesn&rsquo;t supply them. Your tent must be manned by you all day &mdash; outdoor sales are yours, hand to hand.
    Weather looking bad? If we call a weather day, your deposit converts to a credit good for any future date.</p>
    <p style="font-size:11px;color:#999;">Keep this email &mdash; your booking link: ${baseUrl()}/tents?manage=${token}</p>`;
  await send(to, `Tent spot confirmed — ${date}`, shell(inner));
}

export async function sendTentWeatherCreditEmail(to: string, name: string, date: string, token: string) {
  const inner = `
    <h2 style="font-size:19px;font-weight:900;color:#000;margin:0 0 8px;">WEATHER DAY — YOUR DEPOSIT IS SAFE ⛈</h2>
    <p style="font-size:14px;color:#555;">Hi ${name} &mdash; we called a weather day for <b>${date}</b>, so outdoor tents are off.
    Your $12.50 deposit is now a <b>credit good for any future tent date</b> &mdash; pick a new day and it books with no new deposit:</p>
    <br>
    <a href="${baseUrl()}/tents?credit=${token}" style="display:inline-block;background:#000;color:#fff;font-weight:800;font-size:15px;padding:14px 26px;border-radius:0;text-decoration:none;">PICK A NEW DATE</a>`;
  await send(to, `Weather day — your tent deposit became a credit`, shell(inner));
}

export async function sendSelfCheckoutReceiptEmail(
  to: string, number: number,
  lines: { name: string; quantity: number; priceCents: number }[],
  subtotalCents: number, taxCents: number, totalCents: number
) {
  const rows = lines.map((l) => `<div style="display:flex;justify-content:space-between;font-size:13.5px;padding:3px 0;"><span>${l.quantity}&times; ${l.name}</span><b>$${((l.priceCents * l.quantity) / 100).toFixed(2)}</b></div>`).join("");
  const inner = `
    <h2 style="font-size:19px;font-weight:900;color:#000;margin:0 0 8px;">RECEIPT — #${number} ✅</h2>
    <p style="font-size:14px;color:#555;">Thanks for shopping Community Harvest! Here&rsquo;s your self-checkout receipt.</p>
    <div style="display:inline-block;text-align:left;background:#fff;border:1px dashed #000;padding:14px 20px;margin:8px 0;min-width:240px;">
      ${rows}
      <div style="border-top:1px solid #000;margin-top:6px;padding-top:6px;font-size:13.5px;display:flex;justify-content:space-between;"><span>Subtotal</span><b>$${(subtotalCents / 100).toFixed(2)}</b></div>
      <div style="font-size:13.5px;display:flex;justify-content:space-between;"><span>Sales tax</span><b>$${(taxCents / 100).toFixed(2)}</b></div>
      <div style="font-size:15px;display:flex;justify-content:space-between;"><span><b>TOTAL</b></span><b>$${(totalCents / 100).toFixed(2)}</b></div>
    </div>
    <p style="font-size:12px;color:#999;">Community Harvest — Food and Craft Market · Noble, Oklahoma</p>`;
  await send(to, `Receipt #${number} — Community Harvest`, shell(inner));
}

export async function sendContractSignEmail(to: string, businessName: string, link: string) {
  const inner = `
    <h2 style="font-size:19px;font-weight:900;color:#000;margin:0 0 8px;">YOUR BOOTH CONTRACT IS READY \u270d\ufe0f</h2>
    <p style="font-size:14px;color:#333;">Hi ${businessName} — your Community Harvest booth rental agreement is ready to review and sign. The packet includes your agreement, your application, and the Market Rules.</p>
    <p style="margin:18px 0;"><a href="${link}" style="background:#000;color:#fff;padding:12px 22px;text-decoration:none;font-weight:700;display:inline-block;">REVIEW &amp; SIGN</a></p>
    <p style="font-size:12px;color:#777;">Sign right on your phone with your finger. This link is private to you — don&rsquo;t forward it. Questions? Just reply to this email.</p>`;
  await send(to, "Your booth contract is ready to sign — Community Harvest", shell(inner));
}

export async function sendExecutedContractEmail(to: string, businessName: string, link: string, phoneType: string = "") {
  const inner = `
    <h2 style="font-size:19px;font-weight:900;color:#000;margin:0 0 8px;">YOUR CONTRACT IS FULLY SIGNED \u2705</h2>
    <p style="font-size:14px;color:#333;">Hi ${businessName} — both you and Community Harvest have signed your booth rental agreement. It&rsquo;s official! Your copy (agreement, application, and Market Rules, with both signatures) is at the link below — open it anytime, and use the print button to save a PDF for your records.</p>
    <p style="margin:18px 0;"><a href="${link}" style="background:#000;color:#fff;padding:12px 22px;text-decoration:none;font-weight:700;display:inline-block;">VIEW &amp; PRINT MY SIGNED CONTRACT</a></p>
    <p style="font-size:12px;color:#777;">Welcome to the vendor family. \ud83c\udf3e</p>
    ${installBlock(phoneType)}
    <p style="font-size:12px;color:#777;">Full guide for either phone, anytime: <a href="${baseUrl()}/install">${baseUrl().replace("https://", "")}/install</a></p>`;
  await send(to, "Fully signed — your Community Harvest booth contract \u2705", shell(inner));
}
