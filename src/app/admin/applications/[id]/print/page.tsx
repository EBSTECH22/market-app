import { db } from "@/lib/db";
import { isAdmin } from "@/lib/auth";

export const dynamic = "force-dynamic";

const fmtDay = (d: Date) => d.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });

function Row({ label, value }: { label: string; value: string }) {
  if (!value) return null;
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: "0.06em", color: "#6b7280" }}>{label.toUpperCase()}</div>
      <div style={{ fontSize: 13.5, whiteSpace: "pre-wrap" }}>{value}</div>
    </div>
  );
}

export default async function ApplicationPrint({ params }: { params: { id: string } }) {
  if (!isAdmin()) return <main style={{ padding: 60, textAlign: "center", fontWeight: 600 }}>Not logged in — open the admin side first.</main>;
  const a = await db.vendorApplication.findUnique({ where: { id: params.id } });
  if (!a) return <main style={{ padding: 40 }}>Application not found.</main>;
  return (
    <main style={{ maxWidth: 640, margin: "0 auto", padding: "26px 22px 60px", background: "#fff", minHeight: "100vh", color: "#111" }}>
      <style>{`@media print { .no-print { display: none !important; } main { padding: 0 !important; } }`}</style>
      <button className="btn small no-print" style={{ marginBottom: 12 }}><a href="/admin" style={{ textDecoration: "none", color: "inherit" }}>← BACK</a></button>
      <span className="no-print" style={{ fontSize: 12, color: "#777", marginLeft: 10 }}>Ctrl+P to print or save as PDF</span>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/logo.png" alt="" style={{ width: 80, height: 80, display: "block", margin: "0 auto 6px" }} />
      <h1 style={{ textAlign: "center", fontSize: 18, fontWeight: 900 }}>VENDOR APPLICATION</h1>
      <p style={{ textAlign: "center", color: "#555", fontSize: 12.5, marginBottom: 16 }}>
        Community Harvest — Food and Craft Market · Submitted {fmtDay(a.createdAt)} · Status: {a.status}
      </p>
      <Row label="Business name" value={a.businessName} />
      <Row label="Contact" value={a.contactName} />
      <Row label="Email" value={a.email} />
      <Row label="Phone" value={a.phone} />
      <Row label="Category" value={a.category} />
      <Row label="What they make / grow" value={a.products} />
      <Row label="Made / grown by applicant" value={a.madeByYou} />
      <Row label="Links" value={a.links} />
      <Row label="Licenses / permits" value={a.licenses} />
      <Row label="Insurance" value={a.insurance} />
      <Row label="Availability" value={a.availability} />
      <Row label="Booth request" value={a.boothRequest} />
      <Row label="How they heard about us" value={a.heardFrom} />
      <Row label="Internal notes" value={a.notes} />
    </main>
  );
}
