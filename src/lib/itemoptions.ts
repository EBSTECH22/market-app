/**
 * Item options — "Large", "Strawberry", "Extra ice".
 *
 * An item with no option groups behaves exactly as it always has. That is the
 * point: three hundred jars of jam on this floor need nothing, and one drinks
 * stand needs sizes and flavours, so options are something an item opts into
 * rather than something every item now carries.
 *
 * WHAT A CHOICE DOES TO THE PRICE. Each option carries a delta in cents, added
 * to the vendor's price for the item. Deltas can be negative — a small costing
 * less than the listed price is the normal way to write a drinks menu — and the
 * result is floored at zero, because no arrangement of options should ever make
 * the market pay the customer.
 *
 * WHERE THE MARKET FEE AND CARD PERCENTAGE GO: on top, afterwards, exactly as
 * they do for an item with no options. The delta moves the VENDOR'S price; the
 * fee and the card percentage are then worked out from that, by the same
 * functions in lib/cardprice, so a drink with options and a jar of jam are
 * priced by the same rules and the vendor is paid on their own number either
 * way.
 *
 * This file is pure — no database, no next/headers — so the register, the
 * ordering page and the server all import it and agree to the cent.
 */

export type OptionChoice = {
  id: string;
  name: string;
  priceDeltaCents: number;
  soldOut?: boolean;
  active?: boolean;
};

export type OptionGroup = {
  id: string;
  name: string;
  required: boolean;
  minChoices: number;
  maxChoices: number;
  active?: boolean;
  options: OptionChoice[];
};

export type Selection = {
  /** Group id → the option ids chosen in it. */
  [groupId: string]: string[];
};

export type ResolvedSelection = {
  /** Chosen options in menu order, for display and for the snapshot. */
  chosen: { groupName: string; name: string; priceDeltaCents: number }[];
  /** The sum of the deltas. May be negative. */
  deltaCents: number;
  /** "Large · Strawberry · Extra ice" — what gets stored on the line. */
  text: string;
};

/** Only groups and options still in use. A retired option stays on old orders
    through the snapshot, but must not be offered again. */
export function liveGroups(groups: OptionGroup[]): OptionGroup[] {
  return groups
    .filter((g) => g.active !== false)
    .map((g) => ({ ...g, options: g.options.filter((o) => o.active !== false) }))
    .filter((g) => g.options.length > 0);
}

/**
 * Check a set of choices against the menu.
 *
 * Returns the first problem in words a customer can act on, or null. Called on
 * the server for every order — a page can be edited, and a basket that priced
 * itself in the browser is a basket somebody can set to zero.
 */
export function validateSelection(groups: OptionGroup[], selection: Selection): string | null {
  for (const g of liveGroups(groups)) {
    const picked = (selection[g.id] || []).filter((id) => g.options.some((o) => o.id === id));
    const min = g.required ? Math.max(1, g.minChoices) : Math.max(0, g.minChoices);
    const max = Math.max(min, g.maxChoices);

    if (picked.length < min) {
      return min === 1 ? `Choose a ${g.name.toLowerCase()}.` : `Choose at least ${min} from ${g.name}.`;
    }
    if (picked.length > max) {
      return max === 1 ? `Only one ${g.name.toLowerCase()}.` : `Choose at most ${max} from ${g.name}.`;
    }
    /* Sold out is checked here rather than at display time, because a syrup can
       run out between loading the page and pressing Order. */
    for (const id of picked) {
      const o = g.options.find((x) => x.id === id);
      if (o?.soldOut) return `${o.name} has just sold out — pick something else.`;
    }
  }

  /* Anything sent that isn't on this item's menu at all. Not a customer
     mistake — a basket that has been tampered with, or a stale page. */
  const known = new Set(liveGroups(groups).flatMap((g) => g.options.map((o) => o.id)));
  for (const ids of Object.values(selection)) {
    for (const id of ids) {
      if (!known.has(id)) return "That choice isn't on the menu any more — reload and try again.";
    }
  }
  return null;
}

/**
 * Turn a validated set of choices into a price delta and a line of text.
 *
 * Menu order, not click order: two people ordering the same drink should get
 * the same words on the ticket, or the vendor reads two lines and sees two
 * different drinks.
 */
export function resolveSelection(groups: OptionGroup[], selection: Selection): ResolvedSelection {
  const chosen: ResolvedSelection["chosen"] = [];
  for (const g of liveGroups(groups)) {
    const picked = selection[g.id] || [];
    for (const o of g.options) {
      if (picked.includes(o.id)) {
        chosen.push({ groupName: g.name, name: o.name, priceDeltaCents: Math.round(o.priceDeltaCents || 0) });
      }
    }
  }
  return {
    chosen,
    deltaCents: chosen.reduce((n, c) => n + c.priceDeltaCents, 0),
    text: chosen.map((c) => c.name).join(" · "),
  };
}

/**
 * The vendor's price for one unit, with the choices applied.
 *
 * `baseCents` is the item's price AFTER any sale percentage and BEFORE the
 * market fee — the same number the rest of the app calls the vendor's price.
 */
export function unitVendorCents(baseCents: number, deltaCents: number): number {
  return Math.max(0, Math.round(baseCents || 0) + Math.round(deltaCents || 0));
}

/** Does this item ask anything before it can be ordered? */
export function needsChoices(groups: OptionGroup[]): boolean {
  return liveGroups(groups).some((g) => g.required || g.minChoices > 0);
}
