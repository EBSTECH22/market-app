export const metadata = { title: "Market Rules — Community Harvest" };

const Rule = ({ n, title, children }: { n: number; title: string; children: React.ReactNode }) => (
  <div style={{ marginBottom: 14 }}>
    <div className="display" style={{ fontSize: 14.5 }}>{n}. {title}</div>
    <p style={{ fontSize: 13.5, color: "#374151", marginTop: 2 }}>{children}</p>
  </div>
);

export default function RulesPage() {
  return (
    <main style={{ maxWidth: 640, margin: "0 auto", padding: "26px 16px 70px" }}>
      <div style={{ textAlign: "center", marginBottom: 16 }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/wordmark.png" alt="Community Harvest" style={{ width: 220, maxWidth: "70%", height: "auto", margin: "0 auto 6px", display: "block" }} />
        <div className="display" style={{ fontSize: 22 }}>MARKET RULES &amp; BOOTH STANDARDS</div>
        <p style={{ fontSize: 12.5, color: "var(--ash)", marginTop: 4 }}>
          These rules are part of every vendor agreement and may be updated by posting here. Last updated: September 12, 2026.
        </p>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <h2 className="display" style={{ fontSize: 16, marginBottom: 10 }}>BOOTH APPEARANCE — WE&rsquo;RE A SHOP, NOT A GARAGE SALE 🌾</h2>
        <Rule n={1} title="TABLECLOTHS, ALWAYS">Every table is covered with a clean WHITE tablecloth, or a tablecloth branded for your business if you prefer. Floor-length in front is strongly encouraged — it hides bins and boxes and instantly looks professional. Bare tables (plastic, folding, or otherwise) are not permitted on the floor.</Rule>
        <Rule n={2} title="SAFE, SECURED DISPLAYS">All shelving and displays must be freestanding, stable, and secured so they cannot tip or fall on anyone — if a curious kid pulls on it, it stays put. Nothing may be nailed, screwed, or taped to market walls without prior approval.</Rule>
        <Rule n={3} title="YOU PROVIDE YOUR FIXTURES">Tables, cloths, shelves, risers, and displays are provided by you and kept clean and in good repair. Broken, stained, or wobbly fixtures come off the floor.</Rule>
        <Rule n={4} title="STAY IN YOUR FOOTPRINT">Your display lives inside your rented booth space — no spilling into aisles or neighboring booths. Keep displays under about 6 feet tall so booths don&rsquo;t wall each other off.</Rule>
        <Rule n={5} title="PRINTED SIGNAGE">Business name and pricing signage should be printed and legible — no handwritten cardboard. (Your barcode labels already carry the register price; display pricing should match.)</Rule>
        <Rule n={6} title="KEEP IT STOCKED &amp; TIDY">A bare or messy booth drags down the whole market. Keep your space stocked, dusted, and faced. If a booth sits chronically empty, the Market may ask you to restock, downsize, or release the space.</Rule>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <h2 className="display" style={{ fontSize: 16, marginBottom: 10 }}>SAFETY &amp; OPERATIONS</h2>
        <Rule n={7} title="ELECTRICAL NEEDS APPROVAL">Lights, warmers, or anything that plugs in requires prior Market approval. No daisy-chained power strips or extension cords.</Rule>
        <Rule n={8} title="NO OPEN FLAMES">Sell candles, don&rsquo;t burn them. No open flames, burners, or heat sources on the floor. Scent testers are welcome.</Rule>
        <Rule n={9} title="SAMPLING REQUIRES APPROVAL">Food sampling requires prior approval and must follow health department requirements.</Rule>
        <Rule n={10} title="FAMILY-FRIENDLY FLOOR">Merchandise and signage must be appropriate for a family audience; the Market has final discretion.</Rule>
        <Rule n={11} title="RESTOCK WINDOWS">Restocking happens 7:00–8:00 AM and 6:00–8:00 PM, coordinated by staff — other times need prior approval. Pre-order dropoffs to staff are welcome anytime. Keep your portal quantities current.</Rule>
        <Rule n={12} title="BOOTH MOVES">The Market may relocate your booth to comparable space with 14 days&rsquo; notice when the floor plan needs it.</Rule>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <h2 className="display" style={{ fontSize: 16, marginBottom: 10 }}>ENFORCEMENT — FRIENDLY BUT REAL</h2>
        <p style={{ fontSize: 13.5, color: "#374151" }}>
          If something&rsquo;s off, you&rsquo;ll get a friendly written notice with 7 days to fix it. Repeat or serious violations are grounds for termination under your vendor agreement. Safety issues get corrected on the spot.
        </p>
      </div>

      <p style={{ textAlign: "center", fontSize: 12.5, color: "var(--ash)" }}>
        Questions? Ask any staff member — we want your booth to look amazing. · <a href="/apply">Become a vendor</a> · <a href="/market">See the market</a>
      </p>
    </main>
  );
}
