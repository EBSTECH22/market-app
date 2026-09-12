export const metadata = { title: "Add the Vendor App to Your Phone — Community Harvest" };

const Step = ({ n, children }: { n: number; children: React.ReactNode }) => (
  <div style={{ display: "flex", gap: 10, marginBottom: 10 }}>
    <div style={{ flex: "0 0 auto", width: 26, height: 26, borderRadius: "50%", background: "#111827", color: "#fff", fontWeight: 800, fontSize: 13, display: "flex", alignItems: "center", justifyContent: "center" }}>{n}</div>
    <div style={{ fontSize: 13.5, paddingTop: 3 }}>{children}</div>
  </div>
);

export default function InstallPage() {
  return (
    <main style={{ maxWidth: 560, margin: "0 auto", padding: "26px 16px 70px" }}>
      <div style={{ textAlign: "center", marginBottom: 16 }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/wordmark.png" alt="Community Harvest" style={{ width: 210, maxWidth: "70%", height: "auto", margin: "0 auto 6px", display: "block" }} />
        <div className="display" style={{ fontSize: 21 }}>PUT YOUR VENDOR APP ON YOUR HOME SCREEN</div>
        <p style={{ fontSize: 12.5, color: "var(--ash)", marginTop: 4 }}>
          Two minutes, no app store. You get a real app icon, full-screen portal, and sale notifications on your phone.
        </p>
      </div>

      <div className="card" style={{ marginBottom: 16 }} id="iphone">
        <h2 className="display" style={{ fontSize: 17, marginBottom: 8 }}>📱 IPHONE (SAFARI)</h2>
        <Step n={1}>Open <b>Safari</b> (it must be Safari) and go to <a href="https://market.dailybreadbaked.com"><b>market.dailybreadbaked.com</b></a> — that&rsquo;s your vendor login page.</Step>
        <Step n={2}>Tap the <b>Share button</b> — the square with the arrow pointing up, at the bottom center of the screen.</Step>
        <Step n={3}>Scroll down the share menu and tap <b>&ldquo;Add to Home Screen.&rdquo;</b></Step>
        <Step n={4}>Tap <b>Add</b> in the top corner. A Community Harvest icon appears on your home screen.</Step>
        <Step n={5}>From now on, <b>open the portal from that icon</b> — log in with your vendor code and password.</Step>
        <Step n={6}>Want a buzz every time you make a sale? In the portal go to <b>⚙️ SETTINGS → SALE ALERTS → TURN ON FOR THIS DEVICE</b> and allow notifications. (Works on iOS 16.4 and newer, and only when opened from the home-screen icon.)</Step>
      </div>

      <div className="card" style={{ marginBottom: 16 }} id="android">
        <h2 className="display" style={{ fontSize: 17, marginBottom: 8 }}>🤖 ANDROID (CHROME)</h2>
        <Step n={1}>Open <b>Chrome</b> and go to <a href="https://market.dailybreadbaked.com"><b>market.dailybreadbaked.com</b></a> — that&rsquo;s your vendor login page.</Step>
        <Step n={2}>Tap the <b>⋮ menu</b> in the top-right corner.</Step>
        <Step n={3}>Tap <b>&ldquo;Add to Home screen&rdquo;</b> (on some phones it says <b>&ldquo;Install app&rdquo;</b>).</Step>
        <Step n={4}>Confirm. A Community Harvest icon appears on your home screen.</Step>
        <Step n={5}>Open the portal from that icon and log in with your vendor code and password.</Step>
        <Step n={6}>For a buzz on every sale: in the portal go to <b>⚙️ SETTINGS → SALE ALERTS → TURN ON FOR THIS DEVICE</b> and allow notifications.</Step>
      </div>

      <p style={{ textAlign: "center", fontSize: 12.5, color: "var(--ash)" }}>
        Stuck? Ask any staff member at the market — we&rsquo;ll set it up with you in person. 🌾
      </p>
    </main>
  );
}
