import { describe, it, expect } from 'vitest'
import {
  PRESET_CATEGORIES, LIMITS, cnOrdinal, formatDateCn, sanitizeEditionInput,
  renderScript, splitScriptChunks, buildEdition, applyRetention, findInCooldown,
  summarizeEdition, metaForEdition, estimateMinutes, sanitizeSchedulePrefs,
  sanitizeModelSelection, runStateAlive,
} from '../lib/news-core.js'

const VALID_BODY = {
  title: '早间新闻播报',
  date: '2026-05-30',
  categories: [
    {
      name: '热点',
      items: [
        { title: '某重大政策发布', summary: '今早国新办举行发布会，介绍相关政策要点。', source: '新华社', url: 'https://example.com/1', publishedAt: '08:02' },
        { title: '多地迎来强降雨', summary: '中央气象台继续发布暴雨预警，多地启动应急响应。', source: '央视新闻' },
      ],
    },
    {
      name: 'AI',
      items: [
        { title: '新一代模型发布', summary: '多家厂商密集发布新一代模型，推理成本显著下降。', source: '机器之心' },
      ],
    },
  ],
}

describe('cnOrdinal', () => {
  it('生成中文序数条目词', () => {
    expect(cnOrdinal(1)).toBe('第一条')
    expect(cnOrdinal(2)).toBe('第二条')
    expect(cnOrdinal(10)).toBe('第十条')
    expect(cnOrdinal(11)).toBe('第十一条')
    expect(cnOrdinal(20)).toBe('第二十条')
    expect(cnOrdinal(21)).toBe('第二十一条')
  })
})

describe('formatDateCn', () => {
  it('ISO 日期转中文', () => {
    expect(formatDateCn('2026-05-30')).toBe('2026年5月30日')
    expect(formatDateCn('garbage')).toBe('garbage')
  })
})

describe('sanitizeEditionInput', () => {
  it('接受有效输入并补默认值', () => {
    const r = sanitizeEditionInput({ categories: VALID_BODY.categories }, { today: '2026-05-30' })
    expect(r.ok).toBe(true)
    expect(r.value.title).toBe('今日新闻播报')
    expect(r.value.date).toBe('2026-05-30')
    expect(r.value.autoplay).toBe(true)
    expect(r.value.originShiftId).toBe('manual')
    expect(r.value.itemCount).toBe(3)
  })
  it('拒绝无有效条目的输入', () => {
    expect(sanitizeEditionInput({}).ok).toBe(false)
    expect(sanitizeEditionInput({ categories: [{ name: 'x' }] }).ok).toBe(false)
    expect(sanitizeEditionInput(null).ok).toBe(false)
  })
  it('超限条目被截断（每类/全期）', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ title: 't' + i, summary: 's' + i }))
    const r = sanitizeEditionInput({ categories: [{ name: '热点', items: many }] })
    expect(r.ok).toBe(true)
    expect(r.value.categories[0].items.length).toBe(LIMITS.itemsPerCategory)
  })
  it('超长 summary 截断且保留省略号', () => {
    const r = sanitizeEditionInput({
      categories: [{ name: '热点', items: [{ title: 't', summary: '长'.repeat(300) }] }],
    })
    expect(r.value.categories[0].items[0].summary.length).toBe(LIMITS.summaryChars)
    expect(r.value.categories[0].items[0].summary.endsWith('…')).toBe(true)
  })
})

describe('renderScript + splitScriptChunks', () => {
  const input = sanitizeEditionInput(VALID_BODY).value
  const { text, itemOffsets, categoryOffsets } = renderScript(input)

  it('开场含标题与日期（不再重复罗列类别）', () => {
    expect(text.startsWith('您好，这里是早间新闻播报，2026年5月30日。')).toBe(true)
    expect(text).not.toContain('今天的主要内容有')
  })
  it('条目句含序数、标题、摘要；不含来源尾缀', () => {
    expect(text).toContain('第一条，某重大政策发布。今早国新办举行发布会')
    expect(text).not.toContain('以上消息来自')
    expect(text).toContain('首先来听热点。')
    expect(text).toContain('接下来听AI。')
  })
  it('摘要自带句号时不会出现重复句号', () => {
    // VALID_BODY 的 summary 不带句号；构造一个带句号的验证不出现「。。」
    const r = sanitizeEditionInput({
      categories: [{ name: '热点', items: [{ title: 't', summary: '事件要点。事件影响。' }] }],
    }).value
    const { text: t2 } = renderScript(r)
    expect(t2).toContain('第一条，t。事件要点。事件影响。')
    expect(t2).not.toContain('。。')
  })
  it('条目与类别偏移指向正确文本起点', () => {
    expect(text.slice(itemOffsets[0], itemOffsets[0] + 4)).toBe('第一条，')
    expect(text.slice(categoryOffsets[1], categoryOffsets[1] + 6)).toBe('接下来听AI')
  })
  it('分块均不超上限、拼接等于原文', () => {
    const chunks = splitScriptChunks(text)
    expect(chunks.join('')).toBe(text)
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(200)
  })
  it('空文本得到一个空块', () => {
    expect(splitScriptChunks('')).toEqual([''])
  })
  it('超长单句被硬切', () => {
    const chunks = splitScriptChunks('长'.repeat(450) + '。')
    expect(chunks.join('').length).toBe(451)
    expect(chunks.every((c) => c.length <= 200)).toBe(true)
  })
})

describe('buildEdition', () => {
  const input = sanitizeEditionInput(VALID_BODY).value
  const e = buildEdition(input, { id: 'n1', createdAt: 1000 })

  it('期次字段完整且 itemChunk 有效', () => {
    expect(e.id).toBe('n1')
    expect(e.originShiftId).toBe('manual')
    expect(e.totalChars).toBe(e.chunks.join('').length)
    expect(e.charOffsets[0]).toBe(0)
    expect(e.charOffsets.length).toBe(e.chunks.length + 1)
    expect(e.itemChunk.length).toBe(3)
    for (const c of e.itemChunk) expect(c).toBeGreaterThanOrEqual(0)
    expect(e.categoryChunk.length).toBe(2)
    expect(e.categoryChunk[1]).toBeGreaterThanOrEqual(e.categoryChunk[0])
  })
  it('metaForEdition 暴露目录结构与偏移', () => {
    const meta = metaForEdition(e)
    expect(meta.total).toBe(e.chunks.length)
    expect(meta.sections[0].heading).toBe('热点')
    expect(meta.sections[0].itemCount).toBe(2)
    expect(meta.itemChunk).toEqual(e.itemChunk)
  })
  it('estimateMinutes 至少 1 分钟且随字数增长', () => {
    expect(estimateMinutes(10)).toBe(1)
    expect(estimateMinutes(1500)).toBeGreaterThan(estimateMinutes(300))
  })
})

describe('applyRetention（每任务独立 7 期）', () => {
  const mk = (id, shift, createdAt) => ({ id, originShiftId: shift, createdAt, categories: [] })
  it('高频班次不挤占低频班次的窗口', () => {
    const editions = []
    // s-ai：9 期；s-morning：3 期（时间交错）
    for (let i = 0; i < 9; i++) editions.push(mk('ai' + i, 's-ai', 1000 + i * 10))
    for (let i = 0; i < 3; i++) editions.push(mk('mo' + i, 's-morning', 1005 + i * 10))
    const kept = applyRetention(editions)
    const ai = kept.filter((e) => e.originShiftId === 's-ai')
    const mo = kept.filter((e) => e.originShiftId === 's-morning')
    expect(ai.length).toBe(LIMITS.retentionPerShift)
    expect(mo.length).toBe(3) // 低频班次的 3 期全部保留，未被挤掉
    expect(ai.map((e) => e.id)).toEqual(['ai2', 'ai3', 'ai4', 'ai5', 'ai6', 'ai7', 'ai8'])
  })
  it('手动组独立计数', () => {
    const editions = Array.from({ length: 8 }, (_, i) => mk('m' + i, 'manual', i))
    editions.push(mk('x1', 's-x', 100))
    const kept = applyRetention(editions)
    expect(kept.filter((e) => e.originShiftId === 'manual').length).toBe(LIMITS.retentionPerShift)
    expect(kept.some((e) => e.id === 'x1')).toBe(true)
  })
})

describe('findInCooldown（冷却窗）', () => {
  const e = { id: 'n1', originShiftId: 's1', createdAt: 1000, categories: [] }
  it('窗口内命中返回该期次', () => {
    expect(findInCooldown([e], { originShiftId: 's1', now: 1000 + LIMITS.cooldownMs - 1 })).toBe(e)
  })
  it('窗口外返回 null', () => {
    expect(findInCooldown([e], { originShiftId: 's1', now: 1000 + LIMITS.cooldownMs })).toBe(null)
  })
  it('不同班次不受影响', () => {
    expect(findInCooldown([e], { originShiftId: 's2', now: 1001 })).toBe(null)
  })
  it('取的是该班次最新一期判断', () => {
    const older = { id: 'n0', originShiftId: 's1', createdAt: 100, categories: [] }
    expect(findInCooldown([older, e], { originShiftId: 's1', now: 1200 })).toBe(e)
  })
})

describe('summarizeEdition', () => {
  it('列表行含类别计数与播放状态', () => {
    const input = sanitizeEditionInput(VALID_BODY).value
    const e = { ...buildEdition(input, { id: 'n1', createdAt: 5 }), played: false }
    const s = summarizeEdition(e)
    expect(s.categories[0]).toEqual({ name: '热点', count: 2 })
    expect(s.totalItems).toBe(3)
    expect(s.played).toBe(false)
  })
})

describe('sanitizeSchedulePrefs', () => {
  it('默认值与班次规整', () => {
    const p = sanitizeSchedulePrefs({})
    expect(p.enabled).toBe(true)
    expect(p.shifts).toEqual([])
    expect(p.prefVersion).toBe(0)
    expect(p.syncedVersion).toBe(-1)
  })
  it('默认类别白名单过滤', () => {
    const p = sanitizeSchedulePrefs({
      defaultScope: { categories: ['热点', '不存在', '国内'], topics: ['AI', ''] },
    })
    expect(p.defaultScope.categories).toEqual(['热点', '国内'])
    expect(p.defaultScope.topics).toEqual(['AI'])
  })
  it('班次时间非法被丢弃、超限截断、scope=null 表示继承默认', () => {
    const p = sanitizeSchedulePrefs({
      shifts: [
        { id: 'a', time: '08:00', autoplay: false, scope: null },
        { id: 'b', time: '25:00' },
        { id: 'c', time: '12:30', autoplay: true, scope: { topics: Array.from({ length: 9 }, (_, i) => 't' + i) } },
      ],
    })
    expect(p.shifts.length).toBe(2)
    expect(p.shifts[0].autoplay).toBe(false)
    expect(p.shifts[0].scope).toBe(null)
    expect(p.shifts[1].scope.topics.length).toBe(LIMITS.topicsPerShift)
  })
  it('班次数上限 6', () => {
    const shifts = Array.from({ length: 9 }, (_, i) => ({ time: `0${i}:00` }))
    expect(sanitizeSchedulePrefs({ shifts }).shifts.length).toBe(LIMITS.shifts)
  })
  it('保留上一版的版本号', () => {
    const prev = { prefVersion: 3, syncedVersion: 3 }
    expect(sanitizeSchedulePrefs({ shifts: [] }, prev).prefVersion).toBe(3)
    expect(sanitizeSchedulePrefs({ shifts: [] }, prev).syncedVersion).toBe(3)
  })
  it('model 字段规整（用户选的新闻会话模型）', () => {
    const p = sanitizeSchedulePrefs({ model: { provider: 'deepseek', model: 'deepseek-chat' } })
    expect(p.model).toEqual({ provider: 'deepseek', model: 'deepseek-chat' })
    // 非法/空 model → null（= 跟随当前活跃会话）
    expect(sanitizeSchedulePrefs({ model: { provider: '', model: 'x' } }).model).toBe(null)
    expect(sanitizeSchedulePrefs({ model: {} }).model).toBe(null)
    expect(sanitizeSchedulePrefs({ model: null }).model).toBe(null)
  })
  it('model 从上一版保留', () => {
    const prev = { model: { provider: 'deepseek', model: 'deepseek-chat' } }
    expect(sanitizeSchedulePrefs({ shifts: [] }, prev).model).toEqual({ provider: 'deepseek', model: 'deepseek-chat' })
  })
})

describe('sanitizeModelSelection', () => {
  it('有效选择原样保留', () => {
    expect(sanitizeModelSelection({ provider: ' deepseek ', model: ' deepseek-chat ' }))
      .toEqual({ provider: 'deepseek', model: 'deepseek-chat' })
  })
  it('provider 或 model 缺失 → null', () => {
    expect(sanitizeModelSelection({ provider: 'deepseek' })).toBe(null)
    expect(sanitizeModelSelection({ model: 'deepseek-chat' })).toBe(null)
    expect(sanitizeModelSelection({})).toBe(null)
    expect(sanitizeModelSelection(null)).toBe(null)
    expect(sanitizeModelSelection('x')).toBe(null)
  })
})

describe('runStateAlive（TTL 懒过期）', () => {
  it('未超时存活、超时失效、空值失效', () => {
    const run = { shiftId: 's1', startedAt: 1000 }
    expect(runStateAlive(run, 1000 + LIMITS.runStateTtlMs - 1)).toBe(true)
    expect(runStateAlive(run, 1000 + LIMITS.runStateTtlMs)).toBe(false)
    expect(runStateAlive(null, 1000)).toBe(false)
  })
})

describe('PRESET_CATEGORIES', () => {
  it('热点排第一', () => {
    expect(PRESET_CATEGORIES[0]).toBe('热点')
    expect(PRESET_CATEGORIES).toContain('国内')
  })
})
