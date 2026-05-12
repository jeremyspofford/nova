export const API_BASE = "";
export const WS_URL = "/ws";

export async function apiFetch<T>(
  path: string,
  init?: RequestInit
): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { "Content-Type": "application/json", ...init?.headers },
    ...init,
  });
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
