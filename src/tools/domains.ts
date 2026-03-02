import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { SotaClient } from '@sota-io/sdk';

export function registerDomainTools(server: McpServer, client: SotaClient) {
  server.registerTool('add-domain', {
    description: 'Add a custom domain to a sota.io project. Each project supports up to 5 custom domains with automatic HTTPS via Let\'s Encrypt. Returns DNS setup instructions: for apex domains (example.com), add an A record pointing to 23.88.45.28; for subdomains (app.example.com), add a CNAME record pointing to {slug}.sota.io. Domain statuses: pending (waiting for DNS) → verified (SSL provisioning) → active (live with HTTPS). After DNS is configured, verification and SSL provisioning happen automatically.',
    inputSchema: {
      project_id: z.string().describe('Project ID (UUID) to add the domain to. Use list-projects to find the ID'),
      domain: z.string().describe('Domain name to add (e.g. "app.example.com" or "example.com")'),
    },
  }, async ({ project_id, domain }) => {
    try {
      const result = await client.addDomain(project_id, domain);
      const d = result.domain;
      const dns = result.dns_instructions;

      let text = `Domain added: ${d.domain}\n  ID: ${d.id}\n  Status: ${d.status}`;

      if (dns) {
        text += `\n\nDNS Setup Required:\n  Record Type: ${dns.type}\n  Name: ${dns.name}\n  Value: ${dns.value}`;
        text += '\n\nAfter adding the DNS record, the domain will be verified automatically and SSL provisioned via Let\'s Encrypt.';
      }

      return {
        content: [{ type: 'text' as const, text }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text' as const, text: `Add domain failed: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      };
    }
  });

  server.registerTool('list-domains', {
    description: 'List all custom domains for a sota.io project. Shows domain name, status (pending/verified/active), and ID for each domain. Use get-domain with a domain ID to see DNS instructions and full details.',
    inputSchema: {
      project_id: z.string().describe('Project ID (UUID) to list domains for. Use list-projects to find the ID'),
    },
  }, async ({ project_id }) => {
    try {
      const domains = await client.listDomains(project_id);

      if (domains.length === 0) {
        return {
          content: [{ type: 'text' as const, text: 'No custom domains found. Use add-domain to add one.' }],
        };
      }

      const lines = domains.map(
        (d) => `${d.domain} - Status: ${d.status} - ID: ${d.id}`
      );

      return {
        content: [{ type: 'text' as const, text: `Domains:\n${lines.join('\n')}` }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text' as const, text: `List domains failed: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      };
    }
  });

  server.registerTool('get-domain', {
    description: 'Get details of a custom domain including its current status and DNS setup instructions. Domain statuses: pending (DNS not yet configured), verified (DNS confirmed, SSL provisioning), active (live with HTTPS). If status is \'pending\', configure the DNS record as shown in the instructions.',
    inputSchema: {
      project_id: z.string().describe('Project ID (UUID). Use list-projects to find the ID'),
      domain_id: z.string().describe('Domain ID (UUID). Use list-domains to find the ID'),
    },
  }, async ({ project_id, domain_id }) => {
    try {
      const result = await client.getDomain(project_id, domain_id);
      const d = result.domain;
      const dns = result.dns_instructions;

      let text = `Domain: ${d.domain}\n  ID: ${d.id}\n  Status: ${d.status}\n  Type: ${d.dns_type}\n  Created: ${d.created_at}`;

      if (d.verified_at) {
        text += `\n  Verified: ${d.verified_at}`;
      }

      if (d.error_message) {
        text += `\n  Error: ${d.error_message}`;
      }

      if (dns) {
        text += `\n\nDNS Instructions:\n  Record Type: ${dns.type}\n  Name: ${dns.name}\n  Value: ${dns.value}`;
      }

      return {
        content: [{ type: 'text' as const, text }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text' as const, text: `Get domain failed: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      };
    }
  });

  server.registerTool('remove-domain', {
    description: 'Remove a custom domain from a sota.io project. This removes the domain mapping and its SSL certificate. The DNS records at your registrar are NOT automatically removed — clean those up manually. This action is immediate and irreversible.',
    inputSchema: {
      project_id: z.string().describe('Project ID (UUID). Use list-projects to find the ID'),
      domain_id: z.string().describe('Domain ID (UUID). Use list-domains to find the ID'),
    },
  }, async ({ project_id, domain_id }) => {
    try {
      await client.removeDomain(project_id, domain_id);
      return {
        content: [{ type: 'text' as const, text: `Domain ${domain_id} removed successfully.` }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text' as const, text: `Remove domain failed: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      };
    }
  });
}
