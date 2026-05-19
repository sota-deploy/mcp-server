/**
 * Disposable-email domain check — server-side gate for create_account tool.
 *
 * The web /api/auth/check-email route uses a build-time-embedded TS module
 * generated from the maintained github.com/disposable-email-domains list.
 * Here in mcp-server we don't want to duplicate the 5500-domain list, so we
 * just call the web's check endpoint (it's already public, no auth, returns
 * 200/422). One round-trip per create_account Step 1.
 */
const CHECK_URL =
  process.env.DISPOSABLE_EMAIL_CHECK_URL ?? "https://sota.io/api/auth/check-email";

export async function isDisposableEmailDomain(email: string): Promise<boolean> {
  try {
    const r = await fetch(CHECK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
      signal: AbortSignal.timeout(5_000),
    });
    if (r.status === 422) return true;
    return false;
  } catch {
    // Fail open on network error — we'd rather let a real user through
    // than block them because our own /api/auth/check-email had a hiccup.
    // Supabase OTP rate-limits will still catch volume abuse.
    return false;
  }
}
