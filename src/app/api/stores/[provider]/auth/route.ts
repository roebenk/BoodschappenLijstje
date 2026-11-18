import { NextResponse } from "next/server";
import { guard, jsonError, readJson } from "../../../_lib/http";
import { getProvider } from "@/lib/providers/registry";
import { emitEvent, nowIso } from "@/lib/services/eventBus";
import type { StoreAuthRequest, StoreProviderId } from "@/lib/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const IDS: StoreProviderId[] = ["ah", "picnic", "jumbo", "plus"];

export async function POST(request: Request, context: { params: Promise<{ provider: string }> }) {
  return guard(async () => {
    const { provider } = await context.params;
    if (!IDS.includes(provider as StoreProviderId)) return jsonError(404, "Onbekende winkel");
    const body = await readJson<StoreAuthRequest>(request);
    if (!body || typeof body.step !== "string") return jsonError(400, "`step` ontbreekt");
    const result = await getProvider(provider as StoreProviderId).authenticate(body);
    emitEvent({ type: "stores.changed", at: nowIso(), provider: provider as StoreProviderId });
    return NextResponse.json(result);
  });
}
