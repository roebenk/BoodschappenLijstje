import { NextResponse } from "next/server";
import { guard } from "../_lib/http";
import { getDealsView } from "@/lib/services/preferencesService";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  return guard(async () => NextResponse.json(await getDealsView()));
}
