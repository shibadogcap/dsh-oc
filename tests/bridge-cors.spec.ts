import { describe, expect, it } from 'vitest'
import { isAllowedCorsOrigin, corsHeaders } from '../src/bridge/http.js'

// The official opencode server answers a browser's cross-origin request with
// the request's own origin and allows credentials. Answering `*` instead
// breaks every credentialed request, which is what a web UI sends.
describe('bridge: the CORS policy of the official opencode server', () => {
  it('allows the loopback origins', () => {
    expect(isAllowedCorsOrigin('http://localhost:3000')).toBe(true)
    expect(isAllowedCorsOrigin('http://127.0.0.1:39100')).toBe(true)
    expect(isAllowedCorsOrigin('oc://renderer')).toBe(true)
    expect(isAllowedCorsOrigin('tauri://localhost')).toBe(true)
    expect(isAllowedCorsOrigin('https://tauri.localhost')).toBe(true)
    expect(isAllowedCorsOrigin('https://opencode.ai')).toBe(true)
    expect(isAllowedCorsOrigin('https://app.opencode.ai')).toBe(true)
  })

  it('rejects an origin outside the list', () => {
    expect(isAllowedCorsOrigin('https://example.com')).toBe(false)
    expect(isAllowedCorsOrigin('http://192.168.8.10:3000')).toBe(false)
  })

  it('allows the origins named in the extra list', () => {
    expect(isAllowedCorsOrigin('http://192.168.8.10:3000', ['http://192.168.8.10:3000'])).toBe(true)
    expect(isAllowedCorsOrigin('http://192.168.8.11:3000', ['http://192.168.8.10:3000'])).toBe(false)
  })

  it('treats a request without an origin as same-origin', () => {
    expect(isAllowedCorsOrigin(undefined)).toBe(true)
    expect(corsHeaders(undefined)).toMatchObject({ 'Access-Control-Allow-Origin': '*' })
  })

  it('echoes the origin and allows credentials', () => {
    const headers = corsHeaders('http://127.0.0.1:39100')
    expect(headers['Access-Control-Allow-Origin']).toBe('http://127.0.0.1:39100')
    expect(headers['Access-Control-Allow-Credentials']).toBe('true')
    expect(headers['Access-Control-Allow-Headers']).toContain('Content-Type')
    expect(headers['Access-Control-Allow-Methods']).toContain('PATCH')
  })

  it('sends no CORS header for a rejected origin', () => {
    expect(corsHeaders('https://example.com')).toEqual({})
  })
})
