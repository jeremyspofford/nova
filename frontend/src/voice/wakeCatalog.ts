/** Wake-phrase catalog — key → human label + on-device model file. Kept free
 *  of the onnxruntime import (unlike wake.ts) so the UI and settings can name
 *  the available phrases without pulling the ~1 MB ORT runtime into the main
 *  bundle. Add an entry here when a new model lands in public/wake/ (see the
 *  custom-wake-word roadmap in docs/plans/voice.md).
 *
 *  A wake phrase is a trained model, so this list is fixed and INDEPENDENT of
 *  the assistant's display name — renaming the assistant does not change it. */
export const WAKE_CATALOG: Record<string, { label: string; file: string }> = {
  hey_jarvis: { label: 'Hey Jarvis', file: 'hey_jarvis_v0.1.onnx' },
};

export const DEFAULT_WAKE = 'hey_jarvis';

export function wakeLabel(key: string): string {
  return WAKE_CATALOG[key]?.label ?? WAKE_CATALOG[DEFAULT_WAKE].label;
}
