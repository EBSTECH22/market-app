const RESEND_URL = "https://api.resend.com/emails";
const FROM = process.env.EMAIL_FROM || "The Market <orders@dailybreadbaked.com>";

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
  const name = process.env.MARKET_NAME || "The Market at Noble";
  return `
  <div style="background:#eef3e4;padding:30px 12px;font-family:Helvetica,Arial,sans-serif;">
    <div style="max-width:480px;margin:0 auto;background:#fbfaf4;border:3px solid #22301c;border-radius:18px;padding:28px 24px;text-align:center;">
      <div style="font-weight:900;font-size:22px;color:#22301c;letter-spacing:-0.5px;margin-bottom:16px;">${name}</div>
      ${inner}
    </div>
    <div style="max-width:480px;margin:12px auto 0;text-align:center;font-size:11px;color:#6d7a5f;">
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
    <h2 style="font-size:19px;font-weight:900;color:#22301c;margin:0 0 8px;">YOU MADE A SALE! 🎉</h2>
    <div style="display:inline-block;text-align:left;background:#f2f0e4;border:2px dashed #22301c;border-radius:12px;padding:12px 18px;margin-bottom:12px;">
      <div style="font-weight:600;font-size:14px;color:#22301c;">${rows}</div>
      <div style="font-size:14px;font-weight:700;color:#3c7a3c;margin-top:8px;">Your net: $${(net / 100).toFixed(2)}</div>
    </div>
    <p style="font-size:12px;color:#777;margin:0;">Log in to see your live inventory and balance: <a href="${baseUrl()}">${baseUrl().replace("https://", "")}</a></p>`;
  await send(vendor.email, `You made a sale! ${lines[0].name}${lines.length > 1 ? " + more" : ""}`, shell(inner));
}

export async function sendWelcomeEmail(
  vendor: { email: string; businessName: string; code: string },
  tempPassword: string
) {
  const inner = `
    <h2 style="font-size:19px;font-weight:900;color:#22301c;margin:0 0 8px;">WELCOME, ${vendor.businessName.toUpperCase()}!</h2>
    <p style="font-size:14px;color:#555;">Your vendor account is ready. Log in to add items, set prices, and print your barcode labels.</p>
    <div style="display:inline-block;text-align:left;background:#f2f0e4;border:2px dashed #22301c;border-radius:12px;padding:12px 18px;margin:10px 0;">
      <div style="font-size:14px;"><b>Login:</b> ${vendor.email}</div>
      <div style="font-size:14px;"><b>Temporary password:</b> ${tempPassword}</div>
      <div style="font-size:14px;"><b>Vendor code:</b> ${vendor.code}</div>
    </div>
    <br>
    <a href="${baseUrl()}" style="display:inline-block;background:#22301c;color:#fbfaf4;font-weight:800;font-size:15px;padding:14px 26px;border-radius:12px;text-decoration:none;">LOG IN</a>
    <p style="font-size:12px;color:#999;margin-top:12px;">Please change your password after your first login.</p>`;
  await send(vendor.email, "Your vendor account is ready", shell(inner));
}
