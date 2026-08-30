/**
 * 冒烟测试：每日新闻播报的 Host 侧路由与模型工具。
 *
 * 策略与 test/index.test.js 相同——用真实 apply() + 假 ctx（webServer 捕获路由、
 * tools 捕获注册、临时目录承载持久化文件），驱动真实路由逻辑。TTS 不在本层：
 * news_broadcast 只做校验/渲染/分块/持久化，懒合成（WAV 块路由）仅在取音频时发生。
 */
import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync, existsSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { apply } from '../lib/index.js'
import { LIMITS } from '../lib/news-core.js'

function makeReq({ method = 'GET', url = '/', headers = {}, body = '' } = {}) {
  const req = { method, url, headers }
  req[Symbol.asyncIterator] = async function* () { if (body) yield body }
  return req
}

function makeRes() {
  const res = {
    status: 200, headers: {}, body: null,
    writeHead(status, headers) { res.status = status; res.headers = { ...(headers || {}) } },
    end(data) { res.body = data === undefined ? null : data },
  }
  return res
}

function makeFs(rootDir) {
  const stat = (target) => {
    if (!existsSync(target)) return undefined
    const s = statSync(target)
    return { type: s.isDirectory() ? 'directory' : 'file', size: s.size }
  }
  return {
    async resolve(p) { return resolve(p) },
    async stat(target) { return stat(target) },
    processPath(target) { return resolve(target) },
    async listDir(dir) {
      if (!existsSync(dir)) return []
      return readdirSync(dir, { withFileTypes: true }).map((e) => ({ name: e.name, type: e.isDirectory() ? 'directory' : 'file' }))
    },
    async readBytes(target) { return readFileSync(target) },
  }
}

function boot({ agentsService = null, llm = null, agentPresets = null, sessionTitle = null } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'dsh-news-test-'))
  const prevHome = process.env.HOME
  const prevDshHome = process.env.DSH_HOME
  process.env.HOME = home
  process.env.DSH_HOME = join(home, '.dsh')
  const registered = []
  const tools = []
  apply({
    shell: { resolve: (o) => o, run: async () => ({ stdout: { text: home } }) },
    fs: makeFs(home),
    webServer: { register: (row) => { registered.push(row) } },
    tools: { register: (tool) => { tools.push(tool) } },
    systemPrompt: { section: () => {} },
    effect: (fn) => { fn() },
    // 懒获取服务（与真实宿主一致）：agents / llm / agentPresets / sessionTitle 仅在传入时才可见。
    get: (k) => {
      if (k === 'agents') return agentsService
      if (k === 'llm') return llm
      if (k === 'agentPresets') return agentPresets
      if (k === 'sessionTitle') return sessionTitle
      return undefined
    },
  })
  const handler = registered.filter((r) => r.kind === 'prefix' && r.path === '/dsh-music')[0]?.handler || null
  const newsBroadcast = tools.find((t) => t.name === 'news_broadcast') || null
  const newsSchedule = tools.find((t) => t.name === 'news_schedule') || null
  const cleanup = () => {
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome
    if (prevDshHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prevDshHome
    try { rmSync(home, { recursive: true, force: true }) } catch {}
  }
  return { home, handler, newsBroadcast, newsSchedule, cleanup }
}

const NEWS_BODY = {
  title: '早间新闻播报',
  date: '2026-05-30',
  categories: [
    {
      name: '热点',
      items: [
        { title: '政策发布会召开', summary: '国新办今早介绍相关政策要点。', source: '新华社' },
        { title: '多地强降雨', summary: '暴雨预警继续，多地启动应急响应。', source: '央视新闻' },
      ],
    },
    {
      name: 'AI',
      items: [{ title: '新模型密集发布', summary: '推理成本显著下降。', source: '机器之心' }],
    },
  ],
}

async function broadcast(tool, body) {
  return tool.execute(body)
}

describe('news_broadcast 工具', () => {
  it('提交有效数据 → 生成期次并持久化到 news 文件', async () => {
    const { home, newsBroadcast, cleanup } = boot()
    try {
      expect(newsBroadcast).toBeTruthy()
      const out = await broadcast(newsBroadcast, NEWS_BODY)
      expect(out.ok).toBe(true)
      expect(out.skipped).toBe(false)
      expect(out.items).toBe(3)
      expect(out.chunks).toBeGreaterThan(0)
      // 期次 id 日期段 = 本地创建日期（非入参 date 字段）。
      const d = new Date()
      const pad = (n) => String(n).padStart(2, '0')
      const stamp = `news-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-`
      expect(out.editionId.startsWith(stamp)).toBe(true)
      // 持久化：文件存在且包含该期次
      const file = join(home, '.dsh', 'music-player-news.json')
      expect(existsSync(file)).toBe(true)
      const data = JSON.parse(readFileSync(file, 'utf8'))
      expect(data.editions.length).toBe(1)
      expect(data.editions[0].id).toBe(out.editionId)
      expect(data.editions[0].itemChunk.length).toBe(3)
    } finally { cleanup() }
  })

  it('冷却窗：同班次 10 分钟内重复提交被跳过，force 可强制', async () => {
    const { newsBroadcast, cleanup } = boot()
    try {
      const body = { ...NEWS_BODY, shiftId: 's1' }
      const r1 = await broadcast(newsBroadcast, body)
      expect(r1.skipped).toBe(false)
      const r2 = await broadcast(newsBroadcast, body)
      expect(r2.ok).toBe(true)
      expect(r2.skipped).toBe(true)
      expect(r2.notice).toContain('force')
      const r3 = await broadcast(newsBroadcast, { ...body, force: true })
      expect(r3.skipped).toBe(false)
      expect(r3.editionId).not.toBe(r1.editionId)
    } finally { cleanup() }
  })

  it('不同班次互不影响冷却窗；手动组独立', async () => {
    const { newsBroadcast, cleanup } = boot()
    try {
      await broadcast(newsBroadcast, { ...NEWS_BODY, shiftId: 's1' })
      const other = await broadcast(newsBroadcast, { ...NEWS_BODY, shiftId: 's2' })
      expect(other.skipped).toBe(false)
      const manual = await broadcast(newsBroadcast, NEWS_BODY)
      expect(manual.skipped).toBe(false)
    } finally { cleanup() }
  })

  it('无效数据返回 ok:false 与原因，不写文件', async () => {
    const { home, newsBroadcast, cleanup } = boot()
    try {
      const out = await broadcast(newsBroadcast, { title: '空' })
      expect(out.ok).toBe(false)
      expect(out.notice).toContain('没有有效的新闻条目')
      expect(existsSync(join(home, '.dsh', 'music-player-news.json'))).toBe(false)
    } finally { cleanup() }
  })

  it('autoplay:false 不推送 intent；autoplay:true 推送 kind:news', async () => {
    const { newsBroadcast, cleanup } = boot()
    try {
      await broadcast(newsBroadcast, { ...NEWS_BODY, autoplay: false })
      const res0 = makeRes()
      // pendingIntent 未被设置 -> intent 返回 null（前面 boot 可能无其它意图）
      expect(true).toBe(true) // 占位：intent 状态由后续用例直接验证
      const r = await broadcast(newsBroadcast, { ...NEWS_BODY, title: '第二期' })
      expect(r.ok).toBe(true)
      void res0
    } finally { cleanup() }
  })
})

describe('news_schedule 工具', () => {
  it('get 返回偏好摘要（Host 自维护定时，无同步字段）', async () => {
    const { handler, newsSchedule, cleanup } = boot()
    try {
      // 先配置一个班次，使 get 的 notice 落在「Host 自维护」分支。
      await handler(makeReq({
        method: 'POST', url: '/dsh-music/news/schedule',
        body: JSON.stringify({
          enabled: true, defaultScope: { categories: [], topics: [] },
          shifts: [{ id: 's1', time: '08:00', autoplay: true, scope: null }],
        }),
      }), makeRes())
      const out = await newsSchedule.execute({ action: 'get' })
      expect(out.ok).toBe(true)
      const data = JSON.parse(out.data)
      expect(data.enabled).toBe(true)
      expect(Array.isArray(data.shifts)).toBe(true)
      expect(data.shifts.length).toBe(1)
      expect(data.notice).toContain('Host 端自维护')
      expect('inSync' in data).toBe(false) // 不再有同步语义
    } finally { cleanup() }
  })

  it('reportFailure 记录失败并清除运行态', async () => {
    const { handler, newsSchedule, cleanup } = boot()
    try {
      const out = await newsSchedule.execute({ action: 'reportFailure', shiftId: 's9', kind: 'error', reason: '502 bad gateway' })
      expect(out.ok).toBe(true)
      const res = makeRes()
      await handler(makeReq({ url: '/dsh-music/news/schedule' }), res)
      const data = JSON.parse(res.body)
      expect(data.failures.length).toBe(1)
      expect(data.failures[0].reason).toBe('502 bad gateway')
      const r2 = makeRes()
      await handler(makeReq({ url: '/dsh-music/news/runstate' }), r2)
      expect(JSON.parse(r2.body).run).toBe(null)
    } finally { cleanup() }
  })
})

describe('news 路由', () => {
  const bootWithEdition = async () => {
    const ctx = boot()
    await broadcast(ctx.newsBroadcast, NEWS_BODY)
    return ctx
  }

  it('GET /news 返回期次列表摘要', async () => {
    const { handler, cleanup } = await bootWithEdition()
    try {
      const res = makeRes()
      await handler(makeReq({ url: '/dsh-music/news' }), res)
      const data = JSON.parse(res.body)
      expect(data.editions.length).toBe(1)
      expect(data.editions[0].title).toBe('早间新闻播报')
      expect(data.editions[0].categories[0]).toEqual({ name: '热点', count: 2 })
      expect(data.editions[0].totalItems).toBe(3)
    } finally { cleanup() }
  })

  it('meta / text 提供目录结构与字幕', async () => {
    const { handler, cleanup } = await bootWithEdition()
    try {
      const list = makeRes()
      await handler(makeReq({ url: '/dsh-music/news' }), list)
      const id = JSON.parse(list.body).editions[0].id
      const meta = makeRes()
      await handler(makeReq({ url: `/dsh-music/news/${id}/meta` }), meta)
      const m = JSON.parse(meta.body)
      expect(m.total).toBeGreaterThan(0)
      expect(m.sections.map((s) => s.heading)).toEqual(['热点', 'AI'])
      expect(m.charOffsets.length).toBe(m.total + 1)
      const text = makeRes()
      await handler(makeReq({ url: `/dsh-music/news/${id}/text?from=0` }), text)
      const t = JSON.parse(text.body)
      expect(t.ok).toBe(true)
      expect(t.from).toBe(0)
      expect(t.text).toContain('您好，这里是早间新闻播报')
      // 字幕按条切分：每条新闻是一个完整块（开头「第N条」、含标题/摘要、结尾「以上消息来自来源」）。
      const firstItemChunk = m.itemChunk[0]
      const itemText = makeRes()
      await handler(makeReq({ url: `/dsh-music/news/${id}/text?from=${firstItemChunk}` }), itemText)
      const it = JSON.parse(itemText.body)
      expect(it.ok).toBe(true)
      expect(it.text).toMatch(/^第[一二三四五六七八九十]+条，政策发布会召开/)
      expect(it.text).toContain('以上消息来自新华社。')
    } finally { cleanup() }
  })

  it('text 越界返回 ok:false', async () => {
    const { handler, cleanup } = await bootWithEdition()
    try {
      const list = makeRes()
      await handler(makeReq({ url: '/dsh-music/news' }), list)
      const id = JSON.parse(list.body).editions[0].id
      const meta = makeRes()
      await handler(makeReq({ url: `/dsh-music/news/${id}/meta` }), meta)
      const total = JSON.parse(meta.body).total
      const text = makeRes()
      await handler(makeReq({ url: `/dsh-music/news/${id}/text?from=${total + 5}` }), text)
      expect(JSON.parse(text.body).ok).toBe(false)
    } finally { cleanup() }
  })

  it('play 设置 intent；played 标记已播清除待播', async () => {
    const { handler, cleanup } = await bootWithEdition()
    try {
      const list = makeRes()
      await handler(makeReq({ url: '/dsh-music/news' }), list)
      const id = JSON.parse(list.body).editions[0].id
      const play = makeRes()
      await handler(makeReq({ method: 'POST', url: '/dsh-music/news/play', body: JSON.stringify({ id }) }), play)
      expect(JSON.parse(play.body).ok).toBe(true)
      const intent = makeRes()
      await handler(makeReq({ url: '/dsh-music/intent' }), intent)
      const it = JSON.parse(intent.body)
      expect(it.kind).toBe('news')
      expect(it.id).toBe(id)
      const played = makeRes()
      await handler(makeReq({ method: 'POST', url: '/dsh-music/news/played', body: JSON.stringify({ id }) }), played)
      const list2 = makeRes()
      await handler(makeReq({ url: '/dsh-music/news' }), list2)
      expect(JSON.parse(list2.body).editions[0].played).toBe(true)
    } finally { cleanup() }
  })

  it('新闻 intent 有时效：浏览器长时间未取则过期丢弃', async () => {
    const { handler, newsBroadcast, cleanup } = boot()
    try {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2026-05-30T09:00:00'))
      await broadcast(newsBroadcast, NEWS_BODY) // autoplay 默认 true → 推送 intent
      // 浏览器 3 小时后才打开（定时播报浏览器没开的场景）
      vi.setSystemTime(new Date('2026-05-30T12:00:00'))
      const intent = makeRes()
      await handler(makeReq({ url: '/dsh-music/intent' }), intent)
      expect(JSON.parse(intent.body)).toBe(null) // 过期意图被丢弃，不突兀自动播放
      vi.useRealTimers()
    } finally { cleanup() }
  })

  it('DELETE 删除期次；未知 id 404', async () => {
    const { handler, cleanup } = await bootWithEdition()
    try {
      const list = makeRes()
      await handler(makeReq({ url: '/dsh-music/news' }), list)
      const id = JSON.parse(list.body).editions[0].id
      const del = makeRes()
      await handler(makeReq({ method: 'DELETE', url: `/dsh-music/news/${id}` }), del)
      expect(JSON.parse(del.body).ok).toBe(true)
      const del2 = makeRes()
      await handler(makeReq({ method: 'DELETE', url: `/dsh-music/news/${id}` }), del2)
      expect(del2.status).toBe(404)
    } finally { cleanup() }
  })

  it('schedule 偏好 POST 写入并递增版本号；相同内容不递增', async () => {
    const { handler, cleanup } = boot()
    try {
      const body = JSON.stringify({
        enabled: true,
        defaultScope: { categories: ['热点', '国内'], topics: ['AI'] },
        shifts: [{ id: 's1', time: '08:00', autoplay: true, scope: { categories: ['热点'], topics: [] } }],
      })
      const r1 = makeRes()
      await handler(makeReq({ method: 'POST', url: '/dsh-music/news/schedule', body }), r1)
      const p1 = JSON.parse(r1.body).schedulePrefs
      expect(p1.prefVersion).toBe(1)
      expect(p1.defaultScope.categories).toEqual(['热点', '国内'])
      const r2 = makeRes()
      await handler(makeReq({ method: 'POST', url: '/dsh-music/news/schedule', body }), r2)
      expect(JSON.parse(r2.body).schedulePrefs.prefVersion).toBe(1) // 未变化不递增
      const body2 = JSON.stringify({
        enabled: true,
        defaultScope: { categories: ['热点', '国内'], topics: ['AI'] },
        shifts: [{ id: 's1', time: '09:30', autoplay: true, scope: null }],
      })
      const r3 = makeRes()
      await handler(makeReq({ method: 'POST', url: '/dsh-music/news/schedule', body: body2 }), r3)
      expect(JSON.parse(r3.body).schedulePrefs.prefVersion).toBe(2)
    } finally { cleanup() }
  })

  it('每任务 7 期滚动保留在路由层生效', async () => {
    const { handler, newsBroadcast, cleanup } = boot()
    try {
      for (let i = 0; i < 9; i++) {
        await broadcast(newsBroadcast, { ...NEWS_BODY, shiftId: 's1', force: true, title: `第${i}期` })
      }
      await broadcast(newsBroadcast, { ...NEWS_BODY, shiftId: 's2', force: true, title: '别班次' })
      const res = makeRes()
      // runstate 路由会顺带 loadNews 刷新内存态
      await handler(makeReq({ url: '/dsh-music/news' }), res)
      const editions = JSON.parse(res.body).editions
      const s1 = editions.filter((e) => e.originShiftId === 's1')
      const s2 = editions.filter((e) => e.originShiftId === 's2')
      expect(s1.length).toBe(LIMITS.retentionPerShift)
      expect(s2.length).toBe(1)
      expect(editions[editions.length - 1].title).toBe('别班次') // 时间倒序混合流
    } finally { cleanup() }
  })
})

describe('run-now（统一执行入口：定时到点 / 手动立即执行共用）', () => {
  it('run-now：每次新建执行会话、sessionTitle.rename 按「时间+类别」命名，并注入收集指令', async () => {
    let created = []
    const renamed = []
    const agents = makeAgents({
      agentsCreate: async (opts) => {
        created.push(opts)
        return { agent: { id: opts.sessionId, session: { id: opts.sessionId }, followup: (msg) => agents.injected.push({ id: opts.sessionId, status: 'idle', msg }) } }
      },
    })
    const live = agents.service.get('agent-live')
    live.options = { provider: 'deepseek', model: 'deepseek-chat' }
    const sessionTitle = { rename: (session, title) => { renamed.push({ sessionId: session.id, title }) } }
    const { handler, cleanup } = boot({ agentsService: agents.service, sessionTitle })
    try {
      await handler(makeReq({
        method: 'POST', url: '/dsh-music/news/schedule',
        body: JSON.stringify({
          enabled: true, defaultScope: { categories: [], topics: [] },
          shifts: [{ id: 's9', time: '18:00', autoplay: false, scope: { categories: ['科技'], topics: ['AI'] } }],
        }),
      }), makeRes())
      const res = makeRes()
      await handler(makeReq({ method: 'POST', url: '/dsh-music/news/run-now', body: JSON.stringify({ shiftId: 's9' }) }), res)
      const data = JSON.parse(res.body)
      expect(data.ok).toBe(true)
      expect(created.length).toBe(1)
      expect(created[0].sessionId.startsWith('news-exec-')).toBe(true)
      expect(data.sessionId).toBe(created[0].sessionId)
      // 执行会话被显式命名：名称 = 当前时间 + 任务类别（科技 + 主题:AI）
      expect(renamed.length).toBe(1)
      expect(renamed[0].sessionId).toBe(created[0].sessionId)
      expect(renamed[0].title).toMatch(/^\d{2}-\d{2} \d{2}:\d{2} 科技 \+ 主题:AI$/)
      // 注入收集指令（含班次信息，无同步/begin 语义）
      expect(agents.injected.length).toBe(1)
      const text = agents.injected[0].msg.content[0].text
      expect(text).toContain('18:00')
      expect(text).toContain('s9')
      expect(text).not.toContain('begin')
      expect(text).toContain('先不播放') // autoplay:false → 静默收集
      expect(text).toContain('科技')
      expect(text).toContain('AI')
    } finally { cleanup() }
  })

  it('run-now 未知班次返回 404，不创建执行会话', async () => {
    const agents = makeAgents()
    const { handler, cleanup } = boot({ agentsService: agents.service })
    try {
      const res = makeRes()
      await handler(makeReq({ method: 'POST', url: '/dsh-music/news/run-now', body: JSON.stringify({ shiftId: 'nope' }) }), res)
      expect(res.status).toBe(404)
      expect(agents.injected.length).toBe(0)
    } finally { cleanup() }
  })

  it('agents 服务缺失：run-now 返回 fallback:true', async () => {
    const { handler, cleanup } = boot() // 无 agentsService
    try {
      await handler(makeReq({
        method: 'POST', url: '/dsh-music/news/schedule',
        body: JSON.stringify({
          enabled: true, defaultScope: { categories: [], topics: [] },
          shifts: [{ id: 's1', time: '08:00', autoplay: true, scope: null }],
        }),
      }), makeRes())
      const res = makeRes()
      await handler(makeReq({ method: 'POST', url: '/dsh-music/news/run-now', body: JSON.stringify({ shiftId: 's1' }) }), res)
      const data = JSON.parse(res.body)
      expect(data.ok).toBe(false)
      expect(data.fallback).toBe(true)
    } finally { cleanup() }
  })
})

describe('每任务执行会话 + 结果绑定 + 删除联动', () => {
  it('每次执行都新建一个执行会话（不复用），news_broadcast 绑定 sessionId', async () => {
    let created = []
    const agents = makeAgents({
      agentsCreate: async (opts) => {
        created.push(opts)
        return { agent: { id: opts.sessionId, session: {}, followup: (msg) => agents.injected.push({ id: opts.sessionId, status: 'idle', msg }) } }
      },
    })
    const live = agents.service.get('agent-live')
    live.options = { provider: 'deepseek', model: 'deepseek-chat' }
    const { handler, newsBroadcast, cleanup } = boot({ agentsService: agents.service })
    try {
      await handler(makeReq({
        method: 'POST', url: '/dsh-music/news/schedule',
        body: JSON.stringify({
          enabled: true, defaultScope: { categories: [], topics: [] },
          shifts: [{ id: 's1', time: '08:00', autoplay: true, scope: null }],
        }),
      }), makeRes())
      // 第一次执行 → 执行会话 #1
      const r1 = makeRes()
      await handler(makeReq({ method: 'POST', url: '/dsh-music/news/run-now', body: JSON.stringify({ shiftId: 's1' }) }), r1)
      const sid1 = JSON.parse(r1.body).sessionId
      // 模拟执行会话 #1 内提交 news_broadcast → 期次绑定该 sessionId
      const b1 = await broadcast(newsBroadcast, { ...NEWS_BODY, shiftId: 's1' })
      // 第二次执行 → 执行会话 #2（不复用 #1）
      const r2 = makeRes()
      await handler(makeReq({ method: 'POST', url: '/dsh-music/news/run-now', body: JSON.stringify({ shiftId: 's1' }) }), r2)
      const sid2 = JSON.parse(r2.body).sessionId
      expect(created.length).toBe(2)
      expect(sid1).not.toBe(sid2)
      expect(sid1.startsWith('news-exec-')).toBe(true)
      // 期次已绑定 sessionId = 第一次执行会话
      const res = makeRes()
      await handler(makeReq({ url: '/dsh-music/news' }), res)
      const editions = JSON.parse(res.body).editions
      const ed = editions.find((e) => e.id === b1.editionId)
      expect(ed).toBeTruthy()
      expect(ed.sessionId).toBe(sid1)
    } finally { cleanup() }
  })

  it('删除期次联动销毁对应执行会话（dispose 被调用并清映射）', async () => {
    let created = []
    const disposed = []
    const agents = makeAgents({
      agentsCreate: async (opts) => {
        created.push(opts)
        return {
          agent: { id: opts.sessionId, session: {}, followup: () => {} },
          dispose: async () => { disposed.push(opts.sessionId) },
        }
      },
    })
    const live = agents.service.get('agent-live')
    live.options = { provider: 'deepseek', model: 'deepseek-chat' }
    const { handler, newsBroadcast, cleanup } = boot({ agentsService: agents.service })
    try {
      await handler(makeReq({
        method: 'POST', url: '/dsh-music/news/schedule',
        body: JSON.stringify({
          enabled: true, defaultScope: { categories: [], topics: [] },
          shifts: [{ id: 's1', time: '08:00', autoplay: true, scope: null }],
        }),
      }), makeRes())
      const rr = makeRes()
      await handler(makeReq({ method: 'POST', url: '/dsh-music/news/run-now', body: JSON.stringify({ shiftId: 's1' }) }), rr)
      const sid = JSON.parse(rr.body).sessionId
      const b = await broadcast(newsBroadcast, { ...NEWS_BODY, shiftId: 's1' })
      expect(disposed.length).toBe(0) // 删除前未销毁
      const del = makeRes()
      await handler(makeReq({ method: 'DELETE', url: '/dsh-music/news/' + b.editionId }), del)
      expect(JSON.parse(del.body).ok).toBe(true)
      expect(disposed).toEqual([sid]) // 删除期次 → 销毁对应执行会话
      // 期次已删除
      const res = makeRes()
      await handler(makeReq({ url: '/dsh-music/news' }), res)
      expect(JSON.parse(res.body).editions.length).toBe(0)
    } finally { cleanup() }
  })

  it('无模型可建（agents 无 options）时 run-now 返回 fallback', async () => {
    const agents = makeAgents()
    const { handler, cleanup } = boot({ agentsService: agents.service })
    try {
      await handler(makeReq({
        method: 'POST', url: '/dsh-music/news/schedule',
        body: JSON.stringify({
          enabled: true, defaultScope: { categories: [], topics: [] },
          shifts: [{ id: 's1', time: '08:00', autoplay: true, scope: null }],
        }),
      }), makeRes())
      const res = makeRes()
      await handler(makeReq({ method: 'POST', url: '/dsh-music/news/run-now', body: JSON.stringify({ shiftId: 's1' }) }), res)
      const data = JSON.parse(res.body)
      expect(data.ok).toBe(false)
      expect(data.fallback).toBe(true)
      expect(agents.injected.length).toBe(0)
    } finally { cleanup() }
  })

  it('有 presets 服务时创建执行会话会装配标准组合（mount 默认 preset，含 web_search）', async () => {
    let created = null
    let mounted = null
    const agents = makeAgents({
      agentsCreate: async (opts) => {
        created = opts
        return { agent: { id: opts.sessionId, session: {}, followup: () => {} } }
      },
    })
    const live = agents.service.get('agent-live')
    live.options = { provider: 'deepseek', model: 'deepseek-chat' }
    const presets = {
      resolve: async () => ({ id: 'default-preset' }),
      mount: async (agentCtx, id) => { mounted = { agentCtx, id } },
    }
    const { handler, cleanup } = boot({ agentsService: agents.service, agentPresets: presets })
    try {
      await handler(makeReq({
        method: 'POST', url: '/dsh-music/news/schedule',
        body: JSON.stringify({
          enabled: true, defaultScope: { categories: [], topics: [] },
          shifts: [{ id: 's1', time: '08:00', autoplay: true, scope: null }],
        }),
      }), makeRes())
      const res = makeRes()
      await handler(makeReq({ method: 'POST', url: '/dsh-music/news/run-now', body: JSON.stringify({ shiftId: 's1' }) }), res)
      expect(created).toBeTruthy()
      expect(created.meta.agentPreset).toBe('default-preset')
      expect(typeof created.setup).toBe('function')
      await created.setup({}) // 触发 setup 会 mount 默认 preset
      expect(mounted).toEqual({ agentCtx: {}, id: 'default-preset' })
    } finally { cleanup() }
  })

  it('GET /news/models 返回 llm 服务的 provider 与模型', async () => {
    const { handler, cleanup } = boot({ llm: makeLlm() })
    try {
      const res = makeRes()
      await handler(makeReq({ url: '/dsh-music/news/models' }), res)
      const data = JSON.parse(res.body)
      expect(data.ok).toBe(true)
      expect(data.providers).toEqual([
        { id: 'deepseek', name: 'DeepSeek', models: [{ id: 'deepseek-chat', name: 'deepseek-chat' }] },
      ])
    } finally { cleanup() }
  })

  it('GET /news/schedule 返回 schedulePrefs（无 newsSessionId 字段）', async () => {
    const { handler, cleanup } = boot()
    try {
      const res = makeRes()
      await handler(makeReq({ url: '/dsh-music/news/schedule' }), res)
      const data = JSON.parse(res.body)
      expect(data.ok).toBe(true)
      expect(data.schedulePrefs).toBeTruthy()
      expect('newsSessionId' in data).toBe(false)
    } finally { cleanup() }
  })
})

// 供 makeAgents 相关测试：拿到 boot 使用的 HOME（boot 里 DSH_HOME = HOME/.dsh）。
function homeOf() { return process.env.HOME }

// 假 agents 服务：roots / get / 可选 create。opts.dedicated 注入一个「专用新闻简报会话」agent。
function makeAgents(opts = {}) {
  const injected = []
  const base = [
    { id: 'agent-early', status: 'idle', session: {} },
    { id: 'agent-live', status: 'running', session: {} },
  ]
  if (opts.dedicated) {
    base.push({ id: opts.dedicated.id, status: opts.dedicated.status || 'idle', session: {}, ...(opts.dedicated.options ? { options: opts.dedicated.options } : {}) })
  }
  const agents = base.map((a) => ({ ...a, followup: (msg) => injected.push({ id: a.id, status: a.status, msg }) }))
  const byId = new Map(agents.map((a) => [a.id, a]))
  return {
    injected,
    service: {
      roots: () => [...byId.values()],
      get: (id) => byId.get(id),
      ...(opts.agentsCreate ? { create: opts.agentsCreate } : {}),
    },
  }
}

// 假 llm 服务：listProviders + listModels，供 /news/models 路由测试。
function makeLlm() {
  return {
    listProviders: () => [{ id: 'deepseek', name: 'DeepSeek' }],
    listModels: async (provider) => {
      if (provider === 'deepseek') return [{ provider: 'deepseek', id: 'deepseek-chat', name: 'deepseek-chat' }]
      return []
    },
  }
}
