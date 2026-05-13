import { useState, useRef, useCallback } from "react";

export type VoiceState = "idle" | "recording" | "processing" | "error";

interface UseVoiceInputOptions {
  onTranscript: (text: string) => void;
  onError?: (msg: string) => void;
}

export function useVoiceInput({ onTranscript, onError }: UseVoiceInputOptions) {
  const [state, setState] = useState<VoiceState>("idle");
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  const start = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : "audio/webm";
      const recorder = new MediaRecorder(stream, { mimeType });
      recorderRef.current = recorder;
      chunksRef.current = [];

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };

      recorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(chunksRef.current, { type: mimeType });
        if (blob.size < 100) {
          setState("idle");
          return;
        }
        setState("processing");
        try {
          const res = await fetch("/voice-api/stt/stream", {
            method: "POST",
            body: blob,
            headers: { "Content-Type": mimeType },
          });
          if (!res.ok) throw new Error(`STT ${res.status}`);
          const reader = res.body!.getReader();
          const decoder = new TextDecoder();
          let buf = "";
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            const lines = buf.split("\n");
            buf = lines.pop() ?? "";
            for (const line of lines) {
              if (!line.startsWith("data:")) continue;
              const data = JSON.parse(line.slice(5).trim());
              if (data.error) throw new Error(data.error);
              if (data.is_final && data.text) onTranscript(data.text.trim());
            }
          }
          setState("idle");
        } catch (err) {
          setState("error");
          onError?.((err as Error).message);
          setTimeout(() => setState("idle"), 3000);
        }
      };

      recorder.start();
      setState("recording");
    } catch (err) {
      setState("error");
      onError?.((err as Error).message);
      setTimeout(() => setState("idle"), 3000);
    }
  }, [onTranscript, onError]);

  const stop = useCallback(() => {
    recorderRef.current?.stop();
    recorderRef.current = null;
  }, []);

  const toggle = useCallback(() => {
    if (state === "recording") stop();
    else if (state === "idle") start();
  }, [state, start, stop]);

  return { state, toggle };
}
