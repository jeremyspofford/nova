import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import type { Dispatch } from "react";
import { useConversation } from "../hooks/useConversation";
import type { Message, Action } from "../hooks/useConversation";
import { apiFetch } from "../api";

const TASK_ID_KEY = "nova_task_id";

interface ConversationContextValue {
  messages: Message[];
  thinking: boolean;
  dispatch: Dispatch<Action>;
  taskId: string | null;
  setTaskId: (id: string) => void;
}

const ConversationContext = createContext<ConversationContextValue | null>(null);

export function ConversationProvider({ children }: { children: ReactNode }) {
  const { messages, thinking, dispatch } = useConversation();
  const [taskId, setTaskIdState] = useState<string | null>(
    () => localStorage.getItem(TASK_ID_KEY)
  );
  // Capture initial value in a ref so the effect runs exactly once on mount
  const initialTaskId = useRef(localStorage.getItem(TASK_ID_KEY));

  const setTaskId = useCallback((id: string) => {
    localStorage.setItem(TASK_ID_KEY, id);
    setTaskIdState(id);
  }, []);

  // Restore history from the server if we have a stored task_id
  useEffect(() => {
    const id = initialTaskId.current;
    if (!id) return;
    apiFetch<Array<{ role: string; content: string; created_at: string }>>(
      `/api/v1/tasks/${id}/messages`
    )
      .then((rows) => {
        const visible = rows.filter((r) => r.role !== "system");
        if (visible.length === 0) return;
        dispatch({
          type: "SET_MESSAGES",
          messages: visible.map((r, i) => ({
            id: `history-${i}-${r.created_at}`,
            role: r.role === "assistant" ? ("nova" as const) : ("user" as const),
            text: r.content,
          })),
        });
      })
      .catch(() => {
        // Task no longer exists — start fresh
        localStorage.removeItem(TASK_ID_KEY);
        setTaskIdState(null);
        initialTaskId.current = null;
      });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const value = { messages, thinking, dispatch, taskId, setTaskId };
  return (
    <ConversationContext.Provider value={value}>
      {children}
    </ConversationContext.Provider>
  );
}

export function useConversationContext(): ConversationContextValue {
  const ctx = useContext(ConversationContext);
  if (!ctx) throw new Error("useConversationContext must be used inside ConversationProvider");
  return ctx;
}
