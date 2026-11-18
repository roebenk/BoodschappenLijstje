export const AH_BASE = "https://api.ah.nl";
export const AH_CLIENT_ID = "appie-ios";
export const AH_LOGIN_URL =
  "https://login.ah.nl/login?client_id=appie-ios&response_type=code&redirect_uri=appie://login-exit";

export const AH_HEADERS: Record<string, string> = {
  "User-Agent": "Appie/9.28 (iPhone; iOS 18.0; Scale/3.00)",
  "x-application": "AHWEBSHOP",
  "Content-Type": "application/json",
  Accept: "application/json",
};

export class AhHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "AhHttpError";
  }
}

export class AhAuthRequiredError extends Error {
  constructor(message = "Koppel eerst je Albert Heijn-account om dit te kunnen gebruiken") {
    super(message);
    this.name = "AhAuthRequiredError";
  }
}

export interface AhRequestOptions {
  method?: "GET" | "POST" | "PATCH";
  body?: unknown;
  token?: string;
}

export async function ahRequest<T = unknown>(path: string, options: AhRequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { ...AH_HEADERS };
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  const res = await fetch(path.startsWith("http") ? path : `${AH_BASE}${path}`, {
    method: options.method ?? "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  if (!res.ok) {
    let detail = "";
    try {
      detail = (await res.text()).slice(0, 200);
    } catch {
      /* ignore */
    }
    throw new AhHttpError(res.status, `Albert Heijn API ${res.status}${detail ? `: ${detail}` : ""}`);
  }
  const text = await res.text();
  return (text ? JSON.parse(text) : null) as T;
}

interface GraphQlResponse<T> {
  data?: T | null;
  errors?: Array<{ message?: string }>;
}

/** Throws when GraphQL reports errors without usable data (resolver failures return HTTP 200). */
export async function ahGraphql<T = Record<string, unknown>>(
  query: string,
  variables: Record<string, unknown> | undefined,
  token: string,
): Promise<T> {
  const json = await ahRequest<GraphQlResponse<T>>("/graphql", {
    method: "POST",
    body: { query, variables },
    token,
  });
  if (json?.errors?.length && !json.data) {
    throw new Error(`Albert Heijn GraphQL: ${json.errors.map((e) => e.message).join("; ")}`);
  }
  return (json?.data ?? {}) as T;
}
