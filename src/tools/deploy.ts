import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { execSync } from 'child_process';
import { existsSync } from 'fs';
import { resolve } from 'path';
import { SotaClient } from '@sota-io/sdk';

export function registerDeployTool(server: McpServer, client: SotaClient) {
  server.registerTool('deploy', {
    description: `Deploy an application to sota.io. Creates a tar.gz archive of the specified directory and uploads it (max 50 MB). The platform auto-detects your framework and builds a Docker image automatically:

- Next.js: Detected via next.config.js/ts. Add output: 'standalone' to next.config for optimal builds.
- Node.js: Detected via package.json with a "start" script. Works with Express, Fastify, Koa, Hapi, etc.
- Python: Detected via requirements.txt or pyproject.toml. Works with Flask, FastAPI, Django.
- Custom Dockerfile: If a Dockerfile exists in the project root, it takes priority over auto-detection. Use this for Go, Rust, Java, or any other language. The EXPOSE directive in the Dockerfile is used to detect the app port automatically.

IMPORTANT: Your app MUST listen on the PORT environment variable. For auto-detected frameworks (Next.js, Node.js, Python) PORT is 8080. For custom Dockerfiles, the port is auto-detected from the EXPOSE directive (e.g. EXPOSE 3000 sets PORT=3000). If no EXPOSE is found, it defaults to 8080.

Every project includes a managed PostgreSQL 17 database. The DATABASE_URL environment variable is auto-injected into your container — no manual database configuration needed. Your app just needs to read DATABASE_URL to connect. If your app needs database migrations, run them on startup.

Deployments use blue-green strategy for zero downtime. The old container keeps running until the new one passes health checks (60s timeout). Use get-logs to monitor build progress. Files matching .gitignore and .sotaignore are excluded from the archive.`,
    inputSchema: {
      project_id: z.string().describe('Project ID (UUID) to deploy to. Use list-projects to find the ID'),
      directory: z.string().optional().describe('Absolute path to the directory to deploy. Defaults to current working directory. Must contain your app source code (package.json, requirements.txt, or Dockerfile)'),
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
