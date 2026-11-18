/**
 * Structured logging without personal data.
 *
 * Every log line of the hosted server goes through `logEvent`, which
 * serialises the fields as one JSON object and then redacts anything that
 * looks like an email address, including emails embedded in upstream error
 * messages. Log user ids (JWT `sub`) to correlate requests, never emails.
 */

// Deliberately broad: a false positive only costs a redacted log fragment.
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;

export const EMAIL_REDACTED = '[email redacted]';

export function redactEmails(text: string): string {
  return text.replace(EMAIL_RE, EMAIL_REDACTED);
}

export type LogLevel = 'info' | 'warn' | 'error';

/** Serialise `fields` as a single JSON line with emails redacted. */
export function formatLogLine(fields: Record<string, unknown>): string {
  let line: string;
  try {
    line = JSON.stringify(fields);
  } catch {
    line = JSON.stringify({ event: 'log_serialisation_failed' });
  }
  return redactEmails(line);
}

export function logEvent(level: LogLevel, fields: Record<string, unknown>): void {
  const line = formatLogLine(fields);
  /* eslint-disable no-console */
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
  /* eslint-enable no-console */
}

/** Error message for a log field, with emails redacted. */
export function errorMessage(err: unknown): string {
  return redactEmails(err instanceof Error ? err.message : String(err));
}
