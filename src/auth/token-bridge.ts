/**
 * Token-to-Key bridge: maps a verified sign-in token to the user's own
 * sota_xxx connector key.
 *
 * Why: the tools call sota-api with a `sota_` key. Claude gives us a JWT
 * (an OAuth connector token, or the session token create_account gets from
 * the e-mail code). We exchange it once per few minutes for the user's single
 * connector key (`source='claude'`).
 *
 * The exchange is an API call, `POST /v1/auth/mcp-key`
 * with the user's own token: sota-api rotates the key, writes an audit row
 * and refuses API keys (a key never mints a key). This process no longer
 * writes the platform database. The key always belongs to the signed-in
 * person, never to an account they are a member of: what it may reach is
 * decided by sota-api on every request, so a member's key stops reaching the
 * account's apps the moment the membership ends.
 *
 * The plaintext lives only in this process's memory (5-minute TTL). After the
 * TTL or a restart we ask again; the API then rotates the key (the old
 * plaintext dies), which is fine because every session re-binds to whatever
 * key is current.
 */
import { errorMessage, logEvent } from "../lib/log.js";

const SOTA_API_URL = process.env.SOTA_API_URL ?? "https://api.sota.io";
// MCP_BRIDGE_SECRET: the service secret the API requires on /v1/auth/mcp-key.
const BRIDGE_SECRET = process.env.MCP_BRIDGE_SECRET ?? "";
const BRIDGE_TIMEOUT_MS = 10_000;

/** Why the hosted server must not start with this secret, or null when it is fine. */
export function bridgeSecretProblem(secret: string | undefined): string | null {
  if (!secret) return "MCP_BRIDGE_SECRET is not set: the hosted MCP server cannot mint connector keys (POST /v1/auth/mcp-key)";
  if (secret.length < 32) return "MCP_BRIDGE_SECRET must be at least 32 characters";
  return null;
}

// In-memory cache: userId → { plaintextKey, expiresAt }
const cache = new Map<string, { plaintext: string; expiresAt: number }>();
const CACHE_TTL_MS = 5 * 60_000;

function cacheGet(userId: string): string | null {
  const entry = cache.get(userId);
  if (!entry) return null;
  if (entry.expiresAt < Date.now()) {
    cache.delete(userId);
    return null;
  }
  return entry.plaintext;
}

function cacheSet(userId: string, plaintext: string): void {
  cache.set(userId, { plaintext, expiresAt: Date.now() + CACHE_TTL_MS });
}

/** Test hook: forget every cached key. */
export function clearBridgeCache(): void {
  cache.clear();
}

export interface BridgeResult {
  /** The sota_xxx key plaintext to forward to sota-api on this request */
  apiKey: string;
  /** Whether a new key row was created (true on first sight of this user) */
  created: boolean;
  /** Whether an existing key was rotated (a fresh plaintext for an existing row) */
  rotated: boolean;
}

/** Error of the bridge call (network, non-2xx). The message never holds a token. */
export class BridgeError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "BridgeError";
  }
}

async function mint(token: string, ensurePlan: boolean, apiUrl: string): Promise<{ api_key: string; created: boolean }> {
  let res: Response;
  try {
    res = await fetch(`${apiUrl}/v1/auth/mcp-key`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        // Only the hosted MCP server may mint connector keys (shared service
        // secret, compared in constant time by the API).
        "X-Sota-Bridge-Secret": BRIDGE_SECRET,
      },
      body: JSON.stringify({ ensure_plan: ensurePlan }),
      signal: AbortSignal.timeout(BRIDGE_TIMEOUT_MS),
    });
  } catch (err) {
    throw new BridgeError(`connector key request failed: ${errorMessage(err)}`);
  }
  if (!res.ok) {
    let code = "";
    try {
      code = ((await res.json()) as { error?: { code?: string } })?.error?.code ?? "";
    } catch {
      // body is not JSON
    }
    throw new BridgeError(`connector key request answered HTTP ${res.status}${code ? ` (${code})` : ""}`, res.status);
  }
  const body = (await res.json()) as { data?: { api_key?: string; created?: boolean }; api_key?: string; created?: boolean };
  const data = body.data ?? body;
  if (typeof data.api_key !== "string" || !data.api_key.startsWith("sota_")) {
    throw new BridgeError("connector key response has no key");
  }
  return { api_key: data.api_key, created: data.created === true };
}

/**
 * Net-new user provisioning: called from the `create_account` tool after
 * Supabase verified the OTP, with the session's access token. The API
 * creates the free plan row if the user has none (an existing row stays as
 * it is) and returns the connector key.
 */
export async function provisionPlanAndKey(
  userId: string,
  accessToken: string,
  apiUrl: string = SOTA_API_URL,
): Promise<BridgeResult> {
  const { api_key, created } = await mint(accessToken, true, apiUrl);
  cacheSet(userId, api_key);
  return { apiKey: api_key, created, rotated: !created };
}

/**
 * The user's connector key for this request: from the cache, or freshly
 * issued by sota-api for the user's verified token.
 */
export async function getOrProvisionApiKey(
  userId: string,
  token: string,
  apiUrl: string = SOTA_API_URL,
): Promise<BridgeResult> {
  const cached = cacheGet(userId);
  if (cached) return { apiKey: cached, created: false, rotated: false };
  try {
    const { api_key, created } = await mint(token, false, apiUrl);
    cacheSet(userId, api_key);
    return { apiKey: api_key, created, rotated: !created };
  } catch (err) {
    logEvent("error", { event: "bridge_mint_failed", error_message: errorMessage(err) });
    throw err;
  }
}
