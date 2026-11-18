import { NextResponse } from "next/server";
import { guard, parseId, readJson } from "../../_lib/http";
import { getItemComparisonDetails, removeItem, updateItem } from "@/lib/services/shoppingService";
import type { OkResponse, UpdateListItemRequest, UpdateListItemResponse } from "@/lib/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ id: string }> };

export async function GET(_request: Request, context: Context) {
  return guard(async () => {
    const id = parseId((await context.params).id);
    return NextResponse.json(await getItemComparisonDetails(id));
  });
}

export async function PATCH(request: Request, context: Context) {
  return guard(async () => {
    const id = parseId((await context.params).id);
    const patch = await readJson<UpdateListItemRequest>(request);
    const item = await updateItem(id, patch);
    return NextResponse.json({ item } satisfies UpdateListItemResponse);
  });
}

export async function DELETE(_request: Request, context: Context) {
  return guard(async () => {
    const id = parseId((await context.params).id);
    removeItem(id);
    return NextResponse.json({ ok: true } satisfies OkResponse);
  });
}
