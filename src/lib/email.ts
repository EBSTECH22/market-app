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
