import { NextResponse } from "next/server";
import { guard } from "../../_lib/http";
import { seedDemoHistory } from "@/lib/services/demoSeedService";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST() {
  return guard(async () => NextResponse.json(await seedDemoHistory()));
}
