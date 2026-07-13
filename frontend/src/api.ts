/**API client for Nova backend */

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8000';

export interface ChatEvent {
  type: 'meta' | 'text' | 'done' | 'error';
  meta?: { conversation_id: string; model: string };
  t?: string;
  error?: string;
}

export async function* streamChat(message: string, conversationId?: string): AsyncGenerator<ChatEvent> {
  const response = await fetch(`${API_URL}/api/v1/chat/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, conversation_id: conversationId }),
  });

  if (!response.ok) throw new Error(`Chat error: ${response.statusText}`);
  if (!response.body) throw new Error('No response body');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6);

        if (data === '[DONE]') {
          yield { type: 'done' };
        } else {
          try {
            const parsed = JSON.parse(data);
            if (parsed.meta) yield { type: 'meta', meta: parsed.meta };
            if (parsed.t) yield { type: 'text', t: parsed.t };
            if (parsed.error) yield { type: 'error', error: parsed.error };
          } catch (e) {
            console.error('Parse error:', e);
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export async function getActiveConversation() {
  const response = await fetch(`${API_URL}/api/v1/conversations/active`);
  if (!response.ok) throw new Error('Failed to get conversation');
  return response.json();
}

export async function getMessages(conversationId: string) {
  const response = await fetch(`${API_URL}/api/v1/conversations/${conversationId}/messages`);
  if (!response.ok) throw new Error('Failed to get messages');
  return response.json();
}
