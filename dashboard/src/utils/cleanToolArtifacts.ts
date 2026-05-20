/**
 * Strip raw tool call/response blocks that the LLM may emit as inline text
 * when tools are passed directly to the streaming call (skip_tool_preresolution).
 * Handles complete blocks, partial/truncated tags, and orphaned JSON fragments.
 */
export function cleanToolArtifacts(text: string): string {
  let cleaned = text

  // 1. Remove complete paired blocks (with or without underscore):
  //    <tool_call>...</tool_call>, <toolcall>...</toolcall>, <tool_response>...</tool_response>, etc.
  cleaned = cleaned.replace(/<tool_?call>[\s\S]*?<\/tool_?call>/g, '')
  cleaned = cleaned.replace(/<tool_?response>[\s\S]*?<\/tool_?response>/g, '')

  // 2. Remove partial/truncated tool blocks: anything from a tool-like marker to a closing tag
  cleaned = cleaned.replace(/_?call>[\s\S]*?<\/tool[_\s>]/g, '')
  cleaned = cleaned.replace(/_?response>[\s\S]*?<\/tool[_\s>]/g, '')

  // 3. Remove orphaned opening/closing tags and fragments (with or without underscore)
  cleaned = cleaned.replace(/<\/?tool_?(?:call|response)?>/g, '')
  cleaned = cleaned.replace(/<\/tool\b[^>]*>/g, '')
  cleaned = cleaned.replace(/\b_?(?:call|response)>/g, '')

  // 4. Remove bare JSON tool invocations: {"name": "...", "parameters": {...}}
  cleaned = cleaned.replace(/\{"name":\s*"[^"]+",\s*"parameters":\s*\{[^}]*\}\s*\}/g, '')
  // Also handle broken ones missing the opening brace: "tool_name", "parameters": {...}}
  cleaned = cleaned.replace(/"[a-z_]+",\s*"parameters":\s*\{[^}]*\}\s*\}/g, '')

  // 5. Remove JSON array/object responses from tools
  cleaned = cleaned.replace(/\[\s*\{[^[\]]*?"type"\s*:\s*"(?:file|directory)"[^[\]]*?\}\s*\]/g, '')
  cleaned = cleaned.replace(/\{\s*"task_id"\s*:[\s\S]*?\}\s*/g, '')

  // 6. Collapse excessive whitespace left behind
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n')
  cleaned = cleaned.replace(/[ \t]+\n/g, '\n')

  return cleaned.trim()
}

