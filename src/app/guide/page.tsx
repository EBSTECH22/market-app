import { Badge, Card, Icon, LinkButton, Note } from "@/components/ui";

export const metadata = { title: "Vendor Setup & Portal Guide — Community Harvest" };

const Step = ({ n, children }: { n: number; children: React.ReactNode }) => (
  <li className="row-top g-3">
    <span
      className="shrink0 num"
      aria-hidden
      style={{
        width: 26,
        height: 26,
        borderRadius: "var(--r-full)",
        background: "var(--accent)",
        color: "var(--text-inverse)",
        fontWeight: 700,
        fontSize: "var(--fs-sm)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {n}
    </span>
    <span className="t-body grow" style={{ lineHeight: 1.6, paddingTop: 3 }}>{children}</span>
  </li>
);

const Steps = ({ children }: { children: React.ReactNode }) => (
  <ol className="stack g-3" style={{ listStyle: "none", margin: 0, padding: 0 }}>{children}</ol>
);

const Divider = ({ children }: { children: React.ReactNode }) => (
  <h2 className="t-label" style={{ textAlign: "center", margin: "var(--sp-10) 0 var(--sp-4)" }}>
    {children}
  </h2>
);

const Chip = ({ children }: { children: React.ReactNode }) => (
  <span
    className="t-xs"
    style={{
      display: "inline-flex",
      alignItems: "center",
      gap: "var(--sp-1)",
      border: "1px solid var(--border)",
      background: "var(--bg-sunken)",
      borderRadius: "var(--r-full)",
      padding: "var(--sp-1) var(--sp-3)",
      fontWeight: 560,
    }}
  >
    {children}
  </span>
);

export default function GuidePage() {
  return (
    <>
      <header className="public-header">
        <div className="public-header-inner">
          <a href="/market" aria-label="Community Harvest" style={{ display: "flex", alignItems: "center" }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/wordmark.png" alt="Community Harvest" style={{ width: 150, maxWidth: "46vw", height: "auto", display: "block" }} />
          </a>
          <LinkButton href="/" variant="primary" size="sm" icon="lock" className="shrink0">Vendor portal</LinkButton>
        </div>
      </header>

      <main className="public-wrap public-narrow">
        <div className="hero">
          <h1 className="hero-title">Vendor setup &amp; portal guide</h1>
          <p className="hero-sub">Everything from putting the app on your phone to your first payout.</p>
          <div style={{ maxWidth: 340, margin: "var(--sp-4) auto 0" }}>
            <LinkButton href="/" variant="primary" size="lg" block icon="lock" iconRight="arrowRight">
              Open your vendor portal
            </LinkButton>
          </div>
          <p className="t-xs t-muted mt-2">Every step below happens in your portal — that button is the door.</p>
        </div>

        <Divider>Part 1 · Put the app on your phone</Divider>

        <Card title="iPhone (Safari)" id="iphone" className="mb-4">
          <Steps>
            <Step n={1}>Open <b>Safari</b> (it must be Safari) and go to <a href="https://market.dailybreadbaked.com"><b>market.dailybreadbaked.com</b></a>.</Step>
            <Step n={2}>Tap the <b>Share button</b> — the square with the arrow pointing up, bottom center.</Step>
            <Step n={3}>Scroll down and tap <b>&ldquo;Add to Home Screen,&rdquo;</b> then <b>Add</b>.</Step>
            <Step n={4}>Open the new icon and log in with your vendor code and password.</Step>
            <Step n={5}>Sale alerts: in the portal, go to <b>Settings → Sale alerts → Turn on for this device</b>. (iOS 16.4+, and only when opened from the home-screen icon.)</Step>
          </Steps>
        </Card>

        <Card title="Android (Chrome)" id="android" className="mb-4">
          <Steps>
            <Step n={1}>Open <b>Chrome</b> and go to <a href="https://market.dailybreadbaked.com"><b>market.dailybreadbaked.com</b></a>.</Step>
            <Step n={2}>Tap the <b>menu</b> (three dots) in the top-right corner.</Step>
            <Step n={3}>Tap <b>&ldquo;Add to Home screen&rdquo;</b> (on some phones: <b>&ldquo;Install app&rdquo;</b>) and confirm.</Step>
            <Step n={4}>Open the new icon and log in with your vendor code and password.</Step>
            <Step n={5}>Sale alerts: <b>Settings → Sale alerts → Turn on for this device</b>, and allow notifications.</Step>
          </Steps>
        </Card>

        <Divider>Part 2 · Add your products</Divider>

        <Card title="Add a product (20 seconds each)" id="products" className="mb-4">
          <div className="mb-3"><Badge tone="info" icon="box">My items</Badge></div>
          <Steps>
            <Step n={1}>Open the portal and tap the <b>My items</b> tab.</Step>
            <Step n={2}>Scroll to <b>Add an item</b>.</Step>
            <Step n={3}><b>Item name:</b> write it the way a customer should read it — &ldquo;Strawberry Jam 8oz,&rdquo; not &ldquo;jam1.&rdquo; It prints on the label and shows on your public page.</Step>
            <Step n={4}><b>Price in dollars.</b> Sales tax is not your problem — the register adds and remits it.</Step>
            <Step n={5}><b>Quantity:</b> how many you&rsquo;re actually putting on the floor.</Step>
            <Step n={6}>Tap <b>Add item</b>. It gets a barcode number (like V07-0003) automatically. Repeat for every product.</Step>
          </Steps>
          <p className="t-sm t-muted mt-3" style={{ marginBottom: 0 }}>
            Sell the same thing in two sizes? Make two items. Changing a price later is one tap — <b>Price</b> on the
            item — then print fresh labels for the ones on the shelf.
          </p>
        </Card>

        <Divider>Part 3 · Print &amp; sticker your barcodes</Divider>

        <Card title="What to buy (once, about $10)" id="labels-shopping" className="mb-4">
          <div className="stack g-3">
            <Note tone="success" title="Standard items — jars, bags, loaves, candles, soap">
              White <b>&ldquo;address labels, 30 per sheet&rdquo;</b> — 1&quot; × 2⅝&quot;. Avery 5160 or any store brand.
              Any Walmart, office store, or Amazon; works in any inkjet or laser printer.
            </Note>
            <Note tone="success" title="Small items — lip balm, jewelry cards, tiny tins">
              White <b>&ldquo;return address labels, 60 per sheet&rdquo;</b> — ⅔&quot; × 1¾&quot;. Avery 5195/8195 or store brand.
            </Note>
            <Note tone="success" title="Tiny items — earrings, rings, charms">
              Don&rsquo;t sticker the product — put a label on a <b>kraft hang tag</b> with string (craft store, about
              $6 per 100) and tie it on.
            </Note>
            <p className="t-sm t-muted" style={{ margin: 0 }}>
              No printer? Print at any library or print shop for pennies — or ask us, we&rsquo;re happy to run a sheet for you.
            </p>
          </div>
        </Card>

        <Card title="Print your labels" id="labels" className="mb-4">
          <div className="mb-3"><Badge tone="info" icon="tag">Print labels</Badge></div>
          <Steps>
            <Step n={1}>In <b>My items</b>, tap <b>Print barcode labels</b>. (Easiest from a computer, but a phone works.)</Step>
            <Step n={2}>Pick your sheet size at the top: <b>Standard (30/sheet)</b> or <b>Small (60/sheet)</b> — match the labels you bought.</Step>
            <Step n={3}><b>Tick the items</b> you want labels for and set <b>copies</b> for each — it starts at your floor quantity, so usually you just check the boxes.</Step>
            <Step n={4}>Load a label sheet in your printer and tap <b>Print labels</b>.</Step>
            <Step n={5}>In the print window, set <b>Scale to 100%</b> — never &ldquo;Fit to page.&rdquo; This is the step everyone misses; wrong scale means barcodes miss the stickers.</Step>
            <Step n={6}><b>Sticker every item</b> on a flat spot — not over a seam, curve, or crinkly wrap. Flat barcodes scan; wrinkled ones don&rsquo;t.</Step>
          </Steps>
        </Card>

        <Divider>Part 4 · Running your booth week to week</Divider>

        <Card title="When you restock" id="restock" className="mb-4">
          <div className="mb-3"><Badge tone="info" icon="box">Restocking</Badge></div>
          <Steps>
            <Step n={1}>Come during a <b>restock window: 7–8 AM or 6–8 PM</b> (other times need staff approval — just ask).</Step>
            <Step n={2}>Sticker your new items <b>before</b> they go on the shelf.</Step>
            <Step n={3}>In <b>My items</b>, tap <b>Restock</b> on each item and enter <b>how many you just added</b> — the system does the math. (Miscounted or lost some? Fix the exact total inside <b>Edit</b>.) The count is what shoppers see online — keep it honest and your booth sells even when you&rsquo;re not there.</Step>
          </Steps>
        </Card>

        <Card title="Answer a pre-order — this is money, don't sleep on it" id="inbox" className="mb-4">
          <div className="mb-3"><Badge tone="info" icon="inbox">Inbox</Badge></div>
          <Steps>
            <Step n={1}>A red <b>Reply</b> badge on <b>Inbox</b> means a customer is waiting. Tap the message.</Step>
            <Step n={2}>Read what they want. If you can do it, fill in the <b>Accept</b> box: describe what they&rsquo;re getting, your price <b>before tax</b> (tax adds automatically), and the ready date.</Step>
            <Step n={3}>Tap <b>Accept &amp; send link</b>. They get a secure card-payment link by email.</Step>
            <Step n={4}>When they pay, it lands in <b>your balance automatically</b> and shows in the register for pickup day. You&rsquo;ll see a paid mark on the thread.</Step>
            <Step n={5}>Can&rsquo;t do it? <b>Decline</b> with one tap — no hard feelings, fast answers keep customers coming back. Regular questions: type a reply and <b>Send</b>; they get it by email.</Step>
          </Steps>
          <p className="t-sm t-muted mt-3" style={{ marginBottom: 0 }}>
            Don&rsquo;t want pre-orders at all? That&rsquo;s fine — turn <b>Accept pre-orders</b> off in <b>My page</b> and
            customers never see the option. Same for requests. Complaints always stay open — that&rsquo;s a market rule
            that protects everyone.
          </p>
        </Card>

        <Card title="Dress up your public page" id="mypage" className="mb-4">
          <div className="mb-3"><Badge tone="info" icon="star">My page</Badge></div>
          <Steps>
            <Step n={1}>In <b>My page</b>, upload your <b>logo</b> (shows on the market directory) and up to <b>6 product photos</b> — phone photos in good light work great.</Step>
            <Step n={2}>Write a <b>one-sentence blurb</b>: what you make and what makes it yours.</Step>
            <Step n={3}>Choose whether you accept <b>pre-orders</b> and <b>requests</b> (you can change anytime). The <b>self-checkout</b> toggle: on lets shoppers scan &amp; pay for your items on their own phones; off means staffed register only.</Step>
            <Step n={4}>Tap <b>Save</b>, then <b>Print my table QR card</b> and put it on your booth — shoppers scan it to browse you, review you, and message you.</Step>
          </Steps>
        </Card>

        <Card title="Getting paid" id="money" className="mb-4">
          <div className="mb-3"><Badge tone="info" icon="dollar">Money</Badge></div>
          <p className="t-body" style={{ margin: 0, lineHeight: 1.7 }}>
            Every sale credits your balance the moment it rings — your net, after any commission. Booth rent comes out
            of the same balance. The <b>Money</b> tab shows every line with a date, and balances{" "}
            <b>pay out by the 15th of the following month</b>. Something look off? Say so within 30 days — it&rsquo;s your
            agreement right, and we want the books right too.
          </p>
        </Card>

        <Divider>Part 5 · Good to know</Divider>

        <Card className="mb-4">
          <div className="row g-2 wrap">
            <Chip><Icon name="clock" size={12} /> Restock: 7–8 AM &amp; 6–8 PM</Chip>
            <Chip><Icon name="receipt" size={12} /> We handle sales tax</Chip>
            <Chip><Icon name="clipboard" size={12} /> Booth standards: <a href="/rules">/rules</a></Chip>
            <Chip><Icon name="store" size={12} /> Shelf-stable sells through our register</Chip>
            <Chip><Icon name="user" size={12} /> Refrigerated homemade = you sell in person</Chip>
            <Chip><Icon name="lock" size={12} /> Forgot password? Ask the market for a new one</Chip>
            <Chip><Icon name="message" size={12} /> Stuck? Ask any staff member</Chip>
          </div>
        </Card>

        <div style={{ maxWidth: 340, margin: "0 auto var(--sp-4)" }}>
          <LinkButton href="/" variant="primary" size="lg" block icon="lock" iconRight="arrowRight">
            Open your vendor portal
          </LinkButton>
        </div>

        <p className="t-sm t-muted" style={{ textAlign: "center" }}>
          We built all of this so your booth works for you while you live your life. Welcome aboard.
        </p>
      </main>
    </>
  );
}
