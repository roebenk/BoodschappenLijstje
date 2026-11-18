import { NextResponse } from "next/server";
import { guard } from "../_lib/http";
import { getAllProviders } from "@/lib/providers/registry";
import type { StoreInfo, StoresResponse } from "@/lib/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  return guard(async () => {
    const stores = await Promise.all(
      getAllProviders().map(async (p): Promise<StoreInfo> => {
        let auth;
        try {
          auth = await p.getAuthState();
        } catch (e) {
          auth = { provider: p.id, status: "error" as const, message: e instanceof Error ? e.message : "Onbekende fout" };
        }
        return { provider: p.id, displayName: p.displayName, channel: p.channel, capabilities: p.capabilities, auth };
      }),
    );
    return NextResponse.json({ stores } satisfies StoresResponse);
  });
}
