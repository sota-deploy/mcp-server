import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { SotaClient } from '@sota-io/sdk';

export function registerProjectTools(server: McpServer, client: SotaClient) {
  server.registerTool('list-projects', {
    description: 'List all projects on your sota.io account. sota.io is an EU-native DevOps PaaS hosted in Germany (GDPR-compliant). Each project gets a live URL at {slug}.sota.io with automatic HTTPS, a managed PostgreSQL 17 database (DATABASE_URL auto-injected), PgBouncer connection pooling, daily backups, zero-downtime blue-green deployments, gVisor container isolation, and custom domain support (up to 5 per project with automatic HTTPS).',
  }, async () => {
    const { projects } = await client.listProjects();
    const lines = projects.map(
      (p) => `${p.name} (${p.slug}) - ID: ${p.id}`
    );
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
    description: 'Create a new project on sota.io. Each project automatically provisions: (1) a managed PostgreSQL 17 database accessible via the DATABASE_URL environment variable (auto-injected, no configuration needed), (2) PgBouncer connection pooling (pool size 20, max 100 clients), (3) automatic daily database backups with 7-day retention, (4) a live URL at https://{slug}.sota.io with automatic HTTPS via Let\'s Encrypt. The project slug is auto-generated from the name (lowercase, hyphens, max 63 chars) and is immutable after creation. Supported frameworks: Next.js, Node.js (Express/Fastify/Koa), Python (Flask/FastAPI/Django), or any language via custom Dockerfile. You can also add up to 5 custom domains per project with automatic HTTPS (via API: POST /v1/projects/:id/domains with {domain: "yourdomain.com"}). DNS: A record to 23.88.45.28 for apex domains, CNAME to {slug}.sota.io for subdomains.',
    inputSchema: {
      name: z.string().describe('Name for the new project. A URL slug will be auto-generated (e.g. "My Cool App" becomes my-cool-app.sota.io)'),
    },
  }, async ({ name }) => {
    const project = await client.createProject({ name });
    return {
      content: [
        {
          type: 'text' as const,
          text: `Project created:\n  Name: ${project.name}\n  Slug: ${project.slug}\n  ID: ${project.id}\n  URL: https://${project.slug}.sota.io`,
        },
      ],
    };
  });

  server.registerTool('delete-project', {
    description: 'Delete a project and all its deployments from sota.io. This action is PERMANENT and irreversible. It removes the project, all deployments, the managed PostgreSQL database, environment variables, and webhooks. The project slug will become available again after deletion.',
    inputSchema: {
      project_id: z.string().describe('Project ID (UUID) to delete. Use list-projects to find the ID'),
    },
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
