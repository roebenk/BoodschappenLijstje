import { NextResponse } from "next/server";
import { guard } from "../_lib/http";
import { getStatsView } from "@/lib/services/statsService";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  return guard(() => NextResponse.json(getStatsView()));
}
