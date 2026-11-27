import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Account, AccountReader } from '../lib/account.js';
import {
  BUILD_CONTRACT,
  DOCS,
  ENTERPRISE_ACCESS_STEPS,
  ENTERPRISE_CONTRACT,
  bullets,
  enterpriseChecklist,
  numbered,
} from '../lib/guide.js';

const SIGN_IN_STATE_TEXT: Record<string, string> = {
  verified: 'verified (people can sign in)',
  saved_untested: 'saved but not tested yet: the owner must run "Test sign-in" in the dashboard before anyone can sign in',
  not_set_up: 'not set up: nobody can sign in until the owner sets it up in the dashboard',
  unknown: 'unknown (could not be read right now)',
};

function mb(bytes: number): string {
  return `${Math.round(bytes / 1024 / 1024)} MB`;
}

/** The Enterprise next steps for the human, with this account's links. */
export function enterpriseNextSteps(account: Account, appUrl?: string): string {
  const ent = account.enterprise;
  if (!ent) return '';
  const lines = [
    'Next steps for the human (sota Enterprise):',
    numbered(ENTERPRISE_ACCESS_STEPS),
    `App URL: ${appUrl ?? `https://${ent.app_host_pattern}`}`,
    `Users & access: ${ent.users_and_access_url}`,
  ];
  if (ent.sign_in_state !== 'verified') {
    lines.push(
      `Sign-in connection: ${SIGN_IN_STATE_TEXT[ent.sign_in_state] ?? ent.sign_in_state} (${ent.sign_in_setup_url}).`,
    );
  }
  return lines.join('\n');
}

/** get-account output. */
export function renderAccount(account: Account | null): string {
  const parts: string[] = [];
  if (!account) {
    parts.push(
      'Account details are not available from this API version. Assume an ordinary account unless project URLs look like https://<app>.<label>.sota.io (then it is sota Enterprise).',
    );
  } else {
    const p = account.plan;
    const u = account.usage;
    parts.push(
      [
        '# Account',
        `Plan: ${p.name}`,
        `Projects: ${u ? `${u.projects} of ${p.max_projects}` : `max ${p.max_projects}`}; databases: ${u ? `${u.databases} of ${p.max_databases}` : `max ${p.max_databases}`}`,
        `Memory per app: ${p.max_memory_mb} MB; deploy upload: max ${mb(p.max_deploy_bytes)} (hosted connector: 200 files / 10 MB inline)`,
      ].join('\n'),
    );
    if (account.acting_for) {
      const a = account.acting_for;
      parts.push(
        [
          '# You work in another account',
          `You are ${a.role} of ${a.account_label ? `the "${a.account_label}" account` : 'another account'} (${a.project_scope === 'all' ? 'all its apps' : 'the apps shared with you'}). The limits above are that account's.`,
          'list-projects shows the apps you may work on. You can deploy, redeploy, roll back, read logs and source, set env vars and use the database of those apps.',
          'You cannot create or delete apps there, delete databases or change domains: ask the account owner.',
          ...(account.team_key_expires_at
            ? [`This team key expires on ${account.team_key_expires_at.slice(0, 10)}; the person creates a new one in the sota dashboard under Team keys.`]
            : []),
          a.role === 'admin'
            ? 'As admin you also manage Users & access and developers, in the dashboard only.'
            : 'Who may open the apps (Users & access) is managed by the owner or an admin in the dashboard.',
        ].join('\n'),
      );
    } else if ((account.memberships?.length ?? 0) > 1) {
      parts.push(
        `# Accounts you work in\n${account.memberships!.map((m) => `- ${m.account_label || m.account_user_id}: ${m.role}`).join('\n')}\nlist-projects shows the shared apps of each.`,
      );
    }
    const ent = account.enterprise;
    if (ent) {
      parts.push(
        [
          '# sota Enterprise account',
          `Company label: ${ent.customer_label}`,
          `App URLs: https://${ent.app_host_pattern} (a project named "app" gets the slug "${ent.customer_label}-app")`,
          `Apps: ${ent.apps_used ?? 'unknown'} of ${ent.app_limit}, all on the company's own server (status: ${ent.server_status || 'unknown'})`,
          `Sign-in connection (Microsoft 365): ${SIGN_IN_STATE_TEXT[ent.sign_in_state] ?? ent.sign_in_state}`,
          `Users & access (owner, dashboard only): ${ent.users_and_access_url}`,
        ].join('\n'),
      );
    } else {
      parts.push('# Not an Enterprise account\nApps are public at https://<slug>.sota.io; build your own login if the app needs one.');
    }
  }
  parts.push(`# Build contract (every app)\n${bullets(BUILD_CONTRACT)}`);
  if (!account || account.enterprise) {
    parts.push(`# Enterprise contract\n${bullets(ENTERPRISE_CONTRACT)}`);
    parts.push(`# After the deploy: who can open the app\n${numbered(ENTERPRISE_ACCESS_STEPS)}`);
  }
  parts.push(`Docs: ${DOCS.buildWithAi} · identity headers ${DOCS.identity} · limits ${DOCS.limits}`);
  return parts.join('\n\n');
}

export function registerAccountTool(server: McpServer, readAccount: AccountReader) {
  server.registerTool(
    'get-account',
    {
      title: 'Show account and limits',
      description:
        'Call this FIRST, before writing or deploying code. Returns the signed-in sota.io account: plan limits (projects, databases, memory per app, upload size), whether it is a sota Enterprise account (company label, app URL scheme https://<app>.<label>.sota.io, own server, sign-in connection status, the dashboard page where the owner grants access) and the build contract the app must follow: one container, PORT, health gate, database through PgBouncer, upload rules, and for Enterprise the identity headers, fail-closed rule, health-without-identity rule and what the human must do before anyone can open the app. Read-only.',
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      try {
        const account = await readAccount();
        return { content: [{ type: 'text' as const, text: renderAccount(account) }] };
      } catch (error) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Failed to read the account: ${error instanceof Error ? error.message : String(error)}\n\n${renderAccount(null)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );
}

/** Static checklist prompt; needs no account and no API call. */
export function registerChecklistPrompt(server: McpServer) {
  server.registerPrompt(
    'enterprise-app-checklist',
    {
      title: 'Enterprise app checklist',
      description:
        'The rules an app must follow to deploy and behave correctly on sota.io, including sota Enterprise (company sign-in, identity headers, health without identity, who can open the app).',
    },
    () => ({
      messages: [
        {
          role: 'user' as const,
          content: {
            type: 'text' as const,
            text: `${enterpriseChecklist()}\n\nFollow this checklist for the app we build. Call get-account first to learn this account's label and limits.`,
          },
        },
      ],
    }),
  );
}
