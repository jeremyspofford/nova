import { useEffect, useRef, useState } from 'react';
import { streamChat, getActiveConversation, getMessages } from '../api';

interface Message {
  id: string;
  role: 'user' | 'assistant' | 'tool';
  content: string;
  created_at: string;
}

export function ChatPanel() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Initialize conversation
  useEffect(() => {
    async function init() {
      try {
        const conv = await getActiveConversation();
        setConversationId(conv.id);
        const msgs = await getMessages(conv.id);
        setMessages(msgs);
      } catch (err) {
        console.error('Init error:', err);
      }
    }
    init();
  }, []);

  // Scroll to bottom on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!input.trim() || !conversationId) return;

    const userMessage = input;
    setInput('');
    setLoading(true);

    // Add user message to UI
    setMessages(prev => [...prev, { id: Date.now().toString(), role: 'user', content: userMessage, created_at: new Date().toISOString() }]);

    try {
      let assistantContent = '';

      for await (const event of streamChat(userMessage, conversationId)) {
        if (event.type === 'text' && event.t) {
          assistantContent += event.t;
          setMessages(prev => {
            const last = prev[prev.length - 1];
            if (last?.role === 'assistant' && last.id === 'streaming') {
              return [...prev.slice(0, -1), { ...last, content: assistantContent }];
            }
            return prev;
          });
        } else if (event.type === 'done') {
          // Mark streaming message with real ID when done
          setMessages(prev => {
            const last = prev[prev.length - 1];
            if (last?.id === 'streaming') {
              return [...prev.slice(0, -1), { ...last, id: Date.now().toString() }];
            }
            return prev;
          });
        }
      }
    } catch (err) {
      console.error('Chat error:', err);
      setMessages(prev => [...prev, { id: Date.now().toString(), role: 'assistant', content: `Error: ${err}`, created_at: new Date().toISOString() }]);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="absolute top-0 right-0 bottom-0 w-96 bg-stone-800 border-l border-stone-700 flex flex-col shadow-2xl">
      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        {messages.length === 0 && (
          <div className="text-center text-stone-400 mt-8">
            <p className="text-lg font-semibold">Start a conversation</p>
            <p className="text-sm mt-2">Type a message below to begin</p>
          </div>
        )}

        {messages.map(msg => (
          <div key={msg.id} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div
              className={`max-w-xs px-3 py-2 rounded-lg ${
                msg.role === 'user'
                  ? 'bg-teal-600 text-white'
                  : 'bg-stone-700 text-stone-100'
              }`}
            >
              <p className="text-sm">{msg.content}</p>
            </div>
          </div>
        ))}

        {loading && (
          <div className="flex justify-start">
            <div className="bg-stone-700 text-stone-100 px-3 py-2 rounded-lg">
              <div className="flex gap-1">
                <div className="w-2 h-2 bg-stone-400 rounded-full animate-bounce" />
                <div className="w-2 h-2 bg-stone-400 rounded-full animate-bounce" style={{ animationDelay: '0.1s' }} />
                <div className="w-2 h-2 bg-stone-400 rounded-full animate-bounce" style={{ animationDelay: '0.2s' }} />
              </div>
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <form onSubmit={handleSubmit} className="border-t border-stone-700 p-4 flex gap-2">
        <input
          type="text"
          value={input}
          onChange={e => setInput(e.target.value)}
          disabled={loading}
          placeholder="Type a message..."
          className="flex-1 bg-stone-700 text-white placeholder-stone-500 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-teal-500 disabled:opacity-50"
        />
        <button
          type="submit"
          disabled={loading || !input.trim()}
          className="px-4 py-2 bg-teal-600 hover:bg-teal-700 disabled:bg-stone-600 text-white rounded text-sm transition"
        >
          Send
        </button>
      </form>
    </div>
  );
}
