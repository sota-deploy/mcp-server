/**
 * HTTP client for the sota.io REST API.
 * Used by MCP tools to interact with the platform.
 */

export interface Project {
  id: string;
  user_id: string;
  name: string;
  slug: string;
  created_at: string;
  updated_at: string;
}

export interface Deployment {
  id: string;
  project_id: string;
  status: string;
  url?: string;
  image_tag?: string;
  build_method?: string;
  framework?: string;
  error?: string;
  created_at: string;
  updated_at: string;
}

export interface EnvVar {
  id: string;
  project_id: string;
  key: string;
  value?: string;
  created_at: string;
  updated_at: string;
}

interface DataResponse<T> {
  data: T;
}

interface ListResponse<T> {
  data: T[];
  pagination?: {
    next_cursor?: string;
    has_more: boolean;
  };
}

interface ErrorResponse {
  error: {
    code: string;
    message: string;
  };
}

export class SotaAPIClient {
  private baseURL: string;
  private apiKey: string;

  constructor(baseURL: string, apiKey: string) {
    this.baseURL = baseURL.replace(/\/$/, '');
    this.apiKey = apiKey;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {
      'Authorization': `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
    };

    const response = await fetch(`${this.baseURL}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      const errorBody = await response.json() as ErrorResponse;
      throw new Error(`API error: ${errorBody.error?.message || response.statusText}`);
    }

    return response.json() as Promise<T>;
  }

  async listProjects(): Promise<Project[]> {
    const resp = await this.request<ListResponse<Project>>('GET', '/v1/projects?limit=100');
    return resp.data;
  }

  async createProject(name: string): Promise<Project> {
    const resp = await this.request<DataResponse<Project>>('POST', '/v1/projects', { name });
    return resp.data;
  }

  async deploy(projectId: string, archiveBuffer: Buffer): Promise<Deployment> {
    const boundary = '----SotaMCPBoundary' + Date.now();
    const headers: Record<string, string> = {
      'Authorization': `Bearer ${this.apiKey}`,
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
    };

    const bodyParts = [
      `--${boundary}\r\n`,
      `Content-Disposition: form-data; name="archive"; filename="archive.tar.gz"\r\n`,
      `Content-Type: application/gzip\r\n`,
      `\r\n`,
    ];

    const prefix = Buffer.from(bodyParts.join(''));
    const suffix = Buffer.from(`\r\n--${boundary}--\r\n`);
    const body = Buffer.concat([prefix, archiveBuffer, suffix]);

    const response = await fetch(`${this.baseURL}/v1/projects/${projectId}/deploy`, {
      method: 'POST',
      headers,
      body,
    });

    if (!response.ok) {
      const errorBody = await response.json() as ErrorResponse;
      throw new Error(`Deploy failed: ${errorBody.error?.message || response.statusText}`);
    }

    const resp = await response.json() as DataResponse<Deployment>;
    return resp.data;
  }

  async rollback(projectId: string): Promise<Deployment> {
    const resp = await this.request<DataResponse<Deployment>>('POST', `/v1/projects/${projectId}/rollback`);
    return resp.data;
  }

  async getDeployments(projectId: string): Promise<Deployment[]> {
    const resp = await this.request<ListResponse<Deployment>>('GET', `/v1/projects/${projectId}/deployments`);
    return resp.data;
  }

  async getLogs(projectId: string, deploymentId: string): Promise<string> {
    const headers: Record<string, string> = {
      'Authorization': `Bearer ${this.apiKey}`,
    };

    const response = await fetch(
      `${this.baseURL}/v1/projects/${projectId}/deployments/${deploymentId}/logs`,
      { headers }
    );

    if (!response.ok) {
      throw new Error(`Failed to get logs: ${response.statusText}`);
    }

    return response.text();
  }

  async setEnvVar(projectId: string, key: string, value: string): Promise<void> {
    await this.request('POST', `/v1/projects/${projectId}/envs`, { key, value });
  }

  async listEnvVars(projectId: string): Promise<EnvVar[]> {
    const resp = await this.request<DataResponse<EnvVar[]>>('GET', `/v1/projects/${projectId}/envs`);
    return resp.data;
  }

  async deleteEnvVar(projectId: string, key: string): Promise<void> {
    await this.request('DELETE', `/v1/projects/${projectId}/envs/${key}`);
  }

  async deleteProject(projectId: string): Promise<void> {
    const headers: Record<string, string> = {
      'Authorization': `Bearer ${this.apiKey}`,
    };
    const response = await fetch(`${this.baseURL}/v1/projects/${projectId}`, {
      method: 'DELETE',
      headers,
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({ error: { message: response.statusText } }));
      throw new Error(`Delete failed: ${(body as { error?: { message?: string } }).error?.message || response.statusText}`);
    }
  }
}
