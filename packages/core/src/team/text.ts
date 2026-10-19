// Display names are one line (decision 5): newlines and other control characters would let a
// person pose as a label, another person or an instruction where their name is shown or quoted.

/** The text with every run of control characters replaced by one space, trimmed. */
export function oneLine(text: string): string {
  let out = '';
  let gap = false;
  for (const ch of text) {
    const c = ch.codePointAt(0) ?? 0;
    if (c < 0x20 || (c >= 0x7f && c <= 0x9f) || c === 0x2028 || c === 0x2029) {
      gap = true;
      continue;
    }
    if (gap && out) out += ' ';
    gap = false;
    out += ch;
  }
  return out.trim();
}
