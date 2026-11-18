import { NextResponse } from "next/server";
import { guard, readJson } from "../_lib/http";
import { getAppSettings, getPreferencesView, updateConceptPreference } from "@/lib/services/preferencesService";
import type { UpdateConceptPreferenceRequest } from "@/lib/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  return guard(async () => NextResponse.json(await getPreferencesView()));
}

export async function PATCH(request: Request) {
  return guard(async () => {
    updateConceptPreference(await readJson<UpdateConceptPreferenceRequest>(request));
    return NextResponse.json({ ok: true, settings: getAppSettings() });
  });
}
