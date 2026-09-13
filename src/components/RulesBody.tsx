// Shared Market Rules content — rendered on /rules and inside contract packets (Exhibit B)
const Rule = ({ n, title, children }: { n: number; title: string; children: React.ReactNode }) => (
  <div style={{ marginBottom: 12 }}>
    <div style={{ fontWeight: 800, fontSize: 13.5, letterSpacing: "-0.01em" }}>{n}. {title}</div>
    <p style={{ fontSize: 13, color: "#374151", marginTop: 2 }}>{children}</p>
  </div>
);

export const RULES_UPDATED = "September 13, 2026";

export default function RulesBody() {
  return (
    <div>
      <div style={{ fontWeight: 800, fontSize: 14.5, margin: "8px 0 8px" }}>BOOTH APPEARANCE</div>
      <Rule n={1} title="TABLECLOTHS, ALWAYS">Every table is covered with a clean WHITE tablecloth, or a tablecloth branded for your business. Floor-length in front is strongly encouraged. Bare tables (plastic, folding, or otherwise) are not permitted on the floor.</Rule>
      <Rule n={2} title="SAFE, SECURED DISPLAYS">All shelving and displays must be freestanding, stable, and secured so they cannot tip or fall on anyone. Nothing may be nailed, screwed, or taped to market walls without prior approval.</Rule>
      <Rule n={3} title="YOU PROVIDE YOUR FIXTURES">Tables, cloths, shelves, risers, and displays are provided by the vendor and kept clean and in good repair. Broken, stained, or wobbly fixtures come off the floor.</Rule>
      <Rule n={4} title="STAY IN YOUR FOOTPRINT">Displays stay inside the rented booth space — no spilling into aisles or neighboring booths — and under about 6 feet tall.</Rule>
      <Rule n={5} title="PRINTED SIGNAGE">Business name and pricing signage should be printed and legible — no handwritten cardboard. Display pricing must match register pricing.</Rule>
      <Rule n={6} title="KEEP IT STOCKED &amp; TIDY">Keep your space stocked, dusted, and faced. If a booth sits chronically empty, the Market may ask you to restock, downsize, or release the space.</Rule>
      <div style={{ fontWeight: 800, fontSize: 14.5, margin: "12px 0 8px" }}>SAFETY &amp; OPERATIONS</div>
      <Rule n={7} title="ELECTRICAL NEEDS APPROVAL">Anything that plugs in requires prior Market approval. No daisy-chained power strips or extension cords.</Rule>
      <Rule n={8} title="NO OPEN FLAMES">Sell candles, don&rsquo;t burn them. No open flames, burners, or heat sources on the floor. Scent testers are welcome.</Rule>
      <Rule n={9} title="SAMPLING REQUIRES APPROVAL">Food sampling requires prior approval and must follow health department requirements.</Rule>
      <Rule n={10} title="FAMILY-FRIENDLY FLOOR">Merchandise and signage must be appropriate for a family audience; the Market has final discretion.</Rule>
      <Rule n={11} title="RESTOCK WINDOWS">Restocking happens 7:00–8:00 AM and 6:00–8:00 PM, coordinated by staff — other times need prior approval. Pre-order dropoffs to staff are welcome anytime. Keep portal quantities current.</Rule>
      <Rule n={12} title="BOOTH MOVES">The Market may relocate a vendor to comparable space with 14 days&rsquo; notice.</Rule>
      <Rule n={13} title="ALL SALES FINAL">All customer purchases are final — no refunds or exchanges. Vendors and their signage may not promise refunds or exchanges on Market register sales.</Rule>
      <Rule n={14} title="SALE SIGNAGE COMES DOWN FIRST">Before ending a discount or sale remotely in the portal, any physical sale signs at the booth must be removed — come in yourself or ask a Market associate to pull them. The register charges what the app says; signs that advertise a dead sale create disputes at the counter.</Rule>
      <div style={{ fontWeight: 800, fontSize: 14.5, margin: "12px 0 4px" }}>ENFORCEMENT</div>
      <p style={{ fontSize: 13, color: "#374151" }}>Violations receive a friendly written notice with 7 days to fix. Repeat or serious violations are grounds for termination under the vendor agreement. Safety issues get corrected on the spot.</p>
    </div>
  );
}
