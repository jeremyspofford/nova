import { useState, useCallback, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Mic, Send, WifiOff } from "lucide-react";
import { apiFetch } from "../api";
import { useConversation } from "../hooks/useConversation";
import { useWebSocket } from "../hooks/useWebSocket";
import { ConversationView } from "../components/ConversationView";
import { SetupCards } from "../components/SetupCards";

interface Task { id: string; status: string }

export function Chat() {
  const [input, setInput] = useState("");
  const { messages, dispatch } = useConversation();

  const [wizardDismissed, setWizardDismissed] = useState(
    () => localStorage.getItem("wizard-dismissed") === "true"
  );
  const [wizardCompleted, setWizardCompleted] = useState<Set<string>>(
    () => new Set(JSON.parse(localStorage.getItem("wizard-completed") ?? "[]"))
  );
  // Tracks which card started the most recent task so we can mark it complete
  const pendingCard = useRef<string | null>(null);

  const handleTaskComplete = useCallback(() => {
    if (pendingCard.current) {
      const card = pendingCard.current;
      pendingCard.current = null;
      setWizardCompleted((prev) => {
        const next = new Set(prev);
        next.add(card);
        localStorage.setItem("wizard-completed", JSON.stringify([...next]));
        return next;
      });
    }
  }, []);

  const { sendMessage, connected } = useWebSocket({ dispatch, onTaskComplete: handleTaskComplete });

  // Detect first run: no tasks yet
  const { data: recentTasks } = useQuery<Task[]>({
    queryKey: ["tasks", "recent"],
    queryFn: () => apiFetch("/api/v1/tasks?limit=1"),
    staleTime: 60_000,
  });

  const showWizard = !wizardDismissed && recentTasks?.length === 0;

  const handleDismiss = useCallback(() => {
    localStorage.setItem("wizard-dismissed", "true");
    setWizardDismissed(true);
  }, []);

  const handleStartCard = useCallback(
    (cardId: string) => {
      const prompts: Record<string, string> = {
        "cloud-ai":  "Help me connect a cloud AI provider.",
        "tailscale": "Help me set up remote access with Tailscale.",
        "voice":     "Help me enable voice input and output.",
        "briefing":  "Help me set up a daily morning briefing.",
      };
      const text = prompts[cardId];
      if (!text) return;
      pendingCard.current = cardId;
      dispatch({
        type: "ADD_MESSAGE",
        message: { id: Date.now().toString(), role: "user", text },
      });
      sendMessage("message", { text });
    },
    [dispatch, sendMessage]
  );

  function handleSend() {
    const text = input.trim();
    if (!text) return;
    dispatch({
      type: "ADD_MESSAGE",
      message: { id: Date.now().toString(), role: "user", text },
    });
    sendMessage("message", { text });
    setInput("");
  }

  const noSecret = !localStorage.getItem("adminSecret");

  return (
    <div className="flex flex-col h-full">
      {!connected && (
        <div className="flex items-center gap-2 px-4 py-2 bg-amber-900/40 border-b border-amber-800/60 text-amber-300 text-xs">
          <WifiOff size={13} />
          {noSecret ? (
            <>
              Not connected — set your admin secret in{" "}
              <Link to="/settings" className="underline hover:text-amber-200">
                Settings → System
              </Link>
              , then reload.
            </>
          ) : (
            "Connecting to Nova…"
          )}
        </div>
      )}
      {showWizard && (
        <SetupCards
          completed={wizardCompleted}
          onStart={handleStartCard}
          onDismiss={handleDismiss}
        />
      )}

      <ConversationView messages={messages} dispatch={dispatch} />

      <div className="border-t border-stone-800 p-3 flex gap-2">
        <button className="text-stone-500 hover:text-stone-300 p-2 rounded-lg transition-colors">
          <Mic size={18} />
        </button>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && handleSend()}
          placeholder="Type a message..."
          className="flex-1 bg-stone-800/60 border border-stone-700 rounded-xl px-4 py-2 text-sm outline-none focus:border-teal-600 placeholder:text-stone-600"
        />
        <button
          onClick={handleSend}
          disabled={!input.trim()}
          className="text-stone-500 hover:text-teal-400 disabled:opacity-40 p-2 rounded-lg transition-colors"
        >
          <Send size={18} />
        </button>
      </div>
    </div>
  );
}
