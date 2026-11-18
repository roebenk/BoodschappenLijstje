import fs from "node:fs";
import path from "node:path";

export interface RuntimeConfig {
  openRouterApiKey: string;
  hasOpenRouterKey: boolean;
  openRouterDefaultModel: string;
  openRouterFallbackModel: string;
  dataDir: string;
  tokenEncryptionKey: string;
  picnicMinOrderCents: number;
  picnicCountryCode: "NL" | "DE" | "FR";
  port: number;
}

let cache: { file: string; mtimeMs: number; values: Record<string, string> } | null = null;

/** Parses KEY=VALUE lines (comments, quotes and `export ` prefix supported). */
export function parseEnvFile(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of content.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2].trim();
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.endsWith(quote) && value.length >= 2) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, "");
    }
    out[match[1]] = value;
  }
  return out;
}

function resolveProjectRoot(): string {
  const cwd = process.cwd();
  if (cwd.replace(/\\/g, "/").endsWith("/.next/standalone")) {
    return path.resolve(cwd, "../..");
  }
  return cwd;
}

function readDotEnv(root: string): Record<string, string> {
  const file = path.join(root, ".env");
  try {
    const stat = fs.statSync(file);
    if (cache && cache.file === file && cache.mtimeMs === stat.mtimeMs) return cache.values;
    const values = parseEnvFile(fs.readFileSync(file, "utf8"));
    cache = { file, mtimeMs: stat.mtimeMs, values };
    return values;
  } catch {
    cache = null;
    return {};
  }
}

function toInt(value: string | undefined, fallback: number): number {
  const n = Number.parseInt(value ?? "", 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/**
 * Live runtime config: non-empty process.env wins, otherwise the current
 * `.env` file contents (re-read when its mtime changes, no restart needed).
 */
export function getRuntimeConfig(): RuntimeConfig {
  const root = resolveProjectRoot();
  const fileValues = readDotEnv(root);
  const get = (key: string): string => {
    const fromEnv = process.env[key];
    if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
    return fileValues[key] ?? "";
  };

  const openRouterApiKey = get("OPENROUTER_API_KEY").trim();
  const country = get("PICNIC_COUNTRY_CODE").toUpperCase();

  return {
    openRouterApiKey,
    hasOpenRouterKey: openRouterApiKey.length > 0,
    openRouterDefaultModel: get("OPENROUTER_DEFAULT_MODEL") || "google/gemini-2.5-flash-lite",
    openRouterFallbackModel: get("OPENROUTER_FALLBACK_MODEL") || "openai/gpt-4.1-mini",
    dataDir: path.resolve(root, get("DATA_DIR") || "./data"),
    tokenEncryptionKey: get("TOKEN_ENCRYPTION_KEY"),
    picnicMinOrderCents: toInt(get("PICNIC_MIN_ORDER_CENTS"), 3500),
    picnicCountryCode: country === "DE" || country === "FR" ? country : "NL",
    port: toInt(get("PORT"), 3000) || 3000,
  };
}
