import { describe, expect, it } from 'vitest'
import { statedReason } from './statedReason'

describe('statedReason', () => {
  it('reads the {"error"} shape every Nova service actually refuses with', () => {
    // core and gateway both hand StarletteHTTPException to a handler that
    // answers {"error": detail}. Reading only `detail` here printed raw JSON
    // at the user instead of the sentence the backend wrote for them.
    expect(statedReason('{"error":"registration is closed"}', 403)).toBe('registration is closed')
  })

  it('still reads FastAPI’s own {"detail"} shape', () => {
    // Request-validation failures bypass the handler above and keep it.
    expect(statedReason('{"detail":"no identity"}', 401)).toBe('no identity')
  })

  it('joins a 422 field-error list instead of printing [object Object]', () => {
    const body = JSON.stringify({
      detail: [
        { loc: ['body', 'name'], msg: 'field required' },
        { loc: ['body', 'password'], msg: 'too short' },
      ],
    })
    expect(statedReason(body, 422)).toBe('name: field required; password: too short')
  })

  it('prefers error over detail when a body somehow carries both', () => {
    expect(statedReason('{"error":"stated","detail":"other"}', 400)).toBe('stated')
  })

  it('quotes a non-JSON body rather than losing it', () => {
    expect(statedReason('<html>502 Bad Gateway</html>', 502)).toContain('502 Bad Gateway')
  })

  it('falls back to the status when there is no body at all', () => {
    expect(statedReason('', 500)).toBe('request failed with status 500')
    expect(statedReason('   ', 500)).toBe('request failed with status 500')
  })

  it('never returns an empty string for an empty stated reason', () => {
    expect(statedReason('{"error":""}', 400)).toBe('{"error":""}')
    expect(statedReason('{"detail":[]}', 422)).toBe('{"detail":[]}')
  })
})
