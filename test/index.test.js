/**
 * Unit/integration tests for the dsh-music-player host half (lib/index.js).
 *
 * Strategy: drive the plugin's real `apply()` with a fake `ctx` whose `webServer`
 * captures the registered HTTP handler, and whose `fs` is backed by on-disk files
 * in a temporary directory. This exercises the actual route logic — manifest,
 * set-root, Range/seek streaming, 404, HEAD — against real bytes.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, readdirSync, statSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { apply, parseBookStructure } from '../lib/index.js'

// ---- tiny fake HTTP req/res (enough for the plugin's routes) ----
function makeReq({ method = 'GET', url = '/', headers = {}, body = '' }) {
  const req = { method, url, headers }
  // readBody does `for await (const chunk of req)` over body
  req[Symbol.asyncIterator] = async function* () { if (body) yield body }
  return req
}

function makeRes() {
  const calls = []
  const res = {
    status: 200,
    headers: {},
    body: null,
    writeHead(status, headers) {
      res.status = status
      res.headers = { ...(headers || {}) }
    },
    end(data) { res.body = data === undefined ? null : data },
  }
  calls.push(res)
  return res
}

// ---- mock ctx.fs backed by a real temp directory ----
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
      return readdirSync(dir, { withFileTypes: true }).map((e) => {
        const target = join(dir, e.name)
        const s = statSync(target)
        return {
          name: e.name,
          type: e.isDirectory() ? 'directory' : 'file',
          target,
          size: s.size,
        }
      })
    },
    async readBytes(target, _offset, _size) { return readFileSync(target) },
  }
}

// ---- build a ctx + boot a plugin instance against a temp "home" ----
function boot({ files = {}, musicFiles = {} } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'dsh-music-test-'))

  // default music root = <home>/Music, mirroring the plugin's default.
  const musicDir = join(home, 'Music')
  mkdirSync(musicDir, { recursive: true })
  for (const [name, content] of Object.entries(musicFiles)) {
    writeFileSync(join(musicDir, name), content)
  }
  // any extra paths from `files` (relative to home)
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(home, rel)
    mkdirSync(resolve(abs, '..'), { recursive: true })
    writeFileSync(abs, content)
  }

  // env-controlled state file location; saved before apply() reads HOME via shell.
  const prevHome = process.env.HOME
  const prevDshHome = process.env.DSH_HOME
  process.env.HOME = home
  process.env.DSH_HOME = join(home, '.dsh')

  const fs = makeFs(home)
  const registered = []
  const tools = []
  const loader = {
    name: 'test-loader',
    ctx: {
      shell: {
        resolve: (o) => o,
        run: async () => ({ stdout: { text: home } }),
      },
      fs,
      webServer: {
        register: (row) => { registered.push(row) },
      },
      tools: {
        register: (tool) => { tools.push(tool) },
      },
      systemPrompt: {
        section: () => {},
      },
      effect: (fn) => { fn() },
    },
  }

  apply(loader.ctx)

  const routes = registered.filter((r) => r.kind === 'prefix' && r.path === '/dsh-music')
  const handler = routes.length > 0 ? routes[0].handler : null

  const cleanup = () => {
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome
    if (prevDshHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prevDshHome
    try { rmSync(home, { recursive: true, force: true }) } catch {}
  }

  return { home, musicDir, handler, tools, cleanup }
}

afterEach(() => { /* cleanup handled per-boot to avoid cross-test state */ })

describe('dsh-music-player host routes', () => {
  it('reports the scanned library via /dsh-music/manifest', async () => {
    const { handler, musicDir, cleanup } = boot({
      musicFiles: { 'a.mp3': 'AUDIO-A', 'b.flac': 'AUDIO-B' },
    })
    try {
      expect(handler).toBeTruthy()
      const res = makeRes()
      await handler(makeReq({ url: '/dsh-music/manifest' }), res)
      const data = JSON.parse(res.body)
      expect(res.status).toBe(200)
      expect(data.count).toBe(2)
      expect(data.root).toBe(musicDir)
      const names = data.tracks.map((t) => t.name).sort()
      expect(names).toEqual(['a.mp3', 'b.flac'])
    } finally { cleanup() }
  })

  it('lists .txt novels as books in the manifest', async () => {
    // Books share the default root with music until a separate book root is set.
    const { handler, musicDir, cleanup } = boot({
      musicFiles: { 'a.mp3': 'AUDIO-A', 'novel.txt': '\u7b2c\u4e00\u7ae0 \u8d77\u6e90\u3002' },
    })
    try {
      const res = makeRes()
      await handler(makeReq({ url: '/dsh-music/manifest' }), res)
      const data = JSON.parse(res.body)
      expect(res.status).toBe(200)
      expect(data.tracks.map((t) => t.name)).toEqual(['a.mp3'])
      expect(data.books.map((b) => b.name)).toEqual(['novel.txt'])
      expect(data.bookRoot).toBe(musicDir)
      // book URLs route through the /book/ path
      expect(data.books[0].url.startsWith('/dsh-music/book/')).toBe(true)
    } finally { cleanup() }
  })

  it('recognizes a Windows-style GBK-encoded .txt as a book', async () => {
    // Windows often saves .txt as GBK (multi-byte, not valid UTF-8). The scanner
    // matches by extension, so a GBK byte buffer must still surface as a book.
    // "第一章" in GBK/GB2312: 第=B5DA 一=D2BB 章=D5C2
    const gbk = Buffer.from([0xB5, 0xDA, 0xD2, 0xBB, 0xD5, 0xC2])
    const { handler, cleanup } = boot({
      musicFiles: { 'gbk-novel.txt': gbk },
    })
    try {
      const res = makeRes()
      await handler(makeReq({ url: '/dsh-music/manifest' }), res)
      const data = JSON.parse(res.body)
      expect(res.status).toBe(200)
      expect(data.books.map((b) => b.name)).toEqual(['gbk-novel.txt'])
      expect(data.tracks).toEqual([])
    } finally { cleanup() }
  })

  it('synthesizing a book without a TTS key returns a clear error', async () => {
    const { handler, cleanup } = boot({
      musicFiles: { 'novel.txt': 'Hey \u8fd9\u662f\u4e00\u6bb5\u5c0f\u8bf4\u6587\u672c\u3002' },
    })
    try {
      const res = makeRes()
      await handler(makeReq({ url: '/dsh-music/book/b0' }), res)
      // No key in the test env -> host returns 500 with a Chinese diagnostic,
      // not a crash.
      expect(res.status).toBe(500)
      expect(String(res.body)).toContain('\u672a\u914d\u7f6e') // "未配置"
    } finally { cleanup() }
  })

  it('excludes non-audio files from the manifest', async () => {
    const { handler, cleanup } = boot({
      musicFiles: { 'a.mp3': 'A', 'notes.txt': 'not audio', 'cover.jpg': 'img' },
    })
    try {
      const res = makeRes()
      await handler(makeReq({ url: '/dsh-music/manifest' }), res)
      expect(JSON.parse(res.body).count).toBe(1)
    } finally { cleanup() }
  })

  it('streams a track with 200 and the correct content-type and bytes', async () => {
    const { handler, cleanup } = boot({ musicFiles: { 'song.mp3': 'X'.repeat(100) } })
    try {
      const res = makeRes()
      await handler(makeReq({ url: '/dsh-music/0' }), res)
      expect(res.status).toBe(200)
      expect(res.headers['Content-Type']).toBe('audio/mpeg')
      expect(res.headers['Content-Length']).toBe('100')
      expect(Buffer.from(res.body).length).toBe(100)
    } finally { cleanup() }
  })

  it('honours a Range request with a 206 partial response', async () => {
    const { handler, cleanup } = boot({ musicFiles: { 'song.mp3': 'ABCDEFGHIJ' } }) // 10 bytes
    try {
      const res = makeRes()
      await handler(
        makeReq({ url: '/dsh-music/0', headers: { range: 'bytes=2-5' } }),
        res,
      )
      expect(res.status).toBe(206)
      expect(res.headers['Content-Range']).toBe('bytes 2-5/10')
      expect(Buffer.from(res.body).toString()).toBe('CDEF')
      expect(res.headers['Content-Length']).toBe('4')
    } finally { cleanup() }
  })

  it('honours a suffix Range request (bytes=-N)', async () => {
    const { handler, cleanup } = boot({ musicFiles: { 'song.mp3': 'ABCDEFGHIJ' } })
    try {
      const res = makeRes()
      await handler(
        makeReq({ url: '/dsh-music/0', headers: { range: 'bytes=-3' } }),
        res,
      )
      expect(res.status).toBe(206)
      expect(Buffer.from(res.body).toString()).toBe('HIJ')
    } finally { cleanup() }
  })

  it('rejects an unsatisfiable range with 416', async () => {
    const { handler, cleanup } = boot({ musicFiles: { 'song.mp3': 'ABC' } })
    try {
      const res = makeRes()
      await handler(
        makeReq({ url: '/dsh-music/0', headers: { range: 'bytes=10-20' } }),
        res,
      )
      expect(res.status).toBe(416)
      expect(res.headers['Content-Range']).toBe('bytes */3')
    } finally { cleanup() }
  })

  it('returns 404 for an unknown track id', async () => {
    const { handler, cleanup } = boot({ musicFiles: { 'song.mp3': 'A' } })
    try {
      const res = makeRes()
      await handler(makeReq({ url: '/dsh-music/999' }), res)
      expect(res.status).toBe(404)
    } finally { cleanup() }
  })

  it('supports HEAD requests with no body', async () => {
    const { handler, cleanup } = boot({ musicFiles: { 'song.mp3': 'HEADBODY' } })
    try {
      const res = makeRes()
      await handler(makeReq({ method: 'HEAD', url: '/dsh-music/0' }), res)
      expect(res.status).toBe(200)
      expect(res.headers['Content-Length']).toBe('8')
    } finally { cleanup() }
  })

  it('switches the library root via /dsh-music/set-root', async () => {
    const { handler, home, cleanup } = boot({ musicFiles: { 'a.mp3': 'AAA' } })
    try {
      // add a second music directory under the temp home
      const other = join(home, 'OtherMusic')
      mkdirSync(other, { recursive: true })
      writeFileSync(join(other, 'x.wav'), 'WAVDATA')

      const res = makeRes()
      await handler(
        makeReq({ method: 'POST', url: '/dsh-music/set-root', body: JSON.stringify({ path: other }) }),
        res,
      )
      const data = JSON.parse(res.body)
      expect(data.ok).toBe(true)
      expect(data.count).toBe(1)
      expect(data.tracks[0].name).toBe('x.wav')
    } finally { cleanup() }
  })

  it('rejects a set-root to a non-directory path with 400', async () => {
    const { handler, home, cleanup } = boot({
      files: { 'not-a-dir.txt': 'hi' },
    })
    try {
      const res = makeRes()
      await handler(
        makeReq({ method: 'POST', url: '/dsh-music/set-root', body: JSON.stringify({ path: join(home, 'not-a-dir.txt') }) }),
        res,
      )
      expect(res.status).toBe(400)
      expect(JSON.parse(res.body).ok).toBe(false)
    } finally { cleanup() }
  })
})

describe('dsh-music-player /dir route', () => {
  it('lists subdirectories with parent/up info', async () => {
    const { handler, home, cleanup } = boot({
      files: {
        'Music/sub-a/song.mp3': 'A',
        'Music/sub-b/song.mp3': 'B',
        'Music/notes.txt': 'not a dir',
      },
    })
    try {
      const res = makeRes()
      await handler(makeReq({ url: '/dsh-music/dir?path=' + encodeURIComponent(join(home, 'Music')) }), res)
      const data = JSON.parse(res.body)
      expect(res.status).toBe(200)
      expect(data.name).toBe('Music')
      expect(data.up).toBe(home)
      const names = data.dirs.map((d) => d.name).sort()
      expect(names).toEqual(['sub-a', 'sub-b']) // files excluded
    } finally { cleanup() }
  })

  it('reports up=null at the filesystem root', async () => {
    const { handler, cleanup } = boot({ musicFiles: { 'a.mp3': 'A' } })
    try {
      const root = resolve('/')
      const res = makeRes()
      await handler(makeReq({ url: '/dsh-music/dir?path=' + encodeURIComponent(root) }), res)
      const data = JSON.parse(res.body)
      expect(res.status).toBe(200)
      expect(data.up).toBe(null)
    } finally { cleanup() }
  })

  it('handles the __drives__ sentinel on this (non-Windows) host', async () => {
    const { handler, cleanup } = boot({ musicFiles: { 'a.mp3': 'A' } })
    try {
      const res = makeRes()
      await handler(makeReq({ url: '/dsh-music/dir?path=__drives__' }), res)
      const data = JSON.parse(res.body)
      // On non-Windows the sentinel resolves to the POSIX root with no dirs.
      expect([null, '/']).toContain(data.up)
    } finally { cleanup() }
  })
})

describe('dsh-music-player music_play tool', () => {
  it('registers a music_play tool with the expected name', async () => {
    const { tools, cleanup } = boot({ musicFiles: { 'a.mp3': 'A' } })
    try {
      const tool = tools.find((t) => t.name === 'music_play')
      expect(tool).toBeTruthy()
      expect(typeof tool.description).toBe('string')
      expect(tool.description.length).toBeGreaterThan(0)
      // the tool declares a query parameter
      expect(tool.parameters.properties.query.type).toBe('string')
    } finally { cleanup() }
  })

  it('returns a notice when the library is empty', async () => {
    const { tools, cleanup } = boot({ musicFiles: {} })
    try {
      const tool = tools.find((t) => t.name === 'music_play')
      const out = await tool.execute({})
      expect(out.played).toBe(false)
      expect(typeof out.notice).toBe('string')
      expect(out.notice.length).toBeGreaterThan(0)
    } finally { cleanup() }
  })

  it('sets a play intent with the picked track id on a query play', async () => {
    const { tools, handler, cleanup } = boot({ musicFiles: { 'song.mp3': 'A', 'other.mp3': 'B' } })
    try {
      const tool = tools.find((t) => t.name === 'music_play')
      const out = await tool.execute({ query: 'song' })
      expect(out.played).toBe(true)
      expect(out.action).toBe('play')
      expect(out.track).toBe('song.mp3')
      expect(out.matches).toBe(1)
      expect(out.count).toBe(2)
      // the intent it queued for the browser carries the play action + id/name
      const res = makeRes()
      await handler(makeReq({ url: '/dsh-music/intent' }), res)
      const intent = JSON.parse(res.body)
      expect(intent.action).toBe('play')
      expect(typeof intent.id).toBe('string')
      expect(intent.name).toBe('song.mp3')
    } finally { cleanup() }
  })

  it('prefers an exact filename match over a substring match', async () => {
    const { tools, handler, cleanup } = boot({ musicFiles: { 'a.mp3': 'A', 'ab.mp3': 'B' } })
    try {
      const tool = tools.find((t) => t.name === 'music_play')
      const out = await tool.execute({ query: 'a' })   // matches both a.mp3 and ab.mp3
      expect(out.played).toBe(true)
      expect(out.matches).toBe(2)
      expect(out.track).toBe('a.mp3')                   // exact filename match wins
      const res = makeRes()
      await handler(makeReq({ url: '/dsh-music/intent' }), res)
      expect(JSON.parse(res.body).name).toBe('a.mp3')
    } finally { cleanup() }
  })

  it('queues a pause intent for the browser player', async () => {
    const { tools, handler, cleanup } = boot({ musicFiles: { 'a.mp3': 'A' } })
    try {
      const tool = tools.find((t) => t.name === 'music_play')
      const out = await tool.execute({ action: 'pause' })
      expect(out.action).toBe('pause')
      expect(out.played).toBe(false)
      expect(out.count).toBe(1)
      const res = makeRes()
      await handler(makeReq({ url: '/dsh-music/intent' }), res)
      // transport actions carry no id
      expect(JSON.parse(res.body)).toEqual({ action: 'pause' })
    } finally { cleanup() }
  })

  it('queues next/prev/stop/resume intents', async () => {
    const { tools, handler, cleanup } = boot({ musicFiles: { 'a.mp3': 'A' } })
    try {
      const tool = tools.find((t) => t.name === 'music_play')
      for (const action of ['next', 'prev', 'stop', 'resume']) {
        const out = await tool.execute({ action })
        expect(out.action).toBe(action)
        const res = makeRes()
        await handler(makeReq({ url: '/dsh-music/intent' }), res)
        expect(JSON.parse(res.body)).toEqual({ action })
      }
    } finally { cleanup() }
  })

  it('plays a novel via music_play when the query matches only a book', async () => {
    const { tools, handler, cleanup } = boot({
      musicFiles: { 'song.mp3': 'A', '真相 作者：石楠.txt': '第一章\n这是正文。' },
    })
    try {
      const tool = tools.find((t) => t.name === 'music_play')
      const out = await tool.execute({ query: '真相' })
      expect(out.played).toBe(true)
      expect(out.kind).toBe('book')
      expect(out.track).toContain('真相')
      // the queued intent targets the novel for AI 讲书
      const res = makeRes()
      await handler(makeReq({ url: '/dsh-music/intent' }), res)
      const intent = JSON.parse(res.body)
      expect(intent.action).toBe('play')
      expect(intent.kind).toBe('book')
      expect(intent.name).toContain('真相')
    } finally { cleanup() }
  })

  it('plays the first novel when the library has music but the query hits no track', async () => {
    const { tools, handler, cleanup } = boot({
      musicFiles: { 'song.mp3': 'A', '中国制造 作者：周梅森.txt': '第一章\n这是正文。' },
    })
    try {
      const tool = tools.find((t) => t.name === 'music_play')
      const out = await tool.execute({ query: '中国制造' })
      expect(out.played).toBe(true)
      expect(out.kind).toBe('book')
      expect(out.track).toContain('中国制造')
    } finally { cleanup() }
  })

  it('plays the first novel when the library has no music at all', async () => {
    const { tools, handler, cleanup } = boot({ musicFiles: { 'novel.txt': '第一章\n这是正文。' } })
    try {
      const tool = tools.find((t) => t.name === 'music_play')
      const out = await tool.execute({})
      expect(out.played).toBe(true)
      expect(out.kind).toBe('book')
      const res = makeRes()
      await handler(makeReq({ url: '/dsh-music/intent' }), res)
      expect(JSON.parse(res.body).kind).toBe('book')
    } finally { cleanup() }
  })
})

describe('dsh-music-player parseBookStructure', () => {
  it('splits a novel into 简介 / chapters / 尾声 and derives title+author', () => {
    const text = [
      '中国制造 作者：周梅森',
      '',
      '简介',
      '这是一段简介内容，概述全书。',
      '',
      '第一章　闪电划过星空',
      '这是第一章的正文，情节展开。',
      '',
      '第二章　最长的一天',
      '这是第二章的正文，剧情继续。',
      '',
      '尾声',
      '这就是尾声了。',
    ].join('\n')
    const st = parseBookStructure(text, '中国制造 作者：周梅森.txt')
    expect(st.title).toBe('中国制造')
    expect(st.author).toBe('周梅森')
    const types = st.sections.map((s) => s.type)
    expect(types).toEqual(['preface', 'chapter', 'chapter', 'epilogue'])
    expect(st.sections[1].heading).toContain('第一章')
  })

  it('recognizes standalone short-line (named) section headings like 麻将牌', () => {
    const text = [
      '县级夫人 作者：杨晓升',
      '',
      '麻将牌',
      '男人当道，女人当家。这是正文第一段，文字很长很长很长很长很长。' + '正文。'.repeat(220),
      '',
      '青远县',
      '这也是一个分节的正文段落，内容同样足够长，足以视为正文。' + '正文。'.repeat(220),
      '',
      '尾声',
      '结束了。',
    ].join('\n')
    const st = parseBookStructure(text, '县级夫人 作者：杨晓升.txt')
    expect(st.sections.map((s) => s.type)).toEqual(['named', 'named', 'epilogue'])
    expect(st.sections[0].heading).toBe('麻将牌')
    expect(st.sections[1].heading).toBe('青远县')
  })

  it('rejects a run of short lyric lines as headings', () => {
    const text = [
      '第一章',
      '这是第一章的正文第一行。',
      '',
      '能不能让我陪着你走',
      '既然你说留不住你',
      '回去的路有些黑暗',
      '担心让你一个人走',
      '',
      '第二章',
      '这是第二章的正文。',
    ].join('\n')
    const st = parseBookStructure(text, 'novel.txt')
    const chapters = st.sections.filter((s) => s.type === 'chapter')
    expect(chapters.length).toBe(2)
    // none of the lyric lines became a section
    for (const s of st.sections) {
      expect(['能不能', '既然', '回去', '担心']).not.toContain(s.heading.slice(0, 2))
    }
  })

  it('suppresses a duplicated 目录 TOC block', () => {
    const text = [
      '目录',
      '第一章　标题一',
      '第二章　标题二',
      '第三章　标题三',
      '',
      '第一章　标题一',
      '这是第一章正文。很长很长。',
      '',
      '第二章　标题二',
      '这是第二章正文。很长很长。',
    ].join('\n')
    const st = parseBookStructure(text, 'novel.txt')
    // only the two real chapters; the toc block must not produce sections
    expect(st.sections.map((s) => s.type)).toEqual(['chapter', 'chapter'])
  })

  it('suppresses TOC rows that carry trailing page-number refs (…/12)', () => {
    const text = [
      '第一章 标题一',
      '1. 小节一——一句话介绍。/1',
      '2. 小节二——一句话介绍。/4',
      '',
      '第一章 标题一',
      '这是第一章正文，内容很长很长很长很长很长很长很长很长很长。',
      '',
      '第二章 标题二',
      '1. 小节甲——一句话介绍。/9',
      '2. 小节乙——一句话介绍。/12',
      '',
      '第二章 标题二',
      '这是第二章正文，内容同样很长很长很长很长很长很长很长很长。',
    ].join('\n')
    const st = parseBookStructure(text, 'novel.txt')
    // only the two real chapters survive; the /N-page-ref rows are suppressed
    expect(st.sections.map((s) => s.type)).toEqual(['chapter', 'chapter'])
  })

  it('strips WPS typesetting codes before classification', () => {
    const text = '第一章\n正文内容很长。\n\n〖BT3〗第二章\n第二段正文。\n'
    const st = parseBookStructure(text, 'novel.txt')
    expect(st.sections.map((s) => s.type)).toEqual(['chapter', 'chapter'])
    expect(st.sections[1].heading).toBe('第二章')
  })

  it('folds a tiny named section back into the previous section (noise gate)', () => {
    const text = [
      '第一章',
      '这是第一章正文，很长很长的一段文字内容，足够长了。',
      '',
      '小节',
      '这是一段超过二十个字的短正文内容。它只有这一段。',
      '',
      '第二章',
      '这是第二章正文内容。',
    ].join('\n')
    const st = parseBookStructure(text, 'novel.txt')
    expect(st.sections.map((s) => s.type)).toEqual(['chapter', 'chapter'])
  })

  it('accepts a strong heading with no blank line above it', () => {
    const text = [
      '第一部 禁地',
      '这是第一部的正文。',
      '第二部 荒 村',
      '这是第二部的正文。',
    ].join('\n')
    const st = parseBookStructure(text, 'novel.txt')
    expect(st.sections.map((s) => s.type)).toEqual(['part', 'part'])
    expect(st.sections[1].heading).toBe('第二部 荒 村')
  })

  it('reports a valid textStart (offset in the normalized text) per section', () => {
    const text = [
      '第一章 标题甲',
      '这是第一章正文，句子足够长。',
      '',
      '第二章 标题乙',
      '这是第二章正文，句子足够长。',
    ].join('\n')
    const st = parseBookStructure(text, 'novel.txt')
    expect(st.sections.length).toBe(2)
    const norm = text.replace(/\uFEFF/g, '').replace(/\r\n?/g, '\n')
    for (const s of st.sections) {
      expect(typeof s.textStart).toBe('number')
      expect(s.textStart).toBeGreaterThanOrEqual(0)
      expect(s.textStart).toBeLessThan(norm.length)
      // the offset points at the heading text in the normalized source
      expect(norm.slice(s.textStart, s.textStart + s.heading.length)).toContain(
        s.heading.replace(/\s+/g, '').slice(0, 2),
      )
    }
    // section offsets are increasing
    expect(st.sections[1].textStart).toBeGreaterThan(st.sections[0].textStart)
  })
})

describe('dsh-music-player book structure meta route', () => {
  it('returns title/author/sections with monotonic fromChunk from /book/<id>/meta', async () => {
    const text = [
      '真相 作者：石楠',
      '',
      '第一章',
      '这是第一章正文，句子长度足以形成多个分块。',
      '',
      '第二章',
      '这是第二章正文。',
      '',
      '尾声',
      '结束了。',
    ].join('\n')
    const { handler, cleanup } = boot({ musicFiles: { 'novel.txt': text } })
    try {
      const res = makeRes()
      await handler(makeReq({ url: '/dsh-music/book/b0/meta' }), res)
      expect(res.status).toBe(200)
      const data = JSON.parse(res.body)
      expect(data.title).toBe('真相')
      expect(data.author).toBe('石楠')
      expect(Array.isArray(data.sections)).toBe(true)
      expect(data.sections.length).toBeGreaterThan(0)
      // fromChunk is a valid chunk index and non-decreasing across sections
      let prev = -1
      for (const sec of data.sections) {
        expect(sec.fromChunk).toBeGreaterThanOrEqual(0)
        expect(sec.fromChunk).toBeLessThan(data.total)
        expect(sec.fromChunk).toBeGreaterThanOrEqual(prev)
        expect(typeof sec.heading).toBe('string')
        expect(sec.heading.length).toBeGreaterThan(0)
        prev = sec.fromChunk
      }
    } finally { cleanup() }
  })
})

describe('dsh-music-player playlists', () => {
  // helper: run a JSON POST and return the parsed body
  async function post(handler, url, payload) {
    const res = makeRes()
    await handler(
      makeReq({ method: 'POST', url, body: JSON.stringify(payload) }),
      res,
    )
    return { status: res.status, data: JSON.parse(res.body) }
  }

  it('exposes the fixed system playlist 我最喜欢 in the manifest', async () => {
    const { handler, cleanup } = boot({ musicFiles: { 'a.mp3': 'A' } })
    try {
      const res = makeRes()
      await handler(makeReq({ url: '/dsh-music/manifest' }), res)
      const data = JSON.parse(res.body)
      expect(Array.isArray(data.playlists)).toBe(true)
      const fav = data.playlists.find((p) => p.id === 'pl-fav')
      expect(fav).toBeTruthy()
      expect(fav.name).toBe('我最喜欢')
      expect(fav.fixed).toBe(true)
      expect(fav.count).toBe(0)
      expect(fav.tracks).toEqual([])
    } finally { cleanup() }
  })

  it('creates a custom playlist and reports it in the manifest', async () => {
    const { handler, cleanup } = boot({ musicFiles: { 'a.mp3': 'A' } })
    try {
      const r = await post(handler, '/dsh-music/playlist', { name: '通勤' })
      expect(r.status).toBe(200)
      expect(r.data.ok).toBe(true)
      expect(r.data.playlist.id).toMatch(/^pl-/)
      expect(r.data.playlist.name).toBe('通勤')
      expect(r.data.playlist.fixed).toBe(false)
      const res = makeRes()
      await handler(makeReq({ url: '/dsh-music/manifest' }), res)
      const names = JSON.parse(res.body).playlists.map((p) => p.name)
      expect(names).toContain('通勤')
    } finally { cleanup() }
  })

  it('rejects an empty playlist name', async () => {
    const { handler, cleanup } = boot({ musicFiles: {} })
    try {
      const r = await post(handler, '/dsh-music/playlist', { name: '   ' })
      expect(r.status).toBe(400)
      expect(r.data.ok).toBe(false)
    } finally { cleanup() }
  })

  it('adds audio files to a playlist (dedup, skip invalid) and streams them via /file', async () => {
    const { handler, home, cleanup } = boot({
      files: { 'extra/clip.mp3': 'CLIPDATA', 'extra/notes.txt': 'nope' },
      musicFiles: { 'a.mp3': 'A' },
    })
    try {
      const clip = join(home, 'extra', 'clip.mp3')
      const created = await post(handler, '/dsh-music/playlist', { name: 'P' })
      const id = created.data.playlist.id
      // adding the same path twice should dedup; a .txt must be skipped
      const add = await post(handler, '/dsh-music/playlist/add', {
        id, paths: [clip, clip, join(home, 'extra', 'notes.txt')],
      })
      expect(add.data.ok).toBe(true)
      expect(add.data.added).toBe(1)
      expect(add.data.playlist.count).toBe(1)
      expect(add.data.playlist.missing).toBe(0)
      expect(add.data.playlist.tracks[0].name).toBe('clip.mp3')
      expect(add.data.playlist.tracks[0].url.startsWith('/dsh-music/file?path=')).toBe(true)
      expect(add.data.playlist.tracks[0].size).toBe('CLIPDATA'.length)
      // the generic streaming route serves the playlist member
      const res = makeRes()
      await handler(makeReq({ url: add.data.playlist.tracks[0].url }), res)
      expect(res.status).toBe(200)
      expect(res.headers['Content-Type']).toBe('audio/mpeg')
      expect(Buffer.from(res.body).toString()).toBe('CLIPDATA')
    } finally { cleanup() }
  })

  it('streams a playlist member with Range (206) via /file', async () => {
    const { handler, home, cleanup } = boot({
      files: { 'extra/clip.mp3': 'ABCDEFGHIJ' },
    })
    try {
      const clip = join(home, 'extra', 'clip.mp3')
      const created = await post(handler, '/dsh-music/playlist', { name: 'P' })
      await post(handler, '/dsh-music/playlist/add', { id: created.data.playlist.id, paths: [clip] })
      const res = makeRes()
      await handler(makeReq({
        url: '/dsh-music/file?path=' + encodeURIComponent(clip),
        headers: { range: 'bytes=2-5' },
      }), res)
      expect(res.status).toBe(206)
      expect(res.headers['Content-Range']).toBe('bytes 2-5/10')
      expect(Buffer.from(res.body).toString()).toBe('CDEF')
    } finally { cleanup() }
  })

  it('rejects /file for an unregistered path with 403 and a missing file with 404', async () => {
    const { handler, home, cleanup } = boot({
      files: { 'secret.mp3': 'SECRET', 'm/clip.mp3': 'CLIP' },
    })
    try {
      const secret = join(home, 'secret.mp3')
      // never added to any playlist -> not registered
      const forbidden = makeRes()
      await handler(makeReq({ url: '/dsh-music/file?path=' + encodeURIComponent(secret) }), forbidden)
      expect(forbidden.status).toBe(403)
      // register a real file, then delete it from disk -> still registered, now 404
      const clip = join(home, 'm', 'clip.mp3')
      const created = await post(handler, '/dsh-music/playlist', { name: 'P' })
      await post(handler, '/dsh-music/playlist/add', { id: created.data.playlist.id, paths: [clip] })
      rmSync(clip, { force: true })
      const gone = makeRes()
      await handler(makeReq({ url: '/dsh-music/file?path=' + encodeURIComponent(clip) }), gone)
      expect(gone.status).toBe(404)
    } finally { cleanup() }
  })

  it('removes tracks from a playlist', async () => {
    const { handler, home, cleanup } = boot({
      files: { 'm/a.mp3': 'A', 'm/b.mp3': 'B' },
    })
    try {
      const a = join(home, 'm', 'a.mp3')
      const b = join(home, 'm', 'b.mp3')
      const created = await post(handler, '/dsh-music/playlist', { name: 'P' })
      const id = created.data.playlist.id
      await post(handler, '/dsh-music/playlist/add', { id, paths: [a, b] })
      const rm = await post(handler, '/dsh-music/playlist/remove', { id, paths: [a] })
      expect(rm.data.removed).toBe(1)
      expect(rm.data.playlist.tracks.map((t) => t.name)).toEqual(['b.mp3'])
    } finally { cleanup() }
  })

  it('reorders playlist members, appending unmentioned ones at the end', async () => {
    const { handler, home, cleanup } = boot({
      files: { 'm/a.mp3': 'A', 'm/b.mp3': 'B', 'm/c.mp3': 'C' },
    })
    try {
      const a = join(home, 'm', 'a.mp3')
      const b = join(home, 'm', 'b.mp3')
      const c = join(home, 'm', 'c.mp3')
      const created = await post(handler, '/dsh-music/playlist', { name: 'P' })
      const id = created.data.playlist.id
      await post(handler, '/dsh-music/playlist/add', { id, paths: [a, b, c] })
      const re = await post(handler, '/dsh-music/playlist/reorder', { id, paths: [c, a] })
      expect(re.data.ok).toBe(true)
      expect(re.data.playlist.tracks.map((t) => t.name)).toEqual(['c.mp3', 'a.mp3', 'b.mp3'])
    } finally { cleanup() }
  })

  it('renames a custom playlist but rejects renaming the fixed one', async () => {
    const { handler, cleanup } = boot({ musicFiles: {} })
    try {
      const created = await post(handler, '/dsh-music/playlist', { name: 'P' })
      const ok = await post(handler, '/dsh-music/playlist/rename', { id: created.data.playlist.id, name: '新名字' })
      expect(ok.data.ok).toBe(true)
      expect(ok.data.playlist.name).toBe('新名字')
      const fixed = await post(handler, '/dsh-music/playlist/rename', { id: 'pl-fav', name: '改' })
      expect(fixed.status).toBe(400)
      expect(fixed.data.ok).toBe(false)
    } finally { cleanup() }
  })

  it('deletes a custom playlist but rejects deleting the fixed one', async () => {
    const { handler, cleanup } = boot({ musicFiles: {} })
    try {
      const created = await post(handler, '/dsh-music/playlist', { name: 'P' })
      const ok = await post(handler, '/dsh-music/playlist/delete', { id: created.data.playlist.id })
      expect(ok.data.ok).toBe(true)
      const fixed = await post(handler, '/dsh-music/playlist/delete', { id: 'pl-fav' })
      expect(fixed.status).toBe(400)
      expect(fixed.data.ok).toBe(false)
    } finally { cleanup() }
  })

  it('persists playlists to the state file and reloads a pre-seeded file', async () => {
    const { handler, home, cleanup } = boot({
      files: {
        '.dsh/music-player-playlists.json': JSON.stringify({
          version: 1,
          playlists: [{ id: 'pl-seed', name: '预置歌单', fixed: false, trackPaths: [], createdAt: 1, updatedAt: 1 }],
        }),
      },
    })
    try {
      const res = makeRes()
      await handler(makeReq({ url: '/dsh-music/manifest' }), res)
      const names = JSON.parse(res.body).playlists.map((p) => p.name)
      expect(names).toContain('预置歌单') // loaded from the pre-seeded file
      expect(names).toContain('我最喜欢') // system playlist still guaranteed
      // a create writes the file back
      await post(handler, '/dsh-music/playlist', { name: '持久' })
      const file = join(home, '.dsh', 'music-player-playlists.json')
      expect(existsSync(file)).toBe(true)
      const saved = JSON.parse(readFileSync(file, 'utf8'))
      expect(saved.playlists.map((p) => p.name)).toContain('持久')
    } finally { cleanup() }
  })

  it('lists directories plus audio files (excluding others) via /files', async () => {
    const { handler, home, cleanup } = boot({
      files: { 'Music/sub/song.mp3': 'A', 'Music/a.mp3': 'B', 'Music/b.mp3': 'C', 'Music/notes.txt': 'x' },
    })
    try {
      const res = makeRes()
      await handler(makeReq({ url: '/dsh-music/files?path=' + encodeURIComponent(join(home, 'Music')) }), res)
      const data = JSON.parse(res.body)
      expect(res.status).toBe(200)
      expect(data.dirs.map((d) => d.name)).toEqual(['sub'])
      const fileNames = data.files.map((f) => f.name).sort()
      expect(fileNames).toEqual(['a.mp3', 'b.mp3'])
      for (const f of data.files) expect(typeof f.path).toBe('string')
    } finally { cleanup() }
  })

  it('plays a playlist via the music_play playlist param', async () => {
    const { handler, tools, home, cleanup } = boot({
      files: { 'm/a.mp3': 'A', 'm/b.mp3': 'B' },
    })
    try {
      const created = await post(handler, '/dsh-music/playlist', { name: '最爱' })
      const pl = created.data.playlist
      await post(handler, '/dsh-music/playlist/add', { id: pl.id, paths: [join(home, 'm', 'a.mp3')] })
      const tool = tools.find((t) => t.name === 'music_play')
      const out = await tool.execute({ playlist: '最爱' })
      expect(out.played).toBe(true)
      expect(out.matches).toBe(1)
      expect(out.track).toBe('a.mp3')
      const res = makeRes()
      await handler(makeReq({ url: '/dsh-music/intent' }), res)
      const intent = JSON.parse(res.body)
      expect(intent.action).toBe('play')
      expect(intent.playlistId).toBe(pl.id)
      expect(intent.playlistName).toBe('最爱')
      expect(intent.id).toBeTruthy()
    } finally { cleanup() }
  })

  it('reports an unknown playlist name via music_play', async () => {
    const { tools, cleanup } = boot({ musicFiles: { 'a.mp3': 'A' } })
    try {
      const tool = tools.find((t) => t.name === 'music_play')
      const out = await tool.execute({ playlist: '不存在的歌单' })
      expect(out.played).toBe(false)
      expect(out.notice).toContain('没有找到歌单')
    } finally { cleanup() }
  })
})
