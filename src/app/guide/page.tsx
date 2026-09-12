export const metadata = { title: "Vendor Setup & Portal Guide — Community Harvest" };

const Step = ({ n, children }: { n: number; children: React.ReactNode }) => (
  <div style={{ display: "flex", gap: 10, marginBottom: 10 }}>
    <div style={{ flex: "0 0 auto", width: 26, height: 26, borderRadius: "50%", background: "#111827", color: "#fff", fontWeight: 800, fontSize: 13, display: "flex", alignItems: "center", justifyContent: "center" }}>{n}</div>
    <div style={{ fontSize: 13.5, paddingTop: 3 }}>{children}</div>
  </div>
);

const Tag = ({ children }: { children: React.ReactNode }) => (
  <span style={{ display: "inline-block", background: "#f0fdf4", color: "#15803d", border: "1px solid #bbf7d0", borderRadius: 999, fontSize: 10.5, fontWeight: 800, letterSpacing: "0.04em", padding: "2px 9px", marginBottom: 6 }}>{children}</span>
);

const Divider = ({ children }: { children: React.ReactNode }) => (
  <div style={{ textAlign: "center", fontSize: 11, fontWeight: 700, letterSpacing: "0.15em", color: "#9ca3af", margin: "28px 0 14px" }}>{children}</div>
);

const Chip = ({ children }: { children: React.ReactNode }) => (
  <span style={{ display: "inline-block", border: "1px solid var(--border)", background: "#f9fafb", borderRadius: 999, padding: "3px 10px", fontSize: 12, fontWeight: 600, margin: "2px 3px 2px 0" }}>{children}</span>
);

export default function GuidePage() {
  return (
    <main style={{ maxWidth: 560, margin: "0 auto", padding: "26px 16px 70px" }}>
      <div style={{ textAlign: "center", marginBottom: 16 }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/wordmark.png" alt="Community Harvest" style={{ width: 210, maxWidth: "70%", height: "auto", margin: "0 auto 6px", display: "block" }} />
        <div className="display" style={{ fontSize: 21 }}>VENDOR SETUP &amp; PORTAL GUIDE</div>
        <p style={{ fontSize: 12.5, color: "var(--ash)", marginTop: 4 }}>Everything from putting the app on your phone to your first payout.</p>
        <a className="btn" href="/" style={{ maxWidth: 340, margin: "12px auto 0" }}>🔑 OPEN YOUR VENDOR PORTAL →</a>
        <p style={{ fontSize: 11.5, color: "var(--ash)", marginTop: 6 }}>Every step below happens in your portal — that button is the door.</p>
      </div>

      <Divider>PART 1 · PUT THE APP ON YOUR PHONE</Divider>

      <div className="card" style={{ marginBottom: 16 }} id="iphone">
        <h2 className="display" style={{ fontSize: 17, marginBottom: 8 }}>📱 IPHONE (SAFARI)</h2>
        <Step n={1}>Open <b>Safari</b> (it must be Safari) and go to <a href="https://market.dailybreadbaked.com"><b>market.dailybreadbaked.com</b></a>.</Step>
        <Step n={2}>Tap the <b>Share button</b> — the square with the arrow pointing up, bottom center.</Step>
        <Step n={3}>Scroll down and tap <b>&ldquo;Add to Home Screen,&rdquo;</b> then <b>Add</b>.</Step>
        <Step n={4}>Open the new icon and log in with your vendor code and password.</Step>
        <Step n={5}>Sale alerts: in the portal, <b>⚙️ SETTINGS → SALE ALERTS → TURN ON FOR THIS DEVICE</b>. (iOS 16.4+, and only when opened from the home-screen icon.)</Step>
      </div>

      <div className="card" style={{ marginBottom: 16 }} id="android">
        <h2 className="display" style={{ fontSize: 17, marginBottom: 8 }}>🤖 ANDROID (CHROME)</h2>
        <Step n={1}>Open <b>Chrome</b> and go to <a href="https://market.dailybreadbaked.com"><b>market.dailybreadbaked.com</b></a>.</Step>
        <Step n={2}>Tap the <b>⋮ menu</b> in the top-right corner.</Step>
        <Step n={3}>Tap <b>&ldquo;Add to Home screen&rdquo;</b> (on some phones: <b>&ldquo;Install app&rdquo;</b>) and confirm.</Step>
        <Step n={4}>Open the new icon and log in with your vendor code and password.</Step>
        <Step n={5}>Sale alerts: <b>⚙️ SETTINGS → SALE ALERTS → TURN ON FOR THIS DEVICE</b> and allow notifications.</Step>
      </div>

      <Divider>PART 2 · ADD YOUR PRODUCTS</Divider>

      <div className="card" style={{ marginBottom: 16 }} id="products">
        <Tag>📦 MY ITEMS</Tag>
        <h2 className="display" style={{ fontSize: 16, marginBottom: 8 }}>ADD A PRODUCT (20 SECONDS EACH)</h2>
        <Step n={1}>Open the portal and tap the <b>📦 MY ITEMS</b> tab.</Step>
        <Step n={2}>Scroll to <b>ADD AN ITEM</b>.</Step>
        <Step n={3}><b>Item name:</b> write it the way a customer should read it — &ldquo;Strawberry Jam 8oz,&rdquo; not &ldquo;jam1.&rdquo; It prints on the label and shows on your public page.</Step>
        <Step n={4}><b>Price in dollars.</b> Sales tax is NOT your problem — the register adds and remits it.</Step>
        <Step n={5}><b>Quantity:</b> how many you&rsquo;re actually putting on the floor.</Step>
        <Step n={6}>Tap <b>ADD ITEM</b>. It gets a barcode number (like V07-0003) automatically. Repeat for every product.</Step>
        <p style={{ fontSize: 12.5, color: "var(--ash)", marginTop: 4 }}>Sell the same thing in two sizes? Make two items. Changing a price later is one tap — <b>PRICE</b> on the item — then print fresh labels for the ones on the shelf.</p>
      </div>

      <Divider>PART 3 · PRINT &amp; STICKER YOUR BARCODES</Divider>

      <div className="card" style={{ marginBottom: 16, background: "#f0fdf4", border: "1px solid #bbf7d0" }} id="labels-shopping">
        <h2 className="display" style={{ fontSize: 16, marginBottom: 6 }}>🛒 WHAT TO BUY (ONCE, ~$10)</h2>
        <p style={{ fontSize: 13.5 }}><b>STANDARD items</b> (jars, bags, loaves, candles, soap): white <b>&ldquo;address labels, 30 per sheet&rdquo;</b> — 1&quot; × 2⅝&quot;. Avery 5160 or any store brand. Any Walmart, office store, or Amazon; works in any inkjet or laser printer.</p>
        <p style={{ fontSize: 13.5, marginTop: 8 }}><b>SMALL items</b> (lip balm, jewelry cards, tiny tins): white <b>&ldquo;return address labels, 60 per sheet&rdquo;</b> — ⅔&quot; × 1¾&quot;. Avery 5195/8195 or store brand.</p>
        <p style={{ fontSize: 13.5, marginTop: 8 }}><b>Tiny items</b> (earrings, rings, charms): don&rsquo;t sticker the product — put a label on a <b>kraft hang tag</b> with string (craft store, ~$6/100) and tie it on.</p>
        <p style={{ fontSize: 12.5, color: "var(--ash)", marginTop: 8 }}>No printer? Print at any library or print shop for pennies — or ask us, we&rsquo;re happy to run a sheet for you.</p>
      </div>

      <div className="card" style={{ marginBottom: 16 }} id="labels">
        <Tag>🏷 PRINT LABELS</Tag>
        <h2 className="display" style={{ fontSize: 16, marginBottom: 8 }}>PRINT YOUR LABELS</h2>
        <Step n={1}>In <b>📦 MY ITEMS</b>, tap <b>🏷 PRINT BARCODE LABELS</b>. (Easiest from a computer, but a phone works.)</Step>
        <Step n={2}>Pick your sheet size at the top: <b>STANDARD (30/sheet)</b> or <b>SMALL (60/sheet)</b> — match the labels you bought.</Step>
        <Step n={3}><b>Tick the items</b> you want labels for and set <b>copies</b> for each — it starts at your floor quantity, so usually you just check the boxes.</Step>
        <Step n={4}>Load a label sheet in your printer and tap <b>🖨 PRINT LABELS</b>.</Step>
        <Step n={5}>In the print window, set <b>Scale to 100%</b> — never &ldquo;Fit to page.&rdquo; This is the step everyone misses; wrong scale means barcodes miss the stickers.</Step>
        <Step n={6}><b>Sticker every item</b> on a flat spot — not over a seam, curve, or crinkly wrap. Flat barcodes scan; wrinkled ones don&rsquo;t.</Step>
      </div>

      <Divider>PART 4 · RUNNING YOUR BOOTH WEEK TO WEEK</Divider>

      <div className="card" style={{ marginBottom: 16 }} id="restock">
        <Tag>📦 RESTOCKING</Tag>
        <h2 className="display" style={{ fontSize: 16, marginBottom: 8 }}>WHEN YOU RESTOCK</h2>
        <Step n={1}>Come during a <b>restock window: 7–8 AM or 6–8 PM</b> (other times need staff approval — just ask).</Step>
        <Step n={2}>Sticker your new items <b>before</b> they go on the shelf.</Step>
        <Step n={3}>In <b>📦 MY ITEMS</b>, tap <b>SET QTY</b> on each item and enter the new total on the floor. That number is what shoppers see online — keep it honest and your booth sells even when you&rsquo;re not there.</Step>
      </div>

      <div className="card" style={{ marginBottom: 16 }} id="inbox">
        <Tag>📩 INBOX</Tag>
        <h2 className="display" style={{ fontSize: 16, marginBottom: 8 }}>ANSWER A PRE-ORDER (THIS IS MONEY — DON&rsquo;T SLEEP ON IT)</h2>
        <Step n={1}>A red <b>REPLY</b> badge on 📩 INBOX means a customer is waiting. Tap the message.</Step>
        <Step n={2}>Read what they want. If you can do it, fill in the <b>ACCEPT</b> box: describe what they&rsquo;re getting, your price <b>before tax</b> (tax adds automatically), and the ready date.</Step>
        <Step n={3}>Tap <b>✅ ACCEPT &amp; SEND LINK</b>. They get a secure card-payment link by email.</Step>
        <Step n={4}>When they pay, it lands in <b>your balance automatically</b> and shows in the register for pickup day. You&rsquo;ll see PAID ✓ on the thread.</Step>
        <Step n={5}>Can&rsquo;t do it? <b>❌ DECLINE</b> with one tap — no hard feelings, fast answers keep customers coming back. Regular questions: type a reply and <b>SEND</b>; they get it by email.</Step>
        <p style={{ fontSize: 12.5, color: "var(--ash)", marginTop: 4 }}>Don&rsquo;t want pre-orders at all? That&rsquo;s fine — flip <b>Accept PRE-ORDERS</b> off in <b>⭐ MY PAGE</b> and customers never see the option. Same for requests. Complaints always stay open — that&rsquo;s a market rule that protects everyone.</p>
      </div>

      <div className="card" style={{ marginBottom: 16 }} id="mypage">
        <Tag>⭐ MY PAGE</Tag>
        <h2 className="display" style={{ fontSize: 16, marginBottom: 8 }}>DRESS UP YOUR PUBLIC PAGE</h2>
        <Step n={1}>In <b>⭐ MY PAGE</b>, upload your <b>logo</b> (shows on the market directory) and up to <b>6 product photos</b> — phone photos in good light work great.</Step>
        <Step n={2}>Write a <b>one-sentence blurb</b>: what you make and what makes it yours.</Step>
        <Step n={3}>Choose whether you accept <b>pre-orders</b> and <b>requests</b> (you can change anytime). The <b>self-checkout</b> toggle: ON lets shoppers scan &amp; pay for your items on their own phones; OFF means staffed register only.</Step>
        <Step n={4}>Tap <b>SAVE</b>, then <b>🖨 PRINT MY TABLE QR CARD</b> and put it on your booth — shoppers scan it to browse you, review you, and message you.</Step>
      </div>

      <div className="card" style={{ marginBottom: 16 }} id="money">
        <Tag>💵 MONEY</Tag>
        <h2 className="display" style={{ fontSize: 16, marginBottom: 8 }}>GETTING PAID</h2>
        <p style={{ fontSize: 13.5 }}>Every sale credits your balance the moment it rings — your net, after any commission. Booth rent comes out of the same balance. The <b>💵 MONEY</b> tab shows every line with a date, and balances <b>pay out by the 15th of the following month</b>. Something look off? Say so within 30 days — it&rsquo;s your contract right, and we want the books right too.</p>
      </div>

      <Divider>PART 5 · GOOD TO KNOW</Divider>

      <div className="card" style={{ marginBottom: 16 }}>
        <Chip>🕗 Restock: 7–8 AM &amp; 6–8 PM</Chip>
        <Chip>🧾 We handle sales tax</Chip>
        <Chip>📋 Booth standards: <a href="/rules">/rules</a></Chip>
        <Chip>🛒 Shelf-stable sells through our register</Chip>
        <Chip>🧊 Refrigerated homemade = you sell in person</Chip>
        <Chip>🔑 Forgot password? Use the reset link at login</Chip>
        <Chip>💬 Stuck? Ask any staff member</Chip>
      </div>

      <a className="btn" href="/" style={{ maxWidth: 340, margin: "0 auto 12px" }}>🔑 OPEN YOUR VENDOR PORTAL →</a>
      <p style={{ textAlign: "center", fontSize: 12.5, color: "var(--ash)" }}>
        We built all of this so your booth works for you while you live your life. Welcome aboard. 🌾
      </p>
    </main>
  );
}
