import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { QrCode } from './QrCode'

describe('QrCode', () => {
  it('draws the code dark on white and prints the link it encodes', () => {
    render(<QrCode link="https://nova.fake-tailnet.ts.net/install" />)
    const img = screen.getByRole('img')
    expect(img.getAttribute('aria-label')).toBe('QR code for https://nova.fake-tailnet.ts.net/install')
    expect(img.querySelector('rect')?.getAttribute('fill')).toBe('#ffffff')
    expect(img.querySelector('path')?.getAttribute('fill')).toBe('#000000')
    expect(screen.getByText('https://nova.fake-tailnet.ts.net/install')).toBeTruthy()
  })

  it('refuses loopback with the reason and draws nothing to scan', () => {
    render(<QrCode link="http://127.0.0.1:3000/install" />)
    expect(screen.getByRole('alert').textContent).toContain('only an https address')
    expect(screen.queryByRole('img')).toBeNull()
  })
})
