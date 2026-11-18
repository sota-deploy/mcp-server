/**
 * Request guard for the hosted MCP server (mcp.sota.io).
 *
 * The hosted `deploy` tool only accepts inline `files`. Its schema does not
 * advertise `directory`, `git_url` or `git_branch`, but a client can send
 * them anyway. A directory deploy would pack the sota-mcp container's own
 * filesystem (process.cwd() or any absolute path) into the caller's
 * project, and git_url would make the server fetch arbitrary URLs. This
 * guard rejects such calls before any tool code runs, independent of how
 * the MCP SDK validates or strips unknown arguments. The deploy tool itself
 * refuses every non-`files` mode in hosted mode as a second layer.
 */

/** deploy arguments the hosted server refuses. */
export const HOSTED_FORBIDDEN_DEPLOY_ARGS = ['directory', 'git_url', 'git_branch'] as const;

export interface HostedRejection {
  /** JSON-RPC id of the offending message, if it had one. */
  id: string | number | null;
  message: string;
}

export const HOSTED_FILES_ONLY_HINT =
  'Pass the source inline as `files`, or deploy a directory or a git repository with the local server (npx @sota-io/mcp) or the CLI (`sota deploy`).';

/**
 * Returns a rejection when any JSON-RPC message in `body` (a single message
 * or a batch) is a `tools/call` of `deploy` carrying a forbidden argument.
 */
export function hostedDeployRejection(body: unknown): HostedRejection | null {
  const messages = Array.isArray(body) ? body : [body];
  for (const msg of messages) {
    if (!msg || typeof msg !== 'object') continue;
    const m = msg as Record<string, unknown>;
    if (m.method !== 'tools/call') continue;
    const params = m.params;
    if (!params || typeof params !== 'object') continue;
    const p = params as Record<string, unknown>;
    if (p.name !== 'deploy') continue;
    const args = p.arguments;
    if (!args || typeof args !== 'object') continue;
    const forbidden = HOSTED_FORBIDDEN_DEPLOY_ARGS.filter((k) =>
      Object.prototype.hasOwnProperty.call(args, k),
    );
    if (forbidden.length === 0) continue;
    const id = typeof m.id === 'string' || typeof m.id === 'number' ? m.id : null;
    return {
      id,
      message: `The hosted sota.io MCP server does not accept ${forbidden.map((k) => `\`${k}\``).join(', ')}. ${HOSTED_FILES_ONLY_HINT}`,
    };
  }
  return null;
}
