import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

export default async function UnsubscribePage({ params }: { params: { token: string } }) {
  const customer = await db.customer.findUnique({ where: { token: params.token } });
  if (customer && !customer.unsubscribed) {
    await db.customer.update({ where: { id: customer.id }, data: { unsubscribed: true } });
  }
  return (
    <main style={{ maxWidth: 460, margin: "0 auto", padding: "60px 16px", textAlign: "center" }}>
      <div style={{ fontSize: 40 }}>👋</div>
      <h1 className="display" style={{ fontSize: 22, margin: "8px 0" }}>{customer ? "You're unsubscribed" : "Link not found"}</h1>
      <p style={{ fontSize: 13.5, color: "var(--ash)" }}>
        {customer
          ? "No more restock alerts. Your reward points are safe and keep working at the register. Change your mind? Just follow a vendor again from their page."
          : "This unsubscribe link doesn't match anyone — it may have already been used."}
      </p>
      <a className="btn small ghost" style={{ marginTop: 14 }} href="/market">SEE THE MARKET</a>
    </main>
  );
}
