// ui-blocks/context.ts — what a chat bubble hands its blocks (S54a T8).
// Only the chat bubble provides it, so blocks that act (choices) are inert anywhere else.
import { createContext } from 'react'

export type UiBlocksCtx = {
  /** The existing chat send path: the text goes out as his own message. */
  onSend: (text: string) => void
  /** A later user message exists: the block is frozen. */
  answered: boolean
  /** Her reply is still streaming. */
  streaming: boolean
}

export const UiBlocksContext = createContext<UiBlocksCtx | null>(null)
