import { LinkButton } from "@/components/ui";

export type Banner = {
  enabled: boolean;
  title: string;
  dateLine: string;
  message: string;
};

/**
 * The market's event banner with its sponsor sticker.
 *
 * This markup used to be copy-pasted verbatim into /market and /apply; it now
 * lives here so the two can't drift. The "Sponsored by" line was 9px and
 * rotated 12deg — both below/against legibility minimums — so it now uses
 * --fs-2xs (11px) and sits square.
 */
export default function SponsorBanner({
  banner,
  showApplyLink = false,
}: {
  banner: Banner | null | undefined;
  /** Show the "Become a vendor" call to action (hidden on /apply itself). */
  showApplyLink?: boolean;
}) {
  if (!banner?.enabled) return null;

  return (
    <aside
      aria-label="Market event"
      style={{
        background: "var(--n-900)",
        color: "var(--n-0)",
        borderRadius: "var(--r-xl)",
        padding: "var(--sp-5)",
        marginBottom: "var(--sp-4)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        gap: "var(--sp-5)",
        flexWrap: "wrap",
        textAlign: "center",
        boxShadow: "var(--sh-md)",
      }}
    >
      <div style={{ flex: "1 1 240px", minWidth: 0 }}>
        <div
          className="display"
          style={{ fontSize: "var(--fs-2xl)", letterSpacing: "0.02em", lineHeight: 1.15 }}
        >
          {banner.title}
        </div>
        <div className="display" style={{ fontSize: "var(--fs-lg)", marginTop: "var(--sp-2)" }}>
          {banner.dateLine}
        </div>
        {banner.message ? (
          <p style={{ fontSize: "var(--fs-base)", marginTop: "var(--sp-2)", lineHeight: 1.6 }}>
            {banner.message}
          </p>
        ) : null}
        {showApplyLink ? (
          <div style={{ marginTop: "var(--sp-3)" }}>
            <LinkButton href="/apply" variant="secondary" size="sm" iconRight="arrowRight">
              Become a vendor
            </LinkButton>
          </div>
        ) : null}
      </div>

      <div
        className="shrink0"
        style={{
          width: 116,
          height: 116,
          borderRadius: "var(--r-full)",
          border: "2px dashed var(--n-400)",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: "var(--sp-2)",
          padding: "var(--sp-2)",
        }}
      >
        <span
          style={{
            fontSize: "var(--fs-2xs)",
            fontWeight: 700,
            letterSpacing: "0.1em",
            color: "var(--n-0)",
            lineHeight: 1,
          }}
        >
          Sponsored by
        </span>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/sponsor-lightfoot.png"
          alt="Lightfoot Roofs"
          style={{ width: "76%", height: "auto", display: "block" }}
        />
      </div>
    </aside>
  );
}
