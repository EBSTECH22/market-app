"use client";

import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import { Icon, type IconName } from "./Icon";
import { Skeleton } from "./Feedback";

/**
 * One table component for the whole app. The old code had two parallel systems —
 * <table className="grid"> in some places and hand-rolled <ul>/flex rows in
 * others — so sorting, empty states and mobile behaviour were inconsistent
 * everywhere. This handles sorting, loading, empty state, row clicks, and a
 * card layout on phones where a wide table can't be read.
 */

export type Column<T> = {
  key: string;
  header: ReactNode;
  /** Cell content. */
  cell: (row: T) => ReactNode;
  /** Return a comparable value to make the column sortable. */
  sortBy?: (row: T) => string | number;
  align?: "left" | "right";
  /** Hide on narrow screens when the card layout isn't used. */
  hideBelow?: number;
  width?: string;
  /** Used as the label in the mobile card layout. Defaults to `header`. */
  mobileLabel?: ReactNode;
  /** Promote to the card's title line on mobile. */
  primary?: boolean;
};

type Props<T> = {
  rows: T[];
  columns: Column<T>[];
  rowKey: (row: T) => string;
  loading?: boolean;
  /** Rows to show as skeletons while loading. */
  skeletonRows?: number;
  empty?: ReactNode;
  onRowClick?: (row: T) => void;
  /** Column key to sort by initially. */
  defaultSort?: { key: string; dir: "asc" | "desc" };
  /** Render the mobile layout as stacked cards instead of a scrolling table. */
  mobileCards?: boolean;
  caption?: string;
};

export function DataTable<T>({
  rows,
  columns,
  rowKey,
  loading,
  skeletonRows = 5,
  empty,
  onRowClick,
  defaultSort,
  mobileCards,
  caption,
}: Props<T>) {
  const [sort, setSort] = useState<{ key: string; dir: "asc" | "desc" } | null>(defaultSort ?? null);

  const sorted = useMemo(() => {
    if (!sort) return rows;
    const col = columns.find((c) => c.key === sort.key);
    if (!col?.sortBy) return rows;
    const get = col.sortBy;
    const factor = sort.dir === "asc" ? 1 : -1;
    return [...rows].sort((a, b) => {
      const av = get(a);
      const bv = get(b);
      if (typeof av === "number" && typeof bv === "number") return (av - bv) * factor;
      return String(av).localeCompare(String(bv), undefined, { numeric: true }) * factor;
    });
  }, [rows, columns, sort]);

  const toggleSort = (key: string) => {
    setSort((s) =>
      s?.key === key
        ? (s.dir === "asc" ? { key, dir: "desc" } : null)
        : { key, dir: "asc" }
    );
  };

  if (loading) {
    return (
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>{columns.map((c) => <th key={c.key} style={{ width: c.width }}>{c.header}</th>)}</tr>
          </thead>
          <tbody>
            {Array.from({ length: skeletonRows }).map((_, i) => (
              <tr key={i}>
                {columns.map((c) => (
                  <td key={c.key}><Skeleton height={14} width={c.align === "right" ? 60 : "70%"} /></td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  if (sorted.length === 0) return <>{empty}</>;

  // --- mobile card layout ---
  const cards = mobileCards ? (
    <div className="stack g-2 dt-cards">
      {sorted.map((row) => {
        const primary = columns.filter((c) => c.primary);
        const rest = columns.filter((c) => !c.primary);
        const Wrapper = onRowClick ? "button" : "div";
        return (
          <Wrapper
            key={rowKey(row)}
            className={onRowClick ? "card-link card-pad-sm" : "card card-pad-sm"}
            {...(onRowClick ? { type: "button" as const, onClick: () => onRowClick(row) } : {})}
          >
            {primary.length > 0 ? (
              <div className="row between g-2 mb-2">
                {primary.map((c) => <div key={c.key} className="t-card truncate">{c.cell(row)}</div>)}
              </div>
            ) : null}
            <div className="stack g-1">
              {rest.map((c) => (
                <div key={c.key} className="row between g-3">
                  <span className="t-label shrink0">{c.mobileLabel ?? c.header}</span>
                  <span className="t-sm" style={{ textAlign: "right", minWidth: 0 }}>{c.cell(row)}</span>
                </div>
              ))}
            </div>
          </Wrapper>
        );
      })}
    </div>
  ) : null;

  return (
    <>
      {cards}
      <div className={`table-wrap${mobileCards ? " dt-table" : ""}`}>
        <table className="table">
          {caption ? <caption className="sr-only">{caption}</caption> : null}
          <thead>
            <tr>
              {columns.map((c) => {
                const active = sort?.key === c.key;
                const ariaSort = active ? (sort!.dir === "asc" ? "ascending" : "descending") : "none";
                return (
                  <th
                    key={c.key}
                    style={{ width: c.width, textAlign: c.align === "right" ? "right" : "left" }}
                    aria-sort={c.sortBy ? ariaSort : undefined}
                  >
                    {c.sortBy ? (
                      <button
                        type="button"
                        className="th-sort"
                        onClick={() => toggleSort(c.key)}
                      >
                        {c.header}
                        <Icon name={active ? (sort!.dir === "asc" ? "chevronUp" : "chevronDown") : "sort"} size={12} />
                      </button>
                    ) : (
                      c.header
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {sorted.map((row) => (
              <tr
                key={rowKey(row)}
                className={onRowClick ? "row-action" : undefined}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
                tabIndex={onRowClick ? 0 : undefined}
                onKeyDown={
                  onRowClick
                    ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onRowClick(row); } }
                    : undefined
                }
              >
                {columns.map((c) => (
                  <td key={c.key} className={c.align === "right" ? "right num" : undefined}>
                    {c.cell(row)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {mobileCards ? (
        <style>{`
          .dt-cards { display: none; }
          @media (max-width: 760px) {
            .dt-cards { display: flex; }
            .dt-table { display: none; }
          }
        `}</style>
      ) : null}
    </>
  );
}

/** A compact label/value list — used inside detail panels. */
export function DescList({ items }: { items: { label: ReactNode; value: ReactNode }[] }) {
  return (
    <dl className="stack g-3">
      {items.map((it, i) => (
        <div key={i} className="row-top between g-4">
          <dt className="t-label shrink0" style={{ paddingTop: 2 }}>{it.label}</dt>
          <dd className="t-sm" style={{ textAlign: "right", minWidth: 0, wordBreak: "break-word" }}>
            {it.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function TableIconHeader({ icon, children }: { icon: IconName; children: ReactNode }) {
  return <span className="row g-1"><Icon name={icon} size={12} />{children}</span>;
}

export default DataTable;
