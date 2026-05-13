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
  | { type: "APPEND_CHUNK"; taskId: string; text: string }
  | { type: "FINALIZE_STREAM"; taskId: string }
  | { type: "ADD_APPROVAL_REQUEST"; payload: NonNullable<Message["toolApproval"]> & { taskId: string } }
  | { type: "RESOLVE_APPROVAL"; toolCallId: string }
  | { type: "SET_THINKING"; thinking: boolean };

interface ConversationState {
  messages: Message[];
  thinking: boolean;
}

const INITIAL: ConversationState = { messages: [], thinking: false };

function reducer(state: ConversationState, action: Action): ConversationState {
  switch (action.type) {
    case "ADD_MESSAGE":
      return { ...state, messages: [...state.messages, action.message] };

    case "SET_THINKING":
      return { ...state, thinking: action.thinking };

    case "APPEND_CHUNK": {
      const msgs = state.messages;
      const idx = msgs.findLastIndex(
        (m) => m.taskId === action.taskId && m.streaming
      );
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
      return { messages: updated, thinking: false };
    }

    case "FINALIZE_STREAM":
      return {
        ...state,
        messages: state.messages.map((m) =>
          m.taskId === action.taskId && m.streaming ? { ...m, streaming: false } : m
        ),
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
