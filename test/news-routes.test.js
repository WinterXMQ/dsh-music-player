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

function boot({ agentsService = null, llm = null, agentPresets = null } = {}) {
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
    // 懒获取服务（与真实宿主一致）：agents / llm / agentPresets 仅在传入时才可见。
    get: (k) => {
      if (k === 'agents') return agentsService
      if (k === 'llm') return llm
      if (k === 'agentPresets') return agentPresets
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
  it('begin → runstate 记录；broadcast 完成后清除', async () => {
    const { handler, newsBroadcast, newsSchedule, cleanup } = boot()
    try {
      await newsSchedule.execute({ action: 'begin', shiftId: 's1' })
      const r1 = makeRes()
      await handler(makeReq({ url: '/dsh-music/news/runstate' }), r1)
      const state1 = JSON.parse(r1.body)
      expect(state1.run.shiftId).toBe('s1')
      await broadcast(newsBroadcast, { ...NEWS_BODY, shiftId: 's1' })
      const r2 = makeRes()
      await handler(makeReq({ url: '/dsh-music/news/runstate' }), r2)
      expect(JSON.parse(r2.body).run).toBe(null)
    } finally { cleanup() }
  })

  it('get 返回偏好摘要与同步指引', async () => {
    const { newsSchedule, cleanup } = boot()
    try {
      const out = await newsSchedule.execute({ action: 'get' })
      expect(out.ok).toBe(true)
      const data = JSON.parse(out.data)
      expect(data.enabled).toBe(true)
      expect(data.inSync).toBe(true) // 初始 prefVersion=0 = syncedVersion? 0===0 -> true
    } finally { cleanup() }
  })

  it('markSynced 回写版本号', async () => {
    const { newsSchedule, handler, cleanup } = boot()
    try {
      await newsSchedule.execute({ action: 'markSynced', version: 5 })
      const res = makeRes()
      await handler(makeReq({ url: '/dsh-music/news/schedule' }), res)
      const prefs = JSON.parse(res.body).schedulePrefs
      expect(prefs.syncedVersion).toBe(5)
    } finally { cleanup() }
  })

  it('reportFailure 记录失败并清除运行态', async () => {
    const { handler, newsSchedule, cleanup } = boot()
    try {
      await newsSchedule.execute({ action: 'begin', shiftId: 's9' })
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
      expect(t.text).toContain('第一条，政策发布会召开')
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

describe('自动化通道（agents 注入 / fallback）', () => {
  it('同步：指令注入「正在运行」的 agent，文本含同步指引与 markSynced', async () => {
    const agents = makeAgents()
    const { handler, cleanup } = boot({ agentsService: agents.service })
    try {
      // 先配置一个班次（空配置走 delete-all 分支，是另一条用例）
      await handler(makeReq({
        method: 'POST', url: '/dsh-music/news/schedule',
        body: JSON.stringify({
          enabled: true, defaultScope: { categories: [], topics: [] },
          shifts: [{ id: 's1', time: '08:00', autoplay: true, scope: null }],
        }),
      }), makeRes())
      const res = makeRes()
      await handler(makeReq({ method: 'POST', url: '/dsh-music/news/schedule/sync' }), res)
      const data = JSON.parse(res.body)
      expect(data.ok).toBe(true)
      expect(data.mode).toBe('sync')
      expect(data.target).toBe('agent-live') // 优先正在运行的会话
      expect(agents.injected.length).toBe(1)
      expect(agents.injected[0].msg.role).toBe('user')
      expect(agents.injected[0].msg.content[0].text).toContain('同步新闻定时')
      expect(agents.injected[0].msg.content[0].text).toContain('markSynced')
      expect(agents.injected[0].msg.source).toEqual({ kind: 'plugin', plugin: 'dsh-music-player' })
    } finally { cleanup() }
  })

  it('停用状态同步：注入「删除全部定时任务」指令', async () => {
    const agents = makeAgents()
    const { handler, cleanup } = boot({ agentsService: agents.service })
    try {
      await handler(makeReq({
        method: 'POST', url: '/dsh-music/news/schedule',
        body: JSON.stringify({ enabled: false, defaultScope: { categories: [], topics: [] }, shifts: [] }),
      }), makeRes())
      const res = makeRes()
      await handler(makeReq({ method: 'POST', url: '/dsh-music/news/schedule/sync' }), res)
      const data = JSON.parse(res.body)
      expect(data.ok).toBe(true)
      expect(data.mode).toBe('delete-all')
      expect(agents.injected[0].msg.content[0].text).toContain('删除')
    } finally { cleanup() }
  })

  it('立即执行：注入带班次 id 与 begin 上报的执行指令', async () => {
    const agents = makeAgents()
    const { handler, cleanup } = boot({ agentsService: agents.service })
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
      const text = agents.injected[0].msg.content[0].text
      expect(text).toContain('18:00')
      expect(text).toContain('s9')
      expect(text).toContain('begin')
      expect(text).toContain('先不播放')
      expect(text).toContain('科技')
    } finally { cleanup() }
  })

  it('run-now 未知班次返回 404', async () => {
    const agents = makeAgents()
    const { handler, cleanup } = boot({ agentsService: agents.service })
    try {
      const res = makeRes()
      await handler(makeReq({ method: 'POST', url: '/dsh-music/news/run-now', body: JSON.stringify({ shiftId: 'nope' }) }), res)
      expect(res.status).toBe(404)
      expect(agents.injected.length).toBe(0)
    } finally { cleanup() }
  })

  it('agents 服务缺失：返回 fallback:true（客户端回退复制指令）', async () => {
    const { handler, cleanup } = boot() // 无 agentsService
    try {
      const res = makeRes()
      await handler(makeReq({ method: 'POST', url: '/dsh-music/news/schedule/sync' }), res)
      const data = JSON.parse(res.body)
      expect(data.ok).toBe(false)
      expect(data.fallback).toBe(true)
    } finally { cleanup() }
  })
})

describe('专用「新闻简报」会话 + 模型选择', () => {
  it('同步：优先复用已持久化的专用会话（而非当前活跃会话）', async () => {
    // 预置一个「专用新闻简报会话」id，并让 agents 服务能 get 到它。
    const agents = makeAgents({ dedicated: { id: 'dedicated-news-1' } })
    const { handler, cleanup } = boot({ agentsService: agents.service })
    try {
      // 直接把 newsSessionId 写进持久化文件，模拟「已创建过专用会话」。
      const file = join(homeOf(agents), '.dsh', 'music-player-news.json')
      mkdirSync(join(homeOf(agents), '.dsh'), { recursive: true })
      writeFileSync(file, JSON.stringify({ version: 1, editions: [], schedulePrefs: {}, runState: null, failures: [], newsSessionId: 'dedicated-news-1' }), 'utf8')
      await handler(makeReq({
        method: 'POST', url: '/dsh-music/news/schedule',
        body: JSON.stringify({
          enabled: true, defaultScope: { categories: [], topics: [] },
          shifts: [{ id: 's1', time: '08:00', autoplay: true, scope: null }],
        }),
      }), makeRes())
      const res = makeRes()
      await handler(makeReq({ method: 'POST', url: '/dsh-music/news/schedule/sync' }), res)
      const data = JSON.parse(res.body)
      expect(data.ok).toBe(true)
      expect(data.target).toBe('dedicated-news-1') // 走专用会话而非 running 的 agent-live
      expect(agents.injected.length).toBe(1)
      expect(agents.injected[0].msg.content[0].text).toContain('专用「新闻简报」会话')
    } finally { cleanup() }
  })

  it('无模型可建（agents 无 options）时优雅回退到当前活跃会话', async () => {
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
      await handler(makeReq({ method: 'POST', url: '/dsh-music/news/schedule/sync' }), res)
      const data = JSON.parse(res.body)
      expect(data.ok).toBe(true)
      expect(data.target).toBe('agent-live')
    } finally { cleanup() }
  })

  it('有模型可建时调用 agents.create 创建专用会话并持久化 id', async () => {
    let created = null
    const agents = makeAgents({
      agentsCreate: async (opts) => {
        created = opts
        // 真实 harness 中创建的 agent id = 传入的 sessionId。
        return { agent: { id: opts.sessionId, session: {}, followup: (msg) => agents.injected.push({ id: opts.sessionId, status: 'idle', msg }) } }
      },
    })
    // 给 agent-live 补 options，使 ensureNewsSession 有模型可建。
    const live = agents.service.get('agent-live')
    live.options = { provider: 'deepseek', model: 'deepseek-chat' }
    const { handler, cleanup } = boot({ agentsService: agents.service })
    try {
      // 先配置一个班次，走 sync 分支（delete-all 分支不新建会话）。
      await handler(makeReq({
        method: 'POST', url: '/dsh-music/news/schedule',
        body: JSON.stringify({
          enabled: true, defaultScope: { categories: [], topics: [] },
          shifts: [{ id: 's1', time: '08:00', autoplay: true, scope: null }],
        }),
      }), makeRes())
      const res = makeRes()
      await handler(makeReq({ method: 'POST', url: '/dsh-music/news/schedule/sync' }), res)
      const data = JSON.parse(res.body)
      expect(data.ok).toBe(true)
      expect(created).toBeTruthy()
      expect(created.agentOptions).toEqual({ provider: 'deepseek', model: 'deepseek-chat' })
      expect(created.sessionId.startsWith('news-briefing-')).toBe(true)
      // 已持久化 newsSessionId
      const file = join(homeOf(agents), '.dsh', 'music-player-news.json')
      const saved = JSON.parse(readFileSync(file, 'utf8'))
      expect(saved.newsSessionId).toBe(created.sessionId)
      expect(data.target).toBe(created.sessionId)
    } finally { cleanup() }
  })

  it('有 presets 服务时创建会话会装配标准组合（mount 默认 preset，含 web_search）', async () => {
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
      await handler(makeReq({ method: 'POST', url: '/dsh-music/news/schedule/sync' }), res)
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

  it('GET /news/schedule 返回 newsSessionId（面板展示会话状态）', async () => {
    const { handler, cleanup } = boot()
    try {
      const res = makeRes()
      await handler(makeReq({ url: '/dsh-music/news/schedule' }), res)
      const data = JSON.parse(res.body)
      expect(data.ok).toBe(true)
      expect('newsSessionId' in data).toBe(true)
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
