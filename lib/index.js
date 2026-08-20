/**
 * dsh-music-player host half: a plain Cordis plugin running in the host
 * process. It scans the local music directory (default $HOME/Music, or a
 * directory configured through the settings page), streams audio per track
 * through /dsh-music/<id> with Range/seek support, and answers the browser
 * half's JSON calls (manifest / intent / set-root) over the same webServer.
 * It also registers the `music_play` model tool, which lets the CLI/agent ask
 * to play a track; the browser half polls /dsh-music/intent to pick it up.
 *
 * All registrations are effects so the row unmounts cleanly.
 */

// ---- settings constants, mirrored by the client via the manifest route ----
const DEFAULT_KEYS = { mode: 'dsh-music-mode', volume: 'dsh-music-volume', playback: 'dsh-music-playback' }

const AUDIO_TYPES = {
  mp3: 'audio/mpeg', m4a: 'audio/mp4', m4b: 'audio/mp4', aac: 'audio/aac',
  flac: 'audio/flac', wav: 'audio/wav', ogg: 'audio/ogg', oga: 'audio/ogg',
  opus: 'audio/ogg', webm: 'audio/webm', aiff: 'audio/aiff', aif: 'audio/aiff',
}

function isAudioName(name) {
  const i = name.lastIndexOf('.')
  return i > 0 && Object.prototype.hasOwnProperty.call(AUDIO_TYPES, name.slice(i + 1).toLowerCase())
}
function audioType(name) {
  const i = name.lastIndexOf('.')
  return i > 0 ? (AUDIO_TYPES[name.slice(i + 1).toLowerCase()] || 'application/octet-stream') : 'application/octet-stream'
}

// Books: local text files (.txt) we can read and turn into speech.
function isBookName(name) {
  const i = name.lastIndexOf('.')
  return i > 0 && name.slice(i + 1).toLowerCase() === 'txt'
}
// Upper bound of characters sent to the TTS model in one synthesis call.
// Kept small: a 500-char chunk measured ~20-50s of synthesis (the browser shows
// "缓冲中" the whole time), while a ~150-char chunk synthesizes in ~5-10s. With
// the synthesized-audio cache below, the next chunk is generated while the
// current one plays, so smaller chunks lower first-audio latency without
// audible gaps between blocks.
const MAX_TTS_CHARS = 150

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync } from 'node:fs'
import { dirname, basename, parse as pathParse, join as pathJoin } from 'node:path'
import * as os from 'node:os'

// ---- book structure parsing (title / preface / chapters / epilogue) ----
// Heuristic, rule-based parser that splits a novel's normalized text into
// sections so the reader can show a table of contents and jump to a chapter.
// Validated against a corpus of real books; see docs/book-parsing-design.md for
// the algorithm and its documented limits.
const STRUCT_CHAPTER_RE = /^第\s*[0-9一二三四五六七八九十百千万零〇]{1,5}\s*[章节回卷]/
const STRUCT_PART_RE = /^第\s*[0-9一二三四五六七八九十]{1,5}\s*(?:部|篇|集)|^(?:卷|部|篇|集|部分)\s*[0-9一二三四五六七八九十]+|^[一二三四五六七八九十]{1,4}\s*(?:部|卷|篇|集)/
const STRUCT_PREFACE_WORDS = ['前言', '自序', '序言', '序文', '代序', '引言', '楔子', '引子', '题记', '开篇', '开端', '卷首语', '卷前语', '简介', '内容简介', '内容提要', '提要', '作者简介', '出版说明', '编者按', '导读', '序']
const STRUCT_EPILOGUE_WORDS = ['尾声', '后记', '结语', '跋', '补记', '附记', '附录', '番外', '外传', '终章', '结局', '大结局']
const STRUCT_NUM_RE = /^[0-9]{1,3}[.、．\s]/
const STRUCT_CN_NUM_RE = /^[一二三四五六七八九十]{1,4}[、．. 　]/
const STRUCT_BULLET_RE = /^[◇◆●▲▪·•]/
const STRUCT_TOC_RE = /^目录/

function structClassifyLine(raw) {
  // Strip WPS/Founder typesetting codes (〖BT3〗/〖KH*2〗) and invisible leftovers
  // (private-use area, zero-width) that GBK decoding can leave after a sentence —
  // they would defeat the $ anchors below. The cleaned `text` is what becomes the
  // section heading.
  const s = raw
    .replace(/[〖【][^〗】]{0,24}[〗】]/g, '')
    .replace(/[\uE000-\uF8FF\uFFFD\u200b\u200c\u200d\u00a0\u3000]/g, '')
    .trim()
  if (s === '') return { kind: 'body', len: 0, text: '' }
  if (STRUCT_TOC_RE.test(s)) return { kind: 'toc', len: s.length, text: s }
  if (STRUCT_PART_RE.test(s)) return { kind: 'part', len: s.length, text: s }
  if (STRUCT_CHAPTER_RE.test(s)) return { kind: 'chapter', len: s.length, text: s }
  for (const w of STRUCT_PREFACE_WORDS) {
    if (s === w || s.startsWith(w + ' ') || s.startsWith(w + '　') || s.startsWith(w + '：') || s.startsWith(w + ':')) {
      if (s.length <= 14) return { kind: 'preface', len: s.length, text: s }
    }
  }
  for (const w of STRUCT_EPILOGUE_WORDS) {
    if (s === w || s.startsWith(w + ' ') || s.startsWith(w + '　')) {
      if (s.length <= 14) return { kind: 'epilogue', len: s.length, text: s }
    }
  }
  if (STRUCT_BULLET_RE.test(s) && s.length <= 25) return { kind: 'bullet', len: s.length, text: s }
  if ((STRUCT_NUM_RE.test(s) || STRUCT_CN_NUM_RE.test(s)) && s.length <= 22) return { kind: 'num', len: s.length, text: s }
  // A standalone short line with no sentence-final punctuation is a common
  // "named section" convention in Chinese literary fiction (e.g. "麻将牌").
  if (s.length >= 2 && s.length <= 12 && !/[。！？；…！？"”]$/.test(s)
    && !/[，,、：:（）()《》]/.test(s) && !/^\d+$/.test(s) && !/^[一二三四五六七八九十]+$/.test(s)
    && !/^(完|全文完|全书完|本[书卷篇]完)$/.test(s)) return { kind: 'named', len: s.length, text: s }
  return { kind: 'body', len: s.length, text: s }
}

const STRUCT_HEADING_KINDS = new Set(['chapter', 'part', 'preface', 'epilogue', 'toc', 'bullet', 'num', 'named'])

function structHeadingScore(kind, len, prevBlank, nextBlank, nextLen) {
  let s = 0
  switch (kind) {
    case 'chapter': s += 8; break
    case 'part': s += 7; break
    case 'preface': s += 7; break
    case 'epilogue': s += 7; break
    case 'toc': s += 6; break
    case 'named': s += 5; break
    case 'bullet': s += 3; break
    case 'num': s += 3; break
    default: return 0
  }
  if (len <= 6) s += 2
  else if (len <= 14) s += 1
  else if (len > 30) s -= 2
  else if (len > 50) s -= 3
  if (prevBlank || nextBlank) s += 1
  if (nextLen > 20 && nextLen > len * 1.5) s += 1
  return Math.max(0, Math.min(10, s))
}

function structStripTitle(s) { return s.replace(/[《》""「」\s]/g, '') }

function structDeriveFront(front, filenameHint) {
  let title = ''
  let author = ''
  const name = filenameHint.replace(/\.[^.]+$/, '')
  const fm = name.match(/^(.+?)\s*(?:作者|著)\s*[：:]\s*(.+)$/)
  if (fm) { title = structStripTitle(fm[1].trim()); author = fm[2].trim() }
  else { title = structStripTitle(name) }
  let t = title
  let a = author
  for (const s of front.slice(0, 6)) {
    const am = s.match(/^(?:作者|作\s*者|作者：|著\s*者)[：:]?\s*(.+)$/)
    if (am && am[1].length <= 20 && !a) { a = am[1]; continue }
    // a front line like "真相 作者：石楠" (no 《》 wrapper)
    const fam = s.match(/^(.{1,20}?)\s*(?:作者|著)\s*[：:]\s*(.{1,20})$/)
    if (fam && fam[2].trim() !== '' && !a) { t = fam[1].trim(); a = fam[2].trim(); continue }
    const pm = s.match(/^(?:出版社|出版)\s*[：:]?\s*(.+)$/)
    if (pm && pm[1].length <= 30) continue
    if (s.startsWith('《') && s.endsWith('》') && s.length <= 40) { t = s.slice(1, -1); continue }
    const bm = s.match(/^(.{1,12}?)[《]([^》]{1,40})[》]/)
    if (bm && !a) { a = bm[1].trim(); t = bm[2]; continue }
    const bm2 = s.match(/^《([^》]{1,40})》\s*(.{1,12})?$/)
    if (bm2 && !a) { t = bm2[1]; if (bm2[2] && bm2[2].trim()) a = bm2[2].trim(); continue }
    if (a === '' && !am && /^\S{1,12}$/.test(s) && !/第|序|章|[《》]/.test(s)) a = s
  }
  return { title: t || title, author: a || author }
}

/**
 * Split a novel's text into structured sections. Exported for tests.
 * Returns { title, author, sections: [{type, heading, startLine, chars, bodyLines, charStart, charLen, textStart}] }
 * where charStart/charLen are offsets in the "content" space (concatenated
 * trimmed non-blank lines), and textStart is the heading's offset in the
 * normalized input text — used to align chunk boundaries so a chapter jump is
 * exact instead of ±1 chunk.
 */
export function parseBookStructure(text, filenameHint = '') {
  const norm = String(text).replace(/\uFEFF/g, '').replace(/\r\n?/g, '\n')
  const rawLines = norm.split('\n')
  const lines = []
  let running = 0
  for (const raw of rawLines) {
    const s = raw.trim()
    const lead = raw.length - raw.trimStart().length
    lines.push({ text: raw, s, blank: s === '', off: running + lead })
    running += raw.length + 1
  }
  for (const ln of lines) if (!ln.blank) ln.cls = structClassifyLine(ln.s)

  // Pass B: mark TOC blocks (>=3 consecutive heading-like lines with no body
  // line between them) so a duplicated 目录 doesn't produce fake sections.
  let i = 0
  while (i < lines.length) {
    if (lines[i].blank || !STRUCT_HEADING_KINDS.has(lines[i].cls.kind)) { i++; continue }
    let j = i
    while (j < lines.length && !lines[j].blank && STRUCT_HEADING_KINDS.has(lines[j].cls.kind)) j++
    if (j - i >= 3) for (let k = i; k < j; k++) lines[k].cls.kind = 'toc'
    i = j
  }

  // Pass C: decide real headings via confidence score + context.
  const real = new Array(lines.length).fill(false)
  for (let k = 0; k < lines.length; k++) {
    const ln = lines[k]
    if (ln.blank) continue
    const c = ln.cls
    if (!STRUCT_HEADING_KINDS.has(c.kind)) continue
    // Printed TOCs often list each chapter on its own line followed by a page
    // number ("…/12"). If the next non-blank line ends with such a ref, this
    // heading is a TOC row — suppress it (the real chapter appears later).
    // e.g. 一个县委书记的故事.txt: "第一章 一根针执政官" → "1. 石头砸在桌面上…/1"
    if (c.kind !== 'toc') {
      let pn = k + 1
      while (pn < lines.length && lines[pn].blank) pn++
      if (pn < lines.length && /\/\d+\s*$/.test(lines[pn].s)) { c.kind = 'toc'; continue }
    }
    if (c.kind === 'toc') continue
    const prevBlank = k === 0 || lines[k - 1].blank
    const nextIdx = k + 1 < lines.length ? k + 1 : -1
    const nextBlank = nextIdx === -1 || lines[nextIdx].blank
    let nextLen = 0
    let nn = nextIdx
    while (nn !== -1 && lines[nn].blank) nn = nn + 1 < lines.length ? nn + 1 : -1
    if (nn !== -1) nextLen = lines[nn].s.length
    const score = structHeadingScore(c.kind, c.len, prevBlank, nextBlank, nextLen)
    const prevHeading = k > 0 && !lines[k - 1].blank && STRUCT_HEADING_KINDS.has(lines[k - 1].cls.kind)
    const sitsAlone = prevBlank || prevHeading
    const STRONG = c.kind === 'chapter' || c.kind === 'part' || c.kind === 'preface'
      || c.kind === 'epilogue' || c.kind === 'toc'
    // Strong headings don't need a blank line above (some books run a chapter
    // heading straight after the previous paragraph); the length penalty in
    // structHeadingScore keeps mid-paragraph long lines out.
    if (STRONG) { if (score >= 7) real[k] = true; continue }
    if (c.kind === 'named') {
      // The riskiest kind: a short standalone line could be a lyric/song quote.
      // Trust only when it sits on a blank line, the next non-blank line is a
      // long body paragraph, and the line above isn't another short line (a run
      // of short lines = lyrics/poem).
      const aboveIsNamed = k > 0 && !lines[k - 1].blank && lines[k - 1].cls.kind === 'named'
      if (!(prevBlank && nextLen > 20 && !aboveIsNamed)) continue
    }
    if (score >= 6 && sitsAlone) real[k] = true
  }

  // Pass D: group body lines under each real heading; pre-heading lines = front matter.
  const sections = []
  let front = []
  let cur = null
  const flush = () => { if (cur !== null) { sections.push(cur); cur = null } }
  for (let k = 0; k < lines.length; k++) {
    if (lines[k].blank) continue
    if (real[k]) {
      flush()
      cur = { type: lines[k].cls.kind, heading: lines[k].cls.text, startLine: k + 1, body: [], textStart: lines[k].off }
      continue
    }
    if (cur !== null) cur.body.push(lines[k].s)
    else front.push(lines[k].s)
  }
  flush()

  // char spans FIRST, so the noise gate below can judge body size.
  let charPos = 0
  for (const sec of sections) {
    sec.chars = sec.body.join('').length
    sec.bodyLines = sec.body.length
    sec.charStart = charPos
    sec.charLen = sec.heading.length + sec.chars
    charPos += sec.charLen
    delete sec.body
  }

  // Noise gate: a short standalone line opening a tiny block is usually a
  // quote / date / diary stub, not a real section — fold it back into the
  // previous section's body. Real named headings (story titles, chapter
  // sub-heads) open a substantial body, so those survive.
  const NAMED_MIN_BODY = 600
  for (let i2 = 1; i2 < sections.length; i2++) {
    const sec = sections[i2]
    if (sec.type !== 'named' || sec.chars >= NAMED_MIN_BODY) continue
    const prev = sections[i2 - 1]
    prev.chars += sec.heading.length + sec.chars
    prev.bodyLines += 1 + sec.bodyLines
    prev.charLen += sec.heading.length + sec.chars
    sections.splice(i2, 1)
    i2--
  }

  const meta = structDeriveFront(front, filenameHint)
  return {
    title: meta.title,
    author: meta.author,
    sections: sections.map((s) => ({
      type: s.type, heading: s.heading, startLine: s.startLine,
      chars: s.chars, bodyLines: s.bodyLines, charStart: s.charStart, charLen: s.charLen,
      textStart: s.textStart,
    })),
  }
}

export const name = 'dsh-music-player'
export const inject = ['webServer', 'fs', 'shell', 'tools', 'systemPrompt', 'llm']

export function apply(ctx) {
  let home = null
  let musicRoot = null
  let bookRoot = null
  let tracks = []
  let books = []
  let pendingIntent = null
  let startupPromise = null

  const getHome = async () => {
    if (home !== null) return home
    try {
      // os.homedir() resolves the user's home cross-platform (Windows uses
      // C:\Users\<name>; POSIX /Users/<name> or /home/<name>). The $HOME shell
      // variable does not exist under cmd/powershell on Windows, so fall back
      // to the shell only when os.homedir() is unusable.
      const osHome = (typeof os !== 'undefined' && os.homedir) ? os.homedir() : ''
      if (osHome !== '') { home = osHome; return home }
    } catch { /* fall through to shell */ }
    try {
      const result = await ctx.shell.run(ctx.shell.resolve({ command: 'printf %s "$HOME"' }))
      const value = String((result.stdout && result.stdout.text) || '').trim()
      home = value || null
    } catch {
      home = null
    }
    return home
  }
  // ---- persisted music root (survives DSH restarts) ----
  // A tiny JSON state file under the DSH home keeps the configured root across
  // process restarts; an unreadable or non-directory stored root is ignored so
  // the player falls back to the default ~/Music instead of failing to load.
  const stateFile = async () => {
    const h = await getHome()
    const base = (typeof process !== 'undefined' && process.env && process.env.DSH_HOME)
      || (h === null ? null : h + '/.dsh')
    return base === null ? null : base + '/music-player-state.json'
  }
  const loadStoredRoot = async () => {
    const file = await stateFile()
    if (file === null) return { music: null, books: null }
    try {
      const text = readFileSync(file, 'utf8')
      const data = JSON.parse(text)
      return {
        music: data && typeof data.root === 'string' && data.root !== '' ? data.root : null,
        books: data && typeof data.bookRoot === 'string' && data.bookRoot !== '' ? data.bookRoot : null,
      }
    } catch {
      return { music: null, books: null }
    }
  }
  const saveRoot = async (patched) => {
    const file = await stateFile()
    if (file === null) return
    try {
      // Write directly with node:fs: the host ctx.fs service may fence writes
      // under a workspace policy, which silently dropped the state file.
      let prev = {}
      if (existsSync(file)) {
        const prevText = readFileSync(file, 'utf8')
        if (prevText.trim()) { try { prev = JSON.parse(prevText) } catch { prev = {} } }
      }
      const next = { ...prev, ...patched }
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, JSON.stringify(next, null, 2) + '\n', 'utf8')
    } catch {
      // persistence is best-effort; an unwritable state file only loses the
      // remembered directory, never breaks playback
    }
  }
  const publicTracks = () => tracks.map((t) => ({
    id: t.id, name: t.name, url: t.url, size: t.size, ext: t.ext,
  }))
  const publicBooks = () => books.map((b) => ({
    id: b.id, name: b.name, size: b.size, url: '/dsh-music/book/' + b.id,
  }))

  const scan = async (rootPath, kinds = { music: true, books: false }) => {
    const target = await ctx.fs.resolve(rootPath)
    const info = await ctx.fs.stat(target)
    if (info === undefined || info.type !== 'directory') {
      throw new Error('不是有效的目录: ' + rootPath)
    }
    const rootStr = ctx.fs.processPath(target)
    const found = []
    const foundBooks = []
    const wantMusic = kinds.music
    const wantBooks = kinds.books
    const walk = async (dir, depth) => {
      if (depth > 4 || (found.length >= 500 && foundBooks.length >= 200)) return
      // Tolerant listing (all entries, see listEntries): dsh-fs-local's listDir
      // aborts on the first unreadable child, so scanning a drive root (or any
      // dir with protected entries) would silently yield zero tracks.
      const entries = listEntries(dir)
      for (const entry of entries) {
        if (found.length >= 500 && foundBooks.length >= 200) return
        const abs = pathJoin(dir, entry.name)
        try {
          if (entry.isDir) { await walk(abs, depth + 1); continue }
          if (wantMusic && isAudioName(entry.name)) {
            const st = statSync(abs)
            if (!st.isFile()) continue
            const rel = abs.startsWith(rootStr) ? abs.slice(rootStr.length + 1) : entry.name
            found.push({
              name: rel, path: abs, size: st.size || 0,
              ext: entry.name.slice(entry.name.lastIndexOf('.') + 1).toLowerCase(),
            })
          } else if (wantBooks && isBookName(entry.name) && foundBooks.length < 200) {
            const st = statSync(abs)
            if (!st.isFile()) continue
            const rel = abs.startsWith(rootStr) ? abs.slice(rootStr.length + 1) : entry.name
            foundBooks.push({ name: rel, path: abs, size: st.size || 0 })
          }
        } catch {
          // unreadable entry: skip it, keep walking the rest
        }
      }
    }
    await walk(rootStr, 0)
    found.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    foundBooks.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    return { rootPath: rootStr, found, foundBooks }
  }

  const refresh = async () => {
    if (musicRoot === null && bookRoot === null) {
      tracks = []; books = []
      return { root: null, bookRoot: null, tracks: [], books: [], count: 0 }
    }
    tracks = []
    books = []
    if (musicRoot !== null) {
      try {
        const { found } = await scan(musicRoot, { music: true, books: false })
        tracks = found.map((t, i) => ({
          id: String(i), name: t.name, path: t.path, size: t.size, ext: t.ext, url: '/dsh-music/' + i,
        }))
      } catch { /* keep empty */ }
    }
    if (bookRoot !== null) {
      try {
        const { foundBooks } = await scan(bookRoot, { music: false, books: true })
        books = foundBooks.map((b, i) => ({
          id: 'b' + i, name: b.name, path: b.path, size: b.size, url: '/dsh-music/book/b' + i,
        }))
      } catch { /* keep empty */ }
    }
    return { root: musicRoot, bookRoot, tracks: publicTracks(), books: publicBooks(), count: tracks.length }
  }
  const init = async () => {
    const h = await getHome()
    // Use path.join so the default root uses the platform separator; on Windows
    // a bare h + '/Music' produced a mixed "C:\Users\x/Music" root.
    let root = h === null ? null : pathJoin(h, 'Music')
    let broot = null
    const stored = await loadStoredRoot()
    // music root
    if (stored.music) {
      try {
        const target = await ctx.fs.resolve(stored.music)
        const info = await ctx.fs.stat(target)
        if (info !== undefined && info.type === 'directory') root = ctx.fs.processPath(target)
      } catch { /* keep default */ }
    }
    // book root: default to the same directory as music if none stored
    if (stored.books) {
      try {
        const target = await ctx.fs.resolve(stored.books)
        const info = await ctx.fs.stat(target)
        if (info !== undefined && info.type === 'directory') broot = ctx.fs.processPath(target)
      } catch { /* unreadable -> leave null and fall back below */ }
    }
    if (broot === null) broot = root // default books = music dir
    musicRoot = root
    bookRoot = broot
    try {
      return await refresh()
    } catch (err) {
      musicRoot = null
      bookRoot = null
      tracks = []
      books = []
      return { root: null, tracks: [], books: [], count: 0, error: String((err && err.message) || err) }
    }
  }
  const ensureStarted = () => { if (startupPromise === null) startupPromise = init(); return startupPromise }

  // ---- AI 讲书：MiMo TTS（复用 DSH 模型配置）----
  // 我们复用 DSH 已配置的模型：从 ctx.llm.listProviders() 里按 xiaomi/mimo
  // 关键字过滤出一个 provider 作为 TTS 来源。key 从该 provider 的
  // apiKeyEnv（settings.yaml 里约定，其实是环境变量名）读取；也可以直接用
  // MIMO_API_KEY 环境变量 + 固定 MiMo 端点作兜底，方便未在 DSH 里配 provider 时。
  const MIMO_DEFAULT_BASE_URL = 'https://api.xiaomimimo.com/v1/chat/completions'
  const MIMO_DEFAULT_MODEL = 'mimo-v2.5-tts'
  // 只保留四种中文声音，默认白桦（男声）。
  const MIMO_DEFAULT_VOICE = '白桦'
  // Built-in Chinese voices for mimo-v2.5-tts (official list). Exposed to the
  // browser via /manifest so the reader can pick a voice; the chosen voice rides
  // the chunk URL.
  const MIMO_VOICES = [
    { id: '冰糖', label: '冰糖', gender: '女', lang: '中文' },
    { id: '茉莉', label: '茉莉', gender: '女', lang: '中文' },
    { id: '苏打', label: '苏打', gender: '男', lang: '中文' },
    { id: '白桦', label: '白桦', gender: '男', lang: '中文' },
  ]
  const MIMO_VOICE_IDS = new Set(MIMO_VOICES.map((v) => v.id))
  const safeVoice = (v) => (typeof v === 'string' && MIMO_VOICE_IDS.has(v) ? v : MIMO_DEFAULT_VOICE)

  const settingsFile = async () => {
    const h = await getHome()
    const base = (process.env.DSH_HOME) || (h === null ? null : h + '/.dsh')
    return base === null ? null : pathJoin(base, 'settings.yaml')
  }
  const credentialsFile = async () => {
    const h = await getHome()
    const base = (process.env.DSH_HOME) || (h === null ? null : h + '/.dsh')
    return base === null ? null : pathJoin(base, '.credentials.yaml')
  }
  // Reuse the api key the user already configured in DSH. DSH stores configured
  // provider keys in ~/.dsh/.credentials.yaml keyed by the same name as
  // settings.yaml's apiKeyEnv, so read it there (falling back to a real env var).
  const readCredential = async (envName) => {
    if (!envName) return null
    if (process.env[envName]) return process.env[envName]
    try {
      const file = await credentialsFile()
      if (file === null || !existsSync(file)) return null
      const lines = readFileSync(file, 'utf8').split(/\r?\n/)
      for (const ln of lines) {
        const m = new RegExp('^' + envName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*[:=]\\s*(.+?)\\s*$').exec(ln)
        if (m) return m[1]
      }
      return null
    } catch { return null }
  }
  const findSettingsProvider = async (keyword) => {
    // settings.yaml -> llm-pi-ai.providers -> providers whose key mention the
    // keyword. Returns { baseURL, apiKeyEnv } or null. Handles both full
    // entries (displayName/api/baseURL/models) and slim ones that only declare
    // apiKeyEnv — many users register a TTS provider that way.
    try {
      const file = await settingsFile()
      if (file === null || !existsSync(file)) return null
      const lines = readFileSync(file, 'utf8').split(/\r?\n/)
      // Locate the providers: block header.
      const provIdx = lines.findIndex((l) => /^\s{2}providers:\s*$/.test(l))
      if (provIdx < 0) return null
      // Iterate provider blocks: a 4-space-indented "<key>:" starts each one;
      // the provider keeps going until the next 4-space key or a dedent.
      let i = provIdx + 1
      while (i < lines.length) {
        const start = lines[i]
        if (!/^ {4}[A-Za-z0-9_.-]+:\s*$/.test(start)) { i++; continue }
        const id = start.trim().replace(/:$/, '')
        const block = []
        let j = i + 1
        while (j < lines.length && /^ {6}/.test(lines[j])) { block.push(lines[j]); j++ }
        if ((id + '\n' + block.join('\n')).toLowerCase().includes(keyword)) {
          for (const ln of block) {
            const am = /^\s*apiKeyEnv:\s*(\S+)\s*$/.exec(ln)
            if (am) {
              const bm = block.find((b2) => /^\s*baseURL:\s*(\S+)/.test(b2))
              const baseURL = bm ? bm.replace(/^\s*baseURL:\s*/, '').trim() : ''
              return { id, baseURL, apiKeyEnv: am[1].trim() }
            }
          }
        }
        i = j
      }
      return null
    } catch { return null }
  }
  const resolveTts = async () => {
    // 1) 优先：from ctx.llm.listProviders() find xiaomi/mimo provider id
    let providerFound = false
    let providerId = null
    try {
      const provs = (ctx.llm && typeof ctx.llm.listProviders === 'function' ? ctx.llm.listProviders() : []) || []
      const hit = provs.find((p) => /xiaomi|mimo/i.test(String(p.id || '') + ' ' + String(p.name || '')))
      if (hit) { providerFound = true; providerId = hit.id }
    } catch { /* ignore */ }
    // 2) settings.yaml provider lookup by keyword (may reveal apiKeyEnv even if
    //    listProviders doesn't list a slim provider)
    let baseURL = null
    let apiKeyEnv = null
    const sp = await findSettingsProvider('xiaomi') || await findSettingsProvider('mimo')
    if (sp) { providerFound = true; providerId = providerId || sp.id; baseURL = sp.baseURL; apiKeyEnv = sp.apiKeyEnv }
    // key: from the user's DSH-configured provider credential (env var or
    // ~/.dsh/.credentials.yaml), else MIMO_API_KEY
    let key = null
    if (apiKeyEnv) key = await readCredential(apiKeyEnv)
    if (!key) key = await readCredential('MIMO_API_KEY')
    if (!baseURL) baseURL = MIMO_DEFAULT_BASE_URL
    let reason = ''
    if (key) reason = 'ok'
    else if (providerFound) reason = 'provider\u5df2\u914d\u7f6e\uff0c\u4f46\u672a\u8bfb\u5230 ' + (apiKeyEnv || 'MIMO_API_KEY') + '\u7684\u503c\u3002\u8bf7\u5728 DSH \u6a21\u578b\u8bbe\u7f6e\u4e2d\u786e\u8ba4\u5df2\u586b\u5165 xiaomi \u5bc6\u94a5\u3002'
    else reason = '\u672a\u627e\u5230 xiaomi/MiMo TTS provider\u3002\u8bf7\u5728 DSH \u6a21\u578b\u8bbe\u7f6e\u4e2d\u914d\u7f6e\u3002'
    return { providerId, baseURL, apiKeyEnv, key, configured: !!key, reason }
  }
  const ttsCache = {}
  const ttsState = async () => {
    if (ttsCache.checked !== undefined) return ttsCache
    const r = await resolveTts()
    ttsCache.checked = true
    ttsCache.configured = r.configured
    ttsCache.reason = r.reason
    return ttsCache
  }
  const ttsAvailable = async () => (await ttsState()).configured

  // Synthesize a chunk of prose into a Buffer of wav audio (non-streaming, format=wav).
  const synthesize = async (text, voice) => {
    const { baseURL, key } = await resolveTts()
    if (!key) throw new Error('未配置 xiaomi/MiMo TTS 模型（缺少 api key）')
    const body = {
      model: MIMO_DEFAULT_MODEL,
      messages: [
        { role: 'user', content: '请用讲故事、有感情的语气朗读以下内容。' },
        { role: 'assistant', content: text },
      ],
      audio: { format: 'wav', voice: safeVoice(voice) },
      stream: false,
    }
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 60000)
    let res
    try {
      res = await fetch(baseURL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'api-key': key },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      })
    } catch (err) {
      clearTimeout(timer)
      if (err.name === 'AbortError') throw new Error('TTS 请求超时')
      throw err
    }
    clearTimeout(timer)
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      throw new Error('TTS 请求失败 ' + res.status + ' ' + detail.slice(0, 300))
    }
    const json = await res.json()
    const data = json && json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.audio && json.choices[0].message.audio.data
    if (typeof data !== 'string') throw new Error('TTS 响应缺少音频数据')
    const buf = Buffer.from(data, 'base64')
    // Verify it is actually a WAVE file so the browser <audio> can decode it;
    // otherwise report a precise diagnosis instead of feeding it invalid bytes.
    if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
      throw new Error('TTS 返回的不是有效的 WAV 音频（前4字节=' + (buf.length >= 4 ? buf.toString('ascii', 0, 4) : '<空>') + '）——请改用支持 wav 的模型或检查 API 返回')
    }
    // Return the MiMo audio as-is: the 24kHz source played clearly in the smoke
    // test, and our naive linear-interpolation resample to 48kHz degraded
    // intelligibility. Revisit resampling only if it becomes the confirmed cause.
    return buf
  }

  // In-memory synthesized-audio cache + in-flight dedup.
  // The browser requests the same chunk URL more than once per listen (the
  // playing <audio> and the hidden preload <audio> both hit it, and replaying a
  // book hits it again), and each synthesis costs seconds-to-tens-of-seconds.
  // Caching the Buffer here turns those repeat requests into instant hits and
  // prevents two concurrent requests for the same chunk from synthesizing twice.
  // Keyed by book id + chunk index (stable within a session; deterministic
  // synthesis given a fixed voice/model makes the cache safe).
  const ttsAudioCache = new Map()
  const ttsAudioInflight = new Map()
  const MAX_TTS_CACHE_CHUNKS = 80
  const synthesizeCached = async (cacheKey, text, voice) => {
    const hit = ttsAudioCache.get(cacheKey)
    if (hit !== undefined) return hit
    const inFlight = ttsAudioInflight.get(cacheKey)
    if (inFlight !== undefined) return inFlight
    const p = synthesize(text, voice)
      .then((buf) => {
        ttsAudioInflight.delete(cacheKey)
        ttsAudioCache.set(cacheKey, buf)
        if (ttsAudioCache.size > MAX_TTS_CACHE_CHUNKS) {
          const oldest = ttsAudioCache.keys().next().value
          ttsAudioCache.delete(oldest)
        }
        return buf
      })
      .catch((err) => { ttsAudioInflight.delete(cacheKey); throw err })
    ttsAudioInflight.set(cacheKey, p)
    return p
  }

  const readBufToString = (buf) => {
    // Decode with the platform's built-in TextDecoder (Node ships ICU, so it
    // decodes UTF-8, UTF-16, and the GB family natively — no extra dependency).
    // Order: byte-order marks first, then strict UTF-8, then GB18030 (a superset
    // of GBK/GB2312, the encoding Windows saves Chinese .txt in by default).
    const txt = (enc, arr) => {
      try { return new TextDecoder(enc, { fatal: false }).decode(arr) } catch { return null }
    }
    if (buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) {
      return buf.subarray(3).toString('utf8') // UTF-8 with BOM
    }
    if (buf.length >= 2 && buf[0] === 0xFF && buf[1] === 0xFE) return txt('utf-16le', buf.subarray(2))
    if (buf.length >= 2 && buf[0] === 0xFE && buf[1] === 0xFF) return txt('utf-16be', buf)
    // No BOM: validate strict UTF-8; only fall to GB18030 when it isn't.
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(buf)
    } catch {
      return txt('gb18030', buf) || buf.toString('utf8')
    }
  }

  // Turn a book's path into plain text bounded to MAX_TTS_CHARS. Handles UTF-8
  // (with/without BOM), UTF-16 BOM, and GBK/GB2312/GB18030 (typical Windows .txt),
  // so the same plugin works on both macOS and Windows without the user having to
  // convert encoding by hand.
  // Read + decode a book file into clean normalized text (cross-platform encoding).
  const readBookText = (absPath) => {
    const raw = readFileSync(absPath)
    let text = readBufToString(raw)
    // strip common markdown-ish artifacts very lightly + normalize CRLF
    text = text.replace(/\r\n?/g, '\n').replace(/\uFEFF/g, '').replace(/\n{3,}/g, '\n\n').trim()
    if (text.length === 0) throw new Error('该小说文件为空，无法合成')
    return text
  }

  // Split prose into natural chunks (<= MAX_TTS_CHARS each). Sentences are
  // accumulated up to the cap (so each block is a few sentences of speech),
  // only closing a block when the next sentence would overflow. Paragraph
  // newlines are folded into whitespace. A single over-long sentence becomes
  // its own block (hard-capped).
  // Optional `breaks` = sorted char offsets in `text` where a NEW chunk must
  // start. A break is applied at sub-segment precision: text before the break
  // stays in the previous chunk, text from the break (the chapter heading)
  // opens a fresh chunk — so a chapter jump starts exactly at the heading even
  // when a divider page ("《书名》作者") shares the sentence segment with it.
  // Returns { chunks, fromChunkOfBreak } where fromChunkOfBreak[i] is the chunk
  // index opened by breaks[i] (undefined if that break opened no chunk).
  const splitBookChunks = (text, breaks = null) => {
    const chunks = []
    const fromChunkOfBreak = []
    // Sentence segments with their original char offsets in `text`.
    const segs = []
    let segStart = 0
    for (let i = 0; i < text.length; i++) {
      if ('。！？；…'.indexOf(text[i]) !== -1) {
        segs.push({ s: text.slice(segStart, i + 1), start: segStart })
        segStart = i + 1
      }
    }
    if (segStart < text.length) segs.push({ s: text.slice(segStart), start: segStart })
    let cur = ''
    let curOpener = -1 // break index that opened the chunk being accumulated
    let bi = 0
    const push = () => {
      if (cur.trim().length > 0) {
        if (curOpener >= 0) fromChunkOfBreak[curOpener] = chunks.length
        chunks.push(cur.trim())
      }
      cur = ''
      curOpener = -1
    }
    const addSentence = (rawSentence) => {
      const sentence = rawSentence.replace(/\s*\n+\s*/g, ' ').trim()
      if (sentence.length === 0) return
      if (cur.length > 0 && cur.length + sentence.length > MAX_TTS_CHARS) push()
      // A single sentence longer than the cap must be split itself.
      if (sentence.length > MAX_TTS_CHARS) {
        if (cur.length > 0) push()
        for (let i = 0; i < sentence.length; i += MAX_TTS_CHARS) {
          if (curOpener >= 0) fromChunkOfBreak[curOpener] = chunks.length
          chunks.push(sentence.slice(i, i + MAX_TTS_CHARS))
          curOpener = -1
        }
      } else {
        cur += sentence
      }
    }
    for (const seg of segs) {
      if (breaks && breaks.length > 0) {
        while (bi < breaks.length && breaks[bi] < seg.start) bi++
        if (bi < breaks.length && breaks[bi] < seg.start + seg.s.length) {
          const off = breaks[bi] - seg.start
          if (off > 0) addSentence(seg.s.slice(0, off))
          push()
          curOpener = bi
          bi++
          addSentence(seg.s.slice(off))
          // swallow any further breaks inside this same segment (rare)
          while (bi < breaks.length && breaks[bi] < seg.start + seg.s.length) bi++
          continue
        }
      }
      addSentence(seg.s)
    }
    push()
    if (chunks.length === 0) chunks.push(text.trim())
    return { chunks, fromChunkOfBreak }
  }

  // Load a book's text and split into chunks; cache per path to avoid re-reading
  // the file on every block request. Chunks are aligned so each section heading
  // starts a new chunk (structure-aware), which makes chapter jumps exact.
  const bookChunksCache = {}
  const bookStructCache = {}
  const loadBookChunks = (absPath, filenameHint) => {
    if (bookChunksCache[absPath] !== undefined) return bookChunksCache[absPath]
    const text = readBookText(absPath)
    const st = bookStructCache[absPath] !== undefined
      ? bookStructCache[absPath]
      : (bookStructCache[absPath] = parseBookStructure(text, filenameHint || basename(absPath)))
    const breaks = st.sections.map((s) => s.textStart).filter((n) => Number.isFinite(n) && n >= 0)
    bookChunksCache[absPath] = splitBookChunks(text, breaks).chunks
    return bookChunksCache[absPath]
  }

  // Structure meta (title / author / section list) for a book, cached per path.
  // Each section carries a fromChunk index (which TTS chunk starts the section)
  // so the reader can jump straight to a chapter. Because every section heading
  // opens its own chunk, fromChunk is the chunk opened by that section's break —
  // exact by construction (falling back to the char-offset heuristic only if a
  // heading somehow opened no chunk).
  const bookMetaCache = {}
  const loadBookMeta = (absPath, filenameHint) => {
    if (bookMetaCache[absPath] !== undefined) return bookMetaCache[absPath]
    const text = readBookText(absPath)
    const st = bookStructCache[absPath] !== undefined
      ? bookStructCache[absPath]
      : (bookStructCache[absPath] = parseBookStructure(text, filenameHint))
    const breaks = st.sections.map((s) => s.textStart).filter((n) => Number.isFinite(n) && n >= 0)
    const { chunks, fromChunkOfBreak } = splitBookChunks(text, breaks)
    const cum = []
    let acc = 0
    for (const c of chunks) { acc += c.length; cum.push(acc) }
    const upperBound = (x) => {
      let lo = 0, hi = cum.length - 1, ans = 0
      while (lo <= hi) {
        const m = (lo + hi) >> 1
        if (cum[m] <= x) { ans = m + 1; lo = m + 1 } else hi = m - 1
      }
      return Math.min(ans, Math.max(0, chunks.length - 1))
    }
    const sections = st.sections.map((s, i) => {
      const exact = Number.isInteger(fromChunkOfBreak[i]) && fromChunkOfBreak[i] >= 0 ? fromChunkOfBreak[i] : -1
      const fromChunk = exact >= 0 ? exact : upperBound(s.charStart)
      const endChunk = upperBound(s.charStart + s.charLen)
      return {
        type: s.type,
        heading: s.heading,
        fromChunk,
        chunks: Math.max(1, endChunk - fromChunk + 1),
        chars: s.chars,
        startLine: s.startLine,
      }
    })
    bookMetaCache[absPath] = { title: st.title, author: st.author, total: chunks.length, sections }
    return bookMetaCache[absPath]
  }

  // Tolerant directory listing for the picker and the scan. dsh-fs-local's
  // listDir is all-or-nothing: one unreadable child (pagefile.sys, System
  // Volume Information, ...) aborts the entire listing, which made drive roots
  // (and any dir containing protected entries) show up empty. Enumerate with
  // node:fs instead, skip entries that cannot be stat'd, and report every
  // entry with an isDir flag so callers can filter (picker: dirs only;
  // scan: dirs to recurse + audio files to collect).
  const listEntries = (dirPath) => {
    let dirents = []
    try { dirents = readdirSync(dirPath, { withFileTypes: true, encoding: 'utf8' }) } catch { return [] }
    const out = []
    for (const ent of dirents) {
      try {
        const isDir = ent.isDirectory() || (ent.isSymbolicLink() && statSync(pathJoin(dirPath, ent.name)).isDirectory())
        out.push({ name: ent.name, isDir })
      } catch {
        // unreadable entry (EPERM/EBUSY/...): skip it, keep listing the rest
      }
    }
    out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    return out
  }

  // ---- shared HTTP helpers ----
  const writeJson = (res, value, status) => {
    res.writeHead(status || 200, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(value))
  }
  async function readBody(req) {
    let text = ''
    for await (const chunk of req) text += chunk
    if (text === '') return {}
    try { return JSON.parse(text) } catch { return {} }
  }
  const serve = async (req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://x')
      const pathname = url.pathname
      // JSON API routes
      if (pathname === '/dsh-music/manifest' && req.method === 'GET') {
        await ensureStarted()
        const ts = await ttsState()
        writeJson(res, {
          root: musicRoot, bookRoot, tracks: publicTracks(), books: publicBooks(), count: tracks.length,
          ttsConfigured: ts.configured, ttsReason: ts.reason, voices: MIMO_VOICES,
        })
        return
      }
      if (pathname === '/dsh-music/set-root' && req.method === 'POST') {
        const body = await readBody(req)
        const rawPath = body && typeof body.path === 'string' ? body.path.trim() : ''
        if (rawPath === '') { writeJson(res, { ok: false, error: '路径不能为空' }, 400); return }
        const expanded = rawPath.startsWith('~/') ? ((await getHome()) || '') + '/' + rawPath.slice(2) : rawPath
        try {
          const target = await ctx.fs.resolve(expanded)
          const info = await ctx.fs.stat(target)
          if (info === undefined || info.type !== 'directory') {
            writeJson(res, { ok: false, error: '目录不存在或不可读: ' + expanded }, 400)
            return
          }
          musicRoot = ctx.fs.processPath(target)
          const data = await refresh()
          await saveRoot({ root: musicRoot })
          writeJson(res, { ok: true, root: data.root, bookRoot: data.bookRoot, tracks: data.tracks, books: data.books, count: data.count })
        } catch (err) {
          writeJson(res, { ok: false, error: String((err && err.message) || err) }, 500)
        }
        return
      }
      if (pathname === '/dsh-music/set-book-root' && req.method === 'POST') {
        const body = await readBody(req)
        const rawPath = body && typeof body.path === 'string' ? body.path.trim() : ''
        if (rawPath === '') { writeJson(res, { ok: false, error: '路径不能为空' }, 400); return }
        const expanded = rawPath.startsWith('~/') ? ((await getHome()) || '') + '/' + rawPath.slice(2) : rawPath
        try {
          const target = await ctx.fs.resolve(expanded)
          const info = await ctx.fs.stat(target)
          if (info === undefined || info.type !== 'directory') {
            writeJson(res, { ok: false, error: '目录不存在或不可读: ' + expanded }, 400)
            return
          }
          bookRoot = ctx.fs.processPath(target)
          const data = await refresh()
          await saveRoot({ bookRoot })
          writeJson(res, { ok: true, root: data.root, bookRoot: data.bookRoot, tracks: data.tracks, books: data.books, count: data.count })
        } catch (err) {
          writeJson(res, { ok: false, error: String((err && err.message) || err) }, 500)
        }
        return
      }
      // List the immediate subdirectories of a library-visible path, for the
      // browser directory picker used by the playback-list "选择音乐目录" button.
      // An empty/missing path starts from the user's home directory. Only
      // directories are returned; file entries are skipped.
      if (pathname === '/dsh-music/dir' && req.method === 'GET') {
        await ensureStarted()
        const raw = url.searchParams.get('path') || ''
        try {
          // Windows has no single root that lists every drive, so expose a
          // sentinel ("__drives__") that enumerates the available drive roots.
          // Browsing "up" from a drive root (e.g. C:\) lands here so users can
          // switch to another drive.
          if (raw === '__drives__') {
            const isWin = typeof process !== 'undefined' && process.platform === 'win32'
            if (isWin) {
              const roots = []
              for (const letter of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') {
                const root = letter + ':\\'
                try { if (existsSync(root)) roots.push({ name: root, path: root }) } catch {}
              }
              writeJson(res, { path: '__drives__', name: '\u672c\u673a\u78c1\u76d8', up: null, dirs: roots })
            } else {
              writeJson(res, { path: '/', name: '/', up: null, dirs: [] })
            }
            return
          }
          const base = raw === '' ? ((await getHome()) || '/') : raw
          const expanded = base.startsWith('~/') ? ((await getHome()) || '') + '/' + base.slice(2) : base
          const target = await ctx.fs.resolve(expanded)
          const info = await ctx.fs.stat(target)
          if (info === undefined || info.type !== 'directory') {
            writeJson(res, { error: '目录不存在或不可读', path: expanded }, 400)
            return
          }
          const abs = ctx.fs.processPath(target)
          // Parent / name computation must use the host filesystem's separators
          // (Windows uses "\" and drive roots like C:\, POSIX uses "/"), so do it
          // with node:path rather than guessing a separator in the browser.
          const atRoot = pathParse(abs).dir === abs
          // On Windows, "up" from a drive root goes to the drive-list sentinel so
          // users can switch drives; at the POSIX root there is nowhere to go.
          const up = atRoot
            ? (process.platform === 'win32' ? '__drives__' : null)
            : dirname(abs)
          // Tolerant listing (see listEntries): skip unreadable entries so
          // drive roots like C:\ still show their normal folders instead of an
          // empty list. Only directories are offered by the picker.
          const dirs = listEntries(abs)
            .filter((e) => e.isDir)
            .map((e) => ({ name: e.name, path: pathJoin(abs, e.name) }))
          writeJson(res, { path: abs, name: basename(abs) || abs, up, dirs })
        } catch (err) {
          writeJson(res, { error: String((err && err.message) || err) }, 500)
        }
        return
      }
      if (pathname === '/dsh-music/intent' && req.method === 'GET') {
        const it = pendingIntent
        pendingIntent = null
        writeJson(res, it || null)
        return
      }
      // AI 讲书：一本书的元信息（总块数）或某个块的 wav。
      //   GET /dsh-music/book/<id>/meta  -> { id, name, total, size }  (JSON)
      //   GET /dsh-music/book/<id>?from=n -> chunk n as wav audio
      if (pathname.startsWith('/dsh-music/book/') && (req.method === 'GET' || req.method === 'HEAD')) {
        await ensureStarted()
        const rest = pathname.slice('/dsh-music/book/'.length) // "<id>" or "<id>/meta"
        const isMeta = rest.endsWith('/meta')
        const id = isMeta ? rest.slice(0, -'/meta'.length) : rest
        const book = books.find((b) => b.id === id)
        if (book === undefined) { res.writeHead(404); res.end(); return }
        try {
          // book.path is an absolute native path string; read directly with node:fs.
          // Do NOT run it through ctx.fs.resolve() (DSH's fs returns a non-string
          // descriptor, which native readFileSync rejects).
          const chunks = loadBookChunks(book.path, book.name)
          if (isMeta) {
            // Structure meta (title/author/sections) is computed once and cached;
            // total is the authoritative chunk count from loadBookChunks.
            const meta = loadBookMeta(book.path, book.name)
            writeJson(res, {
              id, name: book.name, size: book.size,
              total: chunks.length,
              title: meta.title, author: meta.author, sections: meta.sections,
            })
            return
          }
          const fromParam = url.searchParams.get('from')
          const from = fromParam !== null ? parseInt(fromParam, 10) : 0
          const idx = Number.isFinite(from) && from >= 0 ? from : 0
          if (idx >= chunks.length) { res.writeHead(410, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('章节结束'); return }
          // The voice rides the chunk URL (?voice=...); it is part of the cache
          // key so switching voices re-synthesizes instead of replaying stale audio.
          const voice = safeVoice(url.searchParams.get('voice'))
          // synthesizeCached dedupes the play + preload requests for the same
          // chunk (and makes replays instant) instead of re-running TTS.
          const wav = await synthesizeCached(book.id + ':' + idx + ':' + voice, chunks[idx], voice)
          const headers = {
            'Content-Type': 'audio/wav',
            'Content-Length': String(wav.length),
            // Cacheable so the hidden preload <audio> actually warms the browser
            // cache and the following chunk switch is near-instant (a no-store
            // header was defeating the double-buffering preload entirely).
            'Cache-Control': 'public, max-age=3600',
          }
          res.writeHead(200, headers)
          if (req.method === 'GET') res.end(wav)
          else res.end()
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
          res.end(String((err && err.message) || err))
        }
        return
      }
      // audio streaming
      if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return }
      // Ensure the library scan completes before resolving a track, so a
      // streaming/HEAD request that arrives before any manifest call (or at
      // startup) still finds its track instead of spuriously 404ing.
      await ensureStarted()
      const id = pathname.slice('/dsh-music/'.length)
      const track = tracks.find((t) => t.id === id)
      if (track === undefined) { res.writeHead(404); res.end(); return }
      const target = await ctx.fs.resolve(track.path)
      const info = await ctx.fs.stat(target)
      if (info === undefined || info.type !== 'file' || info.size === undefined) { res.writeHead(404); res.end(); return }
      const size = info.size
      let start = 0
      let end = size - 1
      let status = 200
      const range = req.headers.range
      if (typeof range === 'string') {
        const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim())
        if (m !== null && (m[1] !== '' || m[2] !== '')) {
          if (m[1] !== '') {
            start = parseInt(m[1], 10)
            end = m[2] !== '' ? Math.min(parseInt(m[2], 10), size - 1) : size - 1
          } else {
            start = Math.max(size - parseInt(m[2], 10), 0)
            end = size - 1
          }
          if (!Number.isFinite(start) || start > end || start >= size) {
            res.writeHead(416, { 'Content-Range': 'bytes */' + size })
            res.end()
            return
          }
          status = 206
        }
      }
      const bytes = await ctx.fs.readBytes(target, undefined, size)
      const slice = bytes.slice(start, end + 1)
      const headers = {
        'Content-Type': audioType(track.name),
        'Accept-Ranges': 'bytes',
        'Content-Length': String(end - start + 1),
        'Cache-Control': 'no-store',
      }
      if (status === 206) headers['Content-Range'] = 'bytes ' + start + '-' + end + '/' + size
      res.writeHead(status, headers)
      if (req.method === 'HEAD') { res.end(); return }
      res.end(slice)
    } catch (err) {
      try { res.writeHead(500); res.end() } catch {}
    }
  }
  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: '/dsh-music', handler: serve }), 'music-player: routes')

  // ---- model tool: music_play ----
  const PLAY_ACTIONS = ['play', 'pause', 'resume', 'stop', 'next', 'prev']
  const tool = {
    name: 'music_play',
    description: '控制 DSH 本地音乐库的播放。播放时可按歌曲名/歌手关键词搜索并播放（不传 query 则播放第一首）；也可用 action 执行暂停/继续/停止/下一首/上一首。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string', description: '歌曲名/歌手关键词，用于搜索并播放。仅当 action 为 play（默认）时使用，可留空' },
        action: { type: 'string', enum: PLAY_ACTIONS, description: '要执行的动作：play 播放（默认）、pause 暂停、resume 继续、stop 停止、next 下一首、prev 上一首' },
      },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          action: { type: 'string' }, played: { type: 'boolean' },
          track: { type: 'string' }, matches: { type: 'number' }, count: { type: 'number' },
          notice: { type: 'string' },
        },
      },
      render(_args, value) {
        return [{ type: 'text', text: (value && value.notice) || (value && value.track ? '已请求播放：' + value.track : '音乐库为空') }]
      },
    },
    async execute(args) {
      await ensureStarted()
      const count = tracks.length
      const action = args && typeof args.action === 'string' && PLAY_ACTIONS.includes(args.action) ? args.action : 'play'

      if (count === 0) {
        const notice = '本地音乐库为空。请打开播放列表面板，点击「选择音乐目录」配置音乐目录。'
        return { action, played: false, track: '', matches: 0, count: 0, notice }
      }

      // Non-play actions just relay a transport command to the browser player.
      if (action !== 'play') {
        pendingIntent = { action }
        const labels = {
          pause: '已请求暂停播放', resume: '已请求继续播放', stop: '已请求停止播放',
          next: '已请求播放下一首', prev: '已请求播放上一首',
        }
        const notice = labels[action] + '。若浏览器拦截自动操作，请在播放条上点击对应按钮。'
        return { action, played: false, track: '', matches: 0, count, notice }
      }

      // play: search (exact match first, then substring) and pick the first hit.
      const query = args && typeof args.query === 'string' ? args.query.trim().toLowerCase() : ''
      const pool = query === '' ? tracks : tracks.filter((t) => t.name.toLowerCase().includes(query))
      if (pool.length === 0) {
        const notice = '没有找到包含「' + (args && args.query) + '」的音乐（音乐库共 ' + count + ' 首）。'
        return { action, played: false, track: '', matches: 0, count, notice }
      }
      // Prefer an exact (case-insensitive) filename match over the first substring hit.
      const pick = query === '' ? pool[0]
        : (tracks.find((t) => t.name.toLowerCase() === query) || pool[0])
      pendingIntent = { action: 'play', id: pick.id, name: pick.name }
      return {
        action, played: true, track: pick.name, matches: pool.length, count,
        notice: '已请求播放「' + pick.name + '」（匹配 ' + pool.length + ' / 共 ' + count + ' 首）。浏览器可能拦截自动播放，请在页面播放条上点击一次▶解锁。',
      }
    },
  }
  ctx.effect(() => ctx.tools.register(tool), 'music-player: music_play tool')

  // ---- light prompt hint so the agent knows it can play local music ----
  ctx.systemPrompt.section({
    name: 'tool:music-player', order: 116,
    text: '本机已挂载本地音乐播放器：可用 music_play 工具按关键词播放 ~/Music（或设置的目录）里的音乐，并支持 action 暂停/继续/停止/上下首控制。',
  })

  void ensureStarted()
}
