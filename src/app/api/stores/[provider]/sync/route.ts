import { NextResponse } from "next/server";
import { guard, jsonError } from "../../../_lib/http";
import { syncStore } from "@/lib/services/preferencesService";
import type { StoreProviderId } from "@/lib/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const IDS: StoreProviderId[] = ["ah", "picnic", "jumbo", "plus"];

export async function POST(_request: Request, context: { params: Promise<{ provider: string }> }) {
  return guard(async () => {
    const { provider } = await context.params;
    if (!IDS.includes(provider as StoreProviderId)) return jsonError(404, "Onbekende winkel");
    return NextResponse.json(await syncStore(provider as StoreProviderId));
  });
}
