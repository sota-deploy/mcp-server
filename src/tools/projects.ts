import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { SotaClient } from '@sota-io/sdk';
import { projectUrl } from '../lib/project-url.js';
import { type AccountReader, tryReadAccount } from '../lib/account.js';
import { enterpriseNextSteps } from './account.js';

export interface ProjectToolOptions {
  /** GET /v1/account, for the Enterprise next steps in create-project. */
  readAccount?: AccountReader;
  /** Bound for the account lookup after the project exists (default 3 s). */
  lookupTimeoutMs?: number;
}

/** POST /v1/projects result: the project plus, on newer APIs, where it was created. */
type CreatedProject = Awaited<ReturnType<SotaClient['createProject']>> & {
  account?: { user_id: string; label?: string; enterprise: boolean; role: string; selected_by: string };
  notices?: string[];
};

export function registerProjectTools(server: McpServer, client: SotaClient, options: ProjectToolOptions = {}) {
  server.registerTool('list-projects', {
    title: 'List projects',
    description: 'List all projects on your sota.io account, plus the projects an account you are a team member of shares with you (marked "shared by <label>, you are developer|admin"). sota.io is an EU-native DevOps PaaS hosted in Germany (GDPR-compliant). Each project gets one live URL with automatic HTTPS (https://{slug}.sota.io, or https://{app}.{label}.sota.io behind the company sign-in on a sota Enterprise account; always show the URL this tool returns), a managed PostgreSQL 17 database created on the first deploy (DATABASE_URL auto-injected), PgBouncer connection pooling, daily backups, zero-downtime blue-green deployments, gVisor container isolation, and custom domain support (up to 5 per project with automatic HTTPS).',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async () => {
    const { projects } = await client.listProjects();
    const lines = projects.map((p) => {
      // The API marks projects shared with the person (role, account_label).
      const s = p as typeof p & { role?: string; account_label?: string };
      const shared = s.role && s.role !== 'owner' ? ` - shared${s.account_label ? ` by ${s.account_label}` : ''}, you are ${s.role}` : '';
      return `${p.name} (${p.slug}) - ID: ${p.id} - ${projectUrl(p)}${shared}`;
    });
    return {
      content: [
        {
          type: 'text' as const,
          text: projects.length === 0
            ? 'No projects found. Use create-project to create one.'
            : `Projects:\n${lines.join('\n')}`,
        },
      ],
    };
  });

  server.registerTool('create-project', {
    title: 'Create project',
    description: 'Create a new project on sota.io. Call get-account first: on a sota Enterprise account the project gets the slug "<label>-<name>" and the one URL https://<name>.<label>.sota.io behind the company\'s Microsoft 365 sign-in, counts against the account\'s app limit and runs on the company\'s own server; otherwise the URL is https://{slug}.sota.io and the app is public. The slug is generated from the name (lowercase, hyphens, max 63 chars) and cannot be changed. The first deploy creates a managed PostgreSQL 17 database (DATABASE_URL auto-injected, through PgBouncer in transaction mode) with daily backups kept 7 days. Supported: Next.js, Node.js, Python, or any language with a Dockerfile. Custom domains (not on Enterprise yet): up to 5 per project via the domain tools. Team members: an admin of an account creates apps in it (the app belongs to that account and uses its limits; the result names the account); a developer cannot create apps there.\n\nOptionally associate the project with a public git repository at create-time by passing `git_url` (and optional `git_branch`). The association is informational: it shows up in the dashboard and the `sota deploy --git` CLI flag can default to it, but it does NOT deploy on push.',
    inputSchema: {
      name: z.string().describe('Name for the new project. A URL slug will be auto-generated (e.g. "My Cool App" becomes my-cool-app.sota.io)'),
      git_url: z.string().optional().describe('Optional git repository URL to associate with this project (https://, git://, ssh://, or git@host:path). Informational only — does not trigger an automatic deploy.'),
      git_branch: z.string().optional().describe('Optional branch name (defaults to the repository default branch when omitted). Only meaningful when `git_url` is also set.'),
      account: z.string().optional().describe('Optional: the account to create the project in, for an admin of a team account: its label (get-account lists them under create_accounts), or "own" for your own account. A team key always creates in its own account; leave this out unless the tool asks for it. Developers cannot create projects in another account.'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async ({ name, git_url, git_branch, account: accountName }) => {
    let project: CreatedProject;
    try {
      // `account` is newer than the published SDK's CreateProjectOptions;
      // the SDK sends the options as the request body.
      project = (await client.createProject({
        name,
        git_url,
        git_branch,
        ...(accountName ? { account: accountName } : {}),
      } as Parameters<SotaClient['createProject']>[0])) as CreatedProject;
    } catch (error) {
      return {
        content: [{ type: 'text' as const, text: `Create failed: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      };
    }
    const gitLine = project.git_url
      ? `\n  Git: ${project.git_url}${project.git_branch ? ` @ ${project.git_branch}` : ''}`
      : '';
    const created = project.account;
    const accountLine = created
      ? `\n  Account: ${created.role === 'owner' ? `your own account${created.label ? ` (${created.label})` : ''}` : `${created.label || created.user_id} (you are ${created.role})`}`
      : '';
    let text = `Project created:\n  Name: ${project.name}\n  Slug: ${project.slug}\n  ID: ${project.id}\n  URL: ${projectUrl(project)}${accountLine}${gitLine}`;
    if (project.notices?.length) {
      text += `\n\n${project.notices.join('\n')}`;
    }
    const account = await tryReadAccount(options.readAccount, options.lookupTimeoutMs);
    // The next steps carry the links of the account get-account describes:
    // only when the project was created in that account.
    const described = account ? (account.acting_for?.account_user_id ?? account.user_id) : undefined;
    if (account?.enterprise && (!created || created.user_id === described)) {
      text += `\n\nThis is a sota Enterprise app: follow the Enterprise contract from get-account (no own login, identity headers, GET /health and GET / answer without identity).\n\n${enterpriseNextSteps(account, projectUrl(project))}`;
    } else if (created?.enterprise) {
      text += '\n\nThis is a sota Enterprise app: follow the Enterprise contract from get-account (no own login, identity headers, GET /health and GET / answer without identity).';
    }
    return {
      content: [
        {
          type: 'text' as const,
          text,
        },
      ],
    };
  });

  server.registerTool('delete-project', {
    title: 'Delete project',
    description: 'Delete a project and all its deployments from sota.io. This action is PERMANENT and irreversible. It removes the project, all deployments, the managed PostgreSQL database, environment variables, and webhooks. The project slug will become available again after deletion.',
    inputSchema: {
      project_id: z.string().describe('Project ID (UUID) to delete. Use list-projects to find the ID'),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  }, async ({ project_id }) => {
    try {
      await client.deleteProject(project_id);
      return {
        content: [
          {
            type: 'text' as const,
            text: `Project ${project_id} deleted successfully.`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Delete failed: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
        isError: true,
      };
    }
  });
}
