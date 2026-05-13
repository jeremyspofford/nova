import { useEffect, useRef, useCallback, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { Dispatch } from "react";
import type { Action } from "./useConversation";
import { WS_URL } from "../api";

interface UseWebSocketOptions {
  dispatch: Dispatch<Action>;
  taskId?: string;
  onTaskComplete?: () => void;
  onConnected?: (taskId: string) => void;
}

export function useWebSocket({ dispatch, taskId, onTaskComplete, onConnected }: UseWebSocketOptions) {
  const ws = useRef<WebSocket | null>(null);
  const queryClient = useQueryClient();
  const retryDelay = useRef(1000);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [connected, setConnected] = useState(false);
  // Store latest callbacks in refs so they never need to be deps of connect
  const onTaskCompleteRef = useRef(onTaskComplete);
  useEffect(() => { onTaskCompleteRef.current = onTaskComplete; });
  const onConnectedRef = useRef(onConnected);
  useEffect(() => { onConnectedRef.current = onConnected; });

  // Keep taskId in a ref so onopen always reads the latest value without
  // needing it as a useCallback dep (which would cause reconnect on first assignment)
  const taskIdRef = useRef(taskId);
  useEffect(() => { taskIdRef.current = taskId; });

  const connectRef = useRef<() => void>(() => {});

  const connect = useCallback(() => {
    const secret = localStorage.getItem("adminSecret");
    const url = secret ? `${WS_URL}?secret=${encodeURIComponent(secret)}` : WS_URL;
    const socket = new WebSocket(url);
    ws.current = socket;

    socket.onopen = () => {
      retryDelay.current = 1000;
      setConnected(true);
      socket.send(
        JSON.stringify({ type: "connect", resume_task_id: taskIdRef.current ?? null })
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

      if (t === "connected") {
        const tid = msg.task_id as string;
        if (tid) onConnectedRef.current?.(tid);
        // Wipe any in-progress streaming message from before the (re)connect so
        // the buffer replay can rebuild it without doubling
        dispatch({ type: "CLEAR_STREAMING" });
      } else if (t === "response_chunk") {
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
            onTaskCompleteRef.current?.();
          }
        }
      }
    };

    socket.onclose = () => {
      setConnected(false);
      // Exponential backoff reconnect; store handle so cleanup can cancel it
      const delay = retryDelay.current;
      retryDelay.current = Math.min(delay * 2, 30_000);
      // Use connectRef so we always call the current connect, not a stale closure
      retryTimer.current = setTimeout(() => connectRef.current(), delay);
    };
  }, [dispatch, queryClient]);   // taskId/onTaskComplete/onConnected kept in refs, not deps

  // Keep connectRef in sync with the latest connect
  useEffect(() => { connectRef.current = connect; }, [connect]);

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

  return { sendMessage, connected };
}
