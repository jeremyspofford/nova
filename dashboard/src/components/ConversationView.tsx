import { useEffect, useRef, useState, useCallback } from "react";
import type { Dispatch } from "react";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import "highlight.js/styles/github-dark.css";
import { Copy, Check } from "lucide-react";
import type { Message, Action } from "../hooks/useConversation";
import { ToolApprovalCard } from "./ToolApprovalCard";

interface Props {
  messages: Message[];
  thinking: boolean;
  dispatch: Dispatch<Action>;
}

function CopyableCodeBlock({ children }: { children: React.ReactNode }) {
  const [copied, setCopied] = useState(false);
  const preRef = useRef<HTMLPreElement>(null);

  const handleCopy = useCallback(() => {
    const text = preRef.current?.textContent ?? "";
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, []);

  return (
    <div className="relative group not-prose my-3">
      <pre ref={preRef} className="rounded-lg overflow-x-auto text-xs leading-relaxed">
        {children}
      </pre>
      <button
        onClick={handleCopy}
        className="absolute top-2 right-2 p-1.5 rounded-md bg-stone-700/80 text-stone-400 opacity-0 group-hover:opacity-100 hover:text-stone-100 hover:bg-stone-600 transition-all"
        aria-label="Copy code"
      >
        {copied ? <Check size={13} strokeWidth={2.5} /> : <Copy size={13} strokeWidth={2} />}
      </button>
    </div>
  );
}

const MD_COMPONENTS = {
  pre: ({ children }: { children?: React.ReactNode }) => (
    <CopyableCodeBlock>{children}</CopyableCodeBlock>
  ),
};

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
              className={`max-w-xl rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${
                isUser
                  ? "bg-teal-700 text-white rounded-br-sm whitespace-pre-wrap"
                  : "bg-stone-800 text-stone-100 rounded-bl-sm prose prose-sm prose-invert prose-stone max-w-none"
              }`}
            >
              {isUser ? (
                msg.text
              ) : (
                <>
                  <ReactMarkdown
                    rehypePlugins={[rehypeHighlight]}
                    components={MD_COMPONENTS}
                  >
                    {msg.text}
                  </ReactMarkdown>
                  {msg.streaming && (
                    <span className="inline-block w-1.5 h-4 bg-teal-400 animate-pulse align-middle" />
                  )}
                </>
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
