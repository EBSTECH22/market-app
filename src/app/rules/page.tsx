import RulesBody, { RULES_UPDATED } from "@/components/RulesBody";

export const metadata = { title: "Market Rules — Community Harvest" };

export default function RulesPage() {
  return (
    <main style={{ maxWidth: 640, margin: "0 auto", padding: "26px 16px 70px" }}>
      <div style={{ textAlign: "center", marginBottom: 16 }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/wordmark.png" alt="Community Harvest" style={{ width: 220, maxWidth: "70%", height: "auto", margin: "0 auto 6px", display: "block" }} />
        <div className="display" style={{ fontSize: 22 }}>MARKET RULES &amp; BOOTH STANDARDS</div>
        <p style={{ fontSize: 12.5, color: "var(--ash)", marginTop: 4 }}>
          These rules are part of every vendor agreement and may be updated by posting here. Last updated: {RULES_UPDATED}.
        </p>
      </div>
      <div className="card" style={{ marginBottom: 16 }}>
        <RulesBody />
      </div>
      <p style={{ textAlign: "center", fontSize: 12.5, color: "var(--ash)" }}>
        Questions? Ask any staff member — we want your booth to look amazing. · <a href="/apply">Become a vendor</a> · <a href="/market">See the market</a>
      </p>
    </main>
  );
}
