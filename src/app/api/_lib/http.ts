import { NextResponse } from "next/server";
import { ServiceError } from "@/lib/services/errors";

export const jsonError = (status: number, error: string, details?: unknown) =>
  NextResponse.json({ error, ...(details === undefined ? {} : { details }) }, { status });

/** Runs a handler body and maps thrown errors to `{ error }` JSON responses. */
export async function guard(fn: () => Promise<Response> | Response): Promise<Response> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof ServiceError) return jsonError(e.status, e.message, e.details);
    return jsonError(500, e instanceof Error ? e.message : "Onbekende fout");
  }
}

export async function readJson<T = Record<string, unknown>>(req: Request, optional = false): Promise<T> {
  try {
    return (await req.json()) as T;
  } catch {
    if (optional) return {} as T;
    throw new ServiceError(400, "Ongeldige JSON in request body");
  }
}

export function parseId(raw: string): number {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) throw new ServiceError(400, "Ongeldig id");
  return id;
}
