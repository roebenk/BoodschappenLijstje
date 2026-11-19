import { NextResponse } from "next/server";
import { guard, parseId } from "../../../_lib/http";
import { searchProductsForItem } from "@/lib/services/shoppingService";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return guard(async () => {
    const id = parseId((await context.params).id);
    const params = new URL(request.url).searchParams;
    return NextResponse.json(await searchProductsForItem(id, params.get("provider") ?? "", params.get("query") ?? ""));
  });
}
