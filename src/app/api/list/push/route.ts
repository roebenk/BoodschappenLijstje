import { NextResponse } from "next/server";
import { guard, jsonError, readJson } from "../../_lib/http";
import { pushListToStores } from "@/lib/services/shoppingService";
import type { PushListRequest } from "@/lib/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request) {
  return guard(async () => {
    const body = await readJson<Partial<PushListRequest>>(request, true);
    const mode = body.mode ?? "preview";
    if (mode !== "preview" && mode !== "push") return jsonError(400, "Ongeldige mode");
    return NextResponse.json(
      await pushListToStores({ mode, providers: body.providers, autoCheckPushed: body.autoCheckPushed }),
    );
  });
}
