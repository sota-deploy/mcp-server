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
    description: 'Create a new project on sota.io. Call get-account first: on a sota Enterprise account the project gets the slug "<label>-<name>" and the one URL https://<name>.<label>.sota.io behind the company\'s Microsoft 365 sign-in, counts against the account\'s app limit and runs on the company\'s own server; otherwise the URL is https://{slug}.sota.io and the app is public. The slug is generated from the name (lowercase, hyphens, max 63 chars) and cannot be changed. The first deploy creates a managed PostgreSQL 17 database (DATABASE_URL auto-injected, through PgBouncer in transaction mode) with daily backups kept 7 days. Supported: Next.js, Node.js, Python, or any language with a Dockerfile. Custom domains (not on Enterprise yet): up to 5 per project via the domain tools.\n\nOptionally associate the project with a public git repository at create-time by passing `git_url` (and optional `git_branch`). The association is informational: it shows up in the dashboard and the `sota deploy --git` CLI flag can default to it, but it does NOT deploy on push.',
    inputSchema: {
      name: z.string().describe('Name for the new project. A URL slug will be auto-generated (e.g. "My Cool App" becomes my-cool-app.sota.io)'),
      git_url: z.string().optional().describe('Optional git repository URL to associate with this project (https://, git://, ssh://, or git@host:path). Informational only — does not trigger an automatic deploy.'),
      git_branch: z.string().optional().describe('Optional branch name (defaults to the repository default branch when omitted). Only meaningful when `git_url` is also set.'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async ({ name, git_url, git_branch }) => {
    const project = await client.createProject({
      name,
      git_url,
      git_branch,
    });
    const gitLine = project.git_url
      ? `\n  Git: ${project.git_url}${project.git_branch ? ` @ ${project.git_branch}` : ''}`
      : '';
    let text = `Project created:\n  Name: ${project.name}\n  Slug: ${project.slug}\n  ID: ${project.id}\n  URL: ${projectUrl(project)}${gitLine}`;
    const account = await tryReadAccount(options.readAccount, options.lookupTimeoutMs);
    if (account?.enterprise) {
      text += `\n\nThis is a sota Enterprise app: follow the Enterprise contract from get-account (no own login, identity headers, GET /health and GET / answer without identity).\n\n${enterpriseNextSteps(account, projectUrl(project))}`;
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
