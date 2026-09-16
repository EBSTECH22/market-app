"use client";

import type { CSSProperties, ReactNode } from "react";
import { Icon, type IconName } from "./Icon";

/* ------------------------------------------------------------- skeletons -- */

export function Skeleton({
  width = "100%",
  height = 16,
  radius,
  style,
}: {
  width?: number | string;
  height?: number | string;
  radius?: number | string;
  style?: CSSProperties;
}) {
  return (
    <span
      className="skeleton"
      aria-hidden
      style={{ display: "block", width, height, borderRadius: radius, ...style }}
    />
  );
}

/** Placeholder for a card of content that's still loading. */
export function SkeletonCard({ lines = 3 }: { lines?: number }) {
  return (
    <div className="card card-pad stack g-3" aria-hidden>
      <Skeleton width="45%" height={18} />
      {Array.from({ length: lines }).map((_, i) => (
        <Skeleton key={i} width={i === lines - 1 ? "60%" : "100%"} height={13} />
      ))}
    </div>
  );
}

export function SkeletonStats({ count = 4 }: { count?: number }) {
  return (
    <div className="grid-auto" style={{ ["--min" as string]: "180px" }} aria-hidden>
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="stat">
          <Skeleton width="55%" height={11} />
          <Skeleton width="70%" height={26} style={{ marginTop: 6 }} />
        </div>
      ))}
    </div>
  );
}

/* ----------------------------------------------------------- empty state -- */

export function EmptyState({
  icon = "box",
  title,
  body,
  action,
}: {
  icon?: IconName;
  title: string;
  body?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <span className="empty-icon"><Icon name={icon} size={22} /></span>
      <div className="empty-title">{title}</div>
      {body ? <p className="empty-body">{body}</p> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}

/* --------------------------------------------------------- inline notice -- */

export type NoteTone = "error" | "success" | "warn" | "info" | "neutral";

const NOTE_ICON: Record<NoteTone, IconName> = {
  error: "alert", success: "checkCircle", warn: "warning", info: "info", neutral: "info",
};

export function Note({
  tone = "info",
  title,
  children,
  action,
}: {
  tone?: NoteTone;
  title?: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className={`note note-${tone}`} role={tone === "error" ? "alert" : undefined}>
      <Icon name={NOTE_ICON[tone]} size={16} />
      <div className="grow">
        {title ? <div style={{ fontWeight: 580 }}>{title}</div> : null}
        {children ? <div style={{ marginTop: title ? 2 : 0 }}>{children}</div> : null}
      </div>
      {action ? <div className="shrink0">{action}</div> : null}
    </div>
  );
}

/* ---------------------------------------------------------------- badges -- */

export type BadgeTone = "neutral" | "success" | "danger" | "warn" | "info" | "solid";

export function Badge({
  tone = "neutral",
  children,
  dot,
  icon,
}: {
  tone?: BadgeTone;
  children: ReactNode;
  /** Adds a coloured dot so status never depends on colour alone. */
  dot?: boolean;
  icon?: IconName;
}) {
  return (
    <span className={`badge badge-${tone}`}>
      {dot ? <span className="badge-dot" aria-hidden /> : null}
      {icon ? <Icon name={icon} size={11} /> : null}
      {children}
    </span>
  );
}

/* ----------------------------------------------------------------- stats -- */

export function Stat({
  label,
  value,
  sub,
  feature,
  icon,
}: {
  label: ReactNode;
  value: ReactNode;
  sub?: ReactNode;
  /** The one dark focal tile in a row of stats. */
  feature?: boolean;
  icon?: IconName;
}) {
  return (
    <div className={`stat${feature ? " stat-feature" : ""}`}>
      <span className="stat-label row g-1">
        {icon ? <Icon name={icon} size={11} /> : null}
        {label}
      </span>
      <span className="stat-value truncate">{value}</span>
      {sub ? <span className="stat-sub truncate">{sub}</span> : null}
    </div>
  );
}

/* ----------------------------------------------------------------- cards -- */

export function Card({
  title,
  subtitle,
  actions,
  children,
  flush,
  footer,
  className = "",
  id,
}: {
  title?: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  /** Remove body padding — for a table that should touch the card edges. */
  flush?: boolean;
  footer?: ReactNode;
  className?: string;
  id?: string;
}) {
  return (
    <section className={`card ${className}`} id={id}>
      {title || actions ? (
        <header className="card-head">
          <div className="card-head-text">
            {/* Wraps rather than truncates — a card heading is the one piece of
                context telling you what the buttons beside it act on. */}
            <h2 className="t-card">{title}</h2>
            {subtitle ? <p className="t-xs t-muted" style={{ marginTop: 1 }}>{subtitle}</p> : null}
          </div>
          {actions ? <div className="card-head-actions">{actions}</div> : null}
        </header>
      ) : null}
      {children != null ? (
        <div className={flush ? "card-body-flush" : "card-body"}>{children}</div>
      ) : null}
      {footer ? <div className="card-foot">{footer}</div> : null}
    </section>
  );
}

/* ------------------------------------------------------------ page header -- */

export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="page-head">
      <div style={{ minWidth: 0 }}>
        <h1 className="page-title">{title}</h1>
        {subtitle ? <p className="page-sub">{subtitle}</p> : null}
      </div>
      {actions ? <div className="row g-2 wrap shrink0">{actions}</div> : null}
    </header>
  );
}
