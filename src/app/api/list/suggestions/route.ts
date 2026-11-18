import { NextResponse } from "next/server";
import { guard } from "../../_lib/http";
import { listRecentPurchaseSuggestions } from "@/lib/db/repositories";
import type { ListSuggestionsResponse } from "@/lib/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function GET() {
  return guard(() => NextResponse.json({ suggestions: listRecentPurchaseSuggestions() } satisfies ListSuggestionsResponse));
}
