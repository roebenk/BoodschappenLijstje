import { NextResponse } from "next/server";
import { guard, jsonError, readJson } from "../../_lib/http";
import { optimizeUnlockedList } from "@/lib/services/shoppingService";
import type { OptimizeListRequest } from "@/lib/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request) {
  return guard(async () => {
    const body = await readJson<OptimizeListRequest & { forceMode?: "optimal" | "all_ah" }>(request, true);
    if (body.itemIds !== undefined && (!Array.isArray(body.itemIds) || body.itemIds.some((i) => !Number.isInteger(i)))) {
      return jsonError(400, "`itemIds` moet een lijst met ids zijn");
    }
    if (body.forceMode !== undefined && body.forceMode !== "optimal" && body.forceMode !== "all_ah") {
      return jsonError(400, "Ongeldige forceMode");
    }
    return NextResponse.json(optimizeUnlockedList(body.itemIds, body.forceMode));
  });
}
