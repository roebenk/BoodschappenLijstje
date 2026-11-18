import { NextResponse } from "next/server";
import { guard, jsonError, readJson } from "../_lib/http";
import { addItemsToShoppingList, clearList, getFullListState } from "@/lib/services/shoppingService";
import type { AddListItemsRequest, AddListItemsResponse, OkResponse } from "@/lib/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  return guard(() => NextResponse.json(getFullListState()));
}

export async function POST(request: Request) {
  return guard(async () => {
    const body = await readJson<Partial<AddListItemsRequest>>(request);
    if (!Array.isArray(body.inputs) || body.inputs.some((i) => typeof i !== "string")) {
      return jsonError(400, "`inputs` moet een lijst met tekstregels zijn");
    }
    const items = await addItemsToShoppingList(body.inputs);
    return NextResponse.json({ items } satisfies AddListItemsResponse, { status: 201 });
  });
}

export async function DELETE(request: Request) {
  return guard(() => {
    const params = new URL(request.url).searchParams;
    if (params.get("all") === "1") clearList("all");
    else if (params.get("checked") === "1") clearList("checked");
    else return jsonError(400, "Gebruik ?checked=1 of ?all=1");
    return NextResponse.json({ ok: true } satisfies OkResponse);
  });
}
