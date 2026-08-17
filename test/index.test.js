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

import { apply } from '../lib/index.js'

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
})
