import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { SotaAPIClient } from '../api-client.js';

export function registerProjectTools(server: McpServer, client: SotaAPIClient) {
  server.registerTool('list-projects', {
    description: 'List all projects on your sota.io account',
  }, async () => {
    const projects = await client.listProjects();
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
    description: 'Create a new project on sota.io',
    inputSchema: {
      name: z.string().describe('Name for the new project'),
    },
  }, async ({ name }) => {
    const project = await client.createProject(name);
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
    description: 'Delete a project and all its deployments from sota.io. This action is permanent.',
    inputSchema: {
      project_id: z.string().describe('Project ID to delete'),
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
