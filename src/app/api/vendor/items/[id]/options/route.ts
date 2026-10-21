import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { currentVendorId } from "@/lib/auth";

export const dynamic = "force-dynamic";

/**
 * The questions an item asks when it's ordered, and the answers it accepts.
 *
 * GET                                         → this item's groups and options
 * POST   { kind: "group", name, ... }         → add a question
 * POST   { kind: "option", groupId, name, ... }→ add an answer
 * PATCH  { kind, id, ...fields }              → rename, reprice, reorder, sell out
 * DELETE { kind, id }                         → retire it
 *
 * RETIRED, NOT DELETED. An option that stops being offered is set inactive
 * rather than removed, because the vendor's own history reads better with it
 * there and because reordering a list with holes in it is how sort orders end
 * up duplicated. Orders already placed are safe either way — they carry the
 * words, not a link to this row.
 */

async function ownedItem(itemId: string) {
  const vendorId = currentVendorId();
  if (!vendorId) return { error: NextResponse.json({ error: "Not logged in." }, { status: 401 }) };
  const item = await db.item.findUnique({ where: { id: itemId }, select: { id: true, vendorId: true, name: true } });
  if (!item || item.vendorId !== vendorId) {
    return { error: NextResponse.json({ error: "Item not found." }, { status: 404 }) };
  }
  return { item };
}

const groupsOf = (itemId: string) =>
  db.itemOptionGroup.findMany({
    where: { itemId },
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    include: { options: { orderBy: [{ sortOrder: "asc" }, { name: "asc" }] } },
  });

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const owned = await ownedItem(params.id);
  if (owned.error) return owned.error;
  return NextResponse.json({ groups: await groupsOf(params.id) });
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const owned = await ownedItem(params.id);
  if (owned.error) return owned.error;

  const body = await req.json().catch(() => ({}));
  const name = String(body.name || "").trim().slice(0, 40);
  if (!name) return NextResponse.json({ error: "Give it a name." }, { status: 400 });

  if (body.kind === "group") {
    const count = await db.itemOptionGroup.count({ where: { itemId: params.id } });
    if (count >= 8) {
      return NextResponse.json({ error: "Eight questions per item is plenty — a longer menu than that stops people ordering." }, { status: 400 });
    }
    const required = body.required !== false;
    /* A required group must take at least one, and a group can never want
       more than it allows. Both are easy to set wrong in a form and
       impossible to recover from on the ordering page, where it would simply
       refuse every order with no way through. */
    const minChoices = required ? Math.max(1, Math.round(Number(body.minChoices) || 1)) : Math.max(0, Math.round(Number(body.minChoices) || 0));
    const maxChoices = Math.max(minChoices, Math.round(Number(body.maxChoices) || 1));

    const group = await db.itemOptionGroup.create({
      data: { itemId: params.id, name, required, minChoices, maxChoices, sortOrder: count },
    });
    return NextResponse.json({ group, groups: await groupsOf(params.id) });
  }

  if (body.kind === "option") {
    const groupId = String(body.groupId || "");
    const group = await db.itemOptionGroup.findUnique({ where: { id: groupId }, select: { id: true, itemId: true } });
    if (!group || group.itemId !== params.id) return NextResponse.json({ error: "That question isn't on this item." }, { status: 404 });

    const count = await db.itemOption.count({ where: { groupId } });
    if (count >= 25) return NextResponse.json({ error: "Twenty-five choices in one question is the most." }, { status: 400 });

    const delta = Math.round(Number(body.priceDeltaCents) || 0);
    if (!Number.isFinite(delta) || Math.abs(delta) > 100_00) {
      return NextResponse.json({ error: "A choice can change the price by at most $100." }, { status: 400 });
    }

    const option = await db.itemOption.create({
      data: { groupId, name, priceDeltaCents: delta, sortOrder: count },
    });
    return NextResponse.json({ option, groups: await groupsOf(params.id) });
  }

  return NextResponse.json({ error: "Unknown kind." }, { status: 400 });
}

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const owned = await ownedItem(params.id);
  if (owned.error) return owned.error;

  const body = await req.json().catch(() => ({}));
  const id = String(body.id || "");

  if (body.kind === "group") {
    const group = await db.itemOptionGroup.findUnique({ where: { id }, select: { id: true, itemId: true, required: true, minChoices: true, maxChoices: true } });
    if (!group || group.itemId !== params.id) return NextResponse.json({ error: "That question isn't on this item." }, { status: 404 });

    const data: { name?: string; required?: boolean; minChoices?: number; maxChoices?: number; sortOrder?: number; active?: boolean } = {};
    if (typeof body.name === "string" && body.name.trim()) data.name = body.name.trim().slice(0, 40);
    if (typeof body.required === "boolean") data.required = body.required;
    if (body.minChoices !== undefined) data.minChoices = Math.max(0, Math.round(Number(body.minChoices) || 0));
    if (body.maxChoices !== undefined) data.maxChoices = Math.max(1, Math.round(Number(body.maxChoices) || 1));
    if (body.sortOrder !== undefined) data.sortOrder = Math.max(0, Math.round(Number(body.sortOrder) || 0));
    if (typeof body.active === "boolean") data.active = body.active;

    /* Re-check the pair against what the row will BE, not against what was
       sent: changing only `required` has to drag the minimum with it, or a
       required question that takes none of anything blocks every order. */
    const required = data.required ?? group.required;
    const min = data.minChoices ?? group.minChoices;
    const max = data.maxChoices ?? group.maxChoices;
    data.minChoices = required ? Math.max(1, min) : Math.max(0, min);
    data.maxChoices = Math.max(data.minChoices, max);

    await db.itemOptionGroup.update({ where: { id }, data });
    return NextResponse.json({ groups: await groupsOf(params.id) });
  }

  if (body.kind === "option") {
    const option = await db.itemOption.findUnique({ where: { id }, select: { id: true, group: { select: { itemId: true } } } });
    if (!option || option.group.itemId !== params.id) return NextResponse.json({ error: "That choice isn't on this item." }, { status: 404 });

    const data: { name?: string; priceDeltaCents?: number; soldOut?: boolean; sortOrder?: number; active?: boolean } = {};
    if (typeof body.name === "string" && body.name.trim()) data.name = body.name.trim().slice(0, 40);
    if (body.priceDeltaCents !== undefined) {
      const delta = Math.round(Number(body.priceDeltaCents) || 0);
      if (!Number.isFinite(delta) || Math.abs(delta) > 100_00) {
        return NextResponse.json({ error: "A choice can change the price by at most $100." }, { status: 400 });
      }
      data.priceDeltaCents = delta;
    }
    if (typeof body.soldOut === "boolean") data.soldOut = body.soldOut;
    if (body.sortOrder !== undefined) data.sortOrder = Math.max(0, Math.round(Number(body.sortOrder) || 0));
    if (typeof body.active === "boolean") data.active = body.active;

    if (!Object.keys(data).length) return NextResponse.json({ error: "Nothing to change." }, { status: 400 });
    await db.itemOption.update({ where: { id }, data });
    return NextResponse.json({ groups: await groupsOf(params.id) });
  }

  return NextResponse.json({ error: "Unknown kind." }, { status: 400 });
}

export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  const owned = await ownedItem(params.id);
  if (owned.error) return owned.error;

  const body = await req.json().catch(() => ({}));
  const id = String(body.id || "");

  if (body.kind === "group") {
    const group = await db.itemOptionGroup.findUnique({ where: { id }, select: { id: true, itemId: true } });
    if (!group || group.itemId !== params.id) return NextResponse.json({ error: "That question isn't on this item." }, { status: 404 });
    await db.itemOptionGroup.update({ where: { id }, data: { active: false } });
    return NextResponse.json({ groups: await groupsOf(params.id) });
  }

  if (body.kind === "option") {
    const option = await db.itemOption.findUnique({ where: { id }, select: { id: true, group: { select: { itemId: true } } } });
    if (!option || option.group.itemId !== params.id) return NextResponse.json({ error: "That choice isn't on this item." }, { status: 404 });
    await db.itemOption.update({ where: { id }, data: { active: false } });
    return NextResponse.json({ groups: await groupsOf(params.id) });
  }

  return NextResponse.json({ error: "Unknown kind." }, { status: 400 });
}
