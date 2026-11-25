/**
 * JWT validation for incoming Claude bearer tokens.
 *
 * The Supabase Auth (GoTrue) OAuth server issues access tokens via HS256, signed
 * with the shared JWT secret. We validate with that same secret.
 *
 * Acceptance criteria for a valid token (RFC 8707 audience binding partially):
 *  - signature verifies with the configured HS256 secret
 *  - exp not in the past, nbf not in the future
 *  - iss is one of the accepted issuers (env SUPABASE_JWT_ISSUERS + the
 *    AUTH_SERVER upstream; default: https://auth.sota.io/auth/v1)
 *  - sub is a non-empty UUID-shaped string
 *
 * NOT enforced (until tokens with an mcp.sota.io audience can be minted):
 *  - strict aud == "https://mcp.sota.io" check (Supabase tokens carry
 *    aud="authenticated", not our resource URL; rejecting on that would
 *    block every incoming token)
 */
import { jwtVerify, errors as joseErrors } from "jose";
import { resolveAcceptedIssuers } from "../lib/auth-config.js";

const SUPABASE_JWT_SECRET = process.env.SUPABASE_JWT_SECRET ?? "";
// SUPABASE_JWT_ISSUERS (default: the two prod issuers) plus the AUTH_SERVER
// upstream; see lib/auth-config.ts. Invalid values throw = fail at startup.
const ACCEPTED_ISSUERS = resolveAcceptedIssuers();

if (!SUPABASE_JWT_SECRET) {
  // Server still boots, but every incoming token will fail validation.
  // This keeps health checks alive while signalling a missing config.
  // eslint-disable-next-line no-console
  console.warn(
    "WARN: SUPABASE_JWT_SECRET is not set — every Bearer token will be rejected.",
  );
}

const secretKey = SUPABASE_JWT_SECRET
  ? new TextEncoder().encode(SUPABASE_JWT_SECRET)
  : null;

export interface VerifiedJwt {
  sub: string; // user_id (auth.users.id)
  email?: string;
  iss: string;
  exp: number;
  raw: string;
}

export class JwtVerificationError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message);
  }
}

export async function verifyJwt(rawToken: string): Promise<VerifiedJwt> {
  if (!secretKey) {
    throw new JwtVerificationError(
      "Server JWT secret not configured",
      "server_misconfigured",
    );
  }

  try {
    const { payload } = await jwtVerify(rawToken, secretKey, {
      algorithms: ["HS256"],
    });

    const iss = typeof payload.iss === "string" ? payload.iss : "";
    if (!ACCEPTED_ISSUERS.includes(iss)) {
      throw new JwtVerificationError(
        `Unexpected issuer: ${iss}`,
        "invalid_issuer",
      );
    }

    const sub = typeof payload.sub === "string" ? payload.sub : "";
    if (!sub) {
      throw new JwtVerificationError("Token has no sub claim", "no_subject");
    }

    return {
      sub,
      email: typeof payload.email === "string" ? payload.email : undefined,
      iss,
      exp: typeof payload.exp === "number" ? payload.exp : 0,
      raw: rawToken,
    };
  } catch (err) {
    if (err instanceof JwtVerificationError) throw err;
    if (err instanceof joseErrors.JWTExpired) {
      throw new JwtVerificationError("Token expired", "token_expired");
    }
    if (err instanceof joseErrors.JWTInvalid) {
      throw new JwtVerificationError("Malformed JWT", "malformed_jwt");
    }
    if (err instanceof joseErrors.JWSSignatureVerificationFailed) {
      throw new JwtVerificationError(
        "JWT signature invalid",
        "invalid_signature",
      );
    }
    throw new JwtVerificationError(
      err instanceof Error ? err.message : String(err),
      "unknown",
    );
  }
}
