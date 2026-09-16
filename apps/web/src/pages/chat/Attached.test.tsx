import { describe, it, expect } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import { Attached, sizeWords } from './Attached'
import { attachmentFixture } from './attachmentFixture'

describe('Attached — what he sent, on the message that carried it (S28)', () => {
  it('SHOWS an image rather than naming it', () => {
    // A screenshot he sent and cannot see in the transcript leaves him
    // reading "what does this say?" with no way to know what "this" was.
    render(<Attached files={[attachmentFixture({ id: 'a7', filename: 'shot.png' })]} />)

    const img = screen.getByTestId('attached-image') as HTMLImageElement
    expect(img.getAttribute('src')).toBe('/api/v1/attachments/a7/content')
    // The alt is the name he gave it — the whole of what a screen reader has
    // to go on, and better than "image".
    expect(img.getAttribute('alt')).toBe('shot.png')
  })

  it('names everything else, with its size', () => {
    render(
      <Attached
        files={[
          attachmentFixture({
            id: 'a8',
            filename: 'statement.pdf',
            media_type: 'application/pdf',
            kind: 'application',
            size_bytes: 2_200_000,
          }),
        ]}
      />,
    )

    const chip = screen.getByTestId('attached-file')
    expect(chip.textContent).toContain('statement.pdf')
    // The size tells him whether the thing he sent is the thing he meant.
    expect(chip.textContent).toContain('2.1 MB')
    expect(chip.getAttribute('href')).toBe('/api/v1/attachments/a8/content')
  })

  it('draws nothing at all when nothing was attached', () => {
    // Every message row carries the key, and most carry an empty list. An
    // empty container under every message is furniture.
    const { container } = render(<Attached files={[]} />)

    expect(container.firstChild).toBeNull()
  })

  it('puts images first, then the rest', () => {
    render(
      <Attached
        files={[
          attachmentFixture({ id: 'f1', filename: 'notes.txt', kind: 'text' }),
          attachmentFixture({ id: 'f2', filename: 'shot.png', kind: 'image' }),
        ]}
      />,
    )

    const group = screen.getByTestId('message-attachments')
    const order = [...group.querySelectorAll('[data-testid]')].map(n => n.getAttribute('data-testid'))
    expect(order.indexOf('attached-image')).toBeLessThan(order.indexOf('attached-file'))
  })
})

describe('sizeWords', () => {
  it('reads the way a person says it', () => {
    expect(sizeWords(512)).toBe('512 bytes')
    expect(sizeWords(2048)).toBe('2.0 KB')
    expect(sizeWords(2_200_000)).toBe('2.1 MB')
  })
})
