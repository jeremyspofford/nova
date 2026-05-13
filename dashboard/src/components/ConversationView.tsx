import { useEffect, useRef } from "react";
import type { Dispatch } from "react";
import type { Message, Action } from "../hooks/useConversation";
import { ToolApprovalCard } from "./ToolApprovalCard";

interface Props {
  messages: Message[];
  thinking: boolean;
  dispatch: Dispatch<Action>;
}

export function ConversationView({ messages, thinking, dispatch }: Props) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length, thinking]);

  return (
    <div className="flex-1 overflow-y-auto px-4 py-4 space-y-3">
      {messages.map((msg) => {
        if (msg.toolApproval) {
          return (
            <ToolApprovalCard
              key={msg.id}
              {...msg.toolApproval}
              onResolved={(id) => dispatch({ type: "RESOLVE_APPROVAL", toolCallId: id })}
            />
          );
        }

        const isUser = msg.role === "user";
        return (
          <div
            key={msg.id}
            className={`flex ${isUser ? "justify-end" : "justify-start"}`}
          >
            <div
              className={`max-w-xl rounded-2xl px-4 py-2.5 text-sm leading-relaxed whitespace-pre-wrap ${
                isUser
                  ? "bg-teal-700 text-white rounded-br-sm"
                  : "bg-stone-800 text-stone-100 rounded-bl-sm"
              }`}
            >
              {msg.text}
              {msg.streaming && (
                <span className="ml-1 inline-block w-1.5 h-4 bg-teal-400 animate-pulse align-middle" />
              )}
            </div>
          </div>
        );
      })}
      {thinking && (
        <div className="flex justify-start">
          <div className="bg-stone-800 rounded-2xl rounded-bl-sm px-4 py-3 flex gap-1 items-center">
            <span className="w-1.5 h-1.5 bg-stone-400 rounded-full animate-bounce [animation-delay:-0.3s]" />
            <span className="w-1.5 h-1.5 bg-stone-400 rounded-full animate-bounce [animation-delay:-0.15s]" />
            <span className="w-1.5 h-1.5 bg-stone-400 rounded-full animate-bounce" />
          </div>
        </div>
      )}
      <div ref={bottomRef} />
    </div>
  );
}
