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
  | { type: "RESOLVE_APPROVAL"; toolCallId: string };

function reducer(state: Message[], action: Action): Message[] {
  switch (action.type) {
    case "ADD_MESSAGE":
      return [...state, action.message];

    case "APPEND_CHUNK": {
      const idx = state.findLastIndex(
        (m) => m.taskId === action.taskId && m.streaming
      );
      if (idx === -1) {
        return [
          ...state,
          {
            id: action.taskId,
            role: "nova",
            text: action.text,
            taskId: action.taskId,
            streaming: true,
          },
        ];
      }
      const updated = [...state];
      updated[idx] = { ...updated[idx], text: updated[idx].text + action.text };
      return updated;
    }

    case "FINALIZE_STREAM":
      return state.map((m) =>
        m.taskId === action.taskId && m.streaming ? { ...m, streaming: false } : m
      );

    case "ADD_APPROVAL_REQUEST":
      return [
        ...state,
        {
          id: `approval-${action.payload.toolCallId}`,
          role: "system",
          text: "",
          taskId: action.payload.taskId,
          toolApproval: action.payload,
        },
      ];

    case "RESOLVE_APPROVAL":
      return state.filter(
        (m) => m.toolApproval?.toolCallId !== action.toolCallId
      );

    default:
      return state;
  }
}

export function useConversation() {
  const [messages, dispatch] = useReducer(reducer, []);
  return { messages, dispatch };
}
