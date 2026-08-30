/**
 * Unit tests for the What's New data/decision module (lib/whatsnew.js):
 * semver comparison, per-version entry lookup, popup state decision, and the
 * data-shape invariants that keep the shipped changelog well-formed.
 */
import { describe, it, expect } from 'vitest'
import {
  WHATS_NEW, WELCOME, WHATS_NEW_MAX, PREF_SEEN_VERSION,
  cmpSemver, whatsNewFor, whatsNewState,
} from '../lib/whatsnew.js'

describe('cmpSemver', () => {
  it('主/次/修订按数值逐段比较（不是字典序）', () => {
    expect(cmpSemver('0.7.2', '0.7.2')).toBe(0)
    expect(cmpSemver('0.9.0', '0.10.0')).toBe(-1)
    expect(cmpSemver('0.10.0', '0.9.0')).toBe(1)
    expect(cmpSemver('0.7.2', '0.7.10')).toBe(-1)
    expect(cmpSemver('1.0.0', '0.99.99')).toBe(1)
  })

  it('预发布版低于同版本号的正式版；预发布标识逐段比较', () => {
    expect(cmpSemver('0.8.0-beta.1', '0.8.0')).toBe(-1)
    expect(cmpSemver('0.8.0', '0.8.0-beta.1')).toBe(1)
    expect(cmpSemver('0.8.0-beta.1', '0.8.0-beta.2')).toBe(-1)
    expect(cmpSemver('0.8.0-beta.2', '0.8.0-beta.10')).toBe(-1) // 数值段
    expect(cmpSemver('0.8.0-beta.1', '0.8.0-alpha')).toBe(1) // 数字段 < 非数字段
    expect(cmpSemver('0.8.0-beta.1', '0.8.0-beta.1')).toBe(0)
    expect(cmpSemver('0.8.0-alpha', '0.8.0-alpha.1')).toBe(-1) // 段数少者更低
  })

  it('容忍 v 前缀；垃圾输入按 0.0.0 处理', () => {
    expect(cmpSemver('v1.2.3', '1.2.3')).toBe(0)
    expect(cmpSemver('', '0.0.1')).toBe(-1)
    expect(cmpSemver('oops', '0.0.1')).toBe(-1)
    expect(cmpSemver('oops', '')).toBe(0)
  })
})

describe('whatsNewFor', () => {
  it('命中当前版条目；未命中返回 null', () => {
    expect(whatsNewFor(WHATS_NEW[0].version).entry).toBe(WHATS_NEW[0])
    expect(whatsNewFor('9.9.9').entry).toBeNull()
    expect(whatsNewFor('').entry).toBeNull()
  })

  it('历史列表新→旧，截断到 WHATS_NEW_MAX，且包含当前版（若存在）', () => {
    const cur = WHATS_NEW[0].version
    const { history } = whatsNewFor(cur)
    expect(history.length).toBe(Math.min(WHATS_NEW.length, WHATS_NEW_MAX))
    expect(history[0].version).toBe(cur)
    for (let i = 1; i < history.length; i++) {
      expect(cmpSemver(history[i - 1].version, history[i].version)).toBeGreaterThanOrEqual(0)
    }
  })
})

describe('whatsNewState（弹窗判定）', () => {
  const cur = '0.8.0'

  it('无记录 + prefs 空 → fresh（真·首装）', () => {
    expect(whatsNewState(cur, '', {})).toBe('fresh')
    expect(whatsNewState(cur, '', null)).toBe('fresh')
  })

  it('无记录 + prefs 有其他键 → upgrade（老用户启发式）', () => {
    expect(whatsNewState(cur, '', { 'dsh-music-volume': '0.8' })).toBe('upgrade')
    // prefs 里只有已看标记自身（值为空不合规但键存在）不算「有其他键」
    expect(whatsNewState(cur, '', { [PREF_SEEN_VERSION]: '' })).toBe('fresh')
  })

  it('有更旧记录 → upgrade；同版 → seen；更新记录 → downgrade', () => {
    expect(whatsNewState(cur, '0.7.9', {})).toBe('upgrade')
    expect(whatsNewState(cur, '0.7.2', {})).toBe('upgrade')
    expect(whatsNewState(cur, '0.8.0', {})).toBe('seen')
    expect(whatsNewState(cur, '1.0.0', {})).toBe('downgrade')
    // seen 是预发布版、cur 是正式版：seen 更旧 → upgrade（不是 downgrade）
    expect(whatsNewState(cur, '0.8.0-beta.1', {})).toBe('upgrade')
    // seen 是正式版、cur 是更低的预发布版（回退到 beta）：seen 更新 → downgrade
    expect(whatsNewState('0.8.0-beta.1', '0.8.0', {})).toBe('downgrade')
  })
})

describe('数据完整性（发版约束）', () => {
  it('条目版本号合法且唯一，section 结构完备', () => {
    const seen = new Set()
    for (const e of WHATS_NEW) {
      expect(typeof e.version).toBe('string')
      expect(e.version).toMatch(/^[0-9A-Za-z.+\-]{1,32}$/)
      expect(seen.has(e.version)).toBe(false)
      seen.add(e.version)
      expect(Array.isArray(e.sections)).toBe(true)
      expect(e.sections.length).toBeGreaterThan(0)
      for (const s of e.sections) {
        expect(['feature', 'improve', 'fix']).toContain(s.type)
        expect(Array.isArray(s.items)).toBe(true)
        expect(s.items.length).toBeGreaterThan(0)
        for (const it of s.items) expect(typeof it).toBe('string')
      }
    }
    expect(WHATS_NEW.length).toBeLessThanOrEqual(WHATS_NEW_MAX)
  })

  it('首装欢迎内容可用', () => {
    expect(typeof WELCOME.title).toBe('string')
    expect(WELCOME.title.length).toBeGreaterThan(0)
    expect(WELCOME.sections.length).toBeGreaterThan(0)
  })

  it('已看标记键名与客户端/Host 三处约定一致', () => {
    expect(PREF_SEEN_VERSION).toBe('dsh-music-seen-version')
  })
})
