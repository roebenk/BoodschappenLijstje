import path from "node:path";
import { NextResponse } from "next/server";
import { getRuntimeConfig } from "@/lib/config";
import { getDb } from "@/lib/db";
import { getAllProviders } from "@/lib/providers/registry";
import type { HealthResponse, StoreAuthState } from "@/lib/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const cfg = getRuntimeConfig();
  let dbOk = false;
  try {
    getDb().prepare("SELECT 1").get();
    dbOk = true;
  } catch {
    dbOk = false;
  }
  const stores: StoreAuthState[] = await Promise.all(
    getAllProviders().map(async (p): Promise<StoreAuthState> => {
      try {
        return await p.getAuthState();
      } catch (e) {
        return { provider: p.id, status: "error", message: e instanceof Error ? e.message : "Onbekende fout" };
      }
    }),
  );
  const body: HealthResponse = {
    ok: dbOk,
    version: process.env.npm_package_version ?? "0.1.0",
    time: new Date().toISOString(),
    openRouter: {
      configured: cfg.hasOpenRouterKey,
      defaultModel: cfg.openRouterDefaultModel,
      fallbackModel: cfg.openRouterFallbackModel,
    },
    stores,
    database: { ok: dbOk, path: path.join(cfg.dataDir, "boodschappen.db") },
  };
  return NextResponse.json(body, { status: dbOk ? 200 : 503 });
}
