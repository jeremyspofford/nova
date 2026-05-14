import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { getVoiceProviders } from "../../api";

const VOICE_OPTIONS = ["alloy", "echo", "fable", "nova", "onyx", "shimmer"] as const;
const STORAGE_KEY = 'nova_voice_mode_default'

const getStorage = (key: string): string | null => {
  try { return localStorage.getItem(key) } catch { return null }
}
const setStorage = (key: string, value: string): void => {
  try { localStorage.setItem(key, value) } catch { /* ignore */ }
}

export function VoiceSection() {
  const [defaultVoiceMode, setDefaultVoiceMode] = useState(
    () => getStorage(STORAGE_KEY) === 'true'
  )

  function toggleDefault(checked: boolean) {
    setDefaultVoiceMode(checked)
    setStorage(STORAGE_KEY, String(checked))
  }

  const { data: providers = [], isLoading, error } = useQuery({
    queryKey: ["voice-providers"],
    queryFn: getVoiceProviders,
    staleTime: 30_000,
    retry: 1,
  });

  const stt = providers.find((p) => p.type === "stt");
  const tts = providers.find((p) => p.type === "tts");
  const available = stt?.status === "available" || tts?.status === "available";

  return (
    <div className="space-y-6">
      {/* Default voice mode toggle */}
      <div className="flex items-center justify-between rounded-lg border border-stone-700 bg-stone-900/50 px-4 py-3">
        <div>
          <p className="text-sm font-medium text-stone-200">Default to voice mode</p>
          <p className="text-xs text-stone-500 mt-0.5">
            Activate voice conversation automatically when opening chat
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={defaultVoiceMode}
          onClick={() => toggleDefault(!defaultVoiceMode)}
          onKeyDown={(e) => {
            if (e.key === ' ') {
              e.preventDefault()
              toggleDefault(!defaultVoiceMode)
            }
          }}
          className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-400 ${
            defaultVoiceMode ? 'bg-teal-600' : 'bg-stone-700'
          }`}
        >
          <span
            className={`inline-block h-4 w-4 rounded-full bg-white shadow-sm transition-transform ${
              defaultVoiceMode ? 'translate-x-4' : 'translate-x-0'
            }`}
          />
        </button>
      </div>

      <div>
        <h2 className="text-sm font-medium text-stone-300 mb-3">Provider Status</h2>
        {isLoading && <p className="text-sm text-stone-400">Loading...</p>}
        {error && (
          <p className="text-sm text-amber-400">
            Could not reach voice gateway. Check that the voice profile is enabled.
          </p>
        )}
        {!isLoading && !error && (
          <div className="space-y-2">
            {providers.map((p) => (
              <div
                key={p.name}
                className="flex items-center justify-between rounded-lg border border-stone-700 bg-stone-900/50 px-4 py-3"
              >
                <div>
                  <span className="text-sm font-medium text-stone-100">{p.name}</span>
                  <span className="ml-2 text-xs text-stone-500 uppercase">{p.type}</span>
                </div>
                <span
                  className={`text-xs font-medium px-2 py-0.5 rounded-full ${
                    p.status === "available"
                      ? "bg-teal-900/50 text-teal-400"
                      : "bg-stone-800 text-stone-500"
                  }`}
                >
                  {p.status}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {!available && !isLoading && (
        <div className="rounded-lg bg-amber-900/20 border border-amber-800/40 px-4 py-3">
          <p className="text-sm text-amber-300">
            Voice requires an OpenAI API key. Add one in the{" "}
            <a href="/settings?tab=secrets" className="underline hover:text-amber-200">
              Secrets
            </a>{" "}
            tab under the name <span className="font-mono text-xs">openai_api_key</span>.
          </p>
        </div>
      )}

      <div>
        <h2 className="text-sm font-medium text-stone-300 mb-2">Available TTS Voices</h2>
        <div className="flex flex-wrap gap-2">
          {VOICE_OPTIONS.map((v) => (
            <span
              key={v}
              className="px-2.5 py-1 rounded-full bg-stone-800 text-stone-300 text-xs font-mono"
            >
              {v}
            </span>
          ))}
        </div>
        <p className="mt-2 text-xs text-stone-500">
          Default voice is <span className="font-mono">nova</span>. Set{" "}
          <span className="font-mono">TTS_DEFAULT_VOICE</span> in your <span className="font-mono">.env</span> to change it.
        </p>
      </div>
    </div>
  );
}
