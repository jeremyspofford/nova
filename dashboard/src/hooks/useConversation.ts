import { useReducer } from "react";

export type MessageRole = "user" | "nova" | "system";

export interface Message {
  id: string;
  role: MessageRole;
  text: string;
  taskId?: string;
  streaming?: boolean;
  toolApproval?: {
    toolCallId: string;
    name: string;
    tier: string;
    args: Record<string, unknown>;
    diff?: string;
  };
}

export type Action =
  | { type: "ADD_MESSAGE"; message: Message }
  | { type: "SET_MESSAGES"; messages: Message[] }
  | { type: "APPEND_CHUNK"; taskId: string; text: string }
  | { type: "FINALIZE_STREAM"; taskId: string }
  | { type: "CLEAR_STREAMING" }
  | { type: "ADD_APPROVAL_REQUEST"; payload: NonNullable<Message["toolApproval"]> & { taskId: string } }
  | { type: "RESOLVE_APPROVAL"; toolCallId: string }
  | { type: "SET_THINKING"; thinking: boolean };

interface ConversationState {
  messages: Message[];
  thinking: boolean;
  // True after SET_MESSAGES (history loaded from DB); reset to false on the
  // next user ADD_MESSAGE so live streaming is accepted again.
  historySealed: boolean;
}

const INITIAL: ConversationState = { messages: [], thinking: false, historySealed: false };

function reducer(state: ConversationState, action: Action): ConversationState {
  switch (action.type) {
    case "ADD_MESSAGE":
      return {
        ...state,
        messages: [...state.messages, action.message],
        // User sending a new message means we're live — accept streaming chunks again
        historySealed: action.message.role === "user" ? false : state.historySealed,
      };

    case "SET_MESSAGES":
      return { ...state, messages: action.messages, historySealed: true };

    case "SET_THINKING":
      return { ...state, thinking: action.thinking };

    case "APPEND_CHUNK": {
      const msgs = state.messages;
      const idx = msgs.findLastIndex(
        (m) => m.taskId === action.taskId && m.streaming
      );
      // If history is sealed and there's no existing streaming slot, this is
      // a buffer replay of a past response — discard it.
      if (idx === -1 && state.historySealed) return state;
      const updated =
        idx === -1
          ? [
              ...msgs,
              {
                id: action.taskId,
                role: "nova" as const,
                text: action.text,
                taskId: action.taskId,
                streaming: true,
              },
            ]
          : msgs.map((m, i) =>
              i === idx ? { ...m, text: m.text + action.text } : m
            );
      return { ...state, messages: updated, thinking: false };
    }

    case "FINALIZE_STREAM":
      return {
        ...state,
        messages: state.messages.map((m) =>
          m.taskId === action.taskId && m.streaming ? { ...m, streaming: false } : m
        ),
        thinking: false,
        // Seal after any completed response so WS reconnect replays are ignored
        historySealed: true,
      };

    case "CLEAR_STREAMING":
      // Called on every WS (re)connect — wipes in-progress streaming messages so
      // a mid-stream reconnect lets the buffer replay rebuild them cleanly
      return {
        ...state,
        messages: state.messages.filter((m) => !m.streaming),
      };

    case "ADD_APPROVAL_REQUEST":
      return {
        ...state,
        messages: [
          ...state.messages,
          {
            id: `approval-${action.payload.toolCallId}`,
            role: "system",
            text: "",
            taskId: action.payload.taskId,
            toolApproval: action.payload,
          },
        ],
      };

    case "RESOLVE_APPROVAL":
      return {
        ...state,
        messages: state.messages.filter(
          (m) => m.toolApproval?.toolCallId !== action.toolCallId
        ),
      };

    default:
      return state;
  }
}

export function useConversation() {
  const [{ messages, thinking }, dispatch] = useReducer(reducer, INITIAL);
  return { messages, thinking, dispatch };
}
