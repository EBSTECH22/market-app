"use client";

/**
 * The printable site map: the whole building on one page, every booth showing
 * who is in it or OPEN with its size, then a list of open spaces and a list of
 * vendors and where they are.
 *
 * Ctrl+P (or the Print button) — it is laid out for a landscape sheet.
 */
import { useEffect, useMemo, useState } from "react";
import { BuildingView } from "@/components/floorplan/BuildingView";
import { describeSize, spaceSqFt, rentable, type Wall, type Space } from "@/lib/floorplan";

type PlanSpace = Space & { kind: string };
type Plan = { id: string; name: string; walls: Wall[]; originXIn: number; originYIn: number; spaces: PlanSpace[] };

const today = () => new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
const byLabel = (a: { label: string }, b: { label: string }) => a.label.localeCompare(b.label, undefined, { numeric: true });

export default function SiteMapPrint() {
  const [plans, setPlans] = useState<Plan[] | null>(null);
  const [err, setErr] = useState("");

  useEffect(() => {
    void fetch("/api/admin/floorplan").then(async (r) => {
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { setErr(String(d.error || "Sign in on the admin side first, then open this again.")); return; }
      setPlans(d.plans || []);
    }).catch(() => setErr("No connection."));
  }, []);

  const rows = useMemo(() => (plans || []).flatMap((p) =>
    p.spaces.filter((s) => rentable(s.kind)).map((s) => ({ ...s, room: p.name, label: s.label || "—" }))
  ), [plans]);
  const open = rows.filter((s) => s.status === "AVAILABLE").sort((a, b) => a.room.localeCompare(b.room) || byLabel(a, b));
  const held = rows.filter((s) => s.status === "HELD").sort((a, b) => a.room.localeCompare(b.room) || byLabel(a, b));
  const taken = rows.filter((s) => s.status === "TAKEN").sort((a, b) => (a.vendorName || "").localeCompare(b.vendorName || "") || byLabel(a, b));
  const sq = (list: typeof rows) => Math.round(list.reduce((n, s) => n + spaceSqFt(s), 0));

  if (err) return <main style={{ padding: 60, textAlign: "center", fontWeight: 600 }}>{err}</main>;
  if (!plans) return <main style={{ padding: 60, textAlign: "center" }}>Loading the site map…</main>;

  return (
    <main className="smp">
      <style>{CSS}</style>
      <div className="no-print smp-bar">
        <a href="/admin/floorplan" className="btn btn-secondary btn-sm">Back to the site map</a>
        <button type="button" className="btn btn-primary btn-sm" onClick={() => window.print()}>Print</button>
        <span>Prints best landscape. Use &ldquo;Save as PDF&rdquo; in the print box for a file.</span>
      </div>

      <section className="smp-page">
        <header className="smp-head">
          <div>
            <h1>Community Harvest · Site map</h1>
            <p>{today()}</p>
          </div>
          <div className="smp-stats">
            <span><b>{taken.length}</b> vendors placed</span>
            <span><b>{open.length}</b> open ({sq(open)} sq ft)</span>
            {held.length ? <span><b>{held.length}</b> held</span> : null}
          </div>
        </header>
        <div className="smp-map">
          <BuildingView rooms={plans} detailed paper showLengths={false} />
        </div>
        <div className="smp-legend">
          <span><i style={{ background: "#dcefe3", borderColor: "#2f6b45" }} /> Vendor</span>
          <span><i style={{ background: "#fff", borderColor: "#111" }} /> Open — available to rent</span>
          <span><i style={{ background: "#fdf0d5", borderColor: "#b7791f" }} /> Held for someone</span>
          <span><i style={{ background: "#e5e7eb", borderColor: "#6b7280" }} /> Desk / fixture</span>
          <span><i className="line" style={{ borderColor: "#2b6cb0" }} /> Window</span>
          <span><i className="line dash" style={{ borderColor: "#b7791f" }} /> Door / arch</span>
          <span className="smp-note">Sizes are width × depth in feet.</span>
        </div>
      </section>

      <section className="smp-page smp-lists">
        <div>
          <h2>Open spaces · {open.length}</h2>
          {open.length === 0 ? <p className="smp-empty">Nothing open — every space is taken or held.</p> : (
            <table>
              <thead><tr><th>Space</th><th>Room</th><th>Size</th><th className="r">Sq ft</th></tr></thead>
              <tbody>
                {open.map((s) => (
                  <tr key={s.id}><td><b>{s.label}</b></td><td>{s.room}</td><td>{describeSize(s)}</td><td className="r">{spaceSqFt(s)}</td></tr>
                ))}
              </tbody>
            </table>
          )}
          {held.length ? (
            <>
              <h2 style={{ marginTop: 18 }}>Held · {held.length}</h2>
              <table>
                <thead><tr><th>Space</th><th>Room</th><th>Size</th><th className="r">Sq ft</th></tr></thead>
                <tbody>
                  {held.map((s) => (
                    <tr key={s.id}><td><b>{s.label}</b></td><td>{s.room}</td><td>{describeSize(s)}</td><td className="r">{spaceSqFt(s)}</td></tr>
                  ))}
                </tbody>
              </table>
            </>
          ) : null}
        </div>
        <div>
          <h2>Vendors · {taken.length}</h2>
          {taken.length === 0 ? <p className="smp-empty">No vendors placed on the map yet.</p> : (
            <table>
              <thead><tr><th>Vendor</th><th>Space</th><th>Room</th><th>Size</th></tr></thead>
              <tbody>
                {taken.map((s) => (
                  <tr key={s.id}><td><b>{s.vendorName || "—"}</b></td><td>{s.label}</td><td>{s.room}</td><td>{describeSize(s)}</td></tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>
    </main>
  );
}

const CSS = `
.smp { background: #fff; color: #111; min-height: 100vh; padding: 18px 22px 40px; font-family: inherit; }
.smp-bar { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; margin-bottom: 14px; font-size: 13px; color: #666; }
.smp-page { max-width: 1100px; margin: 0 auto 28px; }
.smp-head { display: flex; justify-content: space-between; align-items: flex-end; gap: 16px; border-bottom: 2px solid #111; padding-bottom: 8px; margin-bottom: 10px; }
.smp-head h1 { margin: 0; font-size: 22px; font-weight: 800; }
.smp-head p { margin: 2px 0 0; color: #555; font-size: 13px; }
.smp-stats { display: flex; gap: 16px; font-size: 13px; color: #333; flex-wrap: wrap; }
.smp-stats b { font-size: 17px; color: #111; }
.smp-map { border: 1px solid #ddd; border-radius: 8px; padding: 6px; }
.smp-map svg { max-height: none !important; }
.smp-legend { display: flex; flex-wrap: wrap; gap: 6px 18px; margin-top: 8px; font-size: 12px; color: #333; align-items: center; }
.smp-legend i { display: inline-block; width: 14px; height: 10px; border: 1.5px solid; vertical-align: -1px; margin-right: 5px; }
.smp-legend i.line { height: 0; border-width: 0 0 3px 0; width: 18px; vertical-align: 3px; }
.smp-legend i.dash { border-bottom-style: dashed; }
.smp-note { color: #777; }
.smp-lists { display: grid; grid-template-columns: 1fr 1fr; gap: 28px; align-items: start; }
.smp-lists h2 { font-size: 16px; margin: 0 0 6px; }
.smp-lists table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
.smp-lists th { text-align: left; font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: #555; border-bottom: 1.5px solid #111; padding: 4px 6px; }
.smp-lists td { border-bottom: 1px solid #e5e5e5; padding: 4px 6px; }
.smp-lists .r { text-align: right; }
.smp-empty { color: #666; font-size: 13px; }
@media (max-width: 760px) { .smp-lists { grid-template-columns: 1fr; } }
@media print {
  @page { size: letter landscape; margin: 0.35in; }
  .no-print { display: none !important; }
  .smp { padding: 0; }
  .smp-page { max-width: none; margin: 0; }
  .smp-page + .smp-page { break-before: page; }
  .smp-map { border: 0; padding: 0; }
  .smp-map svg { height: 6.3in !important; width: 100% !important; }
  .smp-lists tr { break-inside: avoid; }
  * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
}
`;
