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

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync } from 'node:fs'
import { dirname, basename, parse as pathParse, join as pathJoin } from 'node:path'
import * as os from 'node:os'

export const name = 'dsh-music-player'
export const inject = ['webServer', 'fs', 'shell', 'tools', 'systemPrompt']

export function apply(ctx) {
  let home = null
  let musicRoot = null
  let tracks = []
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
    if (file === null) return null
    try {
      const text = readFileSync(file, 'utf8')
      const data = JSON.parse(text)
      return data && typeof data.root === 'string' && data.root !== '' ? data.root : null
    } catch {
      return null
    }
  }
  const saveRoot = async (root) => {
    const file = await stateFile()
    if (file === null) return
    try {
      // Write directly with node:fs: the host ctx.fs service may fence writes
      // under a workspace policy, which silently dropped the state file.
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, JSON.stringify({ root }, null, 2) + '\n', 'utf8')
    } catch {
      // persistence is best-effort; an unwritable state file only loses the
      // remembered directory, never breaks playback
    }
  }
  const publicTracks = () => tracks.map((t) => ({
    id: t.id, name: t.name, url: t.url, size: t.size, ext: t.ext,
  }))

  const scan = async (rootPath) => {
    const target = await ctx.fs.resolve(rootPath)
    const info = await ctx.fs.stat(target)
    if (info === undefined || info.type !== 'directory') {
      throw new Error('不是有效的音乐目录: ' + rootPath)
    }
    const rootStr = ctx.fs.processPath(target)
    const found = []
    const walk = async (dir, depth) => {
      if (depth > 4 || found.length >= 500) return
      // Tolerant listing (all entries, see listEntries): dsh-fs-local's listDir
      // aborts on the first unreadable child, so scanning a drive root (or any
      // dir with protected entries) would silently yield zero tracks.
      const entries = listEntries(dir)
      for (const entry of entries) {
        if (found.length >= 500) return
        const abs = pathJoin(dir, entry.name)
        try {
          if (entry.isDir) { await walk(abs, depth + 1); continue }
          if (!isAudioName(entry.name)) continue
          const st = statSync(abs)
          if (!st.isFile()) continue
          const rel = abs.startsWith(rootStr) ? abs.slice(rootStr.length + 1) : entry.name
          found.push({
            name: rel, path: abs, size: st.size || 0,
            ext: entry.name.slice(entry.name.lastIndexOf('.') + 1).toLowerCase(),
          })
        } catch {
          // unreadable entry: skip it, keep walking the rest
        }
      }
    }
    await walk(rootStr, 0)
    found.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    return { rootPath: rootStr, found }
  }

  const refresh = async () => {
    if (musicRoot === null) { tracks = []; return { root: null, tracks: [], count: 0 } }
    const { rootPath, found } = await scan(musicRoot)
    tracks = found.map((t, i) => ({
      id: String(i), name: t.name, path: t.path, size: t.size, ext: t.ext, url: '/dsh-music/' + i,
    }))
    return { root: rootPath, tracks: publicTracks(), count: tracks.length }
  }
  const init = async () => {
    const h = await getHome()
    // Use path.join so the default root uses the platform separator; on Windows
    // a bare h + '/Music' produced a mixed "C:\Users\x/Music" root.
    let root = h === null ? null : pathJoin(h, 'Music')
    // Restore the user's last chosen directory; validate it so a deleted or
    // renamed directory falls back to the default instead of erroring.
    const stored = await loadStoredRoot()
    if (stored !== null && stored !== '') {
      try {
        const target = await ctx.fs.resolve(stored)
        const info = await ctx.fs.stat(target)
        if (info !== undefined && info.type === 'directory') root = ctx.fs.processPath(target)
      } catch {
        // unreadable stored path -> keep the default
      }
    }
    musicRoot = root
    try {
      return await refresh()
    } catch (err) {
      musicRoot = null
      tracks = []
      return { root: null, tracks: [], count: 0, error: String((err && err.message) || err) }
    }
  }
  const ensureStarted = () => { if (startupPromise === null) startupPromise = init(); return startupPromise }

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
        writeJson(res, { root: musicRoot, tracks: publicTracks(), count: tracks.length })
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
          await saveRoot(musicRoot)
          writeJson(res, { ok: true, root: data.root, tracks: data.tracks, count: data.count })
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
