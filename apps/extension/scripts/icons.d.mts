// Types of icons.mjs (the build runs it as plain JavaScript).
export const ICON_SIZES: number[];
export function drawIcon(size: number): Uint8Array;
export function encodePng(width: number, height: number, rgba: Uint8Array): Uint8Array;
export function writeIcons(dir: string): void;
