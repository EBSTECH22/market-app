import { db } from "@/lib/db";
import type { OptionGroup } from "@/lib/itemoptions";

/**
 * Which questions an item asks: its own, plus its vendor's.
 *
 * THE ONE PLACE THAT ANSWERS THIS. A group belongs either to a single item or
 * to the whole menu, and every screen that prices, sells, displays or rings up
 * an item has to see the same combined list — the till, the ordering page, the
 * barcode lookup, the shop. Working it out separately in each of them is how a
 * drink gets offered a flavour online that the till has never heard of.
 *
 * Shared groups come FIRST. On a menu where everything shares its flavours,
 * those are the questions a customer is actually being asked; anything an item
 * adds on its own is the exception and belongs after.
 */

type Loaded = {
  id: string;
  name: string;
  required: boolean;
  minChoices: number;
  maxChoices: number;
  sortOrder: number;
  itemId: string | null;
  vendorId: string | null;
  options: { id: string; name: string; priceDeltaCents: number; soldOut: boolean; sortOrder: number }[];
};

const shape = (g: Loaded): OptionGroup => ({
  id: g.id,
  name: g.name,
  required: g.required,
  minChoices: g.minChoices,
  maxChoices: g.maxChoices,
  options: g.options.map((o) => ({
    id: o.id,
    name: o.name,
    priceDeltaCents: o.priceDeltaCents,
    soldOut: o.soldOut,
  })),
});

const bySort = (a: Loaded, b: Loaded) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name);

/**
 * For a set of items, the groups each one asks.
 *
 * Two queries whatever the size of the menu — the items' own groups and their
 * vendors' — rather than one per item.
 */
export async function groupsByItem(
  items: { id: string; vendorId: string }[]
): Promise<Map<string, OptionGroup[]>> {
  const out = new Map<string, OptionGroup[]>();
  if (items.length === 0) return out;

  const itemIds = [...new Set(items.map((i) => i.id))];
  const vendorIds = [...new Set(items.map((i) => i.vendorId))];

  const select = {
    id: true, name: true, required: true, minChoices: true, maxChoices: true,
    sortOrder: true, itemId: true, vendorId: true,
    options: {
      where: { active: true },
      orderBy: [{ sortOrder: "asc" as const }, { name: "asc" as const }],
      select: { id: true, name: true, priceDeltaCents: true, soldOut: true, sortOrder: true },
    },
  };

  const [own, shared] = await Promise.all([
    db.itemOptionGroup.findMany({ where: { active: true, itemId: { in: itemIds } }, select }),
    db.itemOptionGroup.findMany({ where: { active: true, vendorId: { in: vendorIds } }, select }),
  ]);

  const sharedByVendor = new Map<string, Loaded[]>();
  for (const g of shared as Loaded[]) {
    if (!g.vendorId) continue;
    const list = sharedByVendor.get(g.vendorId) || [];
    list.push(g);
    sharedByVendor.set(g.vendorId, list);
  }

  const ownByItem = new Map<string, Loaded[]>();
  for (const g of own as Loaded[]) {
    if (!g.itemId) continue;
    const list = ownByItem.get(g.itemId) || [];
    list.push(g);
    ownByItem.set(g.itemId, list);
  }

  for (const i of items) {
    const groups = [
      ...(sharedByVendor.get(i.vendorId) || []).sort(bySort),
      ...(ownByItem.get(i.id) || []).sort(bySort),
    ]
      /* A group with nothing left to choose from is not a question. It would
         otherwise sit on the menu as an empty heading, and — if it is marked
         required — refuse every order with no way to satisfy it. */
      .filter((g) => g.options.length > 0);
    out.set(i.id, groups.map(shape));
  }
  return out;
}

/** The same, for one item. */
export async function groupsForItem(item: { id: string; vendorId: string }): Promise<OptionGroup[]> {
  return (await groupsByItem([item])).get(item.id) || [];
}
