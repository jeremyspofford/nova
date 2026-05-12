import { useEffect, useRef, useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { Dispatch } from "react";
import type { Action } from "./useConversation";
import { WS_URL } from "../api";

interface UseWebSocketOptions {
  dispatch: Dispatch<Action>;
  taskId?: string;
  onTaskComplete?: () => void;
}

export function useWebSocket({ dispatch, taskId, onTaskComplete }: UseWebSocketOptions) {
  const ws = useRef<WebSocket | null>(null);
  const queryClient = useQueryClient();
  const retryDelay = useRef(1000);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const connect = useCallback(() => {
    const socket = new WebSocket(WS_URL);
    ws.current = socket;

    socket.onopen = () => {
      retryDelay.current = 1000;
      socket.send(
        JSON.stringify({ type: "connect", resume_task_id: taskId ?? null })
      );
    };

    socket.onmessage = (event) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(event.data as string);
      } catch {
        return;
      }

      const t = msg.type as string;

      if (t === "response_chunk") {
        dispatch({
          type: "APPEND_CHUNK",
          taskId: msg.task_id as string,
          text: msg.text as string,
        });
      } else if (t === "response_final") {
        dispatch({ type: "FINALIZE_STREAM", taskId: msg.task_id as string });
        queryClient.invalidateQueries({ queryKey: ["tasks"] });
      } else if (t === "tool_approval_request") {
        dispatch({
          type: "ADD_APPROVAL_REQUEST",
          payload: {
            taskId: msg.task_id as string,
            toolCallId: msg.tool_call_id as string,
            name: msg.name as string,
            tier: msg.tier as string,
            args: msg.args as Record<string, unknown>,
            diff: msg.diff as string | undefined,
          },
        });
      } else if (t === "task_status") {
        queryClient.invalidateQueries({ queryKey: ["tasks"] });
        if (msg.status === "completed" || msg.status === "failed") {
          dispatch({
            type: "FINALIZE_STREAM",
            taskId: msg.task_id as string,
          });
          if (msg.status === "completed") {
            onTaskComplete?.();
          }
        }
      }
    };

    socket.onclose = () => {
      // Exponential backoff reconnect; store handle so cleanup can cancel it
      const delay = retryDelay.current;
      retryDelay.current = Math.min(delay * 2, 30_000);
      retryTimer.current = setTimeout(connect, delay);
    };
  }, [dispatch, taskId, queryClient, onTaskComplete]);

  useEffect(() => {
    connect();
    return () => {
      if (retryTimer.current) clearTimeout(retryTimer.current);
      ws.current?.close();
    };
  }, [connect]);

  const sendMessage = useCallback((type: string, payload: Record<string, unknown> = {}) => {
    if (ws.current?.readyState === WebSocket.OPEN) {
      ws.current.send(JSON.stringify({ type, ...payload }));
    }
  }, []);

  return { sendMessage };
}
