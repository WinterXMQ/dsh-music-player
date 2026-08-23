/**
 * Regression tests for parseJsonPreserveBigInt (imports the REAL lib/qq.js — no mock).
 *
 * QQ Music's WeChat login response carries a `musicid`/uin around 1e18, which is far
 * beyond JavaScript's safe integer range (2^53 ≈ 9e15). JSON.parse silently mangles
 * such integers, so the stored uin became wrong and 我的歌单 queried another account's
 * playlists. The bigint-preserving parser must keep those digits exact as a string.
 */
import { describe, it, expect } from 'vitest'
import { parseJsonPreserveBigInt, decodeEntities } from '../lib/qq.js'

describe('decodeEntities', () => {
  it('decodes numeric character references (math letters + emoji) from QQ titles', () => {
    const raw = '&#120380;&#120423;&#120420;&#120426;&#120419;&#120409;&#160;&#120425;&#120413;&#120410;'
    const out = decodeEntities(raw)
    expect(out).toBe('𝘼𝙧𝙤𝙪𝙣𝙙\u00a0𝙩𝙝𝙚')
    expect(out).not.toContain('&#')
  })

  it('decodes emoji codepoints, named entities, <br> and strips tags', () => {
    const raw = 'A&#128171; &amp; B &lt;tag&gt; line1<br>line2 <b>bold</b>'
    const out = decodeEntities(raw)
    expect(out).toContain('💫')
    expect(out).toContain('&')
    expect(out).toContain('line1\nline2')
    expect(out).toContain('bold')
    expect(out).not.toContain('<br')
    expect(out).not.toContain('<b>')
    expect(out).not.toContain('&#')
  })

  it('returns non-strings / empty unchanged', () => {
    expect(decodeEntities('')).toBe('')
    expect(decodeEntities(undefined)).toBe(undefined)
    expect(decodeEntities('plain 中文')).toBe('plain 中文')
  })
})

describe('parseJsonPreserveBigInt', () => {
  it('keeps a QQ-music uin bigger than 2^53 exact as a string', () => {
    const raw = '{"code":0,"req":{"data":{"musicid":1152921505077309428,"nickname":"t","n":42}}}'
    const p = parseJsonPreserveBigInt(raw)
    expect(p.req.data.musicid).toBe('1152921505077309428')
    expect(p.req.data.nickname).toBe('t')
    expect(p.req.data.n).toBe(42) // safe integers stay numbers
    // JSON.parse would have corrupted the big id (precision loss):
    expect(String(JSON.parse(raw).req.data.musicid)).not.toBe('1152921505077309428')
  })

  it('preserves big ids inside arrays and nested objects too', () => {
    const raw = '{"a":[1,1152921505077309999],"b":{"big":90071992547409931234},"small":7}'
    const p = parseJsonPreserveBigInt(raw)
    expect(p.a[1]).toBe('1152921505077309999')
    expect(p.b.big).toBe('90071992547409931234')
    expect(p.small).toBe(7)
  })

  it('handles strings, escapes and nulls correctly', () => {
    const raw = '{"s":"a\\n\\"b","n":null,"t":true,"f":false}'
    const p = parseJsonPreserveBigInt(raw)
    expect(p.s).toBe('a\n"b')
    expect(p.n).toBe(null)
    expect(p.t).toBe(true)
    expect(p.f).toBe(false)
  })
})
