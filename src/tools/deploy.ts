import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { execSync } from 'child_process';
import { existsSync } from 'fs';
import { resolve } from 'path';
import { SotaClient } from '@sota-io/sdk';

export function registerDeployTool(server: McpServer, client: SotaClient) {
  server.registerTool('deploy', {
    description: 'Deploy an application to sota.io. Creates a tar.gz archive of the specified directory and uploads it.',
    inputSchema: {
      project_id: z.string().describe('Project ID to deploy to'),
      directory: z.string().optional().describe('Directory to deploy (defaults to current working directory)'),
    },
  }, async ({ project_id, directory }) => {
    const dir = directory ? resolve(directory) : process.cwd();

    if (!existsSync(dir)) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Error: Directory not found: ${dir}`,
          },
        ],
        isError: true,
      };
    }

    try {
      // Create tar.gz archive using system tar (excludes common ignores)
      const archivePath = `/tmp/sota-deploy-${Date.now()}.tar.gz`;
      execSync(
        `tar -czf ${archivePath} --exclude='.git' --exclude='node_modules' --exclude='.env' --exclude='.DS_Store' -C ${dir} .`,
        { stdio: 'pipe' }
      );

      const { readFileSync, unlinkSync } = await import('fs');
      const archiveBuffer = readFileSync(archivePath);
      unlinkSync(archivePath);

      const deployment = await client.deploy(project_id, archiveBuffer);

      return {
        content: [
          {
            type: 'text' as const,
            text: `Deployment started:\n  ID: ${deployment.id}\n  Status: ${deployment.status}\n  URL: ${deployment.url || 'pending'}\n\nUse get-logs to check build progress.`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Deploy failed: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
        isError: true,
      };
    }
  });
}
