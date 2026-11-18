import { deleteStoreAccount, getStoreAccount, getStoreTokens, saveStoreAccount } from "../../db/repositories";
import type { AuthFlowInput, AuthFlowResult, StoreAuthState } from "../../types";
import { AH_CLIENT_ID, AH_LOGIN_URL, AhAuthRequiredError, AhHttpError, ahRequest } from "./client";

const SKEW_MS = 60_000;
export const SESSION_EXPIRED_MESSAGE = "Sessie verlopen — koppel Albert Heijn opnieuw";

export interface AhTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  isUserToken: true;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
}

let anonymous: { accessToken: string; expiresAt: number } | null = null;
let anonymousInflight: Promise<string> | null = null;
let refreshInflight: Promise<string | null> | null = null;

export function resetAhAuthCacheForTests(): void {
  anonymous = null;
  anonymousInflight = null;
  refreshInflight = null;
}

export async function getAnonymousToken(): Promise<string> {
  if (anonymous && Date.now() < anonymous.expiresAt - SKEW_MS) return anonymous.accessToken;
  anonymousInflight ??= (async () => {
    try {
      const res = await ahRequest<TokenResponse>("/mobile-auth/v1/auth/token/anonymous", {
        method: "POST",
        body: { clientId: AH_CLIENT_ID },
      });
      anonymous = {
        accessToken: res.access_token,
        expiresAt: Date.now() + (res.expires_in ?? 600_000) * 1000,
      };
      return anonymous.accessToken;
    } finally {
      anonymousInflight = null;
    }
  })();
  return anonymousInflight;
}

function toTokens(res: TokenResponse, fallbackRefresh = ""): AhTokens {
  return {
    accessToken: res.access_token,
    refreshToken: res.refresh_token ?? fallbackRefresh,
    expiresAt: Date.now() + (res.expires_in ?? 900) * 1000,
    isUserToken: true,
  };
}

function persistTokens(tokens: AhTokens): void {
  const existing = getStoreAccount("ah");
  saveStoreAccount("ah", { tokens, status: "authenticated", meta: { ...(existing?.meta ?? {}), message: null } });
}

async function refreshUserToken(current: AhTokens): Promise<string | null> {
  try {
    const res = await ahRequest<TokenResponse>("/mobile-auth/v1/auth/token/refresh", {
      method: "POST",
      body: { clientId: AH_CLIENT_ID, refreshToken: current.refreshToken },
    });
    const next = toTokens(res, current.refreshToken);
    persistTokens(next);
    return next.accessToken;
  } catch (e) {
    if (e instanceof AhHttpError && (e.status === 400 || e.status === 401)) {
      const existing = getStoreAccount("ah");
      saveStoreAccount("ah", {
        tokens: null,
        status: "error",
        meta: { ...(existing?.meta ?? {}), message: SESSION_EXPIRED_MESSAGE },
      });
    }
    // Network/5xx: keep the (unspent) refresh token and fall back to anonymous for now.
    return null;
  }
}

/** Valid user access token, refreshing (single-flight) when needed. `null` when not linked or session is dead. */
export async function getUserAccessToken(): Promise<string | null> {
  const account = getStoreAccount("ah");
  if (!account || account.status !== "authenticated" || !account.hasTokens) return null;
  if (refreshInflight) return refreshInflight;
  const tokens = getStoreTokens<AhTokens>("ah");
  if (!tokens?.accessToken) return null;
  if (Date.now() < tokens.expiresAt - SKEW_MS) return tokens.accessToken;
  refreshInflight = refreshUserToken(tokens).finally(() => {
    refreshInflight = null;
  });
  return refreshInflight;
}

export async function requireUserToken(): Promise<string> {
  const token = await getUserAccessToken();
  if (!token) {
    const account = getStoreAccount("ah");
    throw new AhAuthRequiredError(
      account?.status === "error" ? SESSION_EXPIRED_MESSAGE : undefined,
    );
  }
  return token;
}

/** User token when linked, otherwise anonymous. */
export async function getAccessToken(): Promise<{ token: string; isUser: boolean }> {
  const user = await getUserAccessToken();
  if (user) return { token: user, isUser: true };
  return { token: await getAnonymousToken(), isUser: false };
}

export function extractAuthCode(codeOrUrl: string): string | null {
  const input = codeOrUrl.trim();
  if (!input) return null;
  const m = /[?&]code=([^&#\s]+)/.exec(input);
  if (m) return decodeURIComponent(m[1]);
  if (/^[\w\-.~%]+$/.test(input)) return input;
  return null;
}

export async function getAuthState(): Promise<StoreAuthState> {
  const account = getStoreAccount("ah");
  if (account?.status === "authenticated" && account.hasTokens) {
    return {
      provider: "ah",
      status: "authenticated",
      lastSyncedAt: account.lastSyncedAt,
      message: "Albert Heijn is gekoppeld",
    };
  }
  if (account?.status === "error") {
    return {
      provider: "ah",
      status: "error",
      lastSyncedAt: account.lastSyncedAt,
      message: (account.meta.message as string | undefined) ?? SESSION_EXPIRED_MESSAGE,
    };
  }
  return {
    provider: "ah",
    status: "anonymous",
    message: "Zoeken en Bonus werken zonder inloggen. Koppel je account voor kassabonnen en je lijstje.",
  };
}

export async function authenticate(input: AuthFlowInput): Promise<AuthFlowResult> {
  switch (input.step) {
    case "get_login_url": {
      const state = await getAuthState();
      return {
        state: {
          ...state,
          message:
            "Open de link, log in bij Albert Heijn en kopieer daarna de volledige adresbalk-URL (begint met appie://login-exit?code=…) of alleen de code. Plak die hier.",
        },
        loginUrl: AH_LOGIN_URL,
      };
    }
    case "exchange_code": {
      const code = extractAuthCode(input.codeOrUrl);
      if (!code) throw new Error("Geen geldige code gevonden — plak de volledige appie://login-exit?code=… URL");
      let res: TokenResponse;
      try {
        res = await ahRequest<TokenResponse>("/mobile-auth/v1/auth/token", {
          method: "POST",
          body: { clientId: AH_CLIENT_ID, code },
        });
      } catch (e) {
        if (e instanceof AhHttpError && e.status >= 400 && e.status < 500) {
          throw new Error("De code is ongeldig of verlopen — vraag een nieuwe inloglink aan");
        }
        throw e;
      }
      persistTokens(toTokens(res));
      return { state: await getAuthState() };
    }
    case "logout":
      deleteStoreAccount("ah");
      return { state: await getAuthState() };
    default:
      throw new Error(`Onbekende stap voor Albert Heijn: ${(input as { step: string }).step}`);
  }
}
