/**
 * Token-to-Key bridge: maps a verified Claude JWT to an internal sota_xxx API key.
 *
 * Why: sota-api authenticates by `sota_xxx` keys (SHA-256 hashed in DB). Claude
 * gives us a JWT. We don't pass the JWT through to sota-api — instead, on first
 * sight of a JWT.sub, we provision a dedicated key tagged `source='claude'` and
 * cache the mapping in-memory + persisted in DB.
 *
 * Benefits:
 *   - One revocation surface for Marx: "delete all source=claude keys for user X"
 *     immediately cuts off the Claude integration without touching the user's
 *     CLI/dashboard keys
 *   - Audit log can separate Claude-originated tool calls from CLI tool calls
 *   - Future plan-gating happens at the existing sota-api layer (no duplicate
 *     enforcement in sota-mcp)
 *
 * Lifecycle:
 *   1. JWT in (verified, sub = user_id)
 *   2. SELECT id, key_prefix FROM api_keys WHERE user_id=$1 AND source='claude'
 *      LIMIT 1  -- one Claude key per user, reused across requests
 *   3. If not found:
 *      a. Generate sota_ + 40 hex (20 bytes random)
 *      b. SHA-256 the full key
 *      c. INSERT INTO api_keys (user_id, name='Claude MCP', key_hash, key_prefix,
 *         source='claude')
 *      d. Hold the plaintext only in memory for this request
 *   4. Cache user_id → plaintext key for the process lifetime (5-min TTL; new
 *      keys reuse the in-memory cache after restart by regenerating on first
 *      hit — that's wasteful only on cold start, acceptable)
 *
 * IMPORTANT: we never get the plaintext back from the DB on subsequent hits.
 * The plaintext is generated ONCE per user, cached in-memory while the
 * process lives. After a process restart, we have no plaintext for users
 * whose key already exists in DB → solution: REGENERATE (delete old row,
 * insert new). That's safe because each Claude session re-binds to whatever
 * key is current.
 */
import crypto from "node:crypto";
import { Pool } from "pg";

const DATABASE_URL = process.env.DATABASE_URL ?? "";
let pool: Pool | null = null;

function getPool(): Pool {
  if (!pool) {
    if (!DATABASE_URL) {
      throw new Error(
        "DATABASE_URL not configured — sota-mcp cannot bridge tokens to API keys",
      );
    }
    // Supabase pooler uses a CA chain pg can't verify by default. Strip
    // ?sslmode= from the URL and force a permissive TLS config explicitly,
    // matching what the rest of the sota.io stack does.
    const cleanUrl = DATABASE_URL.replace(/[?&]sslmode=[^&]*/i, "");
    pool = new Pool({
      connectionString: cleanUrl,
      max: 5,
      idleTimeoutMillis: 30_000,
      ssl: { rejectUnauthorized: false, require: true } as unknown as object,
    });
    pool.on("error", (err) => {
      // Best-effort logging; pool keeps working across single-conn errors
      // eslint-disable-next-line no-console
      console.error("pg pool error:", err.message);
    });
  }
  return pool;
}

// In-memory cache: userId → { plaintextKey, expiresAt }
// TTL is short (5 min) because we'd rather rotate-on-restart than ever leak.
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

function generateKey(): { plaintext: string; hash: string; prefix: string } {
  const randBytes = crypto.randomBytes(20);
  const plaintext = "sota_" + randBytes.toString("hex"); // sota_ + 40 hex
  const hash = crypto.createHash("sha256").update(plaintext).digest("hex");
  const prefix = plaintext.slice(0, 13); // "sota_" + first 8 hex
  return { plaintext, hash, prefix };
}

export interface BridgeResult {
  /** The sota_xxx key plaintext to forward to sota-api on this request */
  apiKey: string;
  /** Whether a new key row was created (true on first sight of this user) */
  created: boolean;
  /** Whether the existing DB row was rotated (true on cold-start with pre-existing row) */
  rotated: boolean;
}

/**
 * Net-new user provisioning: called from the `create_account` tool after
 * Supabase verified the OTP. Inserts the user_plans Free-tier row (if not
 * already present) AND a `source='claude'` API key. Returns the key plaintext.
 *
 * Idempotent on user_plans (ON CONFLICT DO NOTHING) — covers the case where
 * the user already exists with a plan but no Claude key (e.g. they signed up
 * via the web first, then called create_account from Claude).
 */
export async function provisionPlanAndKey(
  userId: string,
): Promise<BridgeResult> {
  const client = await getPool().connect();
  try {
    // Free-tier defaults (mirrors api/internal/repository/user_plan.go defaults)
    await client.query(
      `INSERT INTO user_plans (
         user_id, plan, max_projects, max_memory_mb, max_cpu_millicores,
         max_databases, max_custom_domains, max_builds_per_day,
         source, onboarded_at
       ) VALUES ($1, 'free', 3, 256, 500, 1, 0, 10, 'claude', now())
       ON CONFLICT (user_id) DO NOTHING`,
      [userId],
    );
  } catch (err) {
    throw new Error(
      `user_plans provisioning failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    client.release();
  }
  return getOrProvisionApiKey(userId);
}

/**
 * Look up or provision a `source='claude'` API key for the given user.
 *
 * On cold start (no in-memory plaintext), if a DB row already exists we have
 * no plaintext recoverable. Solution: rotate — delete the old row, insert a
 * fresh key, return the new plaintext. The Claude integration continues to
 * work transparently because sota-mcp does the lookup on every request.
 */
export async function getOrProvisionApiKey(
  userId: string,
): Promise<BridgeResult> {
  const cached = cacheGet(userId);
  if (cached) return { apiKey: cached, created: false, rotated: false };

  const client = await getPool().connect();
  try {
    const existing = await client.query(
      `SELECT id FROM api_keys WHERE user_id = $1 AND source = 'claude' LIMIT 1`,
      [userId],
    );

    const { plaintext, hash, prefix } = generateKey();

    if (existing.rowCount === 0) {
      // First-time: simple INSERT
      await client.query(
        `INSERT INTO api_keys (user_id, name, key_hash, key_prefix, source)
         VALUES ($1, $2, $3, $4, 'claude')`,
        [userId, "Claude MCP", hash, prefix],
      );
      cacheSet(userId, plaintext);
      return { apiKey: plaintext, created: true, rotated: false };
    }

    // Cold-start rotation: replace the existing row's hash + prefix so the
    // freshly minted plaintext becomes the active key for this user.
    await client.query(
      `UPDATE api_keys
       SET key_hash = $2, key_prefix = $3, last_used_at = now()
       WHERE id = $1`,
      [existing.rows[0].id, hash, prefix],
    );
    cacheSet(userId, plaintext);
    return { apiKey: plaintext, created: false, rotated: true };
  } finally {
    client.release();
  }
}
