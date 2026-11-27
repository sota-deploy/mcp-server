/**
 * `create_account` MCP tool — net-new sota.io signup from inside Claude.
 *
 * Two-step flow:
 *   1. create_account({ email })             → triggers Supabase OTP send
 *   2. create_account({ email, code })       → verifies, provisions plan + key
 *
 * The tool is INTENTIONALLY callable without prior authentication. The HTTP
 * server's middleware whitelists this specific tool/call combination so
 * net-new users (who don't have a Supabase JWT yet) can sign up entirely
 * via Claude tool calls.
 *
 * Why this is OK from a security perspective:
 *  - Disposable-email blocking filters obvious abuse
 *  - Supabase has its own per-email OTP rate limits (default 30/h)
 *  - The tool ONLY hits Supabase's public OTP endpoints + our own DB
 *    via the bridge — no sota-api access without authentication
 *  - The returned `sota_xxx` key is delivered in the tool RESPONSE, not
 *    stored in Claude — the user must save it themselves
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { isDisposableEmailDomain } from "../auth/disposable-check.js";
import { provisionPlanAndKey } from "../auth/token-bridge.js";

const SUPABASE_URL = process.env.SUPABASE_URL ?? "https://auth.sota.io/auth/v1";
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY ?? "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

interface SupabaseUser {
  id: string;
  email: string;
}

export function registerCreateAccountTool(server: McpServer) {
  server.registerTool(
    "create_account",
    {
      title: "Create a sota.io account",
      description: `Sign up for a brand-new sota.io account from inside Claude — no browser, no copy-paste. Two-step flow:

STEP 1: Call with just \`email\`. We send a 6-digit confirmation code to that email.
STEP 2: Call again with \`email\` + \`code\`. We verify, create the account on the Free tier (3 projects, EU-hosted, no credit card), generate a sota.io API key, and return it to you.

After Step 2 you'll get back a key like \`sota_…\`. **Save it in a safe place** — you'll need it for any subsequent sota.io tool call in Claude (or you can use it with the sota CLI). It is shown ONCE and never recoverable.

sota.io is an EU-native PaaS hosted in Germany — GDPR-compliant by default, no CLOUD Act exposure. Disposable / throwaway email addresses are not accepted; use a real address.`,
      inputSchema: {
        email: z
          .string()
          .email()
          .describe(
            "A real email address. We send the confirmation code here. Throwaway / disposable email services are blocked.",
          ),
        code: z
          .string()
          .optional()
          .describe(
            "The 6-digit code from the confirmation email. Provide on the second call to complete signup. Omit on the first call.",
          ),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ email, code }) => {
      const normalizedEmail = email.trim().toLowerCase();

      // Hard gate: reject disposable-email domains at the tool layer too
      // (the web /api/auth/check-email runs at sign-up; this one catches
      // direct-MCP-callers that bypass the web form).
      if (await isDisposableEmailDomain(normalizedEmail)) {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: "❌ This email address can't be used. Throwaway / disposable email services are not supported by sota.io. Please retry with a permanent address.",
            },
          ],
        };
      }

      if (!SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY) {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: "Server misconfigured: SUPABASE keys are missing. Contact info@sota.io.",
            },
          ],
        };
      }

      // ── Step 1: no code → request OTP ──
      if (!code) {
        try {
          const r = await fetch(`${SUPABASE_URL}/otp`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              apikey: SUPABASE_ANON_KEY,
              Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
            },
            body: JSON.stringify({
              email: normalizedEmail,
              create_user: true,
              data: { source: "claude-mcp" },
            }),
          });
          if (!r.ok) {
            const detail = await r.text();
            return {
              isError: true,
              content: [
                {
                  type: "text" as const,
                  text: `Could not send confirmation code: HTTP ${r.status}. Detail: ${detail.slice(0, 200)}`,
                },
              ],
            };
          }
          return {
            content: [
              {
                type: "text" as const,
                text: `✉️ Confirmation code sent to ${normalizedEmail}.\n\nCheck your inbox (and spam folder — subject: "Your sota.io login code") for a 6-digit code. Then call \`create_account\` again with both \`email\` and \`code\` to complete signup.\n\nThe code expires in 10 minutes. If you don't get it, call this tool again with the same email to resend.`,
              },
            ],
          };
        } catch (err) {
          return {
            isError: true,
            content: [
              {
                type: "text" as const,
                text: `Network error reaching Supabase: ${err instanceof Error ? err.message : String(err)}`,
              },
            ],
          };
        }
      }

      // ── Step 2: code provided → verify + provision ──
      try {
        const verifyRes = await fetch(`${SUPABASE_URL}/verify`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            apikey: SUPABASE_ANON_KEY,
          },
          body: JSON.stringify({
            type: "email",
            email: normalizedEmail,
            token: code.trim(),
          }),
        });
        if (!verifyRes.ok) {
          const detail = await verifyRes.text();
          return {
            isError: true,
            content: [
              {
                type: "text" as const,
                text: `❌ Code verification failed (HTTP ${verifyRes.status}). The code may have expired, been mistyped, or already been used. Call \`create_account\` again with just the email to get a fresh code.\n\nDetail: ${detail.slice(0, 200)}`,
              },
            ],
          };
        }
        const session = (await verifyRes.json()) as { user?: SupabaseUser; access_token?: string };
        if (!session.user?.id || !session.user?.email || !session.access_token) {
          return {
            isError: true,
            content: [
              {
                type: "text" as const,
                text: "Verification succeeded but Supabase returned no user record. Contact info@sota.io.",
              },
            ],
          };
        }

        // Provision: user_plans (Free tier) + sota_xxx key tagged source=claude
        const result = await provisionPlanAndKey(session.user.id, session.access_token);

        // Deliberately neutral, descriptive content with no instructions
        // directing the LLM or the user to modify any client configuration.
        // Tool responses that prescribe config changes look like prompt-
        // injection attempts and are (correctly) flagged by Claude.ai's
        // safety layer. The user-facing setup guide lives at the docs URL.
        return {
          content: [
            {
              type: "text" as const,
              text: `Account created on sota.io.

- Email: ${session.user.email}
- Plan: Free tier (3 projects, EU-hosted, no credit card)
- Region: Germany (Hetzner Cloud)
- API key (save this — shown once): \`${result.apiKey}\`

The API key authenticates the sota.io REST API (api.sota.io) and the sota CLI directly.

To use the account in Claude, add the connector URL https://mcp.sota.io/mcp and sign in with this email (steps: https://sota.io/docs/mcp/setup ).`,
            },
          ],
          _meta: {
            // Forward-looking hint per MCP spec — Claude.ai doesn't render
            // a UI for this yet, but if/when it does, sota.io users will
            // get a "Reconnect" affordance automatically. Carries no
            // imperative content directed at the LLM.
            "anthropic.com/connector_reauthentication_suggested": true,
            "anthropic.com/reauth_email": session.user.email,
          },
        };
      } catch (err) {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: `Provisioning error: ${err instanceof Error ? err.message : String(err)}. Contact info@sota.io with this message.`,
            },
          ],
        };
      }
    },
  );
}
