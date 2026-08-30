/**
 * 新闻播报核心纯逻辑：入参校验、口播稿模板渲染、分块、保留策略、冷却窗、定时偏好规整。
 * 不依赖 fs / 网络 / DSH 服务，全部可独立单测；lib/index.js 只做持久化与服务接入。
 *
 * 设计依据：docs/daily-news-briefing-design.md（数据模型 §3 / 口播稿模板 §4 / 工具 §5.1）。
 */

/** 预设类别（热点排第一：跨领域 + 热度排序）。 */
export const PRESET_CATEGORIES = ['热点', '国内', '国际', '科技', '财经', '体育']

export const LIMITS = {
  categories: 8, // 单期类别数上限（预设 6 + 自定义余量）
  itemsPerCategory: 8,
  totalItems: 20,
  summaryChars: 100,
  titleChars: 60,
  categoryNameChars: 20,
  sourceChars: 30,
  urlChars: 500,
  topicsPerShift: 5,
  shifts: 6,
  retentionPerShift: 7, // 每任务（班次）独立滚动保留期数
  cooldownMs: 10 * 60 * 1000, // 冷却窗：同班次 10 分钟内重复提交跳过
  runStateTtlMs: 10 * 60 * 1000, // 执行中状态 TTL（agent 漏报时自动复位）
  failuresKept: 10,
}

/** 中文序数词：1 → 「第一条」…（支持到 99）。 */
export function cnOrdinal(n) {
  const digits = ['', '一', '二', '三', '四', '五', '六', '七', '八', '九']
  if (!Number.isInteger(n) || n < 1 || n > 99) return String(n)
  if (n < 10) return '第' + digits[n] + '条'
  if (n === 10) return '第十条'
  if (n < 20) return '第十' + digits[n - 10] + '条'
  const tens = Math.floor(n / 10)
  const ones = n % 10
  return '第' + digits[tens] + '十' + (ones === 0 ? '条' : digits[ones] + '条')
}

/** 'YYYY-MM-DD' → 'YYYY年M月D日'；解析失败原样返回。 */
export function formatDateCn(dateStr) {
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(String(dateStr || ''))
  if (!m) return String(dateStr || '')
  return `${m[1]}年${Number(m[2])}月${Number(m[3])}日`
}

const clip = (s, n) => {
  const t = String(s === undefined || s === null ? '' : s).trim()
  return t.length > n ? t.slice(0, n - 1) + '…' : t
}

/**
 * 校验并规整 news_broadcast 的入参。超限字段截断（不报错），结构性缺失才报错。
 * @returns {{ ok: true, value: object } | { ok: false, error: string }}
 */
export function sanitizeEditionInput(body, { today } = {}) {
  if (!body || typeof body !== 'object') return { ok: false, error: '缺少新闻数据' }
  const rawCats = Array.isArray(body.categories) ? body.categories : []
  const title = clip(body.title, LIMITS.titleChars) || '今日新闻播报'
  const date = /^\d{4}-\d{1,2}-\d{1,2}$/.test(String(body.date || ''))
    ? String(body.date)
    : (today || new Date().toISOString().slice(0, 10))
  const voice = typeof body.voice === 'string' && body.voice.trim() !== '' ? body.voice.trim() : null
  const categories = []
  let total = 0
  for (const c of rawCats) {
    if (categories.length >= LIMITS.categories) break
    if (!c || typeof c !== 'object') continue
    const name = clip(c.name, LIMITS.categoryNameChars)
    if (name === '') continue
    const rawItems = Array.isArray(c.items) ? c.items : []
    const items = []
    for (const it of rawItems) {
      if (items.length >= LIMITS.itemsPerCategory || total >= LIMITS.totalItems) break
      if (!it || typeof it !== 'object') continue
      const t = clip(it.title, LIMITS.titleChars)
      const summary = clip(it.summary, LIMITS.summaryChars)
      if (t === '' || summary === '') continue
      items.push({
        title: t,
        summary,
        source: clip(it.source, LIMITS.sourceChars),
        url: clip(it.url, LIMITS.urlChars),
        publishedAt: clip(it.publishedAt, 20),
      })
      total += 1
    }
    if (items.length > 0) categories.push({ name, items })
  }
  if (categories.length === 0) {
    return { ok: false, error: '没有有效的新闻条目（每条需要 title 与 summary）' }
  }
  return {
    ok: true,
    value: {
      title,
      date,
      categories,
      opening: typeof body.opening === 'string' ? clip(body.opening, 200) : '',
      closing: typeof body.closing === 'string' ? clip(body.closing, 200) : '',
      voice,
      autoplay: body.autoplay === undefined ? true : !!body.autoplay,
      force: !!body.force,
      originShiftId: typeof body.shiftId === 'string' && body.shiftId.trim() !== '' ? body.shiftId.trim() : 'manual',
      itemCount: total,
    },
  }
}

/**
 * 模板渲染口播稿。返回分片数组（含类别引导语/条目文本），并标注每个条目与类别
 * 在全文中的起始字符偏移——供分块后计算 itemChunk / 类别 fromChunk。
 * @returns {{ text: string, itemOffsets: number[], categoryOffsets: number[] }}
 */
export function renderScript({ title, date, categories, opening, closing }) {
  const parts = []
  const itemOffsets = []
  const categoryOffsets = []
  let pos = 0
  const push = (text) => {
    parts.push(text)
    pos += text.length
  }
  // 开场
  if (opening) {
    push(opening)
  } else {
    const names = categories.map((c) => c.name).join('、')
    push(`您好，这里是${title}，${formatDateCn(date)}。今天的主要内容有：${names}。`)
  }
  // 类别与条目
  categories.forEach((cat, ci) => {
    const lead = ci === 0 ? `首先来听${cat.name}。` : `接下来听${cat.name}。`
    push(lead)
    categoryOffsets.push(pos - lead.length)
    cat.items.forEach((it, ii) => {
      const seq = cnOrdinal(itemOffsets.length + 1)
      const sentence = `${seq === '第一条' ? '第一条' : seq}，${it.title}。${it.summary}。`
        + (it.source ? `以上消息来自${it.source}。` : '')
      itemOffsets.push(pos)
      push(sentence)
      void ii
    })
  })
  // 结语
  if (closing) {
    push(closing)
  } else {
    push('以上就是今天的新闻播报，感谢收听。')
  }
  return { text: parts.join(''), itemOffsets, categoryOffsets }
}

/**
 * 按句子边界把口播稿切块：目标 ~120 字、上限 200 字；单句超限时硬切。
 * @returns {string[]}
 */
export function splitScriptChunks(text) {
  const sentences = []
  let buf = ''
  for (const ch of String(text)) {
    buf += ch
    if ('。！？；!?;\n'.includes(ch)) {
      sentences.push(buf)
      buf = ''
    }
  }
  if (buf !== '') sentences.push(buf)
  const chunks = []
  let cur = ''
  for (const s of sentences) {
    if (s.length > 200) {
      // 先把当前块落盘，再对超长句硬切。
      if (cur !== '') { chunks.push(cur); cur = '' }
      for (let i = 0; i < s.length; i += 200) chunks.push(s.slice(i, i + 200))
      continue
    }
    if (cur !== '' && cur.length + s.length > 200) {
      chunks.push(cur)
      cur = s
    } else if (cur.length + s.length >= 120 && cur.length + s.length <= 200) {
      // 满到目标区间即收块，保持块长稳定。
      cur += s
      chunks.push(cur)
      cur = ''
    } else {
      cur += s
    }
  }
  if (cur !== '') chunks.push(cur)
  return chunks.length > 0 ? chunks : ['']
}

const chunkIndexOfOffset = (cum, offset) => {
  // cum[i] = 前 i 块的字符数；返回包含字符偏移 offset 的块号。
  let lo = 0, hi = cum.length - 1, ans = 0
  while (lo <= hi) {
    const m = (lo + hi) >> 1
    if (cum[m] <= offset) { ans = m; lo = m + 1 } else hi = m - 1
  }
  return ans
}

/**
 * 由规整后的入参构建完整期次记录（渲染 + 分块 + 偏移映射）。
 * @returns {{ id, originShiftId, title, date, createdAt, voice, autoplay, categories, chunks, charOffsets, totalChars, itemChunk, categoryChunk }}
 */
export function buildEdition(input, { id, createdAt } = {}) {
  const { text, itemOffsets, categoryOffsets } = renderScript(input)
  const chunks = splitScriptChunks(text)
  const charOffsets = new Array(chunks.length + 1)
  charOffsets[0] = 0
  for (let i = 0; i < chunks.length; i++) charOffsets[i + 1] = charOffsets[i] + chunks[i].length
  const cum = charOffsets.slice(0, chunks.length)
  return {
    id,
    originShiftId: input.originShiftId,
    title: input.title,
    date: input.date,
    createdAt: createdAt === undefined ? Date.now() : createdAt,
    voice: input.voice || null,
    autoplay: input.autoplay,
    categories: input.categories,
    chunks,
    charOffsets,
    totalChars: text.length,
    itemChunk: itemOffsets.map((off) => chunkIndexOfOffset(cum, off)),
    categoryChunk: categoryOffsets.map((off) => chunkIndexOfOffset(cum, off)),
  }
}

/** 每任务（班次）独立滚动保留：按 originShiftId 分组，各保留最新 7 期；返回裁剪后的数组。 */
export function applyRetention(editions, limit = LIMITS.retentionPerShift) {
  const counts = new Map()
  const kept = []
  // editions 按 createdAt 升序持久化；从新到旧数，组内前 limit 个保留。
  for (let i = editions.length - 1; i >= 0; i--) {
    const e = editions[i]
    const key = e.originShiftId || 'manual'
    const n = counts.get(key) || 0
    if (n < limit) { kept.push(e); counts.set(key, n + 1) }
  }
  return kept.reverse()
}

/** 冷却窗：同 originShiftId 在 windowMs 内已有期次则返回该期次，否则 null。 */
export function findInCooldown(editions, { originShiftId, now, windowMs = LIMITS.cooldownMs }) {
  for (let i = editions.length - 1; i >= 0; i--) {
    const e = editions[i]
    if ((e.originShiftId || 'manual') !== originShiftId) continue
    return (now - e.createdAt) < windowMs ? e : null
  }
  return null
}

/** 期次列表行摘要（第一层列表数据源）。 */
export function summarizeEdition(e) {
  return {
    id: e.id,
    originShiftId: e.originShiftId || 'manual',
    title: e.title,
    date: e.date,
    createdAt: e.createdAt,
    played: !!e.played,
    sessionId: e.sessionId || null, // 产生本次结果的执行会话 id（无执行会话则 null）
    categories: (e.categories || []).map((c) => ({ name: c.name, count: (c.items || []).length })),
    totalItems: (e.categories || []).reduce((n, c) => n + (c.items || []).length, 0),
    totalChars: e.totalChars,
  }
}

/** 期次 meta（/news/<id>/meta：章节结构 + 偏移，供客户端目录/进度/条目跳播）。 */
export function metaForEdition(e) {
  const sections = (e.categories || []).map((c, i) => ({
    type: 'category',
    heading: c.name,
    fromChunk: (e.categoryChunk && e.categoryChunk[i]) || 0,
    itemCount: (c.items || []).length,
  }))
  return {
    id: e.id,
    title: e.title,
    date: e.date,
    createdAt: e.createdAt,
    total: (e.chunks || []).length,
    sections,
    // 完整条目数据：面板「期次详情 / 文字版」直接由 meta 渲染（免第二次请求）。
    categories: e.categories || [],
    charOffsets: e.charOffsets,
    totalChars: e.totalChars,
    itemChunk: e.itemChunk || [],
    categoryChunk: e.categoryChunk || [],
  }
}

/** 播报时长估计（中文 TTS ≈ 260 字/分钟），向上取整，至少 1 分钟。 */
export function estimateMinutes(totalChars) {
  return Math.max(1, Math.ceil((totalChars || 0) / 260))
}

const normScope = (scope) => {
  const out = { categories: [], topics: [] }
  if (!scope || typeof scope !== 'object') return out
  if (Array.isArray(scope.categories)) {
    out.categories = scope.categories
      .filter((c) => typeof c === 'string' && PRESET_CATEGORIES.includes(c))
  }
  if (Array.isArray(scope.topics)) {
    out.topics = scope.topics
      .filter((t) => typeof t === 'string' && t.trim() !== '')
      .map((t) => clip(t, 20))
      .slice(0, LIMITS.topicsPerShift)
  }
  return out
}

/** 定时偏好规整（面板保存 / GET 返回共用）。非法字段丢弃、超限截断、版本号递增由调用方负责。 */
export function sanitizeSchedulePrefs(input, prev) {
  const base = prev && typeof prev === 'object' ? prev : {}
  const out = {
    enabled: input && typeof input === 'object' ? input.enabled !== false : base.enabled !== false,
    defaultScope: normScope(input && input.defaultScope ? input.defaultScope : base.defaultScope),
    model: sanitizeModelSelection(input && input.model !== undefined ? input.model : base.model),
    shifts: [],
    prefVersion: Number.isInteger(base.prefVersion) ? base.prefVersion : 0,
    syncedVersion: Number.isInteger(base.syncedVersion) ? base.syncedVersion : -1,
  }
  const rawShifts = input && Array.isArray(input.shifts) ? input.shifts : (Array.isArray(base.shifts) ? base.shifts : [])
  for (const s of rawShifts) {
    if (out.shifts.length >= LIMITS.shifts) break
    if (!s || typeof s !== 'object') continue
    const time = /^([01]\d|2[0-3]):[0-5]\d$/.test(String(s.time || '')) ? String(s.time) : null
    if (time === null) continue
    out.shifts.push({
      id: typeof s.id === 'string' && s.id !== '' ? s.id.slice(0, 40) : 's' + Math.random().toString(36).slice(2, 8),
      time,
      autoplay: s.autoplay !== false,
      scope: s.scope === null || s.scope === undefined ? null : normScope(s.scope),
    })
  }
  return out
}

/**
 * 规整「新闻会话模型」选择：{ provider, model } 均为非空字符串才保留，否则 null（= 用当前活跃会话模型）。
 * 供面板定时编辑器保存 / 同步时创建专用会话使用。
 */
export function sanitizeModelSelection(input) {
  if (!input || typeof input !== 'object') return null
  const provider = typeof input.provider === 'string' ? input.provider.trim() : ''
  const model = typeof input.model === 'string' ? input.model.trim() : ''
  if (provider === '' || model === '') return null
  return { provider: provider.slice(0, 80), model: model.slice(0, 120) }
}

/** 执行中状态是否过期（TTL 懒过期）。 */
export function runStateAlive(run, now) {
  return !!(run && run.startedAt && (now - run.startedAt) < LIMITS.runStateTtlMs)
}
