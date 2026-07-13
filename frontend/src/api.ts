/** API client for the Nova backend. */

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8000';

export interface Activity {
  kind: 'tool_start' | 'tool_result' | 'dispatch';
  name: string;
  agent?: string;
  detail?: string;
}

export type ChatEvent =
  | { type: 'meta'; conversationId: string; model: string }
  | { type: 'text'; text: string }
  | { type: 'activity'; activity: Activity }
  | { type: 'error'; error: string }
  | { type: 'done' };

export async function* streamChat(message: string, conversationId?: string): AsyncGenerator<ChatEvent> {
  const response = await fetch(`${API_URL}/api/v1/chat/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, conversation_id: conversationId }),
  });

  if (!response.ok || !response.body) {
    throw new Error(`Chat request failed: ${response.status} ${response.statusText}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const frames = buffer.split('\n\n');
      buffer = frames.pop() || '';

      for (const frame of frames) {
        const line = frame.trim();
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6);

        if (data === '[DONE]') {
          yield { type: 'done' };
          return;
        }
        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(data);
        } catch {
          continue;
        }
        if (parsed.meta) {
          const meta = parsed.meta as { conversation_id: string; model: string };
          yield { type: 'meta', conversationId: meta.conversation_id, model: meta.model };
        } else if (typeof parsed.t === 'string') {
          yield { type: 'text', text: parsed.t };
        } else if (parsed.activity) {
          yield { type: 'activity', activity: parsed.activity as Activity };
        } else if (typeof parsed.error === 'string') {
          yield { type: 'error', error: parsed.error };
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export async function getActiveConversation(): Promise<{ id: string; title: string | null }> {
  const r = await fetch(`${API_URL}/api/v1/conversations/active`);
  if (!r.ok) throw new Error('Failed to load conversation');
  return r.json();
}

export interface StoredMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  created_at: string;
}

export async function getMessages(conversationId: string): Promise<StoredMessage[]> {
  const r = await fetch(`${API_URL}/api/v1/conversations/${conversationId}/messages`);
  if (!r.ok) throw new Error('Failed to load messages');
  return r.json();
}

export async function getMemoryStats(): Promise<Record<string, number>> {
  const r = await fetch(`${API_URL}/api/v1/memory/stats`);
  if (!r.ok) throw new Error('Failed to load memory stats');
  return r.json();
}

export interface GraphNode { id: string; label: string; type: string; mtime: number }
export interface GraphEdge { source: string; target: string; kind: string }

export async function getMemoryGraph(): Promise<{ nodes: GraphNode[]; edges: GraphEdge[] }> {
  const r = await fetch(`${API_URL}/api/v1/memory/graph`);
  if (!r.ok) throw new Error('Failed to load memory graph');
  return r.json();
}
