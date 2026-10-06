import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
// @ts-expect-error -- plain JS config, no declaration file; only .theme.extend.colors is read
import config from '../../tailwind.config.js'
import { findUndefinedColorTokens } from './colorTokens'

const colors = (config as { theme: { extend: { colors: object } } }).theme.extend.colors

describe('findUndefinedColorTokens', () => {
  it('is a pure fn: no fs and no tailwind.config import in the module', () => {
    const src = readFileSync('src/lib/colorTokens.ts', 'utf8')
    expect(src).not.toMatch(/from ['"](node:)?fs['"]/)
    expect(src).not.toMatch(/tailwind\.config/)
    expect(findUndefinedColorTokens('<div className="p-2" />', colors)).toEqual([])
  })

  it('reports border-line, bg-surface-raised and variant-prefixed hover:border-border-strong', () => {
    const source = `
      <div className="rounded border border-line p-2" />
      <span className="bg-surface-raised text-sm" />
      <button className="hover:border-border-strong" />
    `
    const found = findUndefinedColorTokens(source, colors)
    expect(found).toEqual(expect.arrayContaining(['border-line', 'bg-surface-raised']))
    expect(found.some((t) => t.includes('border-border-strong'))).toBe(true)
    expect(found).toHaveLength(3)
  })

  it('reports a variant-prefixed token as written, variants and all', () => {
    const source = `
      <button className="p-1 hover:border-border-strong" />
      <div className="md:dark:bg-line/50 group-hover:text-content-primary" />
    `
    expect([...findUndefinedColorTokens(source, colors)].sort()).toEqual([
      'hover:border-border-strong',
      'md:dark:bg-line',
    ])
  })

  it('does not report defined tokens, DEFAULT keys, numeric scales or keywords', () => {
    const source = `
      <div className="border-border border-border-subtle bg-surface-card/90 text-content-primary" />
      <div className="bg-surface text-accent bg-accent-500/30 hover:bg-surface-card-hover text-on-accent" />
      <div className="text-white bg-black border-transparent text-current fill-inherit md:dark:bg-white/10" />
      <div className="border-line" />
    `
    expect(findUndefinedColorTokens(source, colors)).toEqual(['border-line'])
  })

  it('does not report non-colour utilities or arbitrary values', () => {
    const source = `
      <div className="text-sm text-center border-2 border-t border-x-0 bg-cover ring-offset-2 ring-2 outline-none divide-y" />
      <div className="bg-[#fff] pt-[calc(var(--nova-safe-top,0px)+3rem)] text-[13px]" />
      <div className="bg-surface-raised" />
    `
    expect(findUndefinedColorTokens(source, colors)).toEqual(['bg-surface-raised'])
  })

  it('reports each undefined token once', () => {
    const source = `
      <div className="border-line" /><div className="border-line p-1" />
      <div className="bg-surface-raised" /><div className="bg-surface-raised" />
    `
    const found = findUndefinedColorTokens(source, colors)
    expect([...found].sort()).toEqual(['bg-surface-raised', 'border-line'])
  })
})
