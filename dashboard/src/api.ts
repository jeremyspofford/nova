export const API_BASE = "";
export const WS_URL = "/ws";

export async function apiFetch<T>(
  path: string,
  init?: RequestInit
): Promise<T> {
  const secret = localStorage.getItem("adminSecret");
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (secret) headers["X-Admin-Secret"] = secret;
  if (init?.headers) {
    for (const [k, v] of Object.entries(init.headers as Record<string, string>)) {
      headers[k] = v;
    }
  }
  const { headers: _h, ...restInit } = init ?? {};
  const res = await fetch(`${API_BASE}${path}`, { headers, ...restInit });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${res.status} ${res.statusText}: ${text}`);
  }
  return res.json() as Promise<T>;
}

// Secret management (used by SecretsSection)
export interface SecretInfo {
  name: string;
  purpose?: string;
  created_at: string;
  updated_at: string;
  last_used: string | null;
  used_count: number;
}

export async function listSecrets(): Promise<SecretInfo[]> {
  return apiFetch<SecretInfo[]>("/api/v1/secrets");
}

export async function createSecret(params: {
  name: string;
  value: string;
  purpose?: string;
}): Promise<SecretInfo> {
  return apiFetch<SecretInfo>("/api/v1/secrets", {
    method: "POST",
    body: JSON.stringify(params),
  });
}

export async function updateSecret(
  name: string,
  data: { value?: string; purpose?: string }
): Promise<SecretInfo> {
  return apiFetch<SecretInfo>(`/api/v1/secrets/${name}`, {
    method: "PATCH",
    body: JSON.stringify(data),
  });
}

export async function deleteSecret(name: string): Promise<void> {
  await apiFetch(`/api/v1/secrets/${name}`, { method: "DELETE" });
}

// MCP server management (used by ExtensionsSection)
export interface MCPServer {
  id: string;
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  working_dir: string | null;
  transport: string;
  enabled: boolean;
  created_at: string | null;
  last_started: string | null;
  last_error: string | null;
}

export interface MCPTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  auto_tier: string;
  effective_tier: string;
}

export interface MCPServerCreate {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  working_dir?: string;
  enabled?: boolean;
  transport?: string;
}

export async function listMCPServers(): Promise<MCPServer[]> {
  return apiFetch<MCPServer[]>("/api/v1/mcp/servers");
}

export async function createMCPServer(body: MCPServerCreate): Promise<MCPServer> {
  return apiFetch<MCPServer>("/api/v1/mcp/servers", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export async function deleteMCPServer(id: string): Promise<void> {
  await apiFetch(`/api/v1/mcp/servers/${id}`, { method: "DELETE" });
}

export async function listMCPTools(serverId: string): Promise<MCPTool[]> {
  return apiFetch<MCPTool[]>(`/api/v1/mcp/servers/${serverId}/tools`);
}

export async function setToolTierOverride(
  serverId: string,
  toolName: string,
  tierOverride: string | null
): Promise<{ server_id: string; tool_name: string; tier_override: string | null }> {
  return apiFetch(`/api/v1/mcp/servers/${serverId}/tools/${toolName}`, {
    method: "PATCH",
    body: JSON.stringify({ tier_override: tierOverride }),
  });
}

export async function restartMCPServer(
  serverId: string
): Promise<{ started: boolean; server_id: string }> {
  return apiFetch(`/api/v1/mcp/servers/${serverId}/restart`, { method: "POST" });
}

export async function toggleMCPServer(serverId: string, enabled: boolean): Promise<MCPServer> {
  return apiFetch<MCPServer>(`/api/v1/mcp/servers/${serverId}`, {
    method: "PATCH",
    body: JSON.stringify({ enabled }),
  });
}

export interface LLMProvider {
  name: string;
  model: string;
  available: boolean;
  local: boolean;
  supports_embed: boolean;
  url?: string;
}

export interface LLMProvidersResponse {
  providers: LLMProvider[];
  routing_strategy: string;
  local_backend: string;
  local_inference_url: string;
}

export async function getLLMProviders(): Promise<LLMProvidersResponse> {
  return apiFetch<LLMProvidersResponse>("/api/v1/llm/providers");
}

export async function patchLLMConfig(body: { routing_strategy?: string }): Promise<{ routing_strategy: string; local_backend: string }> {
  return apiFetch("/api/v1/llm/config", {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

export interface VoiceProvider {
  name: string;
  type: "stt" | "tts";
  status: "available" | "unconfigured";
}

export async function getVoiceProviders(): Promise<VoiceProvider[]> {
  return apiFetch<VoiceProvider[]>("/voice-api/providers");
}
