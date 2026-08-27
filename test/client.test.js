/**
 * Front-end smoke tests for the browser half (lib/client.js).
 *
 * Strategy: load the client factory under jsdom with stubbed browser globals
 * (Audio / fetch / timers), run its apply() with a fake ctx whose slots capture
 * the registered React elements, then either renderToString them (static smoke)
 * or mount with react-dom/client + act to exercise interactions (open the
 * panel, switch to a playlist, clear it, reach the empty state).
 */
// @vitest-environment jsdom

import { describe, it, expect, beforeEach, vi } from 'vitest'
import React, { act } from 'react'
import { renderToString } from 'react-dom/server'
import { createRoot } from 'react-dom/client'

// React 18 requires this flag so act() works without warnings in test envs.
globalThis.IS_REACT_ACT_ENVIRONMENT = true

// ---- captured plugin data ----
let factory = null
let registered = [] // [{ id, elementFactory }]
let manifest = null

// ---- minimal browser stubs ----
class FakeAudio {
  constructor() {
    this.listeners = {}
    this.currentTime = 0
    this.duration = 0
    this.volume = 0.8
    this.paused = true
    this.src = ''
    this.currentSrc = ''
    this.preload = 'auto'
    this.style = {}
  }
  addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn) }
  removeEventListener() {}
  load() {}
  play() { this.paused = false; return Promise.resolve() }
  pause() { this.paused = true }
  removeAttribute() {}
}

function makePlaylist(id, name, fixed, paths) {
  return {
    id, name, fixed,
    count: paths.length, missing: 0,
    tracks: paths.map((p) => ({
      id: 'p:' + p, name: p.split('/').pop(),
      url: '/dsh-music/file?path=' + encodeURIComponent(p), size: 10, path: p,
    })),
  }
}

function jsonRes(obj) {
  return Promise.resolve({ ok: true, status: 200, json: async () => obj, text: async () => JSON.stringify(obj) })
}
// 与客户端一致：字幕行长度按「去标点后的字数」计（标点不计入）。
const subPunct = '，。！？…：；、“”‘’（）《》—～·`~!@#$%^&*()-_=+[]{};\':",.<>/?\\|'
const subContentLen = (s) => [...String(s)].filter((c) => !subPunct.includes(c) && !/\s/.test(c)).length
// records the last /dsh-music/files path requested (to assert the initial dir)
let lastFilesUrl = null
// test hook: sections served for /dsh-music/book/*/meta (set before bootClient so
// the refresh-restore path — which fetches meta during load — sees them too)
let bookMetaSections = []
// test hook: per-book sections keyed by book id, so different books can report
// different structures (e.g. one with chapters, one without) in the same test.
let bookMetaById = {}
// test hook: per-book、逐块累积字符偏移（charOffsets）用于「已读字符/全书字符」的
// 讲书进度条测试；bookCharOffsetsById 可按 book id 覆盖 bookCharOffsets。
let bookCharOffsets = []
let bookCharOffsetsById = {}
// test hook: /dsh-music/book/*/text?from= response chunk text (for the AI 讲书
// subtitle-line splitting test).
let bookTextFixture = ''
// test hook: whether /dsh-music/qq/status reports logged-in (set before rendering).
let qqLoggedIn = false
// test hook: records /dsh-music/qq/fav POST bodies (action/song) for assertion.
let favCalls = []
// test hook: records /dsh-music/qq/playlist-delete POST bodies (dirId) + delete outcome.
let delPlaylistCalls = []
// test hook: makes the next /dsh-music/qq/playlist-delete POST fail (ok:false).
let delPlaylistFail = false
// test hook: records every /dsh-music/qq/* URL fetched, for asserting the
// "未登录不发外部请求 / 登录后才加载" gate.
let qqFetchLog = []
// test hook: /dsh-music/lyric?path= response (parsed LRC or {ok:false}).
let lyricFixture = null
// test hook: /dsh-music/lyric/online?path= response (本地无 .lrc → 在线兜底取词).
let lyricOnlineFixture = null
// test hook: /dsh-music/qq/lyric?songmid= response (QQ lyric + optional trans).
let qqLyricFixture = null
// ---- Host prefs mirror (the client's authoritative store is the Host; old
// localStorage is only a read-backup + upgrade migration source) ----
// `prefsServer` is the test's view of the Host's music-player-prefs.json.
// `prefsPosts` records every POST /dsh-music/prefs body for assertions.
// `prefsPostOpts` records the fetch options (e.g. keepalive) of each POST.
let prefsServer = {}
let prefsPosts = []
let prefsPostOpts = []
async function fetchStub(url, opts) {
  const u = String(url)
  const o = opts || {}
  if (u === '/dsh-music/prefs') {
    if (o && o.method === 'POST') {
      const body = JSON.parse(o.body || '{}')
      prefsPosts.push(body)
      prefsPostOpts.push({ keepalive: o.keepalive, bodyLen: (o.body || '').length })
      Object.assign(prefsServer, body.prefs || {})
      for (const k of (body.remove || [])) delete prefsServer[k]
      return jsonRes({ ok: true, prefs: prefsServer })
    }
    return jsonRes({ ok: true, prefs: prefsServer })
  }
  if (String(u).startsWith('/dsh-music/qq/')) qqFetchLog.push(u.split('?')[0])
  if (u.startsWith('/dsh-music/lyric?path=')) {
    return jsonRes(lyricFixture || { ok: false, hasLrc: false })
  }
  if (u.startsWith('/dsh-music/lyric/online?path=')) {
    return jsonRes(lyricOnlineFixture || { ok: true, hasLyric: false })
  }
  if (u.startsWith('/dsh-music/qq/lyric?songmid=')) {
    return jsonRes(qqLyricFixture || { ok: false, error: 'no lyric' })
  }
  if (u === '/dsh-music/qq/fav' && o && o.method === 'POST') {
    try { favCalls.push(JSON.parse(o.body || '{}')) } catch {}
    return jsonRes({ ok: true, faved: true })
  }
  if (u === '/dsh-music/qq/playlist-delete' && o && o.method === 'POST') {
    try { delPlaylistCalls.push(JSON.parse(o.body || '{}')) } catch {}
    if (delPlaylistFail) return jsonRes({ ok: false, error: '删除失败（模拟）' })
    return jsonRes({ ok: true })
  }
  if (u === '/dsh-music/manifest') return jsonRes(manifest)
  if (u === '/dsh-music/set-root') {
    return jsonRes({ ok: true, root: '/music', bookRoot: '/books', tracks: manifest.tracks || [], books: manifest.books || [], count: (manifest.tracks || []).length })
  }
  if (u === '/dsh-music/set-book-root') {
    return jsonRes({ ok: true, root: '/music', bookRoot: '/books', tracks: manifest.tracks || [], books: manifest.books || [], count: (manifest.tracks || []).length })
  }
  if (u === '/dsh-music/intent') return jsonRes(null)
  if (u === '/dsh-music/qq/status') return jsonRes({ loggedIn: qqLoggedIn, uin: qqLoggedIn ? '123456' : '' })
  if (u.includes('/dsh-music/qq/search')) {
    return jsonRes({ ok: true, isVip: false, results: [{ id: '123', songmid: '123', title: '晴天', artists: ['周杰伦'], album: '叶惠美', payplay: 0, source: 'qq' }] })
  }
  if (u === '/dsh-music/qq/my-playlists') {
    return jsonRes({ ok: true, playlists: [
      { id: 'mine1', name: '我的收藏', creator: '我', trackCount: 2, source: 'qq', dirId: 987, tid: 987 },
      { id: 'mine2', name: '第二个歌单', creator: '我', trackCount: 5, source: 'qq', dirId: 888, tid: 888 },
    ] })
  }
  if (u === '/dsh-music/qq/playlist-categories') {
    return jsonRes({ ok: true, categories: [{ id: '1', name: '国语', group: '语种' }, { id: '2', name: '欧美', group: '语种' }] })
  }
  if (u.includes('/dsh-music/qq/playlist-search')) {
    return jsonRes({ ok: true, playlists: [{ id: 's1', name: '周杰伦合集', creator: 'UP主', trackCount: 100, source: 'qq' }] })
  }
  if (u === '/dsh-music/qq/top-lists') {
    return jsonRes({ ok: true, groups: [{ id: '0', name: '巅峰榜', toplists: [{ id: '62', name: '飙升榜', cover: 'https://x.jpg', listenNum: 12345 }] }] })
  }
  if (u.includes('/dsh-music/qq/top-songs')) {
    const offset = parseInt(new URL('http://x' + u).searchParams.get('offset') || '0', 10) || 0
    // 榜单共 5 首，每页 2 首：offset 0 -> [a,b], 2 -> [c,d], 4 -> [e]
    const all = [
      { id: 'a', songmid: 'a', title: '飙升歌一', artists: ['歌手1'], payplay: 0, source: 'qq' },
      { id: 'b', songmid: 'b', title: '飙升歌二', artists: ['歌手2'], payplay: 0, source: 'qq' },
      { id: 'c', songmid: 'c', title: '飙升歌三', artists: ['歌手3'], payplay: 0, source: 'qq' },
      { id: 'd', songmid: 'd', title: '飙升歌四', artists: ['歌手4'], payplay: 0, source: 'qq' },
      { id: 'e', songmid: 'e', title: '飙升歌五', artists: ['歌手5'], payplay: 0, source: 'qq' },
    ]
    const page = all.slice(offset, offset + 2)
    return jsonRes({ ok: true, toplist: { id: '62', name: '飙升榜', cover: 'https://x.jpg', total: all.length, hasMore: offset + page.length < all.length, songs: page } })
  }
  if (u === '/dsh-music/qq/liked') {
    return jsonRes({ ok: true, ids: [789001, 999], mids: ['789', '999'] })
  }
  if (u.startsWith('/dsh-music/qq/playlist/')) {
    return jsonRes({ ok: true, playlist: { id: '111', name: '推荐歌单', creator: '作者', trackCount: 2, source: 'qq', songs: [
      { id: '789', songmid: '789', title: '告白气球', artists: ['周杰伦'], songid: 789001, songtype: 0, payplay: 0, source: 'qq' },
      { id: '790', songmid: '790', title: '七里香', artists: ['周杰伦'], songid: 790002, songtype: 0, payplay: 0, source: 'qq' },
    ] } })
  }
  if (u === '/dsh-music/qq/playlists') {
    return jsonRes({ ok: true, playlists: [{ id: '111', name: '热门推荐', creator: '作者', trackCount: 50, source: 'qq' }] })
  }
  if (u.includes('/dsh-music/qq/playlists?category=')) {
    return jsonRes({ ok: true, playlists: [{ id: 'cat1', name: '国语歌单', creator: '作者', trackCount: 30, source: 'qq' }] })
  }
  if (u.includes('/dsh-music/book/') && u.endsWith('/meta')) {
    const id = u.split('/')[3] || 'b1'
    const sections = bookMetaById[id] !== undefined ? bookMetaById[id] : bookMetaSections
    const offsets = bookCharOffsetsById[id] !== undefined ? bookCharOffsetsById[id] : bookCharOffsets
    return jsonRes({
      id, name: '测试小说', total: 25, title: '测试小说', author: '佚名', sections,
      charOffsets: offsets, totalChars: offsets.length > 0 ? offsets[offsets.length - 1] : 0,
    })
  }
  if (u.includes('/dsh-music/book/') && u.includes('/text?from=')) {
    const from = parseInt(new URL('http://x' + u).searchParams.get('from') || '0', 10) || 0
    return jsonRes({ ok: true, from, text: bookTextFixture })
  }
  if (u.startsWith('/dsh-music/files')) {
    lastFilesUrl = u
    return jsonRes({ path: '/music', name: 'Music', up: '/', dirs: [], files: [{ name: 'a.mp3', path: '/music/a.mp3', size: 10, ext: 'mp3' }] })
  }
  if (u === '/dsh-music/playlist/clear') {
    const body = JSON.parse(o.body || '{}')
    const pl = (manifest.playlists || []).find((p) => p.id === body.id)
    if (pl) { pl.count = 0; pl.missing = 0; pl.tracks = [] }
    return jsonRes({ ok: true, cleared: 1, playlist: pl })
  }
  return jsonRes({})
}

async function bootClient() {
  factory = null
  registered = []
  window.__ModuleLoader__ = { load: (def) => { factory = def.factory } }
  vi.stubGlobal('Audio', FakeAudio)
  vi.stubGlobal('fetch', fetchStub)
  vi.stubGlobal('requestAnimationFrame', () => 0)
  vi.stubGlobal('cancelAnimationFrame', () => {})
  vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '' }))
  vi.stubGlobal('setInterval', () => 0) // intent poll: keep from firing
  vi.stubGlobal('clearInterval', () => {})
  window.confirm = () => true
  window.prompt = () => null

  // loading the module runs window.__ModuleLoader__.load -> captures the factory
  await import('../lib/client.js')
  expect(factory).toBeTruthy()
  const modExports = factory((name) => (name === 'react' ? React : undefined))

  const slots = {
    inject: (name, cb) => { cb() },
    register: (meta, elementFactory) => { registered.push({ id: meta.id, elementFactory }); return elementFactory },
  }
  const ctx = {
    get: (k) => (k === 'slots' ? slots : undefined),
    effect: (fn) => fn(),
  }
  modExports.apply(ctx)
  // let the async loadTracks() (manifest fetch -> set store) finish
  await new Promise((r) => setTimeout(r, 0))
  return {
    bar: () => (registered.find((r) => r.id === 'music-player-bar') || {}).elementFactory,
    panel: () => (registered.find((r) => r.id === 'music-player-panel') || {}).elementFactory,
  }
}

function baseManifest() {
  return {
    root: '/music', bookRoot: '/books',
    tracks: [{ id: '0', name: 'a.mp3', url: '/dsh-music/0', size: 10, ext: 'mp3', path: '/music/a.mp3' }],
    books: [], count: 1, ttsConfigured: false, ttsReason: '', voices: [],
    playlists: [
      makePlaylist('pl-fav', '我最喜欢', true, []),
      makePlaylist('pl-1', '通勤', false, ['/music/a.mp3']),
    ],
  }
}

beforeEach(async () => {
  vi.resetModules()
  prefsServer = {}
  prefsPosts = []
  prefsPostOpts = []
  localStorage.clear() // isolated legacy browser-store between tests
  lastFilesUrl = null
  bookMetaSections = []
  bookMetaById = {}
  bookCharOffsets = []
  bookCharOffsetsById = {}
  qqLoggedIn = false
  favCalls = []
  delPlaylistCalls = []
  delPlaylistFail = false
  qqFetchLog = []
  lyricOnlineFixture = null
  manifest = baseManifest()
  await bootClient()
})

describe('dsh-music-player client render smoke', () => {
  it('renders the now-playing bar without throwing', () => {
    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const html = renderToString(bar)
    expect(html).toContain('DSH音乐播放器')
    // idle state (no track) shows the music note icon
    expect(html).toContain('M12 3v10.55')
  })

  it('restores volume/mode/voice from the Host prefs snapshot and mirrors changes back (dsh-desktop fix)', async () => {
    // dsh-desktop: the Host snapshot is the only source of truth (no browser
    // storage at all). Seed the Host prefs and re-boot so the client restores
    // volume/mode/voice from it, then verify changes flush back to the Host.
    prefsServer = { 'dsh-music-volume': '0.42', 'dsh-music-mode': 'shuffle', 'dsh-music-voice': '碧瑶' }
    vi.resetModules(); registered = []; prefsPosts = []; lastFilesUrl = null
    await bootClient()

    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar)) })

    // mode restored from Host ('乱序播放')
    const modeBtn = [...container.querySelectorAll('.dsh-music-mode-trigger')].find((b) => b.title.startsWith('乱序播放'))
    expect(modeBtn).toBeTruthy()

    // volume restored from Host (42%)
    const volBtn = [...container.querySelectorAll('.dsh-music-mode-trigger')].find((b) => b.title === '音量')
    expect(volBtn).toBeTruthy()
    act(() => { volBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    const volSlider = container.querySelector('.dsh-music-vol-slider')
    expect(volSlider).toBeTruthy()
    expect(volSlider.title).toBe('音量 42%')

    // changing the mode pushes the new value to the Host via POST /dsh-music/prefs
    const curModeBtn = [...container.querySelectorAll('.dsh-music-mode-trigger')].find((b) => b.title.startsWith('乱序播放'))
    act(() => { curModeBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    const single = [...document.querySelectorAll('.dsh-music-mode-item')].find((b) => b.title.includes('单曲循环'))
    expect(single).toBeTruthy()
    act(() => { single.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    // the client flushes on an ~800ms debounce; wait for it to fire
    await act(async () => { await new Promise((r) => setTimeout(r, 950)) })
    const modePost = prefsPosts.find((p) => p.prefs && p.prefs['dsh-music-mode'])
    expect(modePost).toBeTruthy()
    expect(modePost.prefs['dsh-music-mode']).toBe('single')
    // the Host's persisted snapshot reflects the new mode too
    expect(prefsServer['dsh-music-mode']).toBe('single')
  })

  it('restores the last played track and QQ search history from the Host prefs after restart', async () => {
    // Real-world scenario: the Host file has a saved playback entry + QQ search
    // history. A fresh page load must restore both (bar shows the track, the
    // QQ search box shows the keyword) with NO browser storage.
    prefsServer = {
      'dsh-music-playback': JSON.stringify({ id: '0', name: '周杰伦 - Mine Mine.wav', position: 42, duration: 210, ts: 999999999 }),
      'dsh-music-qq-history': JSON.stringify(['刀郎']),
      'dsh-music-scope': JSON.stringify({ kind: 'library' }),
    }
    qqLoggedIn = true
    vi.resetModules(); registered = []; prefsPosts = []; lastFilesUrl = null
    await bootClient()

    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    // restorePlayback resolves the saved id '0' against the current library, so
    // the bar shows that track (baseManifest track 0 = "a.mp3" -> "a"), paused.
    const nameSpan = container.querySelector('.dsh-music-bar-name')
    expect(nameSpan).toBeTruthy()
    expect(nameSpan.textContent).toContain('a')
    expect(container.querySelector('button[title="播放/暂停"]')).toBeTruthy()
    // open the panel -> QQ tab -> focus the search box -> history appears
    act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    const onlineTab = [...container.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === 'QQ音乐')
    act(() => { onlineTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const searchTab = [...container.querySelectorAll('.dsh-music-qq-viewtab')].find((b) => b.textContent === '搜索')
    act(() => { searchTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const input = container.querySelector('.dsh-music-qq-input')
    expect(input).toBeTruthy()
    act(() => { input.dispatchEvent(new Event('focusin', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const histItems = [...container.querySelectorAll('.dsh-music-qq-hist-item')]
    expect(histItems.some((b) => b.textContent === '刀郎')).toBe(true)
  })

  it('restores prefs even when the Host prefs fetch is slow (panel mounts before snapshot)', async () => {
    // Timing regression: in the real browser the /dsh-music/prefs fetch resolves
    // after the React tree mounts, so the QQ panel's mount-time history read sees
    // an empty snapshot. The prefsReady effect must re-apply it once it arrives.
    prefsServer = { 'dsh-music-qq-history': JSON.stringify(['七里香']) }
    qqLoggedIn = true
    vi.resetModules(); registered = []; prefsPosts = []; lastFilesUrl = null
    window.__ModuleLoader__ = { load: (def) => { factory = def.factory } }
    vi.stubGlobal('Audio', FakeAudio)
    // delay ONLY the /dsh-music/prefs GET to simulate network latency
    vi.stubGlobal('fetch', (url, opts) => {
      if (String(url) === '/dsh-music/prefs' && (!opts || !opts.method || opts.method === 'GET')) {
        return new Promise((resolve) => setTimeout(() => resolve(jsonRes({ ok: true, prefs: prefsServer })), 120))
      }
      return fetchStub(url, opts)
    })
    vi.stubGlobal('requestAnimationFrame', () => 0)
    vi.stubGlobal('cancelAnimationFrame', () => {})
    vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '' }))
    vi.stubGlobal('setInterval', () => 0)
    vi.stubGlobal('clearInterval', () => {})
    window.confirm = () => true; window.prompt = () => null
    await import('../lib/client.js')
    const modExports = factory((name) => (name === 'react' ? React : undefined))
    const slots = { inject: (n, cb) => cb(), register: (meta, ef) => { registered.push({ id: meta.id, elementFactory: ef }); return ef } }
    modExports.apply({ get: (k) => (k === 'slots' ? slots : undefined), effect: (fn) => fn() })
    // render the panel immediately (before the 120ms prefs fetch resolves)
    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    // open panel -> QQ -> search, focus input: history must be empty for now
    act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    const onlineTab = [...container.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === 'QQ音乐')
    act(() => { onlineTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const searchTab = [...container.querySelectorAll('.dsh-music-qq-viewtab')].find((b) => b.textContent === '搜索')
    act(() => { searchTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const input = container.querySelector('.dsh-music-qq-input')
    expect(input).toBeTruthy()
    // wait for the slow prefs fetch + prefsReady re-apply
    await act(async () => { await new Promise((r) => setTimeout(r, 160)) })
    act(() => { input.dispatchEvent(new Event('focusin', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const histItems = [...container.querySelectorAll('.dsh-music-qq-hist-item')]
    expect(histItems.some((b) => b.textContent === '七里香')).toBe(true)
  })

  it('falls back to the old browser localStorage copy when the Host has no record (upgrade path)', async () => {
    // Pre-0.7 builds kept prefs under the SAME key names in localStorage. On
    // upgrade the Host file is empty, so the client must read the legacy browser
    // copy (mode + QQ history) and restore it — then migrate it into the Host.
    localStorage.setItem('dsh-music-mode', 'single')
    localStorage.setItem('dsh-music-qq-history', JSON.stringify(['刀郎']))
    qqLoggedIn = true
    vi.resetModules(); registered = []; prefsPosts = []; lastFilesUrl = null
    await bootClient()

    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })

    // mode restored from the legacy browser copy ('单曲循环')
    const modeBtn = [...container.querySelectorAll('.dsh-music-mode-trigger')].find((b) => b.title.startsWith('单曲循环'))
    expect(modeBtn).toBeTruthy()

    // QQ history restored from the legacy browser copy
    act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    const onlineTab = [...container.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === 'QQ音乐')
    act(() => { onlineTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const searchTab = [...container.querySelectorAll('.dsh-music-qq-viewtab')].find((b) => b.textContent === '搜索')
    act(() => { searchTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const input = container.querySelector('.dsh-music-qq-input')
    act(() => { input.dispatchEvent(new Event('focusin', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const histItems = [...container.querySelectorAll('.dsh-music-qq-hist-item')]
    expect(histItems.some((b) => b.textContent === '刀郎')).toBe(true)

    // the legacy copy was migrated into the Host snapshot (read via loadPref)
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    // flush fires on an ~800ms debounce
    await act(async () => { await new Promise((r) => setTimeout(r, 950)) })
    const migrated = prefsPosts.find((p) => p.prefs && p.prefs['dsh-music-mode'])
    expect(migrated).toBeTruthy()
    expect(migrated.prefs['dsh-music-mode']).toBe('single')
    expect(prefsServer['dsh-music-qq-history']).toBe(JSON.stringify(['刀郎']))
    // once adopted by the Host, the browser copies are removed — localStorage
    // is a one-way upgrade source and never keeps the migrated data.
    expect(localStorage.getItem('dsh-music-mode')).toBeNull()
    expect(localStorage.getItem('dsh-music-qq-history')).toBeNull()
  })

  it('never writes new data to the browser store (Host-only persistence)', async () => {
    // Regression guard for the "no browser storage" guarantee: a savePref (here
    // triggered by changing the play mode) must NOT appear in localStorage —
    // the Host is the only place new data is stored.
    vi.resetModules(); registered = []; prefsPosts = []; lastFilesUrl = null
    await bootClient()

    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })

    // change mode: 顺序播放 -> 单曲循环 (default is 'order')
    const curModeBtn = [...container.querySelectorAll('.dsh-music-mode-trigger')].find((b) => b.title.startsWith('顺序播放'))
    act(() => { curModeBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    const single = [...document.querySelectorAll('.dsh-music-mode-item')].find((b) => b.title.includes('单曲循环'))
    act(() => { single.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 950)) })

    // flushed to the Host…
    expect(prefsPosts.some((p) => p.prefs && p.prefs['dsh-music-mode'] === 'single')).toBe(true)
    expect(prefsServer['dsh-music-mode']).toBe('single')
    // …but NOT mirrored into localStorage
    expect(localStorage.getItem('dsh-music-mode')).toBeNull()
  })

  it('keeps the Host value authoritative over a conflicting legacy localStorage copy', async () => {
    // If both the Host and the old browser store have a value, the Host wins.
    prefsServer = { 'dsh-music-mode': 'order', 'dsh-music-volume': '0.5' }
    localStorage.setItem('dsh-music-mode', 'single') // stale legacy conflict
    localStorage.setItem('dsh-music-volume', '0.9')
    vi.resetModules(); registered = []; prefsPosts = []; lastFilesUrl = null
    await bootClient()

    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })

    // Host's 'order' (顺序播放) wins, not legacy 'single' (单曲循环)
    const modeBtn = [...container.querySelectorAll('.dsh-music-mode-trigger')].find((b) => b.title.startsWith('顺序播放'))
    expect(modeBtn).toBeTruthy()
    const singleBtn = [...container.querySelectorAll('.dsh-music-mode-trigger')].find((b) => b.title.startsWith('单曲循环'))
    expect(singleBtn).toBeFalsy()
    // the stale browser duplicates are dropped once the Host snapshot has them
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(localStorage.getItem('dsh-music-mode')).toBeNull()
    expect(localStorage.getItem('dsh-music-volume')).toBeNull()
  })

  it('migrates the legacy single-book key into the per-book map on upgrade', async () => {
    // Pre-0.2.1 stored ONE book's progress in dsh-music-book-playback. On upgrade
    // it must fold into dsh-music-books-playback so the novel keeps its place.
    localStorage.setItem('dsh-music-book-playback', JSON.stringify({
      id: 'book:b1', name: '凡人修仙传.txt', from: 5, base: 100, pos: 42, total: 25, ts: 111,
    }))
    const audios = []
    class LocalAudio extends FakeAudio {
      constructor() { super(); audios.push(this) }
      emit(type) { (this.listeners[type] || []).forEach((fn) => fn({ target: this })) }
    }
    manifest = { ...baseManifest(), books: [{ id: 'book:b1', name: '凡人修仙传.txt', url: '/dsh-music/book/b1/text?from=0', sections: [], total: 25, ext: 'txt' }] }
    vi.resetModules(); registered = []; prefsPosts = []; lastFilesUrl = null
    window.__ModuleLoader__ = { load: (def) => { factory = def.factory } }
    vi.stubGlobal('Audio', LocalAudio)
    vi.stubGlobal('fetch', fetchStub)
    vi.stubGlobal('requestAnimationFrame', () => 0)
    vi.stubGlobal('cancelAnimationFrame', () => {})
    vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '' }))
    vi.stubGlobal('setInterval', () => 0)
    vi.stubGlobal('clearInterval', () => {})
    window.confirm = () => true; window.prompt = () => null
    await import('../lib/client.js')
    const modExports = factory((name) => (name === 'react' ? React : undefined))
    const slots = { inject: (n, cb) => cb(), register: (meta, ef) => { registered.push({ id: meta.id, elementFactory: ef }); return ef } }
    modExports.apply({ get: (k) => (k === 'slots' ? slots : undefined), effect: (fn) => fn() })
    await new Promise((r) => setTimeout(r, 0))
    // wait for the legacy migration (runs after loadServerPrefs resolves)
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    // the per-book map now holds the legacy entry and flushes to the Host
    await act(async () => { await new Promise((r) => setTimeout(r, 950)) })
    const map = JSON.parse(prefsServer['dsh-music-books-playback'] || '{}')
    expect(map['凡人修仙传.txt']).toBeTruthy()
    expect(map['凡人修仙传.txt'].pos).toBe(42)
    expect(map['凡人修仙传.txt'].ts).toBe(111)
    // the legacy single-book key is gone from the browser store
    expect(localStorage.getItem('dsh-music-book-playback')).toBeNull()
  })

  it('stays in the work state (no dim / controls expanded) when there is no playback content', async () => {
    // 无播放内容（插件刚安装 / 点击停止）：播放条恒定工作态 —— 不透明度 100%、控件组
    // 展开，不做「闲置/工作态」的特效（不半透明、不滑入滑出、时长不显示）。有内容时
    // 才启用那些交互（由上面的 hover/dim 测试覆盖）。
    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    const barEl = container.querySelector('.dsh-music-bar')
    expect(barEl).toBeTruthy()
    const controls = container.querySelector('.dsh-music-bar-controls')
    expect(controls).toBeTruthy()
    // 无内容 → 恒定工作态：不加 dimmed、控件组 .on 展开、无时长
    expect(barEl.classList.contains('dimmed')).toBe(false)
    expect(controls.classList.contains('on')).toBe(true)
    expect(container.querySelector('.dsh-music-bar-time')).toBeNull()
  })

  it('renders a 1px progress line at the bar bottom that fills with playback', async () => {
    // 播放进度细线：有内容且已获取时长时，在播放条底部渲染一条与播放条等宽、高 1px
    // 的细线，填充宽度 = position/duration * 100%；无内容/无时长时不渲染。
    const audios = []
    class LocalAudio extends FakeAudio {
      constructor() { super(); audios.push(this) }
      emit(type) { (this.listeners[type] || []).forEach((fn) => fn({ target: this })) }
    }
    vi.resetModules(); registered = []; lastFilesUrl = null
    manifest = baseManifest()
    window.__ModuleLoader__ = { load: (def) => { factory = def.factory } }
    vi.stubGlobal('Audio', LocalAudio)
    vi.stubGlobal('fetch', fetchStub)
    vi.stubGlobal('requestAnimationFrame', () => 0)
    vi.stubGlobal('cancelAnimationFrame', () => {})
    vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '' }))
    vi.stubGlobal('setInterval', () => 0)
    vi.stubGlobal('clearInterval', () => {})
    window.confirm = () => true
    window.prompt = () => null
    await import('../lib/client.js')
    const modExports = factory((name) => (name === 'react' ? React : undefined))
    const slots = {
      inject: (name, cb) => { cb() },
      register: (meta, elementFactory) => { registered.push({ id: meta.id, elementFactory }); return elementFactory },
    }
    modExports.apply({ get: (k) => (k === 'slots' ? slots : undefined), effect: (fn) => fn() })
    await new Promise((r) => setTimeout(r, 0))
    const audio = audios[0]
    expect(audio).toBeTruthy()
    try {
      const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
      const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
      const container = document.createElement('div')
      document.body.appendChild(container)
      const root = createRoot(container)
      act(() => { root.render(React.createElement('div', null, bar, panel)) })
      act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      const track = [...container.querySelectorAll('.dsh-music-track')].find((b) => b.textContent.includes('a.mp3'))
      act(() => { track.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      // 无时长（duration 为 0）：细线不渲染
      expect(container.querySelector('.dsh-music-bar-progress')).toBeNull()
      // 有时长后：进度 50/200 = 25%（duration 由 durationchange 事件写入 store）
      audio.duration = 200
      audio.currentTime = 50
      act(() => { audio.emit('durationchange') })
      act(() => { audio.emit('timeupdate') })
      const progress = container.querySelector('.dsh-music-bar-progress')
      expect(progress).toBeTruthy()
      const fill = container.querySelector('.dsh-music-bar-progress-fill')
      expect(fill).toBeTruthy()
      expect(fill.style.width).toBe('25%')
      // 推进到末尾 → 100%
      audio.currentTime = 200
      act(() => { audio.emit('timeupdate') })
      expect(container.querySelector('.dsh-music-bar-progress-fill').style.width).toBe('100%')
      // 细线是播放条的直接子节点（绝对定位、等宽于播放条）
      const barEl = container.querySelector('.dsh-music-bar')
      expect(progress.parentNode).toBe(barEl)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('slides the right-side control buttons in/out on bar hover with a 1s slide-out delay', async () => {
    // Regression: the bar's right-side controls (heart/prev/play/next/stop/mode/
    // volume/panel) must be hidden by default and slide in on mouseenter, slide
    // out on mouseleave with a 1s delay (prevents accidental hide on a quick
    // mouse-out). The time text is part of that foreground cluster: it also
    // hides in the idle (collapsed) state and only shows while hovering.
    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    // play a local track so the transport buttons are present
    act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    const track = [...container.querySelectorAll('.dsh-music-track')].find((b) => b.textContent.includes('a.mp3'))
    act(() => { track.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const barEl = container.querySelector('.dsh-music-bar')
    expect(barEl).toBeTruthy()
    const controls = container.querySelector('.dsh-music-bar-controls')
    expect(controls).toBeTruthy()
    // 默认隐藏：无 .on，闲置态时长一并隐藏（新行为：时长只在操作时显示）
    expect(controls.classList.contains('on')).toBe(false)
    expect(container.querySelector('.dsh-music-bar-time')).toBeNull()
    // 播放条文件名去掉扩展名（本地音乐 a.mp3 -> a）；文件列表里仍保留 a.mp3
    const barName = container.querySelector('.dsh-music-bar-name')
    expect(barName).toBeTruthy()
    expect(barName.textContent).not.toContain('.mp3')
    expect(barName.textContent).toContain('a')
    expect(container.textContent).toContain('a.mp3')
    // 用假定时器控制 1s 滑出延迟。
    vi.useFakeTimers()
    try {
      // 鼠标进入播放条 → 控制按钮滑入（加 .on）。React 的 onMouseEnter/onMouseLeave
      // 由原生 mouseover/mouseout 事件驱动（relatedTarget 为空 = 从外部进入/离开）。
      act(() => { barEl.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })) })
      expect(controls.classList.contains('on')).toBe(true)
      // 操作态：时长显示
      expect(container.querySelector('.dsh-music-bar-time')).toBeTruthy()
      // 鼠标离开 → 1s 延迟内按钮仍保持展开（防止误移出）
      act(() => { barEl.dispatchEvent(new MouseEvent('mouseout', { bubbles: true })) })
      expect(controls.classList.contains('on')).toBe(true)
      // 延迟内重新进入 → 取消隐藏，按钮保持展开
      act(() => { barEl.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })) })
      act(() => { vi.advanceTimersByTime(1500) })
      expect(controls.classList.contains('on')).toBe(true)
      // 离开后超过 1s → 按钮滑出隐藏（去 .on）
      act(() => { barEl.dispatchEvent(new MouseEvent('mouseout', { bubbles: true })) })
      expect(controls.classList.contains('on')).toBe(true) // 还在延迟内
      act(() => { vi.advanceTimersByTime(1000) })
      expect(controls.classList.contains('on')).toBe(false)
      // 离开后（闲置态）：时长一并隐藏
      expect(container.querySelector('.dsh-music-bar-time')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
    // 收藏/播放控制按钮在 controls 容器内
    expect(controls.querySelector('.dsh-music-bar-btn.fav')).toBeTruthy()
    expect([...controls.querySelectorAll('.dsh-music-bar-btn')].some((b) => b.title === '播放/暂停')).toBe(true)
  })

  it('dims the whole bar to 50% opacity on mouse-leave (1s delay), full opacity on hover', async () => {
    // 后台静默播放效果：鼠标移入 → 播放条完全不透明（去 dimmed）；鼠标移出 1s 后 →
    // 控件组折叠的同时播放条变半透明（加 dimmed）。两者同一状态源（barHover）同步变化。
    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    const track = [...container.querySelectorAll('.dsh-music-track')].find((b) => b.textContent.includes('a.mp3'))
    act(() => { track.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const barEl = container.querySelector('.dsh-music-bar')
    expect(barEl).toBeTruthy()
    const controls = container.querySelector('.dsh-music-bar-controls')
    // 初始（未悬停）：半透明 dimmed
    expect(barEl.classList.contains('dimmed')).toBe(true)
    // 闲置态时长隐藏（新行为）
    expect(container.querySelector('.dsh-music-bar-time')).toBeNull()
    vi.useFakeTimers()
    try {
      // 鼠标移入 → 立即不透明（去 dimmed），控件组随之滑入
      act(() => { barEl.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })) })
      expect(barEl.classList.contains('dimmed')).toBe(false)
      expect(controls.classList.contains('on')).toBe(true)
      // 操作态时长显示（新行为）
      expect(container.querySelector('.dsh-music-bar-time')).toBeTruthy()
      // 鼠标移出 → 1s 延迟内仍不透明（防误移出）
      act(() => { barEl.dispatchEvent(new MouseEvent('mouseout', { bubbles: true })) })
      expect(barEl.classList.contains('dimmed')).toBe(false)
      // 延迟内重新进入 → 取消隐藏，保持不透明
      act(() => { barEl.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })) })
      act(() => { vi.advanceTimersByTime(1500) })
      expect(barEl.classList.contains('dimmed')).toBe(false)
      // 离开超过 1s → 控件组折叠，同时播放条变半透明
      act(() => { barEl.dispatchEvent(new MouseEvent('mouseout', { bubbles: true })) })
      act(() => { vi.advanceTimersByTime(1000) })
      expect(controls.classList.contains('on')).toBe(false)
      expect(barEl.classList.contains('dimmed')).toBe(true)
      // 回到闲置态：时长再次隐藏（新行为）
      expect(container.querySelector('.dsh-music-bar-time')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps the controls expanded while the mode popup is open (portal hover fix)', async () => {
    // Regression: the mode popup is portaled to body (outside the bar DOM), so moving
    // the mouse onto it fires the bar's mouseleave. The buttons must NOT collapse
    // while a popup is open, otherwise the popup detaches and mispositions.
    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    const track = [...container.querySelectorAll('.dsh-music-track')].find((b) => b.textContent.includes('a.mp3'))
    act(() => { track.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const barEl = container.querySelector('.dsh-music-bar')
    const controls = container.querySelector('.dsh-music-bar-controls')
    act(() => { barEl.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })) })
    expect(controls.classList.contains('on')).toBe(true)
    // 打开模式弹窗（默认模式=顺序播放）
    const modeBtn = [...container.querySelectorAll('.dsh-music-mode-trigger')].find((b) => b.title === '顺序播放')
    expect(modeBtn).toBeTruthy()
    act(() => { modeBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    // 弹窗打开 → 即使鼠标移出播放条（mouseout 触发 mouseleave），按钮仍保持展开。
    // 先开假定时器，让 mouseleave 安排的 1s 收起定时器成为假定时器，可被推进触发。
    vi.useFakeTimers()
    try {
      act(() => { barEl.dispatchEvent(new MouseEvent('mouseout', { bubbles: true })) })
      expect(controls.classList.contains('on')).toBe(true)
      // 鼠标移出超过 1s：barHover 变为 false，但弹窗打开期间 .on 仍由 anyPopOpen 保持
      act(() => { vi.advanceTimersByTime(1200) })
      expect(controls.classList.contains('on')).toBe(true)
    } finally { vi.useRealTimers() }
    // 选择「单曲循环」→ 弹窗关闭
    const single = [...document.querySelectorAll('.dsh-music-mode-item')].find((b) => b.title.includes('单曲循环'))
    expect(single).toBeTruthy()
    act(() => { single.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    // Regression: 弹窗关闭后 .on 必须立即随 anyPopOpen 收起（此时 barHover 已为 false、
    // 鼠标已不在播放条上、不再触发 mouseleave），否则按钮组一直保持展开不折叠。
    expect(controls.classList.contains('on')).toBe(false)
  })

  it('draws an oscilloscope-style waveform from the live time-domain analyser data', async () => {
    // Waveform mode (dsh-music-viz-mode = 'wave') draws a single continuous curve from
    // getByteTimeDomainData instead of frequency bars. It is driven by the live
    // captureStream+AnalyserNode tap only — no offline fallback — so a non-flat time-domain
    // read must produce a stroked path, and no bars (fillRect) are drawn.
    prefsServer = { 'dsh-music-viz-mode': 'wave' }
    class FakeStream { getAudioTracks() { return [{ kind: 'audio' }] } }
    class LiveAudio extends FakeAudio {
      play() { this.paused = false; for (const fn of (this.listeners.play || [])) fn(); return Promise.resolve() }
      captureStream() { return new FakeStream() }
    }
    class FakeAnalyser {
      constructor() { this.fftSize = 2048; this.smoothingTimeConstant = 0.3; this.frequencyBinCount = 1024 }
      connect() {}
      getByteFrequencyData(arr) { for (let i = 0; i < arr.length; i++) arr[i] = 120 }
      getByteTimeDomainData(arr) {
        // A clear sine around the 128 center line: enough deviation to draw a real curve.
        for (let i = 0; i < arr.length; i++) arr[i] = Math.round(128 + 100 * Math.sin((2 * Math.PI * 4 * i) / arr.length))
      }
    }
    class LiveCtx {
      constructor() { this.state = 'running'; this.sampleRate = 48000; this.destination = {} }
      resume() { this.state = 'running'; return Promise.resolve() }
      close() { this.state = 'closed' }
      createMediaStreamSource() { return { connect: () => {} } }
      createAnalyser() { return new FakeAnalyser() }
    }
    let strokes = 0
    const fakeCtx = {
      clearRect: () => {},
      beginPath: () => {},
      moveTo: () => {},
      lineTo: () => {},
      stroke: () => { strokes++ },
      fillRect: () => {},
      fillStyle: '', strokeStyle: '', lineWidth: 0, lineCap: '', lineJoin: '',
    }
    vi.resetModules(); registered = []; lastFilesUrl = null; manifest = baseManifest()
    window.__ModuleLoader__ = { load: (def) => { factory = def.factory } }
    let rafCb = null
    vi.stubGlobal('Audio', LiveAudio)
    vi.stubGlobal('AudioContext', LiveCtx)
    vi.stubGlobal('XMLHttpRequest', class { open() {} send() {} })
    vi.stubGlobal('fetch', fetchStub)
    vi.stubGlobal('requestAnimationFrame', (cb) => { rafCb = cb; return 1 })
    vi.stubGlobal('cancelAnimationFrame', () => {})
    vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '' }))
    vi.stubGlobal('setInterval', () => 0)
    vi.stubGlobal('clearInterval', () => {})
    const origGetCtx = HTMLCanvasElement.prototype.getContext
    HTMLCanvasElement.prototype.getContext = () => fakeCtx
    try {
      await import('../lib/client.js')
      const modExports = factory((name) => (name === 'react' ? React : undefined))
      const slots = { inject: (n, cb) => cb(), register: (meta, ef) => { registered.push({ id: meta.id, elementFactory: ef }); return ef } }
      modExports.apply({ get: (k) => (k === 'slots' ? slots : undefined), effect: (fn) => fn() })
      await new Promise((r) => setTimeout(r, 0))
      const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
      const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
      const container = document.createElement('div')
      document.body.appendChild(container)
      const root = createRoot(container)
      act(() => { root.render(React.createElement('div', null, bar, panel)) })
      act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      const track = [...container.querySelectorAll('.dsh-music-track')].find((b) => b.textContent.includes('a.mp3'))
      act(() => { track.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      const canvas = container.querySelector('.dsh-music-viz')
      expect(canvas).toBeTruthy()
      strokes = 0
      act(() => { rafCb() })
      // Waveform mode draws one stroked curve PER frequency band (multi-line): the 3 bands
      // (low/mid/high) each call stroke() once, and no bars (fillRect) are drawn.
      expect(strokes).toBe(3)
    } finally {
      HTMLCanvasElement.prototype.getContext = origGetCtx
    }
  })

  it('drives the bars from the live captureStream+AnalyserNode spectrum when available', async () => {
    // Real-time path: when the <audio> exposes captureStream() (a read-only tap) and an
    // AudioContext provides a MediaStreamSource + AnalyserNode, drawViz must read
    // getByteFrequencyData every frame (not the offline FFT envelope). Here the offline
    // envelope XHR never delivers, so if the bars still move the live analyser path is
    // doing the work. The tap must NOT reroute audio (createMediaElementSource mutes the
    // player), so the analyser feeds off a MediaStreamSource, not a MediaElementSource.
    let freqCalls = 0
    let ctxSampleRate = 48000
    class FakeStream { getAudioTracks() { return [{ kind: 'audio' }] } }
    class LiveAudio extends FakeAudio {
      play() { this.paused = false; for (const fn of (this.listeners.play || [])) fn(); return Promise.resolve() }
      captureStream() { return new FakeStream() }
    }
    class FakeAnalyser {
      constructor() { this.fftSize = 2048; this.smoothingTimeConstant = 0.7; this.frequencyBinCount = 1024 }
      connect() {}
      getByteFrequencyData(arr) {
        freqCalls++
        // A single strong low-frequency tone (bin 1) lands only in the first log band =>
        // that bar should be much taller than the rest, proving the bars came from the
        // analyser (not the offline envelope, which never delivers). Only bin 1 is loud so it
        // does not overrun the next band's boundary under the 12-band log spacing.
        for (let i = 0; i < arr.length; i++) arr[i] = i === 1 ? 230 : 4
      }
    }
    class LiveCtx {
      constructor() { this.state = 'running'; this.sampleRate = ctxSampleRate; this.destination = {} }
      resume() { this.state = 'running'; return Promise.resolve() }
      close() { this.state = 'closed' }
      createMediaStreamSource() { return { connect: () => {} } }
      createAnalyser() { return new FakeAnalyser() }
    }
    // Offline envelope XHR never calls onload => trackEnv stays null => the live
    // analyser is the ONLY source of band data.
    class HungXHR { open() {} send() {} }
    const rects = []
    const fakeCtx = {
      clearRect: () => {},
      fillRect: (x, y, w, h) => { rects.push({ x, y, w, h }) },
      fillStyle: '',
    }
    vi.resetModules(); registered = []; lastFilesUrl = null; manifest = baseManifest()
    window.__ModuleLoader__ = { load: (def) => { factory = def.factory } }
    let rafCb = null
    vi.stubGlobal('Audio', LiveAudio)
    vi.stubGlobal('AudioContext', LiveCtx)
    vi.stubGlobal('XMLHttpRequest', HungXHR)
    vi.stubGlobal('fetch', fetchStub)
    vi.stubGlobal('requestAnimationFrame', (cb) => { rafCb = cb; return 1 })
    vi.stubGlobal('cancelAnimationFrame', () => {})
    vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '' }))
    vi.stubGlobal('setInterval', () => 0)
    vi.stubGlobal('clearInterval', () => {})
    const origGetCtx = HTMLCanvasElement.prototype.getContext
    HTMLCanvasElement.prototype.getContext = () => fakeCtx
    try {
      await import('../lib/client.js')
      const modExports = factory((name) => (name === 'react' ? React : undefined))
      const slots = { inject: (n, cb) => cb(), register: (meta, ef) => { registered.push({ id: meta.id, elementFactory: ef }); return ef } }
      modExports.apply({ get: (k) => (k === 'slots' ? slots : undefined), effect: (fn) => fn() })
      await new Promise((r) => setTimeout(r, 0))
      const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
      const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
      const container = document.createElement('div')
      document.body.appendChild(container)
      const root = createRoot(container)
      act(() => { root.render(React.createElement('div', null, bar, panel)) })
      act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      const track = [...container.querySelectorAll('.dsh-music-track')].find((b) => b.textContent.includes('a.mp3'))
      act(() => { track.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      const canvas = container.querySelector('.dsh-music-viz')
      expect(canvas).toBeTruthy()
      const bottom = canvas.height - 1
      rects.length = 0
      act(() => { rafCb() })
      // The live analyser was read (offline envelope never delivered data).
      expect(freqCalls).toBeGreaterThan(0)
      // Dedupe on x to count the real bars (a bottom-anchored bar and its 3px trailing peak
      // cap would otherwise both satisfy the bottom-line filter).
      const bars = rects.filter((r) => r.y + r.h === bottom)
      expect(new Set(bars.map((r) => r.x)).size).toBe(12)
      // The low-frequency bar is still clearly taller than the high-frequency ones (the fixed
      // frequency weighting flattens but does not invert the spectrum).
      expect(bars[0].h).toBeGreaterThan(bars[1].h * 2)
    } finally {
      HTMLCanvasElement.prototype.getContext = origGetCtx
    }
  })

  it('keeps the live bars low during a quiet passage (no per-band auto-gain inflation)', async () => {
    // Regression: per-band auto-gain normalized each band to its OWN peak, so an absolutely
    // quiet but steady band got inflated toward full — the "left bars a bit high when there's
    // little music" bug. The standard AnalyserNode normalization (byte/255) is driven by
    // ABSOLUTE loudness, so a faint spectrum must draw short bars, regardless of how steady it
    // is. The offline envelope XHR hangs, so the live analyser is the only source.
    let freqCalls = 0
    class FakeStream { getAudioTracks() { return [{ kind: 'audio' }] } }
    class LiveAudio extends FakeAudio {
      play() { this.paused = false; for (const fn of (this.listeners.play || [])) fn(); return Promise.resolve() }
      captureStream() { return new FakeStream() }
    }
    class FakeAnalyser {
      constructor() { this.fftSize = 2048; this.smoothingTimeConstant = 0.3; this.frequencyBinCount = 1024 }
      connect() {}
      getByteFrequencyData(arr) {
        freqCalls++
        // A faint, steady spectrum: every bin is just above the silence floor (byte 24). In
        // absolute dB this is quiet content, so the bars must stay short.
        for (let i = 0; i < arr.length; i++) arr[i] = 24
      }
    }
    class LiveCtx {
      constructor() { this.state = 'running'; this.sampleRate = 48000; this.destination = {} }
      resume() { this.state = 'running'; return Promise.resolve() }
      close() { this.state = 'closed' }
      createMediaStreamSource() { return { connect: () => {} } }
      createAnalyser() { return new FakeAnalyser() }
    }
    class HungXHR { open() {} send() {} }
    const rects = []
    const fakeCtx = { clearRect: () => {}, fillRect: (x, y, w, h) => { rects.push({ x, y, w, h }) }, fillStyle: '' }
    vi.resetModules(); registered = []; lastFilesUrl = null; manifest = baseManifest()
    window.__ModuleLoader__ = { load: (def) => { factory = def.factory } }
    let rafCb = null
    vi.stubGlobal('Audio', LiveAudio)
    vi.stubGlobal('AudioContext', LiveCtx)
    vi.stubGlobal('XMLHttpRequest', HungXHR)
    vi.stubGlobal('fetch', fetchStub)
    vi.stubGlobal('requestAnimationFrame', (cb) => { rafCb = cb; return 1 })
    vi.stubGlobal('cancelAnimationFrame', () => {})
    vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '' }))
    vi.stubGlobal('setInterval', () => 0)
    vi.stubGlobal('clearInterval', () => {})
    const origGetCtx = HTMLCanvasElement.prototype.getContext
    HTMLCanvasElement.prototype.getContext = () => fakeCtx
    try {
      await import('../lib/client.js')
      const modExports = factory((name) => (name === 'react' ? React : undefined))
      const slots = { inject: (n, cb) => cb(), register: (meta, ef) => { registered.push({ id: meta.id, elementFactory: ef }); return ef } }
      modExports.apply({ get: (k) => (k === 'slots' ? slots : undefined), effect: (fn) => fn() })
      await new Promise((r) => setTimeout(r, 0))
      const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
      const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
      const container = document.createElement('div')
      document.body.appendChild(container)
      const root = createRoot(container)
      act(() => { root.render(React.createElement('div', null, bar, panel)) })
      act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      const track = [...container.querySelectorAll('.dsh-music-track')].find((b) => b.textContent.includes('a.mp3'))
      act(() => { track.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      const canvas = container.querySelector('.dsh-music-viz')
      expect(canvas).toBeTruthy()
      rects.length = 0
      // A few frames so the bars settle; clear each frame so rects holds only the last frame.
      for (let i = 0; i < 6; i++) { rects.length = 0; act(() => { rafCb() }) }
      expect(freqCalls).toBeGreaterThan(0)
      const bottom = canvas.height - 1
      const bars = rects.filter((r) => r.y + r.h === bottom)
      expect(bars.length).toBe(12)
      // Absolute loudness drives the bar, so a quiet (faint) spectrum stays LOW. (Per-band
      // auto-gain would have inflated these to near-full.)
      expect(bars.every((r) => r.h < canvas.height * 0.5)).toBe(true)
    } finally {
      HTMLCanvasElement.prototype.getContext = origGetCtx
    }
  })

  it('shows nothing when the live tap yields no audio track (no offline fallback)', async () => {
    // This browser's media pipeline won't let a Web Audio source/tap read the proxied
    // stream (an internal "getTopURL" TypeError), so captureStream returns a MediaStream
    // with NO audio track. setupLiveViz must not fail hard — it leaves the live analyser
    // unset, and since there is NO offline fallback, the visualization simply draws nothing
    // (audio is never touched).
    let freqCalls = 0
    let tapAttempted = false
    // Stream that carries no audio track (the getTopURL case in this environment).
    class EmptyStream { getAudioTracks() { return [] } }
    class LiveAudio extends FakeAudio {
      play() { this.paused = false; for (const fn of (this.listeners.play || [])) fn(); return Promise.resolve() }
      captureStream() { tapAttempted = true; return new EmptyStream() }
    }
    class FakeAnalyser {
      constructor() { this.fftSize = 2048; this.smoothingTimeConstant = 0.3; this.frequencyBinCount = 1024 }
      getByteFrequencyData(arr) { freqCalls++; for (let i = 0; i < arr.length; i++) arr[i] = 200 }
    }
    // AudioContext with a MediaStreamSource + AnalyserNode (but the stream has no track,
    // so setupLiveViz bails before using them).
    class NoTrackCtx {
      constructor() { this.state = 'running'; this.sampleRate = 48000; this.destination = {} }
      resume() { this.state = 'running'; return Promise.resolve() }
      close() { this.state = 'closed' }
      createMediaStreamSource() { return { connect: () => {} } }
      createAnalyser() { return new FakeAnalyser() }
    }
    const rects = []
    const fakeCtx = { clearRect: () => {}, fillRect: (x, y, w, h) => { rects.push({ x, y, w, h }) }, fillStyle: '' }
    vi.resetModules(); registered = []; lastFilesUrl = null; manifest = baseManifest()
    window.__ModuleLoader__ = { load: (def) => { factory = def.factory } }
    let rafCb = null
    vi.stubGlobal('Audio', LiveAudio)
    vi.stubGlobal('AudioContext', NoTrackCtx)
    vi.stubGlobal('XMLHttpRequest', class { open() {} send() {} })
    vi.stubGlobal('fetch', fetchStub)
    vi.stubGlobal('requestAnimationFrame', (cb) => { rafCb = cb; return 1 })
    vi.stubGlobal('cancelAnimationFrame', () => {})
    vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '' }))
    vi.stubGlobal('setInterval', () => 0)
    vi.stubGlobal('clearInterval', () => {})
    const origGetCtx = HTMLCanvasElement.prototype.getContext
    HTMLCanvasElement.prototype.getContext = () => fakeCtx
    try {
      await import('../lib/client.js')
      const modExports = factory((name) => (name === 'react' ? React : undefined))
      const slots = { inject: (n, cb) => cb(), register: (meta, ef) => { registered.push({ id: meta.id, elementFactory: ef }); return ef } }
      modExports.apply({ get: (k) => (k === 'slots' ? slots : undefined), effect: (fn) => fn() })
      await new Promise((r) => setTimeout(r, 0))
      const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
      const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
      const container = document.createElement('div')
      document.body.appendChild(container)
      const root = createRoot(container)
      act(() => { root.render(React.createElement('div', null, bar, panel)) })
      act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      const track = [...container.querySelectorAll('.dsh-music-track')].find((b) => b.textContent.includes('a.mp3'))
      act(() => { track.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      const canvas = container.querySelector('.dsh-music-viz')
      expect(canvas).toBeTruthy()
      rects.length = 0
      freqCalls = 0
      act(() => { rafCb() })
      // The tap WAS attempted (captureStream called) but yielded no audio track, so
      // getByteFrequencyData should NOT be read and NO bars/waveform are drawn.
      expect(tapAttempted).toBe(true)
      expect(freqCalls).toBe(0)
      const bottom = canvas.height - 1
      const bars = rects.filter((r) => r.y + r.h === bottom)
      expect(bars.length).toBe(0)
    } finally {
      HTMLCanvasElement.prototype.getContext = origGetCtx
    }
  })

  it('does NOT close the portaled volume/mode popups when clicking inside them', async () => {
    // Regression: the volume/mode popups are portaled to body (outside the bar DOM),
    // so the old outside-click check (button container only) closed them on ANY click
    // including inside the popup. Must keep them open when the click target is inside.
    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    const track = [...container.querySelectorAll('.dsh-music-track')].find((b) => b.textContent.includes('a.mp3'))
    act(() => { track.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const barEl = container.querySelector('.dsh-music-bar')
    act(() => { barEl.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })) })
    // ---- 音量弹窗：打开后点击弹窗内部不应关闭 ----
    const volBtn = [...container.querySelectorAll('.dsh-music-mode-trigger')].find((b) => b.title === '音量')
    act(() => { volBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const volPop = document.querySelector('.dsh-music-bar-vol-pop')
    expect(volPop).toBeTruthy()
    // 点击弹窗内部（音量滑块容器）→ 弹窗保持打开
    act(() => { volPop.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(document.querySelector('.dsh-music-bar-vol-pop')).toBeTruthy()
    // 点击播放条之外的空白处 → 弹窗关闭
    act(() => { document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(document.querySelector('.dsh-music-bar-vol-pop')).toBeNull()
    // ---- 模式弹窗：打开后点击弹窗内部选项不应被「外部点击」误关闭 ----
    const modeBtn = [...container.querySelectorAll('.dsh-music-mode-trigger')].find((b) => b.title === '顺序播放')
    act(() => { modeBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const modePop = document.querySelector('.dsh-music-mode-pop')
    expect(modePop).toBeTruthy()
    // 点击弹窗内部（空白处，非选项按钮）→ 弹窗保持打开
    act(() => { modePop.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(document.querySelector('.dsh-music-mode-pop')).toBeTruthy()
    // 点击弹窗内一个选项 → 选项生效且弹窗关闭
    const shuffle = [...document.querySelectorAll('.dsh-music-mode-item')].find((b) => b.title.includes('乱序播放'))
    act(() => { shuffle.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(document.querySelector('.dsh-music-mode-pop')).toBeNull()
  })

  it('opens the panel, shows subtabs, and renders the playlist detail with a 清空 button', async () => {
    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    // open the panel via the bar's playlist button
    const openBtn = container.querySelector('button[title="打开播放列表"]')
    expect(openBtn).toBeTruthy()
    act(() => { openBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    // library view shows the subtab row
    expect(container.textContent).toContain('曲库')
    expect(container.textContent).toContain('我最喜欢')
    const tab = [...container.querySelectorAll('.dsh-music-subtab')].find((b) => b.textContent === '通勤')
    expect(tab).toBeTruthy()
    // switch into the custom playlist -> detail with 清空/重命名/删除 + track row
    act(() => { tab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(container.textContent).toContain('清空')
    expect(container.textContent).toContain('重命名')
    expect(container.textContent).toContain('删除')
    expect(container.textContent).toContain('a.mp3')
    // the fixed playlist also gets a 清空 button (no rename/delete)
    const favTab = [...container.querySelectorAll('.dsh-music-subtab')].find((b) => b.textContent.includes('我最喜欢'))
    act(() => { favTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(container.textContent).toContain('清空')
    expect(container.textContent).not.toContain('重命名')
    expect(container.textContent).not.toContain('删除')
  })

  it('exposes the full file path as the hover tooltip on a track row', async () => {
    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    const trackBtn = container.querySelector('.dsh-music-track')
    expect(trackBtn).toBeTruthy()
    // manifest track a.mp3 carries path /music/a.mp3; hovering shows the whole path.
    expect(trackBtn.getAttribute('title')).toBe('/music/a.mp3')
  })

  it('clears a playlist to the empty state', async () => {
    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    const tab = [...container.querySelectorAll('.dsh-music-subtab')].find((b) => b.textContent === '通勤')
    act(() => { tab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(container.textContent).toContain('a.mp3')
    const clearBtn = [...container.querySelectorAll('.dsh-music-playlist-btn')].find((b) => b.textContent === '清空')
    expect(clearBtn).toBeTruthy()
    act(() => { clearBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    // 自定义确认弹窗（ConfirmModal）替代原 window.confirm：点「确定」确认
    const okBtn = [...container.querySelectorAll('.dsh-music-picker.confirm .dsh-music-picker-foot .dsh-music-settings-btn')].find((b) => b.textContent === '确定')
    expect(okBtn).toBeTruthy()
    act(() => { okBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    // flush the fetch .then -> store update -> re-render
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(container.textContent).toContain('歌单为空')
  })

  it('opens the file picker from 添加歌曲 starting at the music root directory', async () => {
    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    const tab = [...container.querySelectorAll('.dsh-music-subtab')].find((b) => b.textContent === '通勤')
    act(() => { tab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    const addBtn = [...container.querySelectorAll('.dsh-music-playlist-btn')].find((b) => b.textContent.includes('添加歌曲'))
    expect(addBtn).toBeTruthy()
    act(() => { addBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    // flush the FilePicker useEffect -> /dsh-music/files fetch
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    // initial browse must point at the music root (/music), not home (empty)
    expect(lastFilesUrl).toBeTruthy()
    expect(lastFilesUrl).toMatch(/^\/dsh-music\/files\?path=/)
    expect(lastFilesUrl).not.toMatch(/path=$/)
    expect(lastFilesUrl).toContain(encodeURIComponent('/music'))
    // the picker shows the file it listed
    expect(container.textContent).toContain('a.mp3')
  })

  it('renders the directory picker as breadcrumbs with dirs first and inert files', async () => {
    // Serve the directory listing the 选择音乐目录 picker fetches, with crumbs.
    const dirFetch = vi.fn((url, opts) => {
      const u = String(url)
      if (u.startsWith('/dsh-music/dir')) {
        const target = decodeURIComponent((u.split('path=')[1] || ''))
        if (target === '/music') {
          return jsonRes({ path: '/music', name: 'music', up: '/', dirs: [{ name: 'Albums', path: '/music/Albums' }], files: [{ name: 'a.mp3', path: '/music/a.mp3' }, { name: 'cover.jpg', path: '/music/cover.jpg' }], crumbs: [{ name: '/', path: '/' }, { name: 'music', path: '/music' }] })
        }
        if (target === '/') {
          return jsonRes({ path: '/', name: '/', up: null, dirs: [], files: [], crumbs: [{ name: '/', path: '/' }] })
        }
        return jsonRes({ path: target, name: target, up: null, dirs: [], files: [], crumbs: [] })
      }
      return fetchStub(url, opts)
    })
    vi.stubGlobal('fetch', dirFetch)

    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    const pickBtn = [...container.querySelectorAll('.dsh-music-settings-btn')].find((b) => b.textContent === '选择音乐目录')
    expect(pickBtn).toBeTruthy()
    act(() => { pickBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    // breadcrumb: root ("/") is clickable, current ("music") is highlighted.
    let crumbs = [...container.querySelectorAll('.dsh-music-picker-cur .dsh-music-crumb')]
    expect(crumbs.length).toBe(2)
    expect(crumbs[0].textContent).toBe('/')
    expect(crumbs[0].tagName).toBe('BUTTON')
    expect(crumbs[1].textContent).toBe('music')
    expect(crumbs[1].className).toContain('cur')
    // list: the directory comes first (clickable button), then files (inert spans).
    const listItems = [...container.querySelectorAll('.dsh-music-picker-list .dsh-music-picker-item')]
    expect(listItems.map((el) => el.textContent.trim())).toEqual(['📁 Albums', '📄 a.mp3', '📄 cover.jpg'])
    expect(listItems[0].tagName).toBe('BUTTON')
    expect(listItems[1].tagName).toBe('SPAN')
    expect(listItems[2].tagName).toBe('SPAN')
    expect(listItems[1].className).toContain('file')
    // the empty hint no longer exists
    expect(container.textContent).not.toContain('本目录下无子目录')
    // click the root crumb -> re-browse to "/" and the path collapses to a single crumb.
    act(() => { crumbs[0].dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    crumbs = [...container.querySelectorAll('.dsh-music-picker-cur .dsh-music-crumb')]
    expect(crumbs.length).toBe(1)
    expect(crumbs[0].textContent).toBe('/')
    expect(crumbs[0].className).toContain('cur')
  })

  it('shows the configured root before the picker button with a full-path hover tooltip', async () => {
    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    // The path in front of the 选择音乐目录 button is plain text (truncatable) whose
    // hover title is the full absolute path. It is NOT clickable (no breadcrumb).
    const cur = container.querySelector('.dsh-music-settings-cur')
    expect(cur).toBeTruthy()
    expect(cur.textContent).toContain('/music')
    expect(cur.getAttribute('title')).toBe('/music')
    expect(cur.querySelector('.dsh-music-crumb')).toBeNull()
  })

  it('resizes the panel via the corner handle and persists w/h', async () => {
    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    const handle = container.querySelector('.dsh-music-resize')
    expect(handle).toBeTruthy()
    const panelEl = container.querySelector('.dsh-music-panel')
    // default: no inline geometry (CSS width / auto height), but a comfortable
    // auto-size min-height so a fresh (empty-list) panel does not open too short
    expect(panelEl.style.width).toBe('')
    expect(panelEl.style.minHeight).toBe('45vh')
    const pointer = (type, x, y) => {
      const ev = new Event(type, { bubbles: true })
      ev.clientX = x; ev.clientY = y; ev.button = 0; ev.pointerId = 1
      return ev
    }
    // drag the corner handle 100px right and 150px down
    act(() => { handle.dispatchEvent(pointer('pointerdown', 800, 600)) })
    act(() => { handle.dispatchEvent(pointer('pointermove', 900, 750)) })
    expect(parseInt(panelEl.style.width, 10)).toBe(700)   // 600 + 100
    expect(parseInt(panelEl.style.height, 10)).toBeGreaterThanOrEqual(200) // clamped min
    expect(panelEl.style.maxHeight).toBe('none') // explicit height wins over 72vh
    expect(panelEl.style.minHeight).toBe('') // auto-size min-height released once fixed
    // the resize is mirrored to the Host prefs (flushed on the ~800ms debounce)
    await act(async () => { await new Promise((r) => setTimeout(r, 950)) })
    const saved = JSON.parse(prefsServer['dsh-music-panel-pos'])
    expect(saved).toMatchObject({ w: 700 })
    expect(typeof saved.h).toBe('number')
    // shrink back below the min clamps to 320
    act(() => { handle.dispatchEvent(pointer('pointermove', 500, 300)) })
    expect(parseInt(panelEl.style.width, 10)).toBe(320)
    act(() => { handle.dispatchEvent(pointer('pointerup', 500, 300)) })
  })

  it('opens the chapter TOC scrolled to the currently playing chapter (not the top)', async () => {
    // Re-boot with a book in the library so AI 讲书 (book) mode is available.
    const book = { id: 'b1', name: '测试小说.txt', url: '/dsh-music/book/b1', size: 100, ext: 'txt' }
    const sections = [
      { type: 'preface', heading: '前言', fromChunk: 0 },
      { type: 'chapter', heading: '第一章 起', fromChunk: 0 },
      { type: 'chapter', heading: '第二章 承', fromChunk: 5 },
      { type: 'chapter', heading: '第三章 转', fromChunk: 10 },
      { type: 'epilogue', heading: '后记', fromChunk: 20 },
    ]
    manifest = { ...baseManifest(), ttsConfigured: true, ttsReason: '', books: [book] }
    vi.resetModules()
    lastFilesUrl = null
    await bootClient()
    // Serve the book's /meta (section structure); everything else falls back.
    const baseFetch = globalThis.fetch
    vi.stubGlobal('fetch', (url, opts) => {
      if (String(url).endsWith('/meta')) return jsonRes({ total: 25, title: '测试小说', author: '佚名', sections })
      return baseFetch(url, opts)
    })
    // jsdom has no scrollIntoView — spy on it to observe the TOC auto-scroll.
    const scrollSpy = vi.fn()
    Element.prototype.scrollIntoView = scrollSpy

    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    // open the panel -> 小说 tab -> start the book
    act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    const bookTab = [...container.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === 'AI讲书')
    expect(bookTab).toBeTruthy()
    act(() => { bookTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    const bookRow = [...container.querySelectorAll('.dsh-music-track')].find((b) => b.textContent.includes('测试小说'))
    expect(bookRow).toBeTruthy()
    act(() => { bookRow.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    // flush the async /meta fetch + chapter-structure state
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    // jump forward twice: 第一章 -> 第二章 -> 第三章
    const next = container.querySelector('button[title="下一章"]')
    expect(next).toBeTruthy()
    act(() => { next.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    act(() => { next.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    // open the chapter TOC — it must auto-scroll to the active (current) chapter
    const tocBtn = container.querySelector('button[title="章节目录"]')
    expect(tocBtn).toBeTruthy()
    await act(async () => { tocBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })); await new Promise((r) => setTimeout(r, 0)) })
    const toc = container.querySelector('.dsh-music-toc-list')
    expect(toc).toBeTruthy()
    // the popup must be a child of the button's relative wrapper (same anchor
    // pattern as the volume/mode popups — CSS positions it above the button).
    // 测试环境未提供 react-dom，portal 走内联回退（生产环境 portal 到 body）。
    const tocPanel = toc.closest('.dsh-music-toc')
    expect(tocPanel).toBeTruthy()
    expect(tocPanel.parentElement.classList.contains('dsh-music-toc-trigger')).toBe(true)
    expect(tocPanel.parentElement.contains(tocBtn)).toBe(true)
    // the popup anchors above the button via inline fixed positioning (anchorAbove)
    expect(tocPanel.style.position).toBe('fixed')
    // TOC 用 bottom 锚定（tocAnchorAbove）：底边贴住按钮上方、不被视口顶部钳制
    // 截断。jsdom 中 getBoundingClientRect 全零 → 走回退分支（bottom 被设置、top
    // 为空）；真实浏览器则 bottom = 距视口底边距离，始终贴住按钮上方 6px。
    expect(tocPanel.style.bottom).toBeTruthy()
    expect(tocPanel.style.top).toBe('')
    const activeItems = toc.querySelectorAll('.dsh-music-toc-item.active')
    expect(activeItems.length).toBe(1)
    expect(activeItems[0].textContent).toContain('第三章 转')
    // scrollIntoView must have been called on that active item (never on the top row)
    const tocScrollTargets = scrollSpy.mock.instances.filter((el) =>
      el && el.classList && el.classList.contains('dsh-music-toc-item') && el.classList.contains('active'))
    expect(tocScrollTargets.length).toBeGreaterThan(0)
    expect(tocScrollTargets.some((el) => el.textContent.includes('第三章 转'))).toBe(true)
    // the top (first) chapter must not have been the scroll target
    expect(tocScrollTargets.some((el) => el.textContent.includes('第一章 起'))).toBe(false)
  })

  it('anchors the AI 讲书 volume popup with bottom positioning (like the TOC, not cut off)', async () => {
    // Regression: the book-mode volume popup is variable-height (AI 声音 select +
    // 音量滑块), so it must use anchorPopAbove (bottom-anchored + height-capped) —
    // not anchorAbove (top + translateY(-100%)), which cuts off tall popups at the
    // viewport top and detaches their bottom edge from the bar.
    const book = { id: 'b1', name: '测试小说.txt', url: '/dsh-music/book/b1', size: 100, ext: 'txt' }
    manifest = { ...baseManifest(), ttsConfigured: true, ttsReason: '', books: [book] }
    vi.resetModules()
    lastFilesUrl = null
    await bootClient()
    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    const bookTab = [...container.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === 'AI讲书')
    expect(bookTab).toBeTruthy()
    act(() => { bookTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    const bookRow = [...container.querySelectorAll('.dsh-music-track')].find((b) => b.textContent.includes('测试小说'))
    expect(bookRow).toBeTruthy()
    act(() => { bookRow.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const barEl = container.querySelector('.dsh-music-bar')
    expect(barEl).toBeTruthy()
    act(() => { barEl.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })) })
    // 打开音量弹窗 → 讲书（book）模式
    const volBtn = [...container.querySelectorAll('.dsh-music-mode-trigger')].find((b) => b.title === '音量')
    expect(volBtn).toBeTruthy()
    act(() => { volBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const volPop = document.querySelector('.dsh-music-bar-vol-pop.book')
    expect(volPop).toBeTruthy()
    // 讲书音量弹窗用 anchorPopAbove：bottom 锚定（jsdom 中 rect 全零走回退分支，
    // bottom 被设置、top 为空）；真实浏览器则底边贴住按钮上方 6px、高度受限。
    expect(volPop.style.position).toBe('fixed')
    expect(volPop.style.bottom).toBeTruthy()
    expect(volPop.style.top).toBe('')
    // 弹窗内含 AI 声音选择 + 音量滑块
    expect(volPop.querySelector('.dsh-music-voice')).toBeTruthy()
    expect(volPop.querySelector('.dsh-music-vol-slider')).toBeTruthy()
  })

  it('shows the restored chapter immediately after a refresh (no play needed)', async () => {
    // Simulate a saved book playback at chunk 10 (第三章 转), then re-boot so
    // restoreLatest() runs during load — the same path as a page refresh.
    const sections = [
      { type: 'preface', heading: '前言', fromChunk: 0 },
      { type: 'chapter', heading: '第一章 起', fromChunk: 0 },
      { type: 'chapter', heading: '第二章 承', fromChunk: 5 },
      { type: 'chapter', heading: '第三章 转', fromChunk: 10 },
      { type: 'epilogue', heading: '后记', fromChunk: 20 },
    ]
    manifest = { ...baseManifest(), ttsConfigured: true, ttsReason: '', books: [{ id: 'b1', name: '测试小说.txt', url: '/dsh-music/book/b1', size: 100, ext: 'txt' }] }
    bookMetaSections = sections
    prefsServer = { 'dsh-music-books-playback': JSON.stringify({
      '测试小说.txt': { from: 10, base: 300, pos: 3, total: 25, ts: 999999999 },
    }) }
    vi.resetModules()
    lastFilesUrl = null
    await bootClient()
    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    // flush the restore-time async /meta fetch so currentSection arrives
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    // the restored chapter is appended after the book name (QQ-music「歌名 - 歌手」style),
    // and the trailing '.txt' is stripped from the displayed file name
    const nameSpan = container.querySelector('.dsh-music-bar-name')
    expect(nameSpan).toBeTruthy()
    expect(nameSpan.textContent).toContain('测试小说')
    expect(nameSpan.textContent).toContain('第三章 转')
    expect(nameSpan.textContent).not.toContain('测试小说.txt')
    // no standalone section badge remains inside the bar
    expect(nameSpan.querySelector('.dsh-music-bar-section')).toBeNull()
    expect(container.querySelector('.dsh-music-bar-section')).toBeNull()
    // AI 讲书模式下播放条不显示当前/总时长
    expect(container.querySelector('.dsh-music-bar-time')).toBeNull()
    // the book name is prefixed by a MIC icon (not the music note)
    const nameIcon = container.querySelector('.dsh-music-bar-name .dsh-music-note path')
    expect(nameIcon).toBeTruthy()
    expect(nameIcon.getAttribute('d')).toContain('M12 14c')
    // opening the TOC now highlights the restored chapter (not the first one)
    const tocBtn = container.querySelector('button[title="章节目录"]')
    expect(tocBtn).toBeTruthy()
    await act(async () => { tocBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })); await new Promise((r) => setTimeout(r, 0)) })
    const active = container.querySelector('.dsh-music-toc-item.active')
    expect(active).toBeTruthy()
    expect(active.textContent).toContain('第三章 转')
  })

  it('shows the restored book progress right after a refresh (before any play)', async () => {
    // Regression: after a refresh the book is restored PAUSED, so onTime never
    // fires and bookProgress would stay 0. The restore path must back-fill the
    // fill width from charOffsets once the meta loads — even before the user taps ▶.
    // Chunks: 10 / 20 / 30 chars, total 60. Restored at chunk index 2 → progress to
    // chunk start = offsets[2]/total = 30/60 = 50%.
    manifest = { ...baseManifest(), ttsConfigured: true, ttsReason: '', books: [{ id: 'b1', name: '进度恢复测试.txt', url: '/dsh-music/book/b1', size: 100, ext: 'txt' }] }
    bookMetaSections = []
    bookCharOffsets = [0, 10, 30, 60]
    prefsServer = { 'dsh-music-books-playback': JSON.stringify({
      '进度恢复测试.txt': { from: 2, base: 400, pos: 0, total: 25, ts: 999999999 },
    }) }
    vi.resetModules()
    lastFilesUrl = null
    await bootClient()
    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    // flush the restore-time async /meta fetch so charOffsets land + bookProgress fills
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    // the progress fill is computed from the restored chunk, NOT stuck at 0
    const fill = container.querySelector('.dsh-music-bar-progress-fill')
    expect(fill).toBeTruthy()
    expect(parseFloat(fill.style.width)).toBeCloseTo(50, 1)
  })

  it('loads the current chunk subtitle when resuming a restored book (no gap until next chunk)', async () => {
    // Regression: after a refresh the book is restored PAUSED. Resuming via ▶ went
    // straight to audio.play() WITHOUT loadBookSubtitle, so the current chunk's
    // subtitleLines stayed empty — the lyric only appeared at the NEXT chunk. The
    // resume path must fetch & show the current chunk's subtitle immediately.
    const audios = []
    class ResumeAudio extends FakeAudio {
      constructor() { super(); audios.push(this) }
      emit(type) { (this.listeners[type] || []).forEach((fn) => fn({ target: this })) }
    }
    vi.resetModules(); registered = []; lastFilesUrl = null
    manifest = { ...baseManifest(), ttsConfigured: true, ttsReason: '', books: [{ id: 'b1', name: '恢复字幕测试.txt', url: '/dsh-music/book/b1', size: 100, ext: 'txt' }] }
    bookMetaSections = []
    bookTextFixture = '这是恢复后应立刻出现的字幕。'
    prefsServer = { 'dsh-music-books-playback': JSON.stringify({ '恢复字幕测试.txt': { from: 0, base: 0, pos: 0, total: 1, ts: 999999999 } }) }
    window.__ModuleLoader__ = { load: (def) => { factory = def.factory } }
    vi.stubGlobal('Audio', ResumeAudio)
    vi.stubGlobal('fetch', fetchStub)
    vi.stubGlobal('requestAnimationFrame', () => 0)
    vi.stubGlobal('cancelAnimationFrame', () => {})
    vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '' }))
    vi.stubGlobal('setInterval', () => 0)
    vi.stubGlobal('clearInterval', () => {})
    window.confirm = () => true
    window.prompt = () => null
    await import('../lib/client.js')
    const modExports = factory((name) => (name === 'react' ? React : undefined))
    const slots = {
      inject: (name, cb) => { cb() },
      register: (meta, ef) => { registered.push({ id: meta.id, elementFactory: ef }); return ef },
    }
    modExports.apply({ get: (k) => (k === 'slots' ? slots : undefined), effect: (fn) => fn() })
    await new Promise((r) => setTimeout(r, 0))
    const audio = audios[0]
    expect(audio).toBeTruthy()
    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    // flush the restore-time async /meta fetch
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    // BEFORE resuming there is no subtitle (paused restore never loads it)
    // Resume: click ▶ → togglePlay loads the chunk and must load the subtitle.
    act(() => { container.querySelector('button[title="播放/暂停"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    // flush the loadBookSubtitle /text fetch
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    // give the media a duration + a position so updateLyric can pick line 0
    audio.duration = 10
    audio.currentTime = 0
    act(() => { audio.emit('timeupdate') })
    const lyric = container.querySelector('.dsh-music-bar-lyric')
    expect(lyric).toBeTruthy()
    expect(lyric.textContent).toContain('这是恢复后')
    bookTextFixture = ''
  })

  it('does NOT leak a restored in-chunk position into the NEXT chunk (resume near chunk end)', async () => {
    // Regression: resuming a book restores bookRestorePos (in-chunk position). When
    // that position sat at/near the chunk's END, the pin never released before the
    // chunk ended, so the stale pos leaked into the NEXT chunk — which got seeked
    // back to it (jumping each chunk to its end → 卡住/无声音/字幕不动). Advancing
    // to a new chunk must drop the pin.
    const audios = []
    class ResumeLeakAudio extends FakeAudio {
      constructor() { super(); audios.push(this) }
      emit(type) { (this.listeners[type] || []).forEach((fn) => fn({ target: this })) }
    }
    vi.resetModules(); registered = []; lastFilesUrl = null
    manifest = { ...baseManifest(), ttsConfigured: true, ttsReason: '', books: [{ id: 'b1', name: '续播泄漏测试.txt', url: '/dsh-music/book/b1', size: 100, ext: 'txt' }] }
    bookMetaSections = [{ type: 'chapter', heading: '第一章 起', fromChunk: 0 }, { type: 'chapter', heading: '第二章 承', fromChunk: 2 }]
    bookCharOffsets = [0, 100, 200, 300]
    bookTextFixture = '续播块的文本内容，含若干句子用于字幕。'
    prefsServer = { 'dsh-music-books-playback': JSON.stringify({
      '续播泄漏测试.txt': { from: 2, base: 400, pos: 30, total: 25, ts: 999999999 },
    }) }
    window.__ModuleLoader__ = { load: (def) => { factory = def.factory } }
    vi.stubGlobal('Audio', ResumeLeakAudio)
    vi.stubGlobal('fetch', fetchStub)
    vi.stubGlobal('requestAnimationFrame', () => 0)
    vi.stubGlobal('cancelAnimationFrame', () => {})
    vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '' }))
    vi.stubGlobal('setInterval', () => 0)
    vi.stubGlobal('clearInterval', () => {})
    window.confirm = () => true; window.prompt = () => null
    await import('../lib/client.js')
    const modExports = factory((name) => (name === 'react' ? React : undefined))
    const slots = { inject: (n, cb) => cb(), register: (meta, ef) => { registered.push({ id: meta.id, elementFactory: ef }); return ef } }
    modExports.apply({ get: (k) => (k === 'slots' ? slots : undefined), effect: (fn) => fn() })
    await new Promise((r) => setTimeout(r, 0))
    const audio = audios[0]
    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    const bookTab = [...container.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === 'AI讲书')
    act(() => { bookTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const bookRow = [...container.querySelectorAll('.dsh-music-track')].find((b) => b.textContent.includes('续播泄漏测试'))
    act(() => { bookRow.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(audio.src).toContain('from=2')

    // chunk 2 is 30s and the restored pos=30 sits at the very END: the pin never
    // releases (ct > 31 is impossible), so it holds until the chunk ends.
    audio.duration = 30
    act(() => { audio.emit('durationchange') })
    act(() => { audio.emit('play') })
    audio.currentTime = 30
    act(() => { audio.emit('timeupdate') })
    // chunk 2 ends -> auto-advance to chunk 3
    act(() => { audio.emit('ended') })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(audio.src).toContain('from=3')

    // chunk 3 starts fresh — a stale pin would re-seek it to 30 (clamped to end).
    audio.duration = 30
    audio.currentTime = 0.1
    act(() => { audio.emit('durationchange') })
    act(() => { audio.emit('timeupdate') })
    expect(audio.currentTime).toBeLessThan(1)
    bookTextFixture = ''
  })

  it('releases the restore pin when the saved in-chunk position is beyond the chunk (re-synthesized shorter)', async () => {
    // Regression: resuming into a chunk whose re-synthesized duration is SHORTER
    // than the saved in-chunk position. Seeking to the saved pos would clamp to the
    // end and instantly end the chunk (stall loop). The pin must release instead of
    // keeping the position pinned/unseekable.
    const audios = []
    class ShortChunkAudio extends FakeAudio {
      constructor() { super(); audios.push(this) }
      emit(type) { (this.listeners[type] || []).forEach((fn) => fn({ target: this })) }
    }
    vi.resetModules(); registered = []; lastFilesUrl = null
    manifest = { ...baseManifest(), ttsConfigured: true, ttsReason: '', books: [{ id: 'b1', name: '短块续播测试.txt', url: '/dsh-music/book/b1', size: 100, ext: 'txt' }] }
    bookMetaSections = []
    bookCharOffsets = [0, 100, 200, 300]
    bookTextFixture = '短块续播。'
    prefsServer = { 'dsh-music-books-playback': JSON.stringify({
      '短块续播测试.txt': { from: 2, base: 400, pos: 30, total: 25, ts: 999999999 },
    }) }
    window.__ModuleLoader__ = { load: (def) => { factory = def.factory } }
    vi.stubGlobal('Audio', ShortChunkAudio)
    vi.stubGlobal('fetch', fetchStub)
    vi.stubGlobal('requestAnimationFrame', () => 0)
    vi.stubGlobal('cancelAnimationFrame', () => {})
    vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '' }))
    vi.stubGlobal('setInterval', () => 0)
    vi.stubGlobal('clearInterval', () => {})
    window.confirm = () => true; window.prompt = () => null
    await import('../lib/client.js')
    const ex = factory((name) => (name === 'react' ? React : undefined))
    const slots = { inject: (n, cb) => cb(), register: (meta, ef) => { registered.push({ id: meta.id, elementFactory: ef }); return ef } }
    ex.apply({ get: (k) => (k === 'slots' ? slots : undefined), effect: (fn) => fn() })
    await new Promise((r) => setTimeout(r, 0))
    const audio = audios[0]
    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    const bookTab = [...container.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === 'AI讲书')
    act(() => { bookTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const bookRow = [...container.querySelectorAll('.dsh-music-track')].find((b) => b.textContent.includes('短块续播测试'))
    act(() => { bookRow.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(audio.src).toContain('from=2')

    // chunk duration is only 20s, but saved pos is 30 (beyond duration).
    audio.duration = 20
    act(() => { audio.emit('durationchange') })
    act(() => { audio.emit('play') })
    audio.currentTime = 0.1
    act(() => { audio.emit('timeupdate') })
    // Pin must have released (pos beyond duration), so currentTime is NOT forced to 30.
    expect(audio.currentTime).toBeLessThan(1)
    bookTextFixture = ''
  })

  it('pre-warms the resumed chunk at restore so a restart resume is instant (TTS cache cold)', async () => {
    // Regression: after restarting DSH the Host's in-memory TTS cache and the browser
    // HTTP cache are both empty, so the resumed chunk must be re-synthesized (several
    // to tens of seconds). While synthesizing, the bar sat pinned on the restored
    // position with no sound and no moving subtitle — the exact "重启后续播卡住"
    // symptom. The restore path must warm the resumed chunk in the background so the
    // tap ▶ is near-instant instead of hanging on a cold synthesis.
    const bookAudioFetches = []
    const wrappedFetch = (url, opts) => {
      const u = String(url)
      const m = /^\/dsh-music\/book\/(b\d+)\?from=(\d+)/.exec(u)
      if (m) bookAudioFetches.push({ id: m[1], from: parseInt(m[2], 10) })
      return fetchStub(url, opts)
    }
    vi.resetModules(); registered = []; lastFilesUrl = null
    manifest = { ...baseManifest(), ttsConfigured: true, ttsReason: '', books: [{ id: 'b1', name: '预热续播测试.txt', url: '/dsh-music/book/b1', size: 100, ext: 'txt' }] }
    bookMetaSections = []
    bookCharOffsets = [0, 100, 200, 300]
    prefsServer = { 'dsh-music-books-playback': JSON.stringify({
      '预热续播测试.txt': { from: 2, base: 400, pos: 5, total: 25, ts: 999999999 },
    }) }
    window.__ModuleLoader__ = { load: (def) => { factory = def.factory } }
    vi.stubGlobal('Audio', FakeAudio)
    vi.stubGlobal('fetch', wrappedFetch)
    vi.stubGlobal('requestAnimationFrame', () => 0)
    vi.stubGlobal('cancelAnimationFrame', () => {})
    vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '' }))
    vi.stubGlobal('setInterval', () => 0)
    vi.stubGlobal('clearInterval', () => {})
    window.confirm = () => true; window.prompt = () => null
    await import('../lib/client.js')
    const modExports = factory((name) => (name === 'react' ? React : undefined))
    const slots = { inject: (n, cb) => cb(), register: (meta, ef) => { registered.push({ id: meta.id, elementFactory: ef }); return ef } }
    modExports.apply({ get: (k) => (k === 'slots' ? slots : undefined), effect: (fn) => fn() })
    await new Promise((r) => setTimeout(r, 0))
    // flush the restore-time async /meta + warm-fetch path
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    // the resumed chunk (from=2) must have been warmed via a background fetch, so a
    // cold synthesis isn't left to the tap ▶ (which would show a frozen bar).
    expect(bookAudioFetches).toContainEqual({ id: 'b1', from: 2 })
    bookTextFixture = ''
  })

  it('shows the "AI 合成中…" feedback when resuming a cold chunk and clears it on playback start', async () => {
    // Regression: after restarting DSH the resumed chunk may still need synthesizing
    // (cold cache). The resume path (togglePlay) never armed the buffer indicator or
    // the 60s synthesis timeout, so the bar sat pinned on the restored position —
    // 无声音、字幕不动、看起来像卡住. The resume path must show the same
    // "AI 合成中… Ns" feedback as a fresh play, and clear it once playback truly starts.
    const audios = []
    class ResumeBufferAudio extends FakeAudio {
      constructor() { super(); audios.push(this); this._resolvePlay = null }
      play() {
        this.paused = false
        this._playPromise = new Promise((res) => { this._resolvePlay = res })
        return this._playPromise
      }
      resolvePlay() { if (this._resolvePlay) { const r = this._resolvePlay; this._resolvePlay = null; r() } }
    }
    vi.resetModules(); registered = []; lastFilesUrl = null
    manifest = { ...baseManifest(), ttsConfigured: true, ttsReason: '', books: [{ id: 'b1', name: '续播缓冲反馈测试.txt', url: '/dsh-music/book/b1', size: 100, ext: 'txt' }] }
    bookMetaSections = []
    bookTextFixture = '续播缓冲反馈文本。'
    prefsServer = { 'dsh-music-books-playback': JSON.stringify({
      '续播缓冲反馈测试.txt': { from: 2, base: 400, pos: 3, total: 25, ts: 999999999 },
    }) }
    window.__ModuleLoader__ = { load: (def) => { factory = def.factory } }
    vi.stubGlobal('Audio', ResumeBufferAudio)
    vi.stubGlobal('fetch', fetchStub)
    vi.stubGlobal('requestAnimationFrame', () => 0)
    vi.stubGlobal('cancelAnimationFrame', () => {})
    vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '' }))
    vi.stubGlobal('setInterval', () => 0)
    vi.stubGlobal('clearInterval', () => {})
    window.confirm = () => true; window.prompt = () => null
    await import('../lib/client.js')
    const modExports = factory((name) => (name === 'react' ? React : undefined))
    const slots = { inject: (n, cb) => cb(), register: (meta, ef) => { registered.push({ id: meta.id, elementFactory: ef }); return ef } }
    modExports.apply({ get: (k) => (k === 'slots' ? slots : undefined), effect: (fn) => fn() })
    await new Promise((r) => setTimeout(r, 0))
    const audio = audios[0]
    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    // resume via ▶ → the bar must show the synthesis feedback while the chunk is cold
    act(() => { container.querySelector('button[title="播放/暂停"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(container.querySelector('.dsh-music-bar-buffering')).toBeTruthy()
    // once playback truly starts, the feedback clears (no lingering spinner)
    audio.resolvePlay()
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(container.querySelector('.dsh-music-bar-buffering')).toBeNull()
    bookTextFixture = ''
  })

  it('jumps to the NEXT chunk when the saved position is beyond the re-synthesized chunk (no replay, no clamp-to-end stall)', async () => {
    // Regression ("重启后点以前听过的书 → 合成完响一下就没声音、字幕不动"): after a DSH
    // restart the chunk is re-synthesized and may come out SHORTER than the saved
    // in-chunk position. Seeking to that saved pos clamps to the chunk END, and the
    // browser may not fire `ended` — the audio stalls after a blip. Since the saved
    // position is past this chunk, the reader has effectively finished it, so the
    // correct resume is to JUMP to the next chunk — not replay this one, and never
    // force currentTime to an out-of-range/clamped position.
    const audios = []
    class ReSynthShorterAudio extends FakeAudio {
      constructor() { super(); audios.push(this) }
      emit(type) { (this.listeners[type] || []).forEach((fn) => fn({ target: this })) }
    }
    vi.resetModules(); registered = []; lastFilesUrl = null
    manifest = { ...baseManifest(), ttsConfigured: true, ttsReason: '', books: [{ id: 'b1', name: '重合成变短续播.txt', url: '/dsh-music/book/b1', size: 100, ext: 'txt' }] }
    bookMetaSections = []
    bookCharOffsets = [0, 100, 200, 300]
    bookTextFixture = '重合成变短续播文本。'
    // saved pos=25 was valid for the OLD 30s chunk; after restart the re-synthesized
    // chunk is only 20s, so pos is now beyond the chunk (the user finished chunk 2).
    prefsServer = { 'dsh-music-books-playback': JSON.stringify({
      '重合成变短续播.txt': { from: 2, base: 400, pos: 25, total: 25, ts: 999999999 },
    }) }
    window.__ModuleLoader__ = { load: (def) => { factory = def.factory } }
    vi.stubGlobal('Audio', ReSynthShorterAudio)
    vi.stubGlobal('fetch', fetchStub)
    vi.stubGlobal('requestAnimationFrame', () => 0)
    vi.stubGlobal('cancelAnimationFrame', () => {})
    vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '' }))
    vi.stubGlobal('setInterval', () => 0)
    vi.stubGlobal('clearInterval', () => {})
    window.confirm = () => true; window.prompt = () => null
    await import('../lib/client.js')
    const modExports = factory((name) => (name === 'react' ? React : undefined))
    const slots = { inject: (n, cb) => cb(), register: (meta, ef) => { registered.push({ id: meta.id, elementFactory: ef }); return ef } }
    modExports.apply({ get: (k) => (k === 'slots' ? slots : undefined), effect: (fn) => fn() })
    await new Promise((r) => setTimeout(r, 0))
    const audio = audios[0]
    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    const bookTab = [...container.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === 'AI讲书')
    act(() => { bookTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const bookRow = [...container.querySelectorAll('.dsh-music-track')].find((b) => b.textContent.includes('重合成变短续播'))
    act(() => { bookRow.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(audio.src).toContain('from=2')

    // Duration still unknown (metadata not loaded) when the pin first runs: the pin
    // must NOT seek currentTime to pos yet (it would be clamped later to a wrong spot).
    audio.duration = NaN
    act(() => { audio.emit('durationchange') }) // onDur ignores NaN
    act(() => { audio.emit('play') })
    audio.currentTime = 0.1
    act(() => { audio.emit('timeupdate') })
    expect(audio.currentTime).toBeLessThan(1) // not forced to the (unknown) pos

    // Duration resolves to 20s (< saved pos 25): the saved position is past the chunk,
    // so the reader has finished it — the book must JUMP to the NEXT chunk (from=3),
    // not re-listen chunk 2 and never force currentTime to the clamped 20s end.
    audio.duration = 20
    act(() => { audio.emit('durationchange') })
    audio.currentTime = 0.1
    act(() => { audio.emit('timeupdate') })
    expect(audio.src).toContain('from=3')        // jumped forward to chunk 3
    expect(audio.currentTime).toBeLessThan(1)    // never clamped to the 20s end

    // The next chunk plays fresh (no stale pin), and the book continues normally.
    audio.duration = 30
    audio.currentTime = 0.1
    act(() => { audio.emit('durationchange') })
    act(() => { audio.emit('timeupdate') })
    expect(audio.currentTime).toBeLessThan(1)
    bookTextFixture = ''
  })

  it('does NOT append a chapter name or the “-” separator when the novel has no chapters', async () => {
    // A novel with no detectable section structure must show ONLY the book title
    // in the bar — no " - " and no chapter text appended (currentSection stays '').
    manifest = { ...baseManifest(), ttsConfigured: true, ttsReason: '', books: [{ id: 'b1', name: '无章节小说.txt', url: '/dsh-music/book/b1', size: 100, ext: 'txt' }] }
    bookMetaSections = [] // no structure -> parser returns empty sections
    prefsServer = { 'dsh-music-books-playback': JSON.stringify({
      '无章节小说.txt': { from: 3, base: 100, pos: 1, total: 25, ts: 999999999 },
    }) }
    vi.resetModules()
    lastFilesUrl = null
    await bootClient()
    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    // flush the restore-time async /meta fetch so currentSection would arrive only if sections exist
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const nameSpan = container.querySelector('.dsh-music-bar-name')
    expect(nameSpan).toBeTruthy()
    // title only: extension stripped, NO chapter appended, NO "- " separator
    expect(nameSpan.textContent).toContain('无章节小说')
    expect(nameSpan.textContent).not.toContain('无章节小说.txt')
    expect(nameSpan.textContent).not.toContain('-')
    expect(nameSpan.querySelector('.dsh-music-bar-artist')).toBeNull()
  })

  it('clears a stale chapter name when switching to a novel that has no chapters', async () => {
    // Regression: play a book WITH chapters (sets currentSection), then switch to
    // a book WITHOUT chapters. The bar must NOT show the previous book's chapter
    // (and no " - " separator) — currentSection must be reset on book switch.
    const sections = [
      { type: 'chapter', heading: '第一章 起', fromChunk: 0 },
      { type: 'chapter', heading: '第二章 承', fromChunk: 5 },
    ]
    manifest = { ...baseManifest(), ttsConfigured: true, ttsReason: '', books: [
      { id: 'b1', name: '有章节小说.txt', url: '/dsh-music/book/b1', size: 100, ext: 'txt' },
      { id: 'b2', name: '无章节小说.txt', url: '/dsh-music/book/b2', size: 100, ext: 'txt' },
    ] }
    bookMetaById = { b1: sections, b2: [] }
    vi.resetModules()
    lastFilesUrl = null
    await bootClient()
    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    const bookTab = [...container.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === 'AI讲书')
    expect(bookTab).toBeTruthy()
    act(() => { bookTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    // play the chaptered book first
    const chBook = [...container.querySelectorAll('.dsh-music-track')].find((b) => b.textContent.includes('有章节小说'))
    expect(chBook).toBeTruthy()
    act(() => { chBook.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    let nameSpan = container.querySelector('.dsh-music-bar-name')
    expect(nameSpan.textContent).toContain('有章节小说')
    expect(nameSpan.textContent).toContain('第一章 起')
    expect(nameSpan.textContent).toContain('-')
    // now switch to the chapter-less book
    const plainBook = [...container.querySelectorAll('.dsh-music-track')].find((b) => b.textContent.includes('无章节小说'))
    expect(plainBook).toBeTruthy()
    act(() => { plainBook.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    nameSpan = container.querySelector('.dsh-music-bar-name')
    expect(nameSpan.textContent).toContain('无章节小说')
    expect(nameSpan.textContent).not.toContain('.txt')      // extension stripped
    expect(nameSpan.textContent).not.toContain('第一章 起') // no stale chapter
    expect(nameSpan.textContent).not.toContain('-')         // no separator
    expect(nameSpan.querySelector('.dsh-music-bar-artist')).toBeNull()
  })

  it('keeps a quoted dialogue on a single AI 讲书 subtitle line (no split on 。? inside “”)', async () => {
    // The subtitle line for a book chunk is cut by splitSentences, which must
    // treat “...” as atomic — a 。/？ inside the quotes must NOT split the line.
    const audios = []
    class SubAudio extends FakeAudio {
      constructor() { super(); audios.push(this) }
      emit(type) { (this.listeners[type] || []).forEach((fn) => fn({ target: this })) }
    }
    vi.resetModules(); registered = []; lastFilesUrl = null
    manifest = { ...baseManifest(), ttsConfigured: true, ttsReason: '', books: [{ id: 'b1', name: '对话测试.txt', url: '/dsh-music/book/b1', size: 100, ext: 'txt' }] }
    bookMetaSections = []
    bookTextFixture = '他说：“你来了吗？”她点头。'
    window.__ModuleLoader__ = { load: (def) => { factory = def.factory } }
    vi.stubGlobal('Audio', SubAudio)
    vi.stubGlobal('fetch', fetchStub)
    vi.stubGlobal('requestAnimationFrame', () => 0)
    vi.stubGlobal('cancelAnimationFrame', () => {})
    vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '' }))
    vi.stubGlobal('setInterval', () => 0)
    vi.stubGlobal('clearInterval', () => {})
    window.confirm = () => true
    window.prompt = () => null
    await import('../lib/client.js')
    const modExports = factory((name) => (name === 'react' ? React : undefined))
    const slots = {
      inject: (name, cb) => { cb() },
      register: (meta, elementFactory) => { registered.push({ id: meta.id, elementFactory }); return elementFactory },
    }
    modExports.apply({ get: (k) => (k === 'slots' ? slots : undefined), effect: (fn) => fn() })
    await new Promise((r) => setTimeout(r, 0))
    const audio = audios[0]
    expect(audio).toBeTruthy()
    try {
      const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
      const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
      const container = document.createElement('div')
      document.body.appendChild(container)
      const root = createRoot(container)
      act(() => { root.render(React.createElement('div', null, bar, panel)) })
      act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      const bookTab = [...container.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === 'AI讲书')
      expect(bookTab).toBeTruthy()
      act(() => { bookTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      const bookRow = [...container.querySelectorAll('.dsh-music-track')].find((b) => b.textContent.includes('对话测试'))
      expect(bookRow).toBeTruthy()
      act(() => { bookRow.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      // flush the /text fetch that fills subtitleLines
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      // real chunk duration + position so updateLyric selects line 0
      audio.duration = 10
      audio.currentTime = 0
      act(() => { audio.emit('timeupdate') })
      // idle (non-hovered) bar shows the subtitle line
      const lyric = container.querySelector('.dsh-music-bar-lyric')
      expect(lyric).toBeTruthy()
      // the whole sentence is one line (content ≤20): the 。? inside “...” didn't split it
      expect(lyric.textContent).toContain('他说：“你来了吗？”她点头。')
      expect(lyric.textContent).toContain('你来了吗？”')
    } finally {
      bookTextFixture = ''
    }
  })

  it('wraps long AI 讲书 subtitle lines adaptively, each no longer than 20 chars', async () => {
    // A single long chunk (>20 content chars) full of commas: it must wrap into
    // ≤20-char lines at the natural clause pauses, and keep the dialogue whole.
    const audios = []
    class WrapAudio extends FakeAudio {
      constructor() { super(); audios.push(this) }
      emit(type) { (this.listeners[type] || []).forEach((fn) => fn({ target: this })) }
    }
    vi.resetModules(); registered = []; lastFilesUrl = null
    manifest = { ...baseManifest(), ttsConfigured: true, ttsReason: '', books: [{ id: 'b1', name: '长句测试.txt', url: '/dsh-music/book/b1', size: 100, ext: 'txt' }] }
    bookMetaSections = []
    bookTextFixture = '他说：“我们走吧。”接着，他转身走了出去，留下我一个人在原地发呆，心里想着他刚才说的那一番话。'
    window.__ModuleLoader__ = { load: (def) => { factory = def.factory } }
    vi.stubGlobal('Audio', WrapAudio)
    vi.stubGlobal('fetch', fetchStub)
    vi.stubGlobal('requestAnimationFrame', () => 0)
    vi.stubGlobal('cancelAnimationFrame', () => {})
    vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '' }))
    vi.stubGlobal('setInterval', () => 0)
    vi.stubGlobal('clearInterval', () => {})
    window.confirm = () => true
    window.prompt = () => null
    await import('../lib/client.js')
    const modExports = factory((name) => (name === 'react' ? React : undefined))
    const slots = {
      inject: (name, cb) => { cb() },
      register: (meta, elementFactory) => { registered.push({ id: meta.id, elementFactory }); return elementFactory },
    }
    modExports.apply({ get: (k) => (k === 'slots' ? slots : undefined), effect: (fn) => fn() })
    await new Promise((r) => setTimeout(r, 0))
    const audio = audios[0]
    expect(audio).toBeTruthy()
    try {
      const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
      const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
      const container = document.createElement('div')
      document.body.appendChild(container)
      const root = createRoot(container)
      act(() => { root.render(React.createElement('div', null, bar, panel)) })
      act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      const bookTab = [...container.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === 'AI讲书')
      expect(bookTab).toBeTruthy()
      act(() => { bookTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      const bookRow = [...container.querySelectorAll('.dsh-music-track')].find((b) => b.textContent.includes('长句测试'))
      expect(bookRow).toBeTruthy()
      act(() => { bookRow.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      audio.duration = 10
      const seen = new Set()
      // sample progress across the whole chunk so every subtitle line surfaces
      for (let t = 0; t <= 9.9; t += 0.05) {
        audio.currentTime = t
        act(() => { audio.emit('timeupdate') })
        const el = container.querySelector('.dsh-music-bar-lyric')
        if (el && el.textContent) seen.add(el.textContent)
      }
      // the long sentence wrapped into multiple lines, each line ≤ 20 汉字(去标点)
      expect(seen.size).toBeGreaterThan(1)
      for (const line of seen) expect(subContentLen(line)).toBeLessThanOrEqual(20)
      // the quoted dialogue stays on a single line (never split inside “”)
      const holder = [...seen].find((l) => l.includes('“我们走吧'))
      expect(holder).toBeTruthy()
      expect(holder).toContain('我们走吧。”')
    } finally {
      bookTextFixture = ''
    }
  })

  it('breaks a long quoted dialogue at its internal commas instead of a hard cut', async () => {
    // A single quoted dialogue longer than 20 content chars: when it must be
    // split, the cut should land on a comma (inside the quote) — a graceful
    // clause pause, NOT a hard slice at the content boundary.
    const audios = []
    class LongQuoteAudio extends FakeAudio {
      constructor() { super(); audios.push(this) }
      emit(type) { (this.listeners[type] || []).forEach((fn) => fn({ target: this })) }
    }
    vi.resetModules(); registered = []; lastFilesUrl = null
    manifest = { ...baseManifest(), ttsConfigured: true, ttsReason: '', books: [{ id: 'b1', name: '长对话测试.txt', url: '/dsh-music/book/b1', size: 100, ext: 'txt' }] }
    bookMetaSections = []
    bookTextFixture = '他说：“我们先商量一下，然后再做决定，千万不要冲动。”'
    window.__ModuleLoader__ = { load: (def) => { factory = def.factory } }
    vi.stubGlobal('Audio', LongQuoteAudio)
    vi.stubGlobal('fetch', fetchStub)
    vi.stubGlobal('requestAnimationFrame', () => 0)
    vi.stubGlobal('cancelAnimationFrame', () => {})
    vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '' }))
    vi.stubGlobal('setInterval', () => 0)
    vi.stubGlobal('clearInterval', () => {})
    window.confirm = () => true
    window.prompt = () => null
    await import('../lib/client.js')
    const modExports = factory((name) => (name === 'react' ? React : undefined))
    const slots = {
      inject: (name, cb) => { cb() },
      register: (meta, elementFactory) => { registered.push({ id: meta.id, elementFactory }); return elementFactory },
    }
    modExports.apply({ get: (k) => (k === 'slots' ? slots : undefined), effect: (fn) => fn() })
    await new Promise((r) => setTimeout(r, 0))
    const audio = audios[0]
    expect(audio).toBeTruthy()
    try {
      const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
      const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
      const container = document.createElement('div')
      document.body.appendChild(container)
      const root = createRoot(container)
      act(() => { root.render(React.createElement('div', null, bar, panel)) })
      act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      const bookTab = [...container.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === 'AI讲书')
      expect(bookTab).toBeTruthy()
      act(() => { bookTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      const bookRow = [...container.querySelectorAll('.dsh-music-track')].find((b) => b.textContent.includes('长对话测试'))
      expect(bookRow).toBeTruthy()
      act(() => { bookRow.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      audio.duration = 10
      const seen = new Set()
      for (let t = 0; t <= 9.9; t += 0.05) {
        audio.currentTime = t
        act(() => { audio.emit('timeupdate') })
        const el = container.querySelector('.dsh-music-bar-lyric')
        if (el && el.textContent) seen.add(el.textContent)
      }
      // the long dialogue split into several lines, each ≤20 content chars
      expect(seen.size).toBeGreaterThan(1)
      for (const line of seen) expect(subContentLen(line)).toBeLessThanOrEqual(20)
      // every cut lands on a clause pause (comma) — never a bare hard slice
      for (const line of seen) expect(line.endsWith('，') || line.endsWith('。”')).toBe(true)
    } finally {
      bookTextFixture = ''
    }
  })

  it('breaks a long quoted dialogue at its internal 。！？ (sentence-end inside quotes) too', async () => {
    // splitSentences skips 。！？ inside quotes (only breaks at the closing quote),
    // so a long quoted dialogue may contain internal sentence ends. wrapSubtitleLine
    // must also cut at those 。！？ — not hard-slice mid-content.
    const audios = []
    class LongQuotePauseAudio extends FakeAudio {
      constructor() { super(); audios.push(this) }
      emit(type) { (this.listeners[type] || []).forEach((fn) => fn({ target: this })) }
    }
    vi.resetModules(); registered = []; lastFilesUrl = null
    manifest = { ...baseManifest(), ttsConfigured: true, ttsReason: '', books: [{ id: 'b1', name: '长标点测试.txt', url: '/dsh-music/book/b1', size: 100, ext: 'txt' }] }
    bookMetaSections = []
    bookTextFixture = '他说：“句子一。句子二？句子三。句子四。句子五。句子六。句子七。”'
    window.__ModuleLoader__ = { load: (def) => { factory = def.factory } }
    vi.stubGlobal('Audio', LongQuotePauseAudio)
    vi.stubGlobal('fetch', fetchStub)
    vi.stubGlobal('requestAnimationFrame', () => 0)
    vi.stubGlobal('cancelAnimationFrame', () => {})
    vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '' }))
    vi.stubGlobal('setInterval', () => 0)
    vi.stubGlobal('clearInterval', () => {})
    window.confirm = () => true
    window.prompt = () => null
    await import('../lib/client.js')
    const modExports = factory((name) => (name === 'react' ? React : undefined))
    const slots = {
      inject: (name, cb) => { cb() },
      register: (meta, elementFactory) => { registered.push({ id: meta.id, elementFactory }); return elementFactory },
    }
    modExports.apply({ get: (k) => (k === 'slots' ? slots : undefined), effect: (fn) => fn() })
    await new Promise((r) => setTimeout(r, 0))
    const audio = audios[0]
    expect(audio).toBeTruthy()
    try {
      const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
      const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
      const container = document.createElement('div')
      document.body.appendChild(container)
      const root = createRoot(container)
      act(() => { root.render(React.createElement('div', null, bar, panel)) })
      act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      const bookTab = [...container.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === 'AI讲书')
      expect(bookTab).toBeTruthy()
      act(() => { bookTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      const bookRow = [...container.querySelectorAll('.dsh-music-track')].find((b) => b.textContent.includes('长标点测试'))
      expect(bookRow).toBeTruthy()
      act(() => { bookRow.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      audio.duration = 10
      const seen = new Set()
      for (let t = 0; t <= 9.9; t += 0.05) {
        audio.currentTime = t
        act(() => { audio.emit('timeupdate') })
        const el = container.querySelector('.dsh-music-bar-lyric')
        if (el && el.textContent) seen.add(el.textContent)
      }
      // split into several lines, each ≤20 content chars, and every cut lands on 。！？，
      const enders = new Set('，。？！：；”')
      expect(seen.size).toBeGreaterThan(1)
      for (const line of seen) {
        expect(subContentLen(line)).toBeLessThanOrEqual(20)
        expect(enders.has(line.trim().slice(-1))).toBe(true) // 断在标点，不裸切
      }
    } finally {
      bookTextFixture = ''
    }
  })

  it('weights AI 讲书 subtitle timing by line length so a long line is not swapped out early', async () => {
    // Two lines: a long first sentence and a 2-char second. TTS duration ∝ chars,
    // so the long line should fill most of the chunk. At p=0.6 the uniform "1/N"
    // mapping would jump to the short line, but the char-weighted mapping must
    // still show the long line.
    const audios = []
    class WeightAudio extends FakeAudio {
      constructor() { super(); audios.push(this) }
      emit(type) { (this.listeners[type] || []).forEach((fn) => fn({ target: this })) }
    }
    vi.resetModules(); registered = []; lastFilesUrl = null
    manifest = { ...baseManifest(), ttsConfigured: true, ttsReason: '', books: [{ id: 'b1', name: '加权测试.txt', url: '/dsh-music/book/b1', size: 100, ext: 'txt' }] }
    bookMetaSections = []
    bookTextFixture = '甲，乙，丙，丁，戊，己，庚，辛，壬，癸，子，丑，寅，卯，辰，巳，午，未，申，酉，戌，亥。'
    window.__ModuleLoader__ = { load: (def) => { factory = def.factory } }
    vi.stubGlobal('Audio', WeightAudio)
    vi.stubGlobal('fetch', fetchStub)
    vi.stubGlobal('requestAnimationFrame', () => 0)
    vi.stubGlobal('cancelAnimationFrame', () => {})
    vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '' }))
    vi.stubGlobal('setInterval', () => 0)
    vi.stubGlobal('clearInterval', () => {})
    window.confirm = () => true
    window.prompt = () => null
    await import('../lib/client.js')
    const modExports = factory((name) => (name === 'react' ? React : undefined))
    const slots = {
      inject: (name, cb) => { cb() },
      register: (meta, elementFactory) => { registered.push({ id: meta.id, elementFactory }); return elementFactory },
    }
    modExports.apply({ get: (k) => (k === 'slots' ? slots : undefined), effect: (fn) => fn() })
    await new Promise((r) => setTimeout(r, 0))
    const audio = audios[0]
    expect(audio).toBeTruthy()
    try {
      const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
      const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
      const container = document.createElement('div')
      document.body.appendChild(container)
      const root = createRoot(container)
      act(() => { root.render(React.createElement('div', null, bar, panel)) })
      act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      const bookTab = [...container.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === 'AI讲书')
      expect(bookTab).toBeTruthy()
      act(() => { bookTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      const bookRow = [...container.querySelectorAll('.dsh-music-track')].find((b) => b.textContent.includes('加权测试'))
      expect(bookRow).toBeTruthy()
      act(() => { bookRow.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      // p = 6/10 = 0.6 — uniform "floor(0.6 * 2) = 1" → the short line; weighted keeps the long one.
      audio.duration = 10
      audio.currentTime = 6
      act(() => { audio.emit('timeupdate') })
      const lyric = container.querySelector('.dsh-music-bar-lyric')
      expect(lyric).toBeTruthy()
      // the long first line (20 content chars) still shows, NOT the 2-char second line
      expect(lyric.textContent).toContain('甲')
      expect(lyric.textContent).not.toContain('亥')
      // and the early part of the chunk keeps the same long line
      audio.currentTime = 1
      act(() => { audio.emit('timeupdate') })
      expect(container.querySelector('.dsh-music-bar-lyric').textContent).toContain('甲')
    } finally {
      bookTextFixture = ''
    }
  })

  // Boot a fresh client instance whose FakeAudio can emit events, mount the bar +
  // panel, open the AI 讲书 tab, and click the matching book row. Returns the
  // mounted container and the created <audio> so a test can drive
  // currentTime/duration and read the rendered progress fill + percent readout.
  async function mountProgressBook({ bookName, charOffsets, text }) {
    const audios = []
    class ProgressAudio extends FakeAudio {
      constructor() { super(); audios.push(this) }
      emit(type) { (this.listeners[type] || []).forEach((fn) => fn({ target: this })) }
    }
    vi.resetModules(); registered = []; lastFilesUrl = null
    manifest = { ...baseManifest(), ttsConfigured: true, ttsReason: '', books: [{ id: 'b1', name: bookName, url: '/dsh-music/book/b1', size: 100, ext: 'txt' }] }
    bookMetaSections = []
    bookCharOffsets = charOffsets
    bookTextFixture = text
    window.__ModuleLoader__ = { load: (def) => { factory = def.factory } }
    vi.stubGlobal('Audio', ProgressAudio)
    vi.stubGlobal('fetch', fetchStub)
    vi.stubGlobal('requestAnimationFrame', () => 0)
    vi.stubGlobal('cancelAnimationFrame', () => {})
    vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '' }))
    vi.stubGlobal('setInterval', () => 0)
    vi.stubGlobal('clearInterval', () => {})
    window.confirm = () => true
    window.prompt = () => null
    await import('../lib/client.js')
    const modExports = factory((name) => (name === 'react' ? React : undefined))
    const slots = {
      inject: (name, cb) => { cb() },
      register: (meta, ef) => { registered.push({ id: meta.id, elementFactory: ef }); return ef },
    }
    modExports.apply({ get: (k) => (k === 'slots' ? slots : undefined), effect: (fn) => fn() })
    await new Promise((r) => setTimeout(r, 0))
    const audio = audios[0]
    expect(audio).toBeTruthy()
    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    const bookTab = [...container.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === 'AI讲书')
    expect(bookTab).toBeTruthy()
    act(() => { bookTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    const bookRow = [...container.querySelectorAll('.dsh-music-track')].find((b) => b.textContent.includes(bookName))
    expect(bookRow).toBeTruthy()
    act(() => { bookRow.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    // flush the async /meta (charOffsets) + /text (subtitle) fetches
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    return { container, audio }
  }

  it('fills the AI 讲书 progress bar by read-char / total-char (not chunk time ratio)', async () => {
    // Two chunks: chunk0 = 10 chars, chunk1 = 20 chars, total 30. 块内按时间占比插值
    // 到已读字符数，再除以全书字符——而不是用 position/duration（那会切块回退）。
    const { container, audio } = await mountProgressBook({ bookName: '进度测试.txt', charOffsets: [0, 10, 30], text: '甲' })
    audio.duration = 10
    audio.currentTime = 5 // chunk0 中点
    act(() => { audio.emit('timeupdate') })
    // consumed = offsets[0] + (10-0) * (5/10) = 5 ; progress = 5/30 ≈ 16.7%
    const fill = container.querySelector('.dsh-music-bar-progress-fill')
    expect(fill).toBeTruthy()
    expect(parseFloat(fill.style.width)).toBeCloseTo(16.67, 1)
    // 前进到 chunk0 末端 → consumed = 10 → 33.3%
    audio.currentTime = 10
    act(() => { audio.emit('timeupdate') })
    expect(parseFloat(container.querySelector('.dsh-music-bar-progress-fill').style.width)).toBeCloseTo(33.33, 1)
    bookTextFixture = ''
  })

  it('keeps AI 讲书 progress monotonic across a chunk boundary (never steps back)', async () => {
    const { container, audio } = await mountProgressBook({ bookName: '跨块进度测试.txt', charOffsets: [0, 10, 30], text: '甲' })
    // chunk0 播完 → progress = offsets[1]/total = 10/30 = 33.3%
    audio.duration = 10
    audio.currentTime = 10
    act(() => { audio.emit('timeupdate') })
    const p0 = parseFloat(container.querySelector('.dsh-music-bar-progress-fill').style.width)
    expect(p0).toBeCloseTo(33.33, 1)
    // chunk0 结束 → 自动切到 chunk1（bookFromRef = 1）
    act(() => { audio.emit('ended') })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    // 新块从块内位置 0 开始：consumed = offsets[1] + 0 = 10 → 33.3%，与上一块末端连续
    audio.duration = 20
    audio.currentTime = 0
    act(() => { audio.emit('timeupdate') })
    const p1 = parseFloat(container.querySelector('.dsh-music-bar-progress-fill').style.width)
    expect(p1).toBeCloseTo(33.33, 1)      // 不是回退到更低的百分比
    expect(p1).toBeGreaterThanOrEqual(p0 - 0.001) // 单调：只增不减
    // 且随 chunk1 播放继续爬升（块内插值）
    audio.currentTime = 10
    act(() => { audio.emit('timeupdate') })
    const p2 = parseFloat(container.querySelector('.dsh-music-bar-progress-fill').style.width)
    expect(p2).toBeGreaterThan(p1)
    expect(p2).toBeCloseTo((10 + 20 * 0.5) / 30 * 100, 1) // 50%
    bookTextFixture = ''
  })

  it('tolerates a nearby comma just past the hard-cut boundary (line stays complete)', async () => {
    // 22 个连续汉字后接逗号、窗口内无任何停顿标点：硬切本会在第 20 字处断。容忍算法把
    // 行尾挪到边界后不远处（≤ SUBTITLE_TOLERANCE 字）的逗号之后，使这一行以完整分句结束。
    const fixture = '甲乙丙丁戊己庚辛壬癸子丑寅卯辰巳午未申酉戌亥，'
    const { container, audio } = await mountProgressBook({ bookName: '容忍标点测试.txt', charOffsets: [0, 40], text: fixture })
    audio.duration = 10
    const seen = new Set()
    for (let t = 0; t <= 9.9; t += 0.05) {
      audio.currentTime = t
      act(() => { audio.emit('timeupdate') })
      const el = container.querySelector('.dsh-music-bar-lyric')
      if (el && el.textContent) seen.add(el.textContent)
    }
    expect(seen.size).toBe(1)                 // 没有额外再拆出一行
    const line = [...seen][0]
    expect(subContentLen(line)).toBe(22)      // 容忍后略超 20 字
    expect(line.endsWith('，')).toBe(true)     // 且落在完整分句上，不是裸切
    bookTextFixture = ''
  })

  it('swallows a tiny chunk tail when the block is about to end (no stub line)', async () => {
    // 23 个连续汉字、无任何标点：硬切会拆成「20 字 + 3 字残行」。容忍算法在块尾只余
    // ≤ SUBTITLE_TOLERANCE 字时把尾巴并入本行，避免末尾出现一个极短残行。
    const fixture = '甲乙丙丁戊己庚辛壬癸子丑寅卯辰巳午未申酉戌亥走'
    const { container, audio } = await mountProgressBook({ bookName: '容忍块尾测试.txt', charOffsets: [0, 40], text: fixture })
    audio.duration = 10
    const seen = new Set()
    for (let t = 0; t <= 9.9; t += 0.05) {
      audio.currentTime = t
      act(() => { audio.emit('timeupdate') })
      const el = container.querySelector('.dsh-music-bar-lyric')
      if (el && el.textContent) seen.add(el.textContent)
    }
    expect(seen.size).toBe(1)                 // 不再拆出第 2 个极短残行
    const line = [...seen][0]
    expect(line).toBe(fixture)                // 整块吞进一行
    expect(subContentLen(line)).toBe(23)
    bookTextFixture = ''
  })

  it('double-clicking a track plays it without pausing or showing an autoplay-block error', async () => {
    // Capture the <audio> elements the plugin creates and mimic the real
    // browser: pause() aborts a still-pending play() promise with AbortError.
    // That is exactly the path that previously produced the bogus
    // "浏览器拦截了自动播放" message when a double-click's second click toggled
    // the just-started track to paused.
    const audios = []
    class PendingPlayAudio extends FakeAudio {
      constructor() { super(); audios.push(this) }
      play() {
        this.paused = false
        this._playPromise = new Promise((res, rej) => { this._resolve = res; this._reject = rej })
        return this._playPromise
      }
      pause() {
        this.paused = true
        if (this._reject) {
          const rej = this._reject
          this._reject = null
          rej(Object.assign(new Error('The play() request was interrupted by a call to pause().'), { name: 'AbortError' }))
        }
      }
    }
    // Re-boot with the pending-play Audio stub (fresh module = fresh instances).
    vi.resetModules()
    registered = []
    lastFilesUrl = null
    manifest = baseManifest()
    window.__ModuleLoader__ = { load: (def) => { factory = def.factory } }
    vi.stubGlobal('Audio', PendingPlayAudio)
    vi.stubGlobal('fetch', fetchStub)
    vi.stubGlobal('requestAnimationFrame', () => 0)
    vi.stubGlobal('cancelAnimationFrame', () => {})
    vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '' }))
    vi.stubGlobal('setInterval', () => 0)
    vi.stubGlobal('clearInterval', () => {})
    window.confirm = () => true
    window.prompt = () => null
    await import('../lib/client.js')
    const modExports = factory((name) => (name === 'react' ? React : undefined))
    const slots = {
      inject: (name, cb) => { cb() },
      register: (meta, elementFactory) => { registered.push({ id: meta.id, elementFactory }); return elementFactory },
    }
    modExports.apply({ get: (k) => (k === 'slots' ? slots : undefined), effect: (fn) => fn() })
    await new Promise((r) => setTimeout(r, 0))
    // audios[0] is the main <audio>; audios[1] is the hidden preload element.
    const audio = audios[0]
    expect(audio).toBeTruthy()

    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    const trackBtn = container.querySelector('.dsh-music-track')
    expect(trackBtn).toBeTruthy()

    // First click of a double-click starts the track (play promise stays pending).
    act(() => { trackBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 })) })
    // allow React to re-render (the row is now active) before the second click
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(audio.paused).toBe(false)

    // Second click of the double-click (detail: 2) must be ignored: the track
    // keeps playing and no autoplay-block error is surfaced.
    act(() => { trackBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 2 })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(audio.paused).toBe(false)
    expect(container.textContent).not.toContain('浏览器拦截')
    expect(container.textContent).not.toContain('自动播放')

    // Some environments report detail=1 even for the second click of a double
    // click — the time-window fallback must still ignore it.
    act(() => { trackBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(audio.paused).toBe(false)
    expect(container.textContent).not.toContain('浏览器拦截')

    // After the double-click window passes, a deliberate single click on the
    // active track still toggles (pause) — and that pause aborts the pending
    // play promise, which must NOT be misreported as an autoplay block.
    await new Promise((r) => setTimeout(r, 650))
    act(() => { trackBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(audio.paused).toBe(true)
    expect(container.textContent).not.toContain('浏览器拦截')
    expect(container.textContent).not.toContain('自动播放')
  })

  it('shows the current lyric line in the bar only in the idle (collapsed-controls) state', async () => {
    // 需求规格：歌词位于频谱之后、时长之前，且仅"非使用态"（控件组已滑动折叠、
    // 播放条半透明 dimmed）显示；鼠标进入操作时收起，不给滑入的按钮让路。
    lyricFixture = {
      ok: true, hasLrc: true, name: 'a.lrc',
      lrc: [{ t: 0, text: '第一句歌词' }, { t: 5, text: '第二句歌词' }],
    }
    try {
      const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
      const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
      const container = document.createElement('div')
      document.body.appendChild(container)
      const root = createRoot(container)
      act(() => { root.render(React.createElement('div', null, bar, panel)) })
      act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      const track = [...container.querySelectorAll('.dsh-music-track')].find((b) => b.textContent.includes('a.mp3'))
      act(() => { track.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      const barEl = container.querySelector('.dsh-music-bar')
      // 闲置态（控件组折叠、半透明）：歌词显示，且为当前行（currentTime=0 → 第一句）
      expect(barEl.classList.contains('dimmed')).toBe(true)
      const lyric = container.querySelector('.dsh-music-bar-lyric')
      expect(lyric).toBeTruthy()
      expect(lyric.textContent).toContain('第一句歌词')
      // 来源标记：本地同名 .lrc → data-src="local"
      expect(lyric.getAttribute('data-src')).toBe('local')
      // 歌词在 .dsh-music-bar-controls（时长）之前、频谱之后（DOM 顺序断言）
      const controls = container.querySelector('.dsh-music-bar-controls')
      const idxLyric = [...barEl.children].indexOf(lyric)
      const idxControls = [...barEl.children].indexOf(controls)
      expect(idxLyric).toBeGreaterThanOrEqual(0)
      expect(idxLyric).toBeLessThan(idxControls)
      // 使用态（鼠标进入、控件组滑入）：歌词收起
      act(() => { barEl.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })) })
      expect(barEl.classList.contains('dimmed')).toBe(false)
      expect(container.querySelector('.dsh-music-bar-lyric')).toBeNull()
      // 离开超过 1s → 回到闲置态 → 歌词恢复
      vi.useFakeTimers()
      try {
        act(() => { barEl.dispatchEvent(new MouseEvent('mouseout', { bubbles: true })) })
        act(() => { vi.advanceTimersByTime(1200) })
      } finally { vi.useRealTimers() }
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      expect(barEl.classList.contains('dimmed')).toBe(true)
      expect(container.querySelector('.dsh-music-bar-lyric')).toBeTruthy()
    } finally { lyricFixture = null }
  })

  // 歌词换行动效装置：boot 后播放单曲目 a.mp3，返回可 emit timeupdate 的主 audio。
  // fxPref 为空时保持默认 none（无动效）；否则以 Host pref 预置 dsh-music-lyric-fx。
  // lrc 可覆盖默认两行测试词（构造间奏等场景）。
  async function mountMusicFx({ fxPref, localLrc = true, lrc } = {}) {
    const audios = []
    class FxAudio extends FakeAudio {
      constructor() { super(); audios.push(this) }
      emit(type) { (this.listeners[type] || []).forEach((fn) => fn({ target: this })) }
    }
    lyricFixture = localLrc ? {
      ok: true, hasLrc: true, name: 'a.lrc',
      lrc: lrc || [{ t: 0, text: '第一句歌词' }, { t: 5, text: '第二句歌词' }],
    } : { ok: true, hasLrc: false, name: '', lrc: [] }
    try {
      vi.resetModules(); registered = []; lastFilesUrl = null; prefsPosts = []
      manifest = baseManifest()
      prefsServer = fxPref ? { 'dsh-music-lyric-fx': fxPref } : {}
      window.__ModuleLoader__ = { load: (def) => { factory = def.factory } }
      vi.stubGlobal('Audio', FxAudio)
      vi.stubGlobal('fetch', fetchStub)
      vi.stubGlobal('requestAnimationFrame', () => 0)
      vi.stubGlobal('cancelAnimationFrame', () => {})
      vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '' }))
      vi.stubGlobal('setInterval', () => 0)
      vi.stubGlobal('clearInterval', () => {})
      window.confirm = () => true
      window.prompt = () => null
      await import('../lib/client.js')
      const modExports = factory((name) => (name === 'react' ? React : undefined))
      const slots = {
        inject: (name, cb) => { cb() },
        register: (meta, ef) => { registered.push({ id: meta.id, elementFactory: ef }); return ef },
      }
      modExports.apply({ get: (k) => (k === 'slots' ? slots : undefined), effect: (fn) => fn() })
      await new Promise((r) => setTimeout(r, 0))
      const audio = audios[0]
      expect(audio).toBeTruthy()
      const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
      const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
      const container = document.createElement('div')
      document.body.appendChild(container)
      const root = createRoot(container)
      act(() => { root.render(React.createElement('div', null, bar, panel)) })
      act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      const track = [...container.querySelectorAll('.dsh-music-track')].find((b) => b.textContent.includes('a.mp3'))
      act(() => { track.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      return { container, audio }
    } finally { lyricFixture = null }
  }

  it("fx='slide'（显式选择）：每行歌词重挂载重放入场动画，上一行只经 data-prev 提供给伪元素（textContent 恒为当前行）", async () => {
    const { container, audio } = await mountMusicFx({ fxPref: 'slide' })
    audio.currentTime = 0
    act(() => { audio.emit('timeupdate') })
    let outer = container.querySelector('.dsh-music-bar-lyric')
    expect(outer).toBeTruthy()
    // 关键回归：textContent 是「纯净的当前行」（退场旧行放 CSS 伪元素，不进 DOM 文本）
    expect(outer.textContent).toBe('第一句歌词')
    let fxEl = container.querySelector('.dsh-music-bar-lyric-fx')
    expect(fxEl.getAttribute('data-fx')).toBe('slide')
    expect(fxEl.getAttribute('data-prev')).toBeNull()
    // 默认开启边缘渐隐遮罩；jsdom 无布局不会误判溢出（无 marquee 类、无 data-over）
    expect(outer.getAttribute('data-mask')).toBe('1')
    expect(outer.getAttribute('data-over')).toBeNull()
    expect(container.querySelector('.dsh-music-bar-lyric-run.mq')).toBeNull()

    // 前进到第二句：key(seq) 变化强制重挂载 → 浏览器里入场动画重放；
    // 上一行只出现在 data-prev 属性上。
    const fxFirst = fxEl
    audio.currentTime = 6
    act(() => { audio.emit('timeupdate') })
    outer = container.querySelector('.dsh-music-bar-lyric')
    expect(outer.textContent).toBe('第二句歌词')
    fxEl = container.querySelector('.dsh-music-bar-lyric-fx')
    expect(fxEl).not.toBe(fxFirst)                     // 确实重新挂载了
    expect(fxEl.getAttribute('data-prev')).toBe('第一句歌词')
  })

  it("fx 默认 = 'none'（无动效）：不选择任何动效时行为与旧版硬切完全一致", async () => {
    // 回归：默认值必须是无动效——未显式选择的用户不应看到任何换行动效。
    const { container, audio } = await mountMusicFx()
    audio.currentTime = 0
    act(() => { audio.emit('timeupdate') })
    const outer = container.querySelector('.dsh-music-bar-lyric')
    expect(outer.textContent).toBe('第一句歌词')
    const fxEl = container.querySelector('.dsh-music-bar-lyric-fx')
    expect(fxEl.getAttribute('data-fx')).toBe('none')
    expect(fxEl.getAttribute('data-prev')).toBeNull()
    audio.currentTime = 6
    act(() => { audio.emit('timeupdate') })
    expect(container.querySelector('.dsh-music-bar-lyric').textContent).toBe('第二句歌词')
    // 无 key → React 复用同一节点（重挂载才有的入场动画在这里不存在）
    expect(container.querySelector('.dsh-music-bar-lyric-fx')).toBe(fxEl)
  })

  it("fx='none'：与旧行为一致的硬切——不重挂载、无 data-prev、无动画属性", async () => {
    const { container, audio } = await mountMusicFx({ fxPref: 'none' })
    audio.currentTime = 0
    act(() => { audio.emit('timeupdate') })
    const outer = container.querySelector('.dsh-music-bar-lyric')
    expect(outer.textContent).toBe('第一句歌词')
    const fxEl = container.querySelector('.dsh-music-bar-lyric-fx')
    expect(fxEl.getAttribute('data-fx')).toBe('none')
    expect(fxEl.getAttribute('data-prev')).toBeNull()
    audio.currentTime = 6
    act(() => { audio.emit('timeupdate') })
    expect(container.querySelector('.dsh-music-bar-lyric').textContent).toBe('第二句歌词')
    // 无 key → React 复用同一节点，即原始「硬切」语义
    expect(container.querySelector('.dsh-music-bar-lyric-fx')).toBe(fxEl)
    expect(fxEl.getAttribute('data-prev')).toBeNull()
  })

  it("fx='karaoke'：裸 LRC 也走音频时钟——窗口按字符估算封顶（min(间隔,估算)）", async () => {
    const { container, audio } = await mountMusicFx({ fxPref: 'karaoke' })
    audio.duration = 20
    audio.currentTime = 0
    act(() => { audio.emit('timeupdate') })
    let fxEl = container.querySelector('.dsh-music-bar-lyric-fx')
    expect(fxEl.getAttribute('data-fx')).toBe('karaoke')
    expect(fxEl.getAttribute('data-audioclock')).toBe('1')
    // 行1 间隔 5s，但「第一句歌词」5 汉字 ≈2.75s 更短 → 窗口取估算值；
    // 起点处 f=0 → 位置 70%
    expect(fxEl.style.backgroundPositionX).toBe('70.00%')
    audio.currentTime = 7
    act(() => { audio.emit('timeupdate') })
    fxEl = container.querySelector('.dsh-music-bar-lyric-fx')
    // 行2 是末行（间隔按总长兜底 15s），仍被估算值封顶为 2750ms；
    // 已过 2000ms → f≈0.7273 → (1.05−f)/1.5 ≈ 21.52%
    // 长间奏回归见下一个用例（构造 60s 间隔的独立装置）
  })

  it("fx='karaoke'：长间奏前一句与末行——唱完满亮一小会后歌词消隐（不再挂到下一句）", async () => {
    // 回归：裸 LRC 只有行起点。60s 的间隔曾被全额当扫色窗口 → 龟速；
    // 随后音频时钟+封顶解决摊平，但整句仍显示到下一句才开始。现在：
    // 窗口内正常扫色（估算封顶）→ 唱完且静默 >1.2s → 歌词消失。
    const { container, audio } = await mountMusicFx({
      fxPref: 'karaoke',
      lrc: [{ t: 0, text: '第一句歌词' }, { t: 60, text: '第二句歌词' }],
    })
    audio.duration = 120
    audio.currentTime = 1.5   // 行1 窗口内（~2.75s）：正常扫色
    act(() => { audio.emit('timeupdate') })
    let fxEl = container.querySelector('.dsh-music-bar-lyric-fx')
    expect(container.querySelector('.dsh-music-bar-lyric').textContent).toBe('第一句歌词')
    expect(fxEl.style.backgroundPositionX).toBe('33.64%')   // f=1500/2750 → (1.05−f)/1.5

    audio.currentTime = 30   // 行1 已唱完很久、处于长间奏中段 → 歌词应已消失
    act(() => { audio.emit('timeupdate') })
    expect(container.querySelector('.dsh-music-bar-lyric')).toBeNull()

    audio.currentTime = 61.5 // 行2 窗口内：重新出现
    act(() => { audio.emit('timeupdate') })
    fxEl = container.querySelector('.dsh-music-bar-lyric-fx')
    expect(container.querySelector('.dsh-music-bar-lyric').textContent).toBe('第二句歌词')
    expect(fxEl.style.backgroundPositionX).toBe('33.64%')   // 过 1500/2750

    audio.currentTime = 65   // 行2 唱完后同样消隐（静默到曲尾）
    act(() => { audio.emit('timeupdate') })
    expect(container.querySelector('.dsh-music-bar-lyric')).toBeNull()
  })

  it('QRC 行窗口：卡拉OK改音频时钟驱动——位置随 timeupdate 实时校准，间奏停满亮不摊平', async () => {
    // /lyric 无本地 .lrc → 在线兜底返回 qq-qrc 的精确行窗口 [{t,end,text}]。
    // 扫色不再用墙钟 CSS 动画（挂载锚定会因起播缓冲/卡顿漂移），而是每次
    // timeupdate 按 audio.currentTime 直写 background-position-x + 短过渡。
    lyricOnlineFixture = {
      ok: true, hasLyric: true, source: 'qq-qrc',
      wordLines: [
        { t: 0, end: 4.5, text: '第一句歌词' },
        { t: 4.5, end: 9, text: '第二句歌词' },
      ],
    }
    try {
      const { container, audio } = await mountMusicFx({ fxPref: 'karaoke', localLrc: false })
      audio.duration = 20
      audio.currentTime = 0
      act(() => { audio.emit('timeupdate') })
      expect(container.querySelector('.dsh-music-bar-lyric').textContent).toBe('第一句歌词')
      let fxEl = container.querySelector('.dsh-music-bar-lyric-fx')
      // 音频时钟模式生效：无 --kar-dur 动画变量，标记 data-audioclock；行起点 → 100%
      expect(fxEl.getAttribute('data-audioclock')).toBe('1')
      expect(fxEl.style.getPropertyValue('--kar-dur')).toBe('')
      expect(fxEl.style.backgroundPositionX).toBe('70.00%')

      // 行内进度：7s，第二行 [4.5,9]s 已过 2.5/4.5 → 位置 (1-5/9)=44.44%
      audio.currentTime = 7
      act(() => { audio.emit('timeupdate') })
      fxEl = container.querySelector('.dsh-music-bar-lyric-fx')
      expect(container.querySelector('.dsh-music-bar-lyric').textContent).toBe('第二句歌词')
      expect(fxEl.style.backgroundPositionX).toBe('32.96%')   // f=5/9 → (1.05−f)/1.5

      // 行内 seek 漂移修正：直接跳到行尾附近，下一拍立即对齐（旧墙钟动画做不到）
      audio.currentTime = 8.8
      act(() => { audio.emit('timeupdate') })
      fxEl = container.querySelector('.dsh-music-bar-lyric-fx')
      expect(fxEl.style.backgroundPositionX).toBe('6.30%')   // (1.05−0.956)/1.5

      // 末行唱完后（9~20s 长间奏，静默 11s > 1.2s 阈值）：歌词消隐——不再挂到下一句
      audio.currentTime = 12
      act(() => { audio.emit('timeupdate') })
      expect(container.querySelector('.dsh-music-bar-lyric')).toBeNull()

      // 唱完前的瞬间（8.9s）：仍在显示（真实行窗口内）
      audio.currentTime = 8.9
      act(() => { audio.emit('timeupdate') })
      expect(container.querySelector('.dsh-music-bar-lyric').textContent).toBe('第二句歌词')
      const el = container.querySelector('.dsh-music-bar-lyric-fx')
      expect(el.getAttribute('data-fx')).toBe('karaoke')

      // 暂停：fx 层仍挂 fxfrozen 类（跑马灯/入场动画时钟冻结）
      act(() => { container.querySelector('button[title="播放/暂停"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      expect(container.querySelector('.dsh-music-bar-lyric-fx').classList.contains('fxfrozen')).toBe(true)
    } finally { lyricOnlineFixture = null }
  })

  it('QRC 行窗口恒走整行扫色：词级数据即使存在也不渲染逐字 span（逐字点亮已移除）', async () => {
    // 回归：payload 里残留 words 字段（或未来恢复下发）也不得改变渲染——
    // fx 层无 data-wordmode、DOM 无 .dsh-music-word，扫色仍是整行渐变。
    lyricOnlineFixture = {
      ok: true, hasLyric: true, source: 'qq-qrc',
      wordLines: [
        { t: 0, end: 4, text: '你好世界', words: [
          { text: '你', s: 0, d: 1 }, { text: '好', s: 1, d: 1 },
        ] },
        { t: 4, end: 8, text: '再见了朋友' },
      ],
    }
    try {
      const { container, audio } = await mountMusicFx({ fxPref: 'karaoke', localLrc: false })
      audio.currentTime = 2.5
      act(() => { audio.emit('timeupdate') })
      const outer = container.querySelector('.dsh-music-bar-lyric')
      expect(outer.getAttribute('data-src')).toBe('qq-qrc')
      const fxEl = container.querySelector('.dsh-music-bar-lyric-fx')
      expect(fxEl.getAttribute('data-wordmode')).toBeNull()
      expect(fxEl.textContent).toBe('你好世界')
      expect(fxEl.querySelectorAll('.dsh-music-word').length).toBe(0)
      // 音频时钟模式：行 [0,4]s 已过 2.5s → 位置 (1-2500/4000)=37.50%
      expect(fxEl.getAttribute('data-audioclock')).toBe('1')
      expect(fxEl.style.backgroundPositionX).toBe('28.33%')   // f=2500/4000

      audio.currentTime = 5
      act(() => { audio.emit('timeupdate') })
      const fxEl2 = container.querySelector('.dsh-music-bar-lyric-fx')
      expect(container.querySelector('.dsh-music-bar-lyric').textContent).toBe('再见了朋友')
      expect(fxEl2.style.backgroundPositionX).toBe('53.33%')   // f=1000/4000
    } finally { lyricOnlineFixture = null }
  })

  it('falls back to the online lyric when a local track has no .lrc (no source badge)', async () => {
    // 本地无同名 .lrc（/lyric 返回 hasLrc:false）→ 客户端自动请求 /dsh-music/lyric/online
    // （Host 走 QQ → LRCLIB 兜底）；取到词后直接显示歌词，不显示歌词来源标识。
    lyricOnlineFixture = {
      ok: true, hasLyric: true, source: 'qq',
      matched: { title: '七里香', artist: '周杰伦', songmid: 'S1', score: 90 },
      lrc: [{ t: 0, text: '窗外的麻雀' }, { t: 5, text: '雨下整夜' }],
    }
    try {
      const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
      const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
      const container = document.createElement('div')
      document.body.appendChild(container)
      const root = createRoot(container)
      act(() => { root.render(React.createElement('div', null, bar, panel)) })
      act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      const track = [...container.querySelectorAll('.dsh-music-track')].find((b) => b.textContent.includes('a.mp3'))
      act(() => { track.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      const lyric = container.querySelector('.dsh-music-bar-lyric')
      expect(lyric).toBeTruthy()
      expect(lyric.textContent).toContain('窗外的麻雀')
      // 来源可观测：在线兜底普通 LRC → data-src="qq"（诊断 QRC 是否生效的标记）
      expect(lyric.getAttribute('data-src')).toBe('qq')
      // 不显示来源标识（QQ / LRCLIB 小标已移除）
      expect(container.querySelector('.dsh-music-bar-lyric-src')).toBeNull()
    } finally { lyricOnlineFixture = null }
  })

  it('shows only two centered login buttons (QQ/微信登录) when not logged in', async () => {
    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    const onlineTab = [...container.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === 'QQ音乐')
    expect(onlineTab).toBeTruthy()
    act(() => { onlineTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    // not logged in: only the two centered login buttons, no search/sub-tabs
    expect(container.textContent).toContain('QQ 登录')
    expect(container.textContent).toContain('微信登录')
    // 酷狗面板（第二个 .dsh-music-qq-pane，常驻渲染）也有登录按钮，断言需收窄到
    // 第一个 pane（QQ）内，否则会数到酷狗的「生成酷狗登录二维码」按钮。
    const qqPane = [...container.querySelectorAll('.dsh-music-qq-pane')][0]
    expect(qqPane.querySelector('.dsh-music-qq-input')).toBeNull()
    expect(qqPane.querySelector('.dsh-music-qq-viewtabs')).toBeNull()
    // both login buttons are the enlarged login-btn style and carry a risk disclaimer
    const btns = [...qqPane.querySelectorAll('.dsh-music-qq-login-btn')]
    expect(btns.length).toBe(2)
    expect(container.querySelector('.dsh-music-qq-login-warn')).toBeTruthy()
    expect(container.textContent).toContain('使用声明')
  })

  it('logged-in main UI: toolbar (播放列表 / 退出登录) + 4 sub-tabs + search flow', async () => {
    qqLoggedIn = true
    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    const onlineTab = [...container.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === 'QQ音乐')
    act(() => { onlineTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    // toolbar: 播放列表 (left) and 退出登录 (right), same ghost style
    expect(container.textContent).toContain('播放列表')
    expect(container.textContent).toContain('退出登录')
    const enterPl = [...container.querySelectorAll('.dsh-music-settings-btn')].find((b) => b.textContent === '播放列表')
    const logoutBtn = [...container.querySelectorAll('.dsh-music-settings-btn')].find((b) => b.textContent === '退出登录')
    expect(enterPl && enterPl.className.includes('ghost')).toBe(true)
    expect(logoutBtn && logoutBtn.className.includes('ghost')).toBe(true)
    // 6 sub-tabs: 我的歌单 / 推荐歌单 / 分类歌单 / 排行榜 / 新歌 / 搜索
    const tabs = [...container.querySelectorAll('.dsh-music-qq-viewtab')].map((b) => b.textContent)
    expect(tabs).toEqual(['我的歌单', '推荐歌单', '分类歌单', '排行榜', '新歌', '搜索'])
    // 搜索 sub-tab: input + search results
    const searchTab = [...container.querySelectorAll('.dsh-music-qq-viewtab')].find((b) => b.textContent === '搜索')
    act(() => { searchTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const input = container.querySelector('.dsh-music-qq-input')
    expect(input).toBeTruthy()
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(input, '晴天')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const searchBtn = [...container.querySelectorAll('.dsh-music-settings-btn')].find((b) => b.textContent === '搜索')
    act(() => { searchBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(container.textContent).toContain('晴天')
    expect(container.textContent).toContain('周杰伦')  // artist name shows at the row tail
    // both songs and playlists exist → search results shown as two tabs, default 歌曲
    const resultTabs = [...container.querySelectorAll('.dsh-music-qq-viewtab')].map((b) => b.textContent)
    expect(resultTabs).toContain('歌曲')
    expect(resultTabs).toContain('相关歌单')
    // switch to 相关歌单 tab → playlists appear
    const plTab = [...container.querySelectorAll('.dsh-music-qq-viewtab')].find((b) => b.textContent === '相关歌单')
    act(() => { plTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(container.textContent).toContain('周杰伦合集')
  })

  it('loads more playlist search results via the 加载更多 button (page-2 append)', async () => {
    qqLoggedIn = true
    // 歌单搜索：第一页返回满页(20)→出现「加载更多」；第二页返回不同歌单→点击后追加。
    const origFetch = window.fetch
    window.fetch = (u, o) => {
      const url = String(u)
      if (url.includes('/dsh-music/qq/playlist-search')) {
        const page = parseInt(new URL(url, 'http://x').searchParams.get('page') || '1', 10)
        const list = page === 1
          ? Array.from({ length: 20 }, (_, i) => ({ id: 'pl' + i, name: '歌单' + i, creator: '作者', trackCount: 10, source: 'qq' }))
          : [{ id: 'pl20', name: '第2页歌单', creator: '作者', trackCount: 10, source: 'qq' }]
        return Promise.resolve(new Response(JSON.stringify({ ok: true, playlists: list, total: list.length, page }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
      }
      return origFetch(u, o)
    }
    try {
      const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
      const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
      const container = document.createElement('div')
      document.body.appendChild(container)
      const root = createRoot(container)
      act(() => { root.render(React.createElement('div', null, bar, panel)) })
      act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      const onlineTab = [...container.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === 'QQ音乐')
      act(() => { onlineTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      const searchTab = [...container.querySelectorAll('.dsh-music-qq-viewtab')].find((b) => b.textContent === '搜索')
      act(() => { searchTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      const input = container.querySelector('.dsh-music-qq-input')
      act(() => {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
        setter.call(input, '周杰伦')
        input.dispatchEvent(new Event('input', { bubbles: true }))
      })
      const searchBtn = [...container.querySelectorAll('.dsh-music-settings-btn')].find((b) => b.textContent === '搜索')
      act(() => { searchBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      // 切到「相关歌单」tab：满页 → 出现「加载更多」按钮
      const plTab = [...container.querySelectorAll('.dsh-music-qq-viewtab')].find((b) => b.textContent === '相关歌单')
      expect(plTab).toBeTruthy()
      act(() => { plTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      const moreBtn = [...container.querySelectorAll('.dsh-music-qq-loadmore-btn')].find((b) => b.textContent === '加载更多')
      expect(moreBtn).toBeTruthy()
      act(() => { moreBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      // 第二页追加进来了
      expect(container.textContent).toContain('第2页歌单')
    } finally {
      window.fetch = origFetch
    }
  })

  it('remembers search keywords and lets you pick one from the dropdown', async () => {
    qqLoggedIn = true
    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    const onlineTab = [...container.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === 'QQ音乐')
    act(() => { onlineTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const searchTab = [...container.querySelectorAll('.dsh-music-qq-viewtab')].find((b) => b.textContent === '搜索')
    act(() => { searchTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const input = container.querySelector('.dsh-music-qq-input')
    // type and search → keyword saved to history
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(input, '周杰伦')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const searchBtn = [...container.querySelectorAll('.dsh-music-settings-btn')].find((b) => b.textContent === '搜索')
    act(() => { searchBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    // the keyword is persisted to the Host (flushed on the ~800ms debounce)
    await act(async () => { await new Promise((r) => setTimeout(r, 950)) })
    expect(JSON.parse(prefsServer['dsh-music-qq-history'])).toContain('周杰伦')
    // focus the input again → history dropdown appears with the keyword
    act(() => { input.dispatchEvent(new Event('focusin', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const histItems = [...container.querySelectorAll('.dsh-music-qq-hist-item')]
    expect(histItems.some((b) => b.textContent === '周杰伦')).toBe(true)
    // regression: the dropdown must be portaled + fixed (it would be clipped by
    // the panel's overflow:hidden otherwise — jsdom doesn't lay out CSS, so the
    // fixed positioning is what guarantees it escapes the clip in a real browser)
    const histPop = document.querySelector('.dsh-music-qq-hist')
    expect(histPop).toBeTruthy()
    expect(histPop.style.position).toBe('fixed')
    expect(histPop.style.top).toBeTruthy()
    expect(histPop.style.width).toBeTruthy()
    // clicking a history item fills the box and runs a new search
    const item = histItems.find((b) => b.textContent === '周杰伦')
    act(() => { item.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(container.textContent).toContain('晴天')
    // regression: clicking the portaled dropdown must NOT close the panel (the
    // panel's outside-click handler treats portaled popups as "inside")
    const panelEl = container.querySelector('.dsh-music-panel')
    expect(panelEl).toBeTruthy()
    expect(panelEl.style.display).not.toBe('none')
  })

  it('does NOT close the panel when clicking a portaled popup (history/TOC/mode/volume)', async () => {
    // Regression: popups are portaled to <body> (to escape the panel's
    // overflow:hidden clip), so a click on them is technically outside the
    // panel DOM. The panel's outside-click handler must treat these as "inside".
    qqLoggedIn = true
    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    const panelEl = container.querySelector('.dsh-music-panel')
    expect(panelEl.style.display).not.toBe('none')
    // baseline: a mousedown truly outside (document.body) closes the panel
    act(() => { document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })) })
    expect(panelEl.style.display).toBe('none')
    // reopen, then mousedown inside portaled popups appended to <body> must NOT close it
    act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    const overlays = ['dsh-music-qq-hist', 'dsh-music-toc', 'dsh-music-mode-pop', 'dsh-music-bar-vol-pop', 'dsh-music-picker-overlay', 'dsh-music-add-pop']
    for (const cls of overlays) {
      const pop = document.createElement('div')
      pop.className = cls
      document.body.appendChild(pop)
      act(() => { pop.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })) })
      expect(panelEl.style.display).not.toBe('none')
      pop.remove()
    }
  })

  it('browses QQ playlists (recommend -> detail -> category)', async () => {
    qqLoggedIn = true
    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    const onlineTab = [...container.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === 'QQ音乐')
    act(() => { onlineTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    // default tab is 我的歌单 → switch to 推荐歌单 for the browse flow
    const recTab = [...container.querySelectorAll('.dsh-music-qq-viewtab')].find((b) => b.textContent === '推荐歌单')
    act(() => { recTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    // recommended playlists render straight in the online view
    expect(container.textContent).toContain('热门推荐')
    const recRow = [...container.querySelectorAll('.dsh-music-playlist-card')].find((b) => b.textContent.includes('热门推荐'))
    expect(recRow).toBeTruthy()
    act(() => { recRow.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(container.textContent).toContain('告白气球')
    // back -> 分类歌单 browse tab -> category chips -> category playlists
    const back = [...container.querySelectorAll('.dsh-music-settings-btn')].find((b) => b.textContent === '← 返回')
    act(() => { back.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const categoryTab = [...container.querySelectorAll('.dsh-music-qq-viewtab')].find((b) => b.textContent === '分类歌单')
    expect(categoryTab).toBeTruthy()
    act(() => { categoryTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(container.textContent).toContain('国语')
    const catChip = [...container.querySelectorAll('.dsh-music-qq-cat')].find((b) => b.textContent === '国语')
    act(() => { catChip.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(container.textContent).toContain('国语歌单')
  })

  it('loads more QQ 排行榜 songs via the 加载更多 button (append + hasMore)', async () => {
    qqLoggedIn = true
    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    const onlineTab = [...container.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === 'QQ音乐')
    act(() => { onlineTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    // 切到 排行榜 → 点「飙升榜」进入详情
    const topsTab = [...container.querySelectorAll('.dsh-music-qq-viewtab')].find((b) => b.textContent === '排行榜')
    act(() => { topsTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(container.textContent).toContain('飙升榜')
    const card = [...container.querySelectorAll('.dsh-music-playlist-card')].find((b) => b.textContent.includes('飙升榜'))
    act(() => { card.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    // 第一页：2 首 + 总数 5 + 还有更多
    expect(container.textContent).toContain('飙升歌一')
    expect(container.textContent).toContain('飙升歌二')
    expect(container.textContent).toContain('2 / 5 首')
    const moreBtn = [...container.querySelectorAll('.dsh-music-qq-loadmore-btn')].find((b) => b.textContent === '加载更多')
    expect(moreBtn).toBeTruthy()
    // 点加载更多 → 追加下一页
    act(() => { moreBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(container.textContent).toContain('飙升歌三')
    expect(container.textContent).toContain('飙升歌四')
    expect(container.textContent).toContain('4 / 5 首')
    // 再点 → 最后一首，hasMore=false 后按钮消失
    const moreBtn2 = [...container.querySelectorAll('.dsh-music-qq-loadmore-btn')].find((b) => b.textContent === '加载更多')
    act(() => { moreBtn2.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(container.textContent).toContain('飙升歌五')
    expect(container.textContent).toContain('5 / 5 首')
    expect([...container.querySelectorAll('.dsh-music-qq-loadmore-btn')].some((b) => b.textContent === '加载更多')).toBe(false)
  })

  it('loads more recommended playlists via the 加载更多 button (deduped append)', async () => {
    qqLoggedIn = true
    // category 页返回不同的歌单（每次翻页返回 catN），用于验证追加。
    const origFetch = window.fetch
    window.fetch = (u, o) => {
      if (String(u).includes('/dsh-music/qq/playlists?category=10000000')) {
        const page = parseInt(new URL(String(u), 'http://x').searchParams.get('page') || '1', 10)
        return Promise.resolve(new Response(JSON.stringify({ ok: true, playlists: [{ id: 'more' + page, name: '更多歌单' + page, creator: '作者', trackCount: 20, source: 'qq' }] }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
      }
      return origFetch(u, o)
    }
    try {
      const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
      const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
      const container = document.createElement('div')
      document.body.appendChild(container)
      const root = createRoot(container)
      act(() => { root.render(React.createElement('div', null, bar, panel)) })
      act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      const onlineTab = [...container.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === 'QQ音乐')
      act(() => { onlineTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      // 默认 tab 是 我的歌单 → 切到 推荐歌单
      const recTab = [...container.querySelectorAll('.dsh-music-qq-viewtab')].find((b) => b.textContent === '推荐歌单')
      act(() => { recTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      expect(container.textContent).toContain('热门推荐')
      // 点「加载更多」→ 追加 more2
      const moreBtn = [...container.querySelectorAll('.dsh-music-qq-loadmore-btn')].find((b) => b.textContent === '加载更多')
      expect(moreBtn).toBeTruthy()
      act(() => { moreBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      expect(container.textContent).toContain('更多歌单2')
    } finally {
      window.fetch = origFetch
    }
  })

  it('loads more playlists in 分类歌单 via the 加载更多 button', async () => {
    qqLoggedIn = true
    const origFetch = window.fetch
    window.fetch = (u, o) => {
      if (String(u).includes('/dsh-music/qq/playlists?category=1')) {
        const page = parseInt(new URL(String(u), 'http://x').searchParams.get('page') || '1', 10)
        return Promise.resolve(new Response(JSON.stringify({ ok: true, playlists: [{ id: 'catmore' + page, name: '分类更多' + page, creator: '作者', trackCount: 20, source: 'qq' }] }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
      }
      return origFetch(u, o)
    }
    try {
      const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
      const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
      const container = document.createElement('div')
      document.body.appendChild(container)
      const root = createRoot(container)
      act(() => { root.render(React.createElement('div', null, bar, panel)) })
      act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      const onlineTab = [...container.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === 'QQ音乐')
      act(() => { onlineTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      const categoryTab = [...container.querySelectorAll('.dsh-music-qq-viewtab')].find((b) => b.textContent === '分类歌单')
      act(() => { categoryTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      const catChip = [...container.querySelectorAll('.dsh-music-qq-cat')].find((b) => b.textContent === '国语')
      act(() => { catChip.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      const moreBtn = [...container.querySelectorAll('.dsh-music-qq-loadmore-btn')].find((b) => b.textContent === '加载更多')
      expect(moreBtn).toBeTruthy()
      act(() => { moreBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      expect(container.textContent).toContain('分类更多2')
    } finally {
      window.fetch = origFetch
    }
  })

  it('adds a QQ song to a my-playlist via the per-row + button popup', async () => {
    qqLoggedIn = true
    const origFetch = window.fetch
    const favCalls = []
    window.fetch = (u, o) => {
      const url = String(u)
      if (url === '/dsh-music/qq/playlist-add' && o && o.method === 'POST') {
        try { favCalls.push(JSON.parse(o.body || '{}')) } catch {}
        return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
      }
      return origFetch(u, o)
    }
    try {
      const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
      const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
      const container = document.createElement('div')
      document.body.appendChild(container)
      const root = createRoot(container)
      act(() => { root.render(React.createElement('div', null, bar, panel)) })
      act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      const onlineTab = [...container.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === 'QQ音乐')
      act(() => { onlineTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      const searchTab = [...container.querySelectorAll('.dsh-music-qq-viewtab')].find((b) => b.textContent === '搜索')
      act(() => { searchTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      const input = container.querySelector('.dsh-music-qq-input')
      act(() => {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
        setter.call(input, '晴天')
        input.dispatchEvent(new Event('input', { bubbles: true }))
      })
      const searchBtn = [...container.querySelectorAll('.dsh-music-settings-btn')].find((b) => b.textContent === '搜索')
      act(() => { searchBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      // 歌曲行尾部有「＋」按钮
      const songRow = [...container.querySelectorAll('.dsh-music-track-row')].find((r) => r.textContent.includes('晴天'))
      const plusBtn = songRow && songRow.querySelector('.dsh-music-playlist-mini.add')
      expect(plusBtn).toBeTruthy()
      act(() => { plusBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      // 弹出「我的歌单」列表（弹窗 portal 到 body）
      const popItem = [...document.body.querySelectorAll('.dsh-music-add-pop-item')].find((b) => b.textContent.includes('我的收藏'))
      expect(popItem).toBeTruthy()
      act(() => { popItem.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      // 触发加入请求
      expect(favCalls.length).toBe(1)
      expect(favCalls[0].song.songmid).toBe('123')
      expect(favCalls[0].dirId).toBeTruthy()
    } finally {
      window.fetch = origFetch
    }
  })

  it('shows a centered success toast when adding a local track to a playlist via ＋', async () => {
    // 「＋」→ 加入歌单 → 成功：面板窗口内居中显示「添加到XXX成功」，2s 后自动消失
    const origFetch = window.fetch
    window.fetch = (u, o) => {
      if (String(u) === '/dsh-music/playlist/add' && o && o.method === 'POST') {
        return jsonRes({ ok: true, added: 1, playlist: { id: 'pl-1', name: '通勤', count: 2, tracks: [] } })
      }
      return origFetch(u, o)
    }
    try {
      const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
      const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
      const container = document.createElement('div')
      document.body.appendChild(container)
      const root = createRoot(container)
      act(() => { root.render(React.createElement('div', null, bar, panel)) })
      act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      // 曲库每行的「＋」按钮
      const plusBtn = container.querySelector('.dsh-music-track-row .dsh-music-playlist-mini.add')
      expect(plusBtn).toBeTruthy()
      act(() => { plusBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      // 弹窗列出歌单（含「通勤」）
      const popItem = [...document.body.querySelectorAll('.dsh-music-add-pop-item')].find((b) => b.textContent.includes('通勤'))
      expect(popItem).toBeTruthy()
      act(() => { popItem.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      // 成功 toast：面板窗口内居中（.ok），文本=添加到通勤成功
      const toast = container.querySelector('.dsh-music-panel-toast')
      expect(toast).toBeTruthy()
      expect(toast.className).toContain('ok')
      expect(toast.textContent).toBe('添加到通勤成功')
      // 2s 后自动消失
      await act(async () => { await new Promise((r) => setTimeout(r, 2100)) })
      expect(container.querySelector('.dsh-music-panel-toast')).toBeNull()
    } finally {
      window.fetch = origFetch
    }
  })

  it('shows a centered failure toast and keeps the menu open when adding a local track fails', async () => {
    const origFetch = window.fetch
    window.fetch = (u, o) => {
      if (String(u) === '/dsh-music/playlist/add' && o && o.method === 'POST') {
        return jsonRes({ ok: false, error: '歌单不存在' })
      }
      return origFetch(u, o)
    }
    try {
      const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
      const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
      const container = document.createElement('div')
      document.body.appendChild(container)
      const root = createRoot(container)
      act(() => { root.render(React.createElement('div', null, bar, panel)) })
      act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      const plusBtn = container.querySelector('.dsh-music-track-row .dsh-music-playlist-mini.add')
      act(() => { plusBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      const popItem = [...document.body.querySelectorAll('.dsh-music-add-pop-item')].find((b) => b.textContent.includes('通勤'))
      act(() => { popItem.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      const toast = container.querySelector('.dsh-music-panel-toast')
      expect(toast).toBeTruthy()
      expect(toast.className).toContain('err')
      expect(toast.textContent).toBe('添加到通勤失败')
      // 失败时加入弹窗保留（可换歌单重试）
      expect([...document.body.querySelectorAll('.dsh-music-add-pop-item')].some((b) => b.textContent.includes('通勤'))).toBe(true)
    } finally {
      window.fetch = origFetch
    }
  })

  it('shows a centered success toast when adding a QQ song to 我的歌单 via ＋', async () => {
    qqLoggedIn = true
    const origFetch = window.fetch
    window.fetch = (u, o) => {
      if (String(u) === '/dsh-music/qq/playlist-add' && o && o.method === 'POST') {
        return jsonRes({ ok: true })
      }
      return origFetch(u, o)
    }
    try {
      const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
      const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
      const container = document.createElement('div')
      document.body.appendChild(container)
      const root = createRoot(container)
      act(() => { root.render(React.createElement('div', null, bar, panel)) })
      act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      const onlineTab = [...container.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === 'QQ音乐')
      act(() => { onlineTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      const searchTab = [...container.querySelectorAll('.dsh-music-qq-viewtab')].find((b) => b.textContent === '搜索')
      act(() => { searchTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      const input = container.querySelector('.dsh-music-qq-input')
      act(() => {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
        setter.call(input, '晴天')
        input.dispatchEvent(new Event('input', { bubbles: true }))
      })
      const searchBtn = [...container.querySelectorAll('.dsh-music-settings-btn')].find((b) => b.textContent === '搜索')
      act(() => { searchBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      const songRow = [...container.querySelectorAll('.dsh-music-track-row')].find((r) => r.textContent.includes('晴天'))
      const plusBtn = songRow && songRow.querySelector('.dsh-music-playlist-mini.add')
      expect(plusBtn).toBeTruthy()
      act(() => { plusBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      // 「我的歌单」自动加载 → 弹窗列出「我的收藏」
      const popItem = [...document.body.querySelectorAll('.dsh-music-add-pop-item')].find((b) => b.textContent.includes('我的收藏'))
      expect(popItem).toBeTruthy()
      act(() => { popItem.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      const toast = container.querySelector('.dsh-music-panel-toast')
      expect(toast).toBeTruthy()
      expect(toast.className).toContain('ok')
      expect(toast.textContent).toBe('添加到我的收藏成功')
    } finally {
      window.fetch = origFetch
    }
  })

  it('collapses and expands the category chips in 分类歌单', async () => {
    qqLoggedIn = true
    const origFetch = window.fetch
    const manyCats = Array.from({ length: 12 }, (_, i) => ({ id: 'c' + i, name: '分类' + i, group: '测试' }))
    window.fetch = (u, o) => {
      if (String(u).includes('/dsh-music/qq/playlist-categories')) {
        return Promise.resolve(new Response(JSON.stringify({ ok: true, categories: manyCats }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
      }
      if (String(u).includes('/dsh-music/qq/playlists?category=')) {
        return Promise.resolve(new Response(JSON.stringify({ ok: true, playlists: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
      }
      return origFetch(u, o)
    }
    try {
      const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
      const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
      const container = document.createElement('div')
      document.body.appendChild(container)
      const root = createRoot(container)
      act(() => { root.render(React.createElement('div', null, bar, panel)) })
      act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      const onlineTab = [...container.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === 'QQ音乐')
      act(() => { onlineTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      const categoryTab = [...container.querySelectorAll('.dsh-music-qq-viewtab')].find((b) => b.textContent === '分类歌单')
      act(() => { categoryTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      // 折叠态：只显示 8 个分类，且出现「展开全部分类」按钮
      expect(container.querySelectorAll('.dsh-music-qq-cat').length).toBe(8)
      const toggle = [...container.querySelectorAll('.dsh-music-qq-cat-toggle')].find((b) => b.textContent.includes('展开全部分类'))
      expect(toggle).toBeTruthy()
      act(() => { toggle.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      // 展开态：全部 12 个分类，出现「收起」
      expect(container.querySelectorAll('.dsh-music-qq-cat').length).toBe(12)
      const collapse = [...container.querySelectorAll('.dsh-music-qq-cat-toggle')].find((b) => b.textContent === '收起')
      expect(collapse).toBeTruthy()
      act(() => { collapse.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      expect(container.querySelectorAll('.dsh-music-qq-cat').length).toBe(8)
    } finally {
      window.fetch = origFetch
    }
  })

  it('enters the playlist layer via 播放列表, shows a back button, and persists the layer', async () => {
    qqLoggedIn = true
    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    const onlineTab = [...container.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === 'QQ音乐')
    act(() => { onlineTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    // 播放列表（无在线播放，显示空提示）→ 第 2 层
    const plBtn = [...container.querySelectorAll('.dsh-music-settings-btn')].find((b) => b.textContent === '播放列表')
    expect(plBtn).toBeTruthy()
    act(() => { plBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const back = [...container.querySelectorAll('.dsh-music-settings-btn')].find((b) => b.textContent === '← 返回')
    expect(back).toBeTruthy()
    expect(container.textContent).toContain('暂无歌曲')
    // the panel layer is persisted to the Host (flushed on the ~800ms debounce)
    await act(async () => { await new Promise((r) => setTimeout(r, 950)) })
    expect(JSON.parse(prefsServer['dsh-music-qq-ui']).layer).toBe('playlist')
    // 返回主 UI
    act(() => { back.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(container.textContent).toContain('推荐歌单')
    await act(async () => { await new Promise((r) => setTimeout(r, 950)) })
    expect(JSON.parse(prefsServer['dsh-music-qq-ui']).layer).toBe('main')
  })

  it('QQ 播放列表进入时定位到正在播放的曲目（scrollIntoView 命中 active 行）', async () => {
    qqLoggedIn = true
    // jsdom 无 scrollIntoView：spy 它，验证播放列表层时会把正在播放的 active 行滚到可见。
    const scrollSpy = vi.fn()
    Element.prototype.scrollIntoView = scrollSpy
    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    const onlineTab = [...container.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === 'QQ音乐')
    act(() => { onlineTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    // 推荐歌单 → 打开「热门推荐」歌单（详情 mock 返回 告白气球 + 七里香 两首）
    const recTab = [...container.querySelectorAll('.dsh-music-qq-viewtab')].find((b) => b.textContent === '推荐歌单')
    act(() => { recTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const card = [...container.querySelectorAll('.dsh-music-playlist-card')].find((b) => b.textContent.includes('热门推荐'))
    act(() => { card.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    // 播放第二首（七里香）——让 active 行不是列表第一行，才能证明滚动到了它。
    const second = [...container.querySelectorAll('.dsh-music-track')].find((b) => b.textContent.includes('七里香'))
    act(() => { second.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(container.textContent).toContain('七里香')
    // 播放列表层应显示两首歌，其中正在播放的 七里香 是 active 行
    const activeRows = [...container.querySelectorAll('.dsh-music-track-row.active')]
    expect(activeRows.length).toBe(1)
    expect(activeRows[0].textContent).toContain('七里香')
    // scrollIntoView 必须被调用在 active 行上（证明播放列表层时定位到正在播放位置）
    const targets = scrollSpy.mock.instances.filter((el) =>
      el && el.classList && el.classList.contains('dsh-music-track-row') && el.classList.contains('active'))
    expect(targets.length).toBeGreaterThan(0)
  })

  it('shows a 音乐来源 (QQ音乐) badge on the bar when playing an online track', async () => {
    qqLoggedIn = true
    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const onlineTab = [...container.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === 'QQ音乐')
    act(() => { onlineTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    // default tab is 我的歌单 → switch to 推荐歌单
    const recTab = [...container.querySelectorAll('.dsh-music-qq-viewtab')].find((b) => b.textContent === '推荐歌单')
    act(() => { recTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const row = [...container.querySelectorAll('.dsh-music-playlist-card')].find((b) => b.textContent.includes('热门推荐'))
    act(() => { row.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const song = [...container.querySelectorAll('.dsh-music-track')].find((b) => b.textContent.includes('告白气球'))
    act(() => { song.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    // the bar should mark the source as QQ音乐 after the track name
    expect(container.textContent).toContain('QQ音乐')
    // and show the artist name next to the title
    expect(container.textContent).toContain('周杰伦')
  })

  it('shows the QQ quality tier inside the QQ音乐 badge when the play stream reports it', async () => {
    // 真实品质：Host 随 /qq/play 响应回传 X-DSH-QQ-Quality 头（percent-encoded），
    // 客户端用轻量 HEAD 立即读取，拼进播放条徽标（「QQ音乐 · 无损」）；没取到则只显示「QQ音乐」。
    qqLoggedIn = true
    const headStub = async (url, opts) => {
      const u = String(url)
      const o = opts || {}
      if (u.startsWith('/dsh-music/qq/play/') && o.method === 'HEAD') {
        return Promise.resolve({ ok: true, status: 200, headers: { get: (n) => n === 'X-DSH-QQ-Quality' ? encodeURIComponent('无损') : null } })
      }
      return fetchStub(url, opts)
    }
    vi.stubGlobal('fetch', headStub)
    try {
      const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
      const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
      const container = document.createElement('div')
      document.body.appendChild(container)
      const root = createRoot(container)
      act(() => { root.render(React.createElement('div', null, bar, panel)) })
      act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      const onlineTab = [...container.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === 'QQ音乐')
      act(() => { onlineTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      const recTab = [...container.querySelectorAll('.dsh-music-qq-viewtab')].find((b) => b.textContent === '推荐歌单')
      act(() => { recTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      const row = [...container.querySelectorAll('.dsh-music-playlist-card')].find((b) => b.textContent.includes('热门推荐'))
      act(() => { row.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      const song = [...container.querySelectorAll('.dsh-music-track')].find((b) => b.textContent.includes('告白气球'))
      act(() => { song.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      // 徽标带品质标签：QQ音乐 · 无损
      expect(container.textContent).toContain('QQ音乐 · 无损')
      // 本地/讲书等其他来源不受影响，不会出现品质标签
      expect(container.textContent).not.toContain('QQ音乐 · 高音质')
    } finally {
      vi.unstubAllGlobals()
      document.body.innerHTML = ''
    }
  })

  it('re-fetches the quality via HEAD when clicking 下一首 (startPlay path)', async () => {
    // Regression: 切歌/自动续播走 step → startPlay（通用路径，不走 startQQPlayback），
    // 必须在 startPlay 里也触发 HEAD，否则下一首的品质标签不会出现。
    qqLoggedIn = true
    const headLog = []
    const headStub = async (url, opts) => {
      const u = String(url)
      const o = opts || {}
      if (u.startsWith('/dsh-music/qq/play/') && o.method === 'HEAD') {
        headLog.push(u)
        return Promise.resolve({ ok: true, status: 200, headers: { get: (n) => n === 'X-DSH-QQ-Quality' ? encodeURIComponent('无损') : null } })
      }
      return fetchStub(url, opts)
    }
    vi.stubGlobal('fetch', headStub)
    try {
      const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
      const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
      const container = document.createElement('div')
      document.body.appendChild(container)
      const root = createRoot(container)
      act(() => { root.render(React.createElement('div', null, bar, panel)) })
      act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      const onlineTab = [...container.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === 'QQ音乐')
      act(() => { onlineTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      const recTab = [...container.querySelectorAll('.dsh-music-qq-viewtab')].find((b) => b.textContent === '推荐歌单')
      act(() => { recTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      const row = [...container.querySelectorAll('.dsh-music-playlist-card')].find((b) => b.textContent.includes('热门推荐'))
      act(() => { row.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      const song = [...container.querySelectorAll('.dsh-music-track')].find((b) => b.textContent.includes('告白气球'))
      act(() => { song.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      expect(container.textContent).toContain('QQ音乐 · 无损')
      // 点「下一首」→ step → startPlay → 应为下一首(790) 再发一次 HEAD
      const nextBtn = container.querySelector('button[title="下一首"]')
      act(() => { nextBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      expect(headLog).toContain('/dsh-music/qq/play/790')
      // 下一首的品质标签也应显示
      expect(container.textContent).toContain('QQ音乐 · 无损')
    } finally {
      vi.unstubAllGlobals()
      document.body.innerHTML = ''
    }
  })

  it('shows the local music quality chip (FLAC · 无损) on the bar', async () => {
    // 本地音乐：扫描时解析文件头得到「格式 · 档位」，startPlay 把 track.quality 写入
    // currentQuality，播放条显示品质芯片；与在线 QQ 的「QQ音乐 · 无损」互不叠加。
    manifest = { ...baseManifest(), tracks: [{ id: '0', name: 'a.flac', url: '/dsh-music/0', size: 10, ext: 'flac', path: '/music/a.flac', quality: 'FLAC · 无损' }] }
    vi.resetModules()
    lastFilesUrl = null
    await bootClient()
    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const track = [...container.querySelectorAll('.dsh-music-track')].find((b) => b.textContent.includes('a.flac'))
    act(() => { track.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    // 播放条带本地音质芯片
    expect(container.textContent).toContain('FLAC · 无损')
    // 不会叠加在线 QQ 徽标
    expect(container.textContent).not.toContain('QQ音乐 · 无损')
  })

  it('hides the quality badge when the 音质徽章显示 config toggle is off', async () => {
    // 系统配置「音质徽章显示」关闭后，歌名后不再显示本地「格式 · 音质」芯片
    // 与在线 QQ「QQ音乐 · 无损/高音质/标准」徽标；重新打开后恢复。
    prefsServer = { 'dsh-music-show-quality': '0' }
    manifest = { ...baseManifest(), tracks: [{ id: '0', name: 'a.flac', url: '/dsh-music/0', size: 10, ext: 'flac', path: '/music/a.flac', quality: 'FLAC · 无损' }] }
    vi.resetModules(); registered = []; lastFilesUrl = null
    await bootClient()
    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const track = [...container.querySelectorAll('.dsh-music-track')].find((b) => b.textContent.includes('a.flac'))
    act(() => { track.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    // 开关关闭：本地音质芯片不显示，但歌名仍在
    expect(container.textContent).toContain('a')
    expect(container.textContent).not.toContain('FLAC · 无损')

    // 打开系统配置里的「音质徽章显示」开关 → 恢复显示
    const configTab = [...container.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === '系统配置')
    act(() => { configTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const toggles = [...container.querySelectorAll('.dsh-music-toggle')]
    // 第 3 个开关 = 音质徽章显示（位于频谱之后、进度条之前），当前 OFF
    expect(toggles[2].getAttribute('aria-checked')).toBe('false')
    act(() => { toggles[2].dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    // 返回播放条 → 音质芯片恢复
    const libraryTab = [...container.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === '本地音乐')
    act(() => { libraryTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(container.textContent).toContain('FLAC · 无损')
  })

  it('adds the bare class to the bar (hides border/background) when the 播放条背景显示 toggle is off, keeping content', async () => {
    // 系统配置「播放条背景显示」：关闭后播放条外壳去掉边框与背景（加 .bare class），
    // 但歌名/歌词等内容保持不变（仍是同一 .dsh-music-bar 的子元素）。
    manifest = { ...baseManifest(), tracks: [{ id: '0', name: 'a.flac', url: '/dsh-music/0', size: 10, ext: 'flac', path: '/music/a.flac', quality: 'FLAC · 无损' }] }
    prefsServer = {}
    vi.resetModules(); registered = []; lastFilesUrl = null
    await bootClient()
    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const track = [...container.querySelectorAll('.dsh-music-track')].find((b) => b.textContent.includes('a.flac'))
    act(() => { track.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })

    // 默认开启：播放条无 bare class，歌名正常显示
    let barEl = container.querySelector('.dsh-music-bar')
    expect(barEl.classList.contains('bare')).toBe(false)
    expect(barEl.textContent).toContain('a')
    // 打开系统配置 → 关闭「播放条背景显示」
    const configTab = [...container.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === '系统配置')
    act(() => { configTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const toggles = [...container.querySelectorAll('.dsh-music-toggle')]
    // 第 5 个开关 = 播放条背景显示（位于进度条之后）
    expect(toggles[4].getAttribute('aria-checked')).toBe('true')
    act(() => { toggles[4].dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    // 返回播放条：bare class 加上，内容（歌名）仍保留
    const libraryTab = [...container.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === '本地音乐')
    act(() => { libraryTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    barEl = container.querySelector('.dsh-music-bar')
    expect(barEl.classList.contains('bare')).toBe(true)
    expect(barEl.textContent).toContain('a')
  })

  it('shows the QQ online lyric in the bar (idle state) with translation merged', async () => {
    // P2：在线 QQ 歌词。QQ 播放走 startQQPlayback（不走 startPlay），歌词从
    // /dsh-music/qq/lyric 按 songmid 取；有逐句翻译时合并为「原文 ／ 翻译」。
    const audios = []
    class LyricAudio extends FakeAudio {
      constructor() { super(); audios.push(this) }
      emit(type) { (this.listeners[type] || []).forEach((fn) => fn({ target: this })) }
    }
    vi.resetModules(); registered = []; lastFilesUrl = null; manifest = baseManifest(); qqLoggedIn = true
    qqLyricFixture = {
      ok: true, hasLyric: true,
      lrc: [{ t: 0, text: '告白气球' }, { t: 3, text: '亲爱的 爱上你' }],
      trans: [{ t: 3, text: 'darling I love you' }],
    }
    window.__ModuleLoader__ = { load: (def) => { factory = def.factory } }
    vi.stubGlobal('Audio', LyricAudio)
    vi.stubGlobal('fetch', fetchStub)
    vi.stubGlobal('requestAnimationFrame', () => 0)
    vi.stubGlobal('cancelAnimationFrame', () => {})
    vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '' }))
    vi.stubGlobal('setInterval', () => 0)
    vi.stubGlobal('clearInterval', () => {})
    window.confirm = () => true
    window.prompt = () => null
    await import('../lib/client.js')
    const modExports = factory((name) => (name === 'react' ? React : undefined))
    const slots = {
      inject: (name, cb) => { cb() },
      register: (meta, elementFactory) => { registered.push({ id: meta.id, elementFactory }); return elementFactory },
    }
    modExports.apply({ get: (k) => (k === 'slots' ? slots : undefined), effect: (fn) => fn() })
    await new Promise((r) => setTimeout(r, 0))
    const audio = audios[0]
    expect(audio).toBeTruthy()
    try {
      const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
      const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
      const container = document.createElement('div')
      document.body.appendChild(container)
      const root = createRoot(container)
      act(() => { root.render(React.createElement('div', null, bar, panel)) })
      act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      const onlineTab = [...container.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === 'QQ音乐')
      act(() => { onlineTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      const recTab = [...container.querySelectorAll('.dsh-music-qq-viewtab')].find((b) => b.textContent === '推荐歌单')
      act(() => { recTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      const row = [...container.querySelectorAll('.dsh-music-playlist-card')].find((b) => b.textContent.includes('热门推荐'))
      act(() => { row.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      const song = [...container.querySelectorAll('.dsh-music-track')].find((b) => b.textContent.includes('告白气球'))
      act(() => { song.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      const barEl = container.querySelector('.dsh-music-bar')
      expect(barEl.classList.contains('dimmed')).toBe(true)
      // 闲置态 → 歌词显示当前行（currentTime=0 → 第一行，无翻译）
      const lyric = container.querySelector('.dsh-music-bar-lyric')
      expect(lyric).toBeTruthy()
      expect(lyric.textContent).toContain('告白气球')
      // 推进到 3.5s → 第二行 + 翻译合并（原文 ／ 翻译）
      act(() => { audio.currentTime = 3.5; audio.emit('timeupdate') })
      const lyric2 = container.querySelector('.dsh-music-bar-lyric')
      expect(lyric2.textContent).toContain('亲爱的 爱上你')
      expect(lyric2.textContent).toContain('darling I love you')
      // 使用态（悬停）→ 歌词收起（与本地歌词同规格）
      act(() => { barEl.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })) })
      expect(container.querySelector('.dsh-music-bar-lyric')).toBeNull()
    } finally { qqLyricFixture = null }
  })

  it('QQ 在线歌曲也走 QRC 行窗口：karaoke 整行扫色窗口取精确行时长', async () => {
    // /dsh-music/qq/lyric 返回 wordLines 形态 → loadQQLyric 消费 musicWordLyric；
    // karaoke 动效下整行扫色的 --kar-dur 取 QRC 精确行时长；data-src="qq-qrc"。
    const audios = []
    class QrcAudio extends FakeAudio {
      constructor() { super(); audios.push(this) }
      emit(type) { (this.listeners[type] || []).forEach((fn) => fn({ target: this })) }
    }
    vi.resetModules(); registered = []; lastFilesUrl = null; manifest = baseManifest(); qqLoggedIn = true
    prefsServer = { 'dsh-music-lyric-fx': 'karaoke' }
    qqLyricFixture = {
      ok: true, hasLyric: true, source: 'qq-qrc',
      wordLines: [
        { t: 0, end: 3, text: '告白气球' },
        { t: 3, end: 6, text: '亲爱的 爱上你' },
      ],
    }
    window.__ModuleLoader__ = { load: (def) => { factory = def.factory } }
    vi.stubGlobal('Audio', QrcAudio)
    vi.stubGlobal('fetch', fetchStub)
    vi.stubGlobal('requestAnimationFrame', () => 0)
    vi.stubGlobal('cancelAnimationFrame', () => {})
    vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '' }))
    vi.stubGlobal('setInterval', () => 0)
    vi.stubGlobal('clearInterval', () => {})
    window.confirm = () => true
    window.prompt = () => null
    await import('../lib/client.js')
    const modExports = factory((name) => (name === 'react' ? React : undefined))
    const slots = {
      inject: (name, cb) => { cb() },
      register: (meta, elementFactory) => { registered.push({ id: meta.id, elementFactory }); return elementFactory },
    }
    modExports.apply({ get: (k) => (k === 'slots' ? slots : undefined), effect: (fn) => fn() })
    await new Promise((r) => setTimeout(r, 0))
    const audio = audios[0]
    try {
      const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
      const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
      const container = document.createElement('div')
      document.body.appendChild(container)
      const root = createRoot(container)
      act(() => { root.render(React.createElement('div', null, bar, panel)) })
      act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      const onlineTab = [...container.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === 'QQ音乐')
      act(() => { onlineTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      const recTab = [...container.querySelectorAll('.dsh-music-qq-viewtab')].find((b) => b.textContent === '推荐歌单')
      act(() => { recTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      const row = [...container.querySelectorAll('.dsh-music-playlist-card')].find((b) => b.textContent.includes('热门推荐'))
      act(() => { row.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      const song = [...container.querySelectorAll('.dsh-music-track')].find((b) => b.textContent.includes('告白气球'))
      act(() => { song.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      // 行窗口 [0,3]s → 音频时钟驱动：1.2s 处位置 (1-1200/3000)=60.00%
      audio.duration = 30
      audio.currentTime = 1.2
      act(() => { audio.emit('timeupdate') })
      const outer = container.querySelector('.dsh-music-bar-lyric')
      expect(outer.getAttribute('data-src')).toBe('qq-qrc')
      const fxEl = container.querySelector('.dsh-music-bar-lyric-fx')
      expect(fxEl.getAttribute('data-wordmode')).toBeNull()
      expect(fxEl.textContent).toBe('告白气球')
      expect(fxEl.getAttribute('data-audioclock')).toBe('1')
      expect(fxEl.style.backgroundPositionX).toBe('43.33%')   // f=1200/3000
      expect(fxEl.querySelectorAll('.dsh-music-word').length).toBe(0)
      // 第二行窗口 [3,6]s：4.5s → 50.00%
      audio.currentTime = 4.5
      act(() => { audio.emit('timeupdate') })
      const fxEl2 = container.querySelector('.dsh-music-bar-lyric-fx')
      expect(container.querySelector('.dsh-music-bar-lyric').textContent).toBe('亲爱的 爱上你')
      expect(fxEl2.style.backgroundPositionX).toBe('36.67%')   // f=1500/3000
    } finally {
      qqLyricFixture = null
      prefsServer = {}
    }
  })

  it('clears the QQ artist from the bar when switching to a local track or novel', async () => {
    // Regression: after playing a QQ song (artists set), playing a local track
    // (no artists) or a novel used to leave the stale QQ artist on the bar,
    // because currentArtists was not reset. It must be cleared.
    const audios = []
    class QAudio extends FakeAudio {
      constructor() { super(); audios.push(this) }
      emit(type) { (this.listeners[type] || []).forEach((fn) => fn({ target: this })) }
    }
    vi.resetModules(); registered = []; lastFilesUrl = null; manifest = baseManifest(); qqLoggedIn = true
    window.__ModuleLoader__ = { load: (def) => { factory = def.factory } }
    vi.stubGlobal('Audio', QAudio)
    vi.stubGlobal('fetch', fetchStub)
    vi.stubGlobal('requestAnimationFrame', () => 0)
    vi.stubGlobal('cancelAnimationFrame', () => {})
    vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '' }))
    window.confirm = () => true
    window.prompt = () => null
    await import('../lib/client.js')
    const modExports = factory((name) => (name === 'react' ? React : undefined))
    const slots = {
      inject: (name, cb) => { cb() },
      register: (meta, elementFactory) => { registered.push({ id: meta.id, elementFactory }); return elementFactory },
    }
    modExports.apply({ get: (k) => (k === 'slots' ? slots : undefined), effect: (fn) => fn() })
    await new Promise((r) => setTimeout(r, 0))
    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    const onlineTab = [...container.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === 'QQ音乐')
    act(() => { onlineTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const recTab = [...container.querySelectorAll('.dsh-music-qq-viewtab')].find((b) => b.textContent === '推荐歌单')
    act(() => { recTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const row = [...container.querySelectorAll('.dsh-music-playlist-card')].find((b) => b.textContent.includes('热门推荐'))
    act(() => { row.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const song = [...container.querySelectorAll('.dsh-music-track')].find((b) => b.textContent.includes('告白气球'))
    act(() => { song.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    // QQ 曲目播放中：歌手名显示
    expect(container.textContent).toContain('周杰伦')
    // 切回本地音乐，双击本地曲目（无 artists）→ 歌手名应消失
    const musicTab = [...container.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === '本地音乐')
    act(() => { musicTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const localRow = container.querySelector('.dsh-music-track')
    expect(localRow).toBeTruthy()
    act(() => { localRow.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 })) })
    act(() => { localRow.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 2 })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    // 本地曲目无歌手：artist 元素应消失（不再残留周杰伦）
    expect(container.querySelector('.dsh-music-bar-artist')).toBeNull()
    // bar 上不应再出现 QQ 歌手名（面板常驻后隐藏的 QQ 歌单内容仍在 DOM 中，
    // 因此只检查播放条 bar 本身，不检查整个 container）
    const barText = container.querySelector('.dsh-music-bar') ? container.querySelector('.dsh-music-bar').textContent : container.textContent
    expect(barText).not.toContain('周杰伦')
  })

  it('does NOT jump back to the QQ tab after choosing a directory while playing QQ', async () => {
    // Regression: saveRoot() used to call restoreLatest() -> restorePlayback(),
    // whose QQ branch force-set tab:'qq'. So while a QQ track was playing,
    // confirming a directory in 本地音乐/AI讲书 yanked the panel back to the
    // QQ音乐 tab. Changing the directory must only refresh the list.
    const audios = []
    class QAudio2 extends FakeAudio {
      constructor() { super(); audios.push(this) }
      emit(type) { (this.listeners[type] || []).forEach((fn) => fn({ target: this })) }
    }
    vi.resetModules(); registered = []; lastFilesUrl = null; manifest = baseManifest(); qqLoggedIn = true
    window.__ModuleLoader__ = { load: (def) => { factory = def.factory } }
    vi.stubGlobal('Audio', QAudio2)
    vi.stubGlobal('fetch', fetchStub)
    vi.stubGlobal('requestAnimationFrame', () => 0)
    vi.stubGlobal('cancelAnimationFrame', () => {})
    vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '' }))
    window.confirm = () => true
    window.prompt = () => null
    await import('../lib/client.js')
    const modExports = factory((name) => (name === 'react' ? React : undefined))
    const slots = {
      inject: (name, cb) => { cb() },
      register: (meta, elementFactory) => { registered.push({ id: meta.id, elementFactory }); return elementFactory },
    }
    modExports.apply({ get: (k) => (k === 'slots' ? slots : undefined), effect: (fn) => fn() })
    await new Promise((r) => setTimeout(r, 0))
    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    // 播放一首 QQ 歌（让 currentId 变为 qq:，PREF_PLAYBACK 记录 QQ）
    const onlineTab = [...container.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === 'QQ音乐')
    act(() => { onlineTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const recTab = [...container.querySelectorAll('.dsh-music-qq-viewtab')].find((b) => b.textContent === '推荐歌单')
    act(() => { recTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const row = [...container.querySelectorAll('.dsh-music-playlist-card')].find((b) => b.textContent.includes('热门推荐'))
    act(() => { row.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const song = [...container.querySelectorAll('.dsh-music-track')].find((b) => b.textContent.includes('告白气球'))
    act(() => { song.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    // 切到本地音乐 tab
    const musicTab = [...container.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === '本地音乐')
    act(() => { musicTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    // 选择音乐目录并确认（走 saveRoot）
    const pickBtn = [...container.querySelectorAll('.dsh-music-settings-btn')].find((b) => b.textContent === '选择音乐目录')
    act(() => { pickBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const confirmBtn = [...container.querySelectorAll('.dsh-music-picker-foot .dsh-music-settings-btn')].find((b) => b.textContent === '选择此目录')
    act(() => { confirmBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    // 目录确认后仍应停留在本地音乐（不跳回 QQ 音乐 tab）
    const activeTab = container.querySelector('.dsh-music-tab.active')
    expect(activeTab).toBeTruthy()
    expect(activeTab.textContent).toBe('本地音乐')
  })

  it('favorites an online QQ song via the heart button (adds to 我喜欢)', async () => {
    qqLoggedIn = true
    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const onlineTab = [...container.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === 'QQ音乐')
    act(() => { onlineTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    // default tab is 我的歌单 → switch to 推荐歌单
    const recTab = [...container.querySelectorAll('.dsh-music-qq-viewtab')].find((b) => b.textContent === '推荐歌单')
    act(() => { recTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const row = [...container.querySelectorAll('.dsh-music-playlist-card')].find((b) => b.textContent.includes('热门推荐'))
    act(() => { row.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const song = [...container.querySelectorAll('.dsh-music-track')].find((b) => b.textContent.includes('七里香'))
    act(() => { song.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    // heart button appears for the online track
    const heart = container.querySelector('.dsh-music-bar-btn.fav')
    expect(heart).toBeTruthy()
    act(() => { heart.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    // called /dsh-music/qq/fav with action add for the current song
    expect(favCalls.length).toBeGreaterThan(0)
    expect(favCalls[0].action).toBe('add')
    expect(favCalls[0].song.songmid).toBe('790')
    // heart turns on (filled)
    expect(container.querySelector('.dsh-music-bar-btn.fav.on')).toBeTruthy()
  })

  it('reflects per-song liked state: favorited songs show filled heart, others do not', async () => {
    qqLoggedIn = true
    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const onlineTab = [...container.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === 'QQ音乐')
    act(() => { onlineTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    // default tab is 我的歌单 → switch to 推荐歌单
    const recTab = [...container.querySelectorAll('.dsh-music-qq-viewtab')].find((b) => b.textContent === '推荐歌单')
    act(() => { recTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const row = [...container.querySelectorAll('.dsh-music-playlist-card')].find((b) => b.textContent.includes('热门推荐'))
    act(() => { row.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    // 告白气球 (songid 789001) IS in the liked ids -> heart filled after the async check
    const fav1 = [...container.querySelectorAll('.dsh-music-track')].find((b) => b.textContent.includes('告白气球'))
    act(() => { fav1.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(container.querySelector('.dsh-music-bar-btn.fav.on')).toBeTruthy()
    // 七里香 (songid 790002) is NOT in liked ids -> heart not filled
    const fav2 = [...container.querySelectorAll('.dsh-music-track')].find((b) => b.textContent.includes('七里香'))
    act(() => { fav2.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(container.querySelector('.dsh-music-bar-btn.fav.on')).toBeNull()
    // back to 告白气球 -> filled again (not stuck from a previous toggle)
    const fav3 = [...container.querySelectorAll('.dsh-music-track')].find((b) => b.textContent.includes('告白气球'))
    act(() => { fav3.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(container.querySelector('.dsh-music-bar-btn.fav.on')).toBeTruthy()
  })

  it('persists online QQ playback so a refresh can restore it (not showing local music)', async () => {
    qqLoggedIn = true
    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const onlineTab = [...container.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === 'QQ音乐')
    act(() => { onlineTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    // default tab is 我的歌单 → switch to 推荐歌单
    const recTab = [...container.querySelectorAll('.dsh-music-qq-viewtab')].find((b) => b.textContent === '推荐歌单')
    act(() => { recTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const row = [...container.querySelectorAll('.dsh-music-playlist-card')].find((b) => b.textContent.includes('热门推荐'))
    act(() => { row.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const song = [...container.querySelectorAll('.dsh-music-track')].find((b) => b.textContent.includes('告白气球'))
    act(() => { song.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    // savePlayback must persist the online QQ state to the Host (flushed on debounce)
    await act(async () => { await new Promise((r) => setTimeout(r, 950)) })
    const saved = JSON.parse(prefsServer['dsh-music-qq-playback'])
    expect(saved.id).toBe('qq:789')
    expect(Array.isArray(saved.queue)).toBe(true)
    expect(saved.queue.length).toBe(2)
    // and the scope is remembered as qq (so refresh opens the online view)
    expect(JSON.parse(prefsServer['dsh-music-scope']).kind).toBe('qq')
  })

  it('persists the online QQ track position so a restart resumes mid-song', async () => {
    qqLoggedIn = true
    const audios = []
    class QAudio extends FakeAudio {
      constructor() { super(); audios.push(this) }
      emit(type) { (this.listeners[type] || []).forEach((fn) => fn({ target: this })) }
    }
    vi.resetModules(); registered = []; prefsPosts = []; lastFilesUrl = null
    window.__ModuleLoader__ = { load: (def) => { factory = def.factory } }
    vi.stubGlobal('Audio', QAudio)
    vi.stubGlobal('fetch', fetchStub)
    vi.stubGlobal('requestAnimationFrame', () => 0)
    vi.stubGlobal('cancelAnimationFrame', () => {})
    vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '' }))
    vi.stubGlobal('setInterval', () => 0)
    vi.stubGlobal('clearInterval', () => {})
    window.confirm = () => true; window.prompt = () => null
    await import('../lib/client.js')
    const modExports = factory((name) => (name === 'react' ? React : undefined))
    const slots = { inject: (n, cb) => cb(), register: (meta, ef) => { registered.push({ id: meta.id, elementFactory: ef }); return ef } }
    modExports.apply({ get: (k) => (k === 'slots' ? slots : undefined), effect: (fn) => fn() })
    await new Promise((r) => setTimeout(r, 0))
    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const onlineTab = [...container.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === 'QQ音乐')
    act(() => { onlineTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const recTab = [...container.querySelectorAll('.dsh-music-qq-viewtab')].find((b) => b.textContent === '推荐歌单')
    act(() => { recTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const row = [...container.querySelectorAll('.dsh-music-playlist-card')].find((b) => b.textContent.includes('热门推荐'))
    act(() => { row.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const song = [...container.querySelectorAll('.dsh-music-track')].find((b) => b.textContent.includes('告白气球'))
    act(() => { song.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const audio = audios[0]
    expect(audio.src).toContain('/dsh-music/qq/play/789')
    // 播到 1:00（全曲 4:00）时暂停：暂停会立即 savePlayback，位置必须被持久化
    audio.currentTime = 60
    audio.duration = 240
    act(() => { audio.emit('pause') })
    await act(async () => { await new Promise((r) => setTimeout(r, 950)) }) // flush debounce
    const saved = JSON.parse(prefsServer['dsh-music-qq-playback'])
    expect(saved.id).toBe('qq:789')
    expect(saved.position).toBe(60)
    expect(saved.duration).toBe(240)
    expect(Array.isArray(saved.queue)).toBe(true)
  })

  it('restarts a restored online QQ track from its saved mid-song position', async () => {
    // 模拟重启：Host prefs 里躺着一条「播到 1:00」的 QQ 播放记录。新会话必须恢复
    // 同一曲目 + 队列，播放条显示 1:00 / 4:00（暂停态），点 ▶ 后把流 seek 到 60。
    prefsServer = {
      'dsh-music-qq-playback': JSON.stringify({
        id: 'qq:789', name: '告白气球', artists: ['周杰伦'],
        position: 60, duration: 240,
        queue: [
          { id: '789', songmid: '789', title: '告白气球', artists: ['周杰伦'], payplay: 0, source: 'qq' },
          { id: '790', songmid: '790', title: '七里香', artists: ['周杰伦'], payplay: 0, source: 'qq' },
        ],
        source: '在线', ts: 999999999,
      }),
      'dsh-music-scope': JSON.stringify({ kind: 'qq' }),
    }
    qqLoggedIn = true
    const audios = []
    class QAudio extends FakeAudio {
      constructor() { super(); audios.push(this) }
      emit(type) { (this.listeners[type] || []).forEach((fn) => fn({ target: this })) }
    }
    vi.resetModules(); registered = []; prefsPosts = []; lastFilesUrl = null
    window.__ModuleLoader__ = { load: (def) => { factory = def.factory } }
    vi.stubGlobal('Audio', QAudio)
    vi.stubGlobal('fetch', fetchStub)
    vi.stubGlobal('requestAnimationFrame', () => 0)
    vi.stubGlobal('cancelAnimationFrame', () => {})
    vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '' }))
    vi.stubGlobal('setInterval', () => 0)
    vi.stubGlobal('clearInterval', () => {})
    window.confirm = () => true; window.prompt = () => null
    await import('../lib/client.js')
    const modExports = factory((name) => (name === 'react' ? React : undefined))
    const slots = { inject: (n, cb) => cb(), register: (meta, ef) => { registered.push({ id: meta.id, elementFactory: ef }); return ef } }
    modExports.apply({ get: (k) => (k === 'slots' ? slots : undefined), effect: (fn) => fn() })
    await new Promise((r) => setTimeout(r, 0))
    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    // restorePlayback ran during loadTracks: bar shows the QQ track paused at 1:00 / 4:00
    const nameSpan = container.querySelector('.dsh-music-bar-name')
    expect(nameSpan).toBeTruthy()
    expect(nameSpan.textContent).toContain('告白气球')
    // 播放条处于闲置（半透明）态时不显示时长；mouseover 激活后显示恢复的位置。
    const barEl = container.querySelector('.dsh-music-bar')
    act(() => { barEl.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })) })
    const timeSpan = container.querySelector('.dsh-music-bar-time')
    expect(timeSpan).toBeTruthy()
    expect(timeSpan.textContent).toBe('1:00 / 4:00')
    // click play -> togglePlay reloads the online stream URL and seeks to the saved spot
    const playBtn = [...container.querySelectorAll('.dsh-music-bar-btn')].find((b) => b.title === '播放/暂停')
    expect(playBtn).toBeTruthy()
    act(() => { playBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const audio = audios[0]
    expect(audio.src).toContain('/dsh-music/qq/play/789')
    expect(audio.currentTime).toBeGreaterThanOrEqual(59.5) // 从 1:00 续播而非从头
    expect(audio.paused).toBe(false)
  })

  it('starts a DIFFERENT track from 0 after refresh via the music_play intent (not the old position)', async () => {
    // Regression: after a refresh the player restores the last track PAUSED at its
    // saved position (restoredMusicPos). Switching to a different track via the
    // music_play intent used to leave restoredMusicPos set, so the new track was
    // seeked back to the PREVIOUS song's progress ("换歌从旧进度开始"). The intent
    // play path must drop the restore pin and reset the readout.
    const audios = []
    class IntentAudio extends FakeAudio {
      constructor() { super(); audios.push(this) }
      emit(type) { (this.listeners[type] || []).forEach((fn) => fn({ target: this })) }
    }
    let intent = null
    let intentPoll = null
    const baseFetch = fetchStub
    const fetcher = vi.fn((url, opts) => {
      if (String(url) === '/dsh-music/intent') return jsonRes(intent)
      return baseFetch(url, opts)
    })
    prefsServer = {
      'dsh-music-playback': JSON.stringify({ id: '0', name: 'a.mp3', position: 42, duration: 210, ts: 999999999 }),
    }
    manifest = {
      ...baseManifest(),
      tracks: [
        { id: '0', name: 'a.mp3', url: '/dsh-music/0', size: 10, ext: 'mp3', path: '/music/a.mp3' },
        { id: '1', name: 'b.mp3', url: '/dsh-music/1', size: 20, ext: 'mp3', path: '/music/b.mp3' },
      ],
      count: 2,
    }
    vi.resetModules(); registered = []; prefsPosts = []; lastFilesUrl = null
    window.__ModuleLoader__ = { load: (def) => { factory = def.factory } }
    vi.stubGlobal('Audio', IntentAudio)
    vi.stubGlobal('fetch', fetcher)
    vi.stubGlobal('requestAnimationFrame', () => 0)
    vi.stubGlobal('cancelAnimationFrame', () => {})
    vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '' }))
    vi.stubGlobal('setInterval', (cb) => { intentPoll = cb; return 1 })
    vi.stubGlobal('clearInterval', () => {})
    window.confirm = () => true; window.prompt = () => null
    await import('../lib/client.js')
    const modExports = factory((name) => (name === 'react' ? React : undefined))
    const slots = { inject: (n, cb) => cb(), register: (meta, ef) => { registered.push({ id: meta.id, elementFactory: ef }); return ef } }
    modExports.apply({ get: (k) => (k === 'slots' ? slots : undefined), effect: (fn) => fn() })
    await new Promise((r) => setTimeout(r, 0))
    const audio = audios[0]
    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    // after refresh restore: track 0 is current, paused at 0:42
    const nameSpan = container.querySelector('.dsh-music-bar-name')
    expect(nameSpan.textContent).toContain('a')

    // Host delivers a music_play intent for a DIFFERENT track (id '1').
    expect(intentPoll).toBeTruthy()
    intent = { action: 'play', id: '1', name: 'b.mp3' }
    await act(async () => { await intentPoll() })
    await new Promise((r) => setTimeout(r, 0))
    expect(audio.src).toContain('/dsh-music/1')

    // The new track plays from 0 — simulate a real browser 'play' + timeupdate.
    act(() => { audio.emit('play') })
    audio.currentTime = 0.05
    audio.duration = 100
    act(() => { audio.emit('durationchange') })
    act(() => { audio.emit('timeupdate') })
    // MUST NOT be re-seeked back to the old 42.
    expect(audio.currentTime).toBeLessThan(1)
  })

  it('starts a different QQ track from 0 after refresh (not the restored local track position)', async () => {
    // Regression: after a refresh a LOCAL track is restored PAUSED at 42
    // (restoredMusicPos set). Switching to an online QQ song used to reach
    // startQQPlayback WITHOUT clearing the pin, so the QQ stream was seeked back
    // to 42. startQQPlayback must drop the restore pin too.
    const audios = []
    class QAudio extends FakeAudio {
      constructor() { super(); audios.push(this) }
      emit(type) { (this.listeners[type] || []).forEach((fn) => fn({ target: this })) }
    }
    prefsServer = {
      'dsh-music-playback': JSON.stringify({ id: '0', name: 'a.mp3', position: 42, duration: 210, ts: 999999999 }),
    }
    manifest = baseManifest()
    qqLoggedIn = true
    vi.resetModules(); registered = []; prefsPosts = []; lastFilesUrl = null
    window.__ModuleLoader__ = { load: (def) => { factory = def.factory } }
    vi.stubGlobal('Audio', QAudio)
    vi.stubGlobal('fetch', fetchStub)
    vi.stubGlobal('requestAnimationFrame', () => 0)
    vi.stubGlobal('cancelAnimationFrame', () => {})
    vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '' }))
    vi.stubGlobal('setInterval', () => 0)
    vi.stubGlobal('clearInterval', () => {})
    window.confirm = () => true; window.prompt = () => null
    await import('../lib/client.js')
    const modExports = factory((name) => (name === 'react' ? React : undefined))
    const slots = { inject: (n, cb) => cb(), register: (meta, ef) => { registered.push({ id: meta.id, elementFactory: ef }); return ef } }
    modExports.apply({ get: (k) => (k === 'slots' ? slots : undefined), effect: (fn) => fn() })
    await new Promise((r) => setTimeout(r, 0))
    const audio = audios[0]
    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    // after refresh restore: local track 0 current, paused at 42
    expect(container.querySelector('.dsh-music-bar-name').textContent).toContain('a')

    // switch to the QQ panel and play an online song
    act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const onlineTab = [...container.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === 'QQ音乐')
    act(() => { onlineTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const recTab = [...container.querySelectorAll('.dsh-music-qq-viewtab')].find((b) => b.textContent === '推荐歌单')
    act(() => { recTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const row = [...container.querySelectorAll('.dsh-music-playlist-card')].find((b) => b.textContent.includes('热门推荐'))
    act(() => { row.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const song = [...container.querySelectorAll('.dsh-music-track')].find((b) => b.textContent.includes('告白气球'))
    act(() => { song.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(audio.src).toContain('/dsh-music/qq/play/789')

    // simulate a real browser 'play' + timeupdate — must start from ~0, not be seeked to 42
    act(() => { audio.emit('play') })
    audio.currentTime = 0.05
    audio.duration = 240
    act(() => { audio.emit('durationchange') })
    act(() => { audio.emit('timeupdate') })
    expect(audio.currentTime).toBeLessThan(1)
  })

  it('flushes a large QQ queue playback WITHOUT keepalive (64KiB browser limit regression)', async () => {
    // Regression: the playback save embeds the whole QQ queue; a long playlist
    // (800 songs) makes the POST body exceed the browser's 64KiB keepalive cap,
    // which used to make fetch throw and silently drop the playback write.
    // Large payloads must go out with keepalive=false.
    const bigSongs = Array.from({ length: 800 }, (_, i) => ({
      id: 'mid' + i, songmid: 'mid' + i, title: '测试歌曲 ' + i + ' 号', artists: ['测试歌手'], payplay: 0, source: 'qq',
    }))
    // seed the playlist-layer restore so the panel opens the big playlist
    prefsServer = { 'dsh-music-qq-ui': JSON.stringify({ layer: 'playlist', plId: 'big', plName: '大队列歌单' }) }
    qqLoggedIn = true
    vi.resetModules(); registered = []; prefsPosts = []; prefsPostOpts = []; lastFilesUrl = null
    window.__ModuleLoader__ = { load: (def) => { factory = def.factory } }
    vi.stubGlobal('Audio', FakeAudio)
    vi.stubGlobal('fetch', (url, opts) => {
      if (String(url).startsWith('/dsh-music/qq/playlist/big')) {
        return jsonRes({ ok: true, playlist: { id: 'big', name: '大队列歌单', creator: '作者', trackCount: 800, source: 'qq', songs: bigSongs } })
      }
      return fetchStub(url, opts)
    })
    vi.stubGlobal('requestAnimationFrame', () => 0)
    vi.stubGlobal('cancelAnimationFrame', () => {})
    vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '' }))
    vi.stubGlobal('setInterval', () => 0)
    vi.stubGlobal('clearInterval', () => {})
    window.confirm = () => true; window.prompt = () => null
    await import('../lib/client.js')
    const modExports = factory((name) => (name === 'react' ? React : undefined))
    const slots = { inject: (n, cb) => cb(), register: (meta, ef) => { registered.push({ id: meta.id, elementFactory: ef }); return ef } }
    modExports.apply({ get: (k) => (k === 'slots' ? slots : undefined), effect: (fn) => fn() })
    await new Promise((r) => setTimeout(r, 50))

    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    const onlineTab = [...container.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === 'QQ音乐')
    act(() => { onlineTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 50)) })
    // restoreUi loaded the big playlist layer -> click the first song
    const song = [...container.querySelectorAll('.dsh-music-track')].find((b) => b.textContent.includes('测试歌曲 0 号'))
    expect(song).toBeTruthy()
    act(() => { song.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 950)) }) // flush debounce

    const saved = JSON.parse(prefsServer['dsh-music-qq-playback'])
    expect(saved.queue.length).toBe(800)
    // the large body must NOT use keepalive (browser would throw >64KiB)
    const playbackPost = prefsPostOpts.find((o) => o.bodyLen > 60 * 1024)
    expect(playbackPost).toBeTruthy()
    expect(playbackPost.keepalive).toBe(false)
  })

  it('retries the restored QQ playlist when the first request returns empty songs (refresh-empty bug)', async () => {
    // Bug: 刷新后恢复歌单层时，QQ 歌单详情接口首次请求常返回空 songlist（冷缓存），
    // restoreUi 只发一次请求且无加载态/重试，导致「刷新后播放列表显示为空」；
    // 返回重进（openPlaylist 第二次请求）才取到完整列表。恢复路径应像 openPlaylist
    // 一样显示加载中并对空结果/失败自动重试。
    const retrySongs = [
      { id: 's1', songmid: 's1', title: '重试歌一', artists: ['歌手A'], payplay: 0, source: 'qq' },
      { id: 's2', songmid: 's2', title: '重试歌二', artists: ['歌手A'], payplay: 0, source: 'qq' },
    ]
    prefsServer = { 'dsh-music-qq-ui': JSON.stringify({ layer: 'playlist', plId: 'retrypl', plName: '测试歌单' }) }
    qqLoggedIn = true
    vi.resetModules(); registered = []; prefsPosts = []; lastFilesUrl = null
    window.__ModuleLoader__ = { load: (def) => { factory = def.factory } }
    vi.stubGlobal('Audio', FakeAudio)
    let plCalls = 0
    vi.stubGlobal('fetch', (url, opts) => {
      if (String(url).startsWith('/dsh-music/qq/playlist/retrypl')) {
        plCalls++
        const empty = plCalls === 1
        return jsonRes({ ok: true, playlist: { id: 'retrypl', name: '测试歌单', creator: '作者', trackCount: 2, source: 'qq', songs: empty ? [] : retrySongs } })
      }
      return fetchStub(url, opts)
    })
    vi.stubGlobal('requestAnimationFrame', () => 0)
    vi.stubGlobal('cancelAnimationFrame', () => {})
    vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '' }))
    vi.stubGlobal('setInterval', () => 0)
    vi.stubGlobal('clearInterval', () => {})
    window.confirm = () => true; window.prompt = () => null
    await import('../lib/client.js')
    const modExports = factory((name) => (name === 'react' ? React : undefined))
    const slots = { inject: (n, cb) => cb(), register: (meta, ef) => { registered.push({ id: meta.id, elementFactory: ef }); return ef } }
    modExports.apply({ get: (k) => (k === 'slots' ? slots : undefined), effect: (fn) => fn() })
    await new Promise((r) => setTimeout(r, 50))

    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    const onlineTab = [...container.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === 'QQ音乐')
    act(() => { onlineTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    // 给恢复请求 + 重试留出时间（当前代码只有 1 次请求；修复后最多重试几次）
    await new Promise((r) => setTimeout(r, 2200))
    act(() => {})
    // 恢复的歌单层应自动重试并把完整列表显示出来（而不是停在「暂无歌曲」）
    expect(plCalls).toBeGreaterThan(1)
    const songRow = [...container.querySelectorAll('.dsh-music-track')].find((b) => b.textContent.includes('重试歌一'))
    expect(songRow).toBeTruthy()
    expect(container.textContent).not.toContain('暂无歌曲。')
  })

  it('restores the 在线播放列表 (queue) layer with the saved queue after refresh (queue-restore race)', async () => {
    // Bug: 刷新后 restoreUi 恢复「在线播放列表」（plId=''，来自 openQueue 保存）时，
    // prefsReady 置位早于 restorePlayback 把 qqQueue 灌好（loadTracks 先 set prefsReady、
    // 再等 manifest、最后 restoreLatest→灌队列），读取的是空快照 → 直接显示「暂无歌曲」；
    // 返回重进（openQueue）重新读取已就绪的队列才正常。
    prefsServer = {
      'dsh-music-qq-ui': JSON.stringify({ layer: 'playlist', plId: '', plName: '' }),
      'dsh-music-qq-playback': JSON.stringify({
        id: 'qq:789', name: '告白气球', artists: ['周杰伦'],
        position: 10, duration: 240,
        queue: [
          { id: '789', songmid: '789', title: '告白气球', artists: ['周杰伦'], payplay: 0, source: 'qq' },
          { id: '790', songmid: '790', title: '七里香', artists: ['周杰伦'], payplay: 0, source: 'qq' },
        ],
        source: '在线', ts: 999999999,
      }),
    }
    qqLoggedIn = true
    vi.resetModules(); registered = []; prefsPosts = []; lastFilesUrl = null
    window.__ModuleLoader__ = { load: (def) => { factory = def.factory } }
    vi.stubGlobal('Audio', FakeAudio)
    vi.stubGlobal('fetch', (url, opts) => {
      // 延迟 manifest：让 prefsReady 先到（触发 restoreUi 读空队列），restorePlayback
      // 灌 qqQueue 后到，精确复现竞态。
      if (String(url) === '/dsh-music/manifest') return new Promise((resolve) => setTimeout(() => resolve(jsonRes(manifest)), 300))
      return fetchStub(url, opts)
    })
    vi.stubGlobal('requestAnimationFrame', () => 0)
    vi.stubGlobal('cancelAnimationFrame', () => {})
    vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '' }))
    vi.stubGlobal('setInterval', () => 0)
    vi.stubGlobal('clearInterval', () => {})
    window.confirm = () => true; window.prompt = () => null
    await import('../lib/client.js')
    const modExports = factory((name) => (name === 'react' ? React : undefined))
    const slots = { inject: (n, cb) => cb(), register: (meta, ef) => { registered.push({ id: meta.id, elementFactory: ef }); return ef } }
    modExports.apply({ get: (k) => (k === 'slots' ? slots : undefined), effect: (fn) => fn() })

    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    const onlineTab = [...container.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === 'QQ音乐')
    act(() => { onlineTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    // 等 manifest 延迟（300ms）过后 restorePlayback 已把队列灌进 store
    await new Promise((r) => setTimeout(r, 600))
    act(() => {})
    // 恢复的「在线播放列表」应显示保存的队列歌曲，而不是「暂无歌曲」
    const songRow = [...container.querySelectorAll('.dsh-music-track')].find((b) => b.textContent.includes('告白气球'))
    expect(songRow).toBeTruthy()
    expect(container.textContent).not.toContain('暂无歌曲。')
  })

  it('shows the persisted online QQ queue even when the refresh restored local music (separate persistence)', async () => {
    // 核心场景：上次播的是本地音乐（本地 ts 最新），但 QQ 队列仍单独保存在
    // dsh-music-qq-playback。刷新后 restoreLatest 恢复本地，打开「在线播放列表」
    // 仍能看到之前保存的 QQ 队列——本地/在线互不影响、互不覆盖。
    prefsServer = {
      'dsh-music-playback': JSON.stringify({ id: '0', name: 'a.mp3', position: 42, duration: 210, ts: 999999999 }),
      'dsh-music-qq-playback': JSON.stringify({
        id: 'qq:789', name: '告白气球', artists: ['周杰伦'],
        position: 10, duration: 240,
        queue: [
          { id: '789', songmid: '789', title: '告白气球', artists: ['周杰伦'], payplay: 0, source: 'qq' },
          { id: '790', songmid: '790', title: '七里香', artists: ['周杰伦'], payplay: 0, source: 'qq' },
        ],
        source: '在线', ts: 100,
      }),
      'dsh-music-scope': JSON.stringify({ kind: 'library' }),
    }
    manifest = { ...baseManifest(), tracks: [{ id: '0', name: 'a.mp3', url: '/dsh-music/0', size: 10, ext: 'mp3', path: '/music/a.mp3' }] }
    qqLoggedIn = true
    vi.resetModules(); registered = []; prefsPosts = []; lastFilesUrl = null
    window.__ModuleLoader__ = { load: (def) => { factory = def.factory } }
    vi.stubGlobal('Audio', FakeAudio)
    vi.stubGlobal('fetch', fetchStub)
    vi.stubGlobal('requestAnimationFrame', () => 0)
    vi.stubGlobal('cancelAnimationFrame', () => {})
    vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '' }))
    vi.stubGlobal('setInterval', () => 0)
    vi.stubGlobal('clearInterval', () => {})
    window.confirm = () => true; window.prompt = () => null
    await import('../lib/client.js')
    const modExports = factory((name) => (name === 'react' ? React : undefined))
    const slots = { inject: (n, cb) => cb(), register: (meta, ef) => { registered.push({ id: meta.id, elementFactory: ef }); return ef } }
    modExports.apply({ get: (k) => (k === 'slots' ? slots : undefined), effect: (fn) => fn() })
    await new Promise((r) => setTimeout(r, 0))
    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    // 刷新恢复了本地音乐（本地 ts 最新 → 恢复本地，tab 停在本地音乐）
    expect(container.querySelector('.dsh-music-tab.active').textContent).toBe('本地音乐')
    // 打开 QQ 面板 → 点「播放列表」打开「在线播放列表」→ 仍能看到持久化的 QQ 队列
    const onlineTab = [...container.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === 'QQ音乐')
    act(() => { onlineTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const plBtn = [...container.querySelectorAll('.dsh-music-settings-btn')].find((b) => b.textContent === '播放列表')
    expect(plBtn).toBeTruthy()
    act(() => { plBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    // 显示持久化的 QQ 队列，而不是「暂无歌曲」
    const qqSongRow = [...container.querySelectorAll('.dsh-music-track')].find((b) => b.textContent.includes('告白气球'))
    expect(qqSongRow).toBeTruthy()
    expect(container.textContent).not.toContain('暂无歌曲。')
  })

  it('refreshes the local library list via the 刷新 button (manual re-scan)', async () => {
    // 面板「刷新」按钮：点击后调用 /dsh-music/rescan，用返回的新列表替换曲库（无需重选目录）。
    const origFetch = window.fetch
    window.fetch = (u, o) => {
      if (String(u) === '/dsh-music/rescan' && o && o.method === 'POST') {
        return jsonRes({
          ok: true, root: '/music', bookRoot: '/books', count: 2,
          tracks: [
            { id: '0', name: 'a.mp3', url: '/dsh-music/0', size: 10, ext: 'mp3', path: '/music/a.mp3' },
            { id: '1', name: 'b.mp3', url: '/dsh-music/1', size: 12, ext: 'mp3', path: '/music/b.mp3' },
          ],
          books: [], playlists: manifest.playlists, voices: [],
        })
      }
      return origFetch(u, o)
    }
    try {
      const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
      const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
      const container = document.createElement('div')
      document.body.appendChild(container)
      const root = createRoot(container)
      act(() => { root.render(React.createElement('div', null, bar, panel)) })
      act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      // 初始只有 a.mp3
      expect(container.textContent).toContain('a.mp3')
      expect(container.textContent).not.toContain('b.mp3')
      // 点「刷新」→ 重扫后显示新增的 b.mp3
      const refreshBtn = [...container.querySelectorAll('.dsh-music-settings-btn')].find((b) => b.textContent === '刷新')
      expect(refreshBtn).toBeTruthy()
      act(() => { refreshBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      expect(container.textContent).toContain('b.mp3')
      // 播放范围仍为曲库、tab 未被跳走（rescan 只刷列表，不触发 restorePlayback）
      expect(container.querySelector('.dsh-music-tab.active').textContent).toBe('本地音乐')
    } finally {
      window.fetch = origFetch
    }
  })

  it('loads 我的歌单 in its own sub-tab when logged in', async () => {
    qqLoggedIn = true
    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    const onlineTab = [...container.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === 'QQ音乐')
    act(() => { onlineTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    // 我的歌单 sub-tab → my playlists load lazily
    const mineTab = [...container.querySelectorAll('.dsh-music-qq-viewtab')].find((b) => b.textContent === '我的歌单')
    expect(mineTab).toBeTruthy()
    act(() => { mineTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(container.textContent).toContain('我的收藏')
  })

  it('deletes a user playlist via the 我的歌单 card ✕ button after confirmation', async () => {
    qqLoggedIn = true
    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    const onlineTab = [...container.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === 'QQ音乐')
    act(() => { onlineTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    // 「我的歌单」已自动加载（登录态）→ 找到删除按钮并点击，弹出确认框
    const delBtn = [...container.querySelectorAll('.dsh-music-qq-mine-del')].find((b) => b.title.includes('我的收藏'))
    expect(delBtn).toBeTruthy()
    act(() => { delBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(container.textContent).toContain('删除歌单')
    expect(container.textContent).toContain('我的收藏')
    // 点「删除」确认 → 调用 Host 删除接口，卡片被移除
    const confirmDel = [...document.body.querySelectorAll('.dsh-music-picker.confirm .dsh-music-settings-btn')].find((b) => b.textContent === '删除')
    act(() => { confirmDel.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(delPlaylistCalls).toEqual([{ dirId: 987 }])
    // mine1 已删除，mine2（第二个歌单）仍保留删除按钮
    expect(container.querySelectorAll('.dsh-music-qq-mine-del').length).toBe(1)
    expect(container.textContent).not.toContain('我的收藏')
  })

  it('surfaces an error when deleting a playlist fails, keeping the card', async () => {
    qqLoggedIn = true
    delPlaylistFail = true
    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    const onlineTab = [...container.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === 'QQ音乐')
    act(() => { onlineTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const delBtn = [...container.querySelectorAll('.dsh-music-qq-mine-del')].find((b) => b.title.includes('我的收藏'))
    act(() => { delBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    const confirmDel = [...document.body.querySelectorAll('.dsh-music-picker.confirm .dsh-music-settings-btn')].find((b) => b.textContent === '删除')
    act(() => { confirmDel.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(delPlaylistCalls).toEqual([{ dirId: 987 }])
    // 失败时保留卡片并展示错误（两个歌单都保留）
    expect(container.querySelectorAll('.dsh-music-qq-mine-del').length).toBe(2)
    expect(container.textContent).toContain('删除失败（模拟）')
  })

  it('shows the delete button ONLY on 我的歌单, never on 推荐/分类/搜索 playlists', async () => {
    // Regression: playRow used to receive the Array#map index as its 2nd arg, so in
    // 推荐/分类/搜索 (which call .map(playRow)) every card past the first wrongly got
    // a delete button. The mine flag must be strict `true` (only 我的歌单 passes it).
    qqLoggedIn = true
    // 让搜索歌单返回多条，验证任意非「我的歌单」来源都不出现删除按钮。
    const origFetch = window.fetch
    window.fetch = (u, o) => {
      const url = String(u)
      if (url.includes('/dsh-music/qq/playlist-search')) {
        return Promise.resolve(new Response(JSON.stringify({ ok: true, playlists: [
          { id: '1001', name: '搜索歌单甲', creator: 'UP主', trackCount: 10, source: 'qq' },
          { id: '1002', name: '搜索歌单乙', creator: 'UP主', trackCount: 20, source: 'qq' },
          { id: '1003', name: '搜索歌单丙', creator: 'UP主', trackCount: 30, source: 'qq' },
        ] }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
      }
      return origFetch(u, o)
    }
    try {
      const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
      const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
      const container = document.createElement('div')
      document.body.appendChild(container)
      const root = createRoot(container)
      act(() => { root.render(React.createElement('div', null, bar, panel)) })
      act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      const onlineTab = [...container.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === 'QQ音乐')
      act(() => { onlineTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      // ① 我的歌单：登录自动加载，所有本人创建的歌单都应有删除按钮
      expect(container.querySelectorAll('.dsh-music-qq-mine-del').length).toBe(2)
      // ② 推荐歌单：不应出现任何删除按钮
      const recTab = [...container.querySelectorAll('.dsh-music-qq-viewtab')].find((b) => b.textContent === '推荐歌单')
      act(() => { recTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      expect(container.textContent).toContain('热门推荐')
      expect(container.querySelectorAll('.dsh-music-qq-mine-del').length).toBe(0)
      // ③ 分类歌单：不应出现任何删除按钮
      const categoryTab = [...container.querySelectorAll('.dsh-music-qq-viewtab')].find((b) => b.textContent === '分类歌单')
      act(() => { categoryTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      const catChip = [...container.querySelectorAll('.dsh-music-qq-cat')].find((b) => b.textContent === '国语')
      act(() => { catChip.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      expect(container.textContent).toContain('国语歌单')
      expect(container.querySelectorAll('.dsh-music-qq-mine-del').length).toBe(0)
      // ④ 搜索歌单：多条结果，任意一条都不应出现删除按钮（回归 Array#map index bug）
      const searchTab = [...container.querySelectorAll('.dsh-music-qq-viewtab')].find((b) => b.textContent === '搜索')
      act(() => { searchTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      const input = container.querySelector('.dsh-music-qq-input')
      act(() => {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
        setter.call(input, '周杰伦')
        input.dispatchEvent(new Event('input', { bubbles: true }))
      })
      const searchBtn = [...container.querySelectorAll('.dsh-music-settings-btn')].find((b) => b.textContent === '搜索')
      act(() => { searchBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      // 切到「相关歌单」
      const plTab = [...container.querySelectorAll('.dsh-music-qq-viewtab')].find((b) => b.textContent === '相关歌单')
      act(() => { plTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      expect(container.textContent).toContain('搜索歌单甲')
      expect(container.textContent).toContain('搜索歌单乙')
      expect(container.textContent).toContain('搜索歌单丙')
      expect(container.querySelectorAll('.dsh-music-qq-mine-del').length).toBe(0)
    } finally { window.fetch = origFetch }
  })

  it('does NOT fetch QQ data endpoints when not logged in', async () => {
    // Regression: the QQ panel must treat login as the gate — while logged out,
    // opening the QQ tab issues only the local /status probe (host reads the
    // cookie file), never the data endpoints (categories / my-playlists / playlists).
    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    const onlineTab = [...container.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === 'QQ音乐')
    act(() => { onlineTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    // 未登录：只应请求 /dsh-music/qq/status（本地检测登录态），其余数据接口一律不发
    expect(container.textContent).toContain('QQ 登录') // 登录界面
    const dataEndpoints = ['/dsh-music/qq/my-playlists', '/dsh-music/qq/playlist-categories', '/dsh-music/qq/playlists']
    for (const ep of dataEndpoints) {
      expect(qqFetchLog).not.toContain(ep)
    }
  })

  it('fetches QQ data endpoints automatically once logged in', async () => {
    // When /status reports logged-in, the data endpoints load automatically
    // (categories + my-playlists + recommended) without waiting for a tab click.
    qqLoggedIn = true
    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    const onlineTab = [...container.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === 'QQ音乐')
    act(() => { onlineTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    // 登录后：我的歌单/分类/推荐均已自动请求
    expect(qqFetchLog).toContain('/dsh-music/qq/my-playlists')
    expect(qqFetchLog).toContain('/dsh-music/qq/playlist-categories')
    expect(qqFetchLog).toContain('/dsh-music/qq/playlists')
  })

  it('auto-advances to the next online QQ track when a track ends', async () => {
    // Regression: online (qq scope) used to return [] from activeIds() so step(1)
    // found no next track and playback stopped after one song. The active queue is
    // now kept in store.qqQueue so a finished track advances to the next one.
    const audios = []
    class DispatchAudio extends FakeAudio {
      constructor() { super(); audios.push(this) }
      emit(type) { (this.listeners[type] || []).forEach((fn) => fn({ target: this })) }
    }
    vi.resetModules(); registered = []; lastFilesUrl = null; manifest = baseManifest(); qqLoggedIn = true
    window.__ModuleLoader__ = { load: (def) => { factory = def.factory } }
    vi.stubGlobal('Audio', DispatchAudio)
    vi.stubGlobal('fetch', fetchStub)
    vi.stubGlobal('requestAnimationFrame', () => 0)
    vi.stubGlobal('cancelAnimationFrame', () => {})
    vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '' }))
    vi.stubGlobal('setInterval', () => 0)
    vi.stubGlobal('clearInterval', () => {})
    window.confirm = () => true; window.prompt = () => null
    await import('../lib/client.js')
    const modExports = factory((name) => (name === 'react' ? React : undefined))
    const slots = { inject: (n, cb) => cb(), register: (meta, ef) => { registered.push({ id: meta.id, elementFactory: ef }); return ef } }
    modExports.apply({ get: (k) => (k === 'slots' ? slots : undefined), effect: (fn) => fn() })
    await new Promise((r) => setTimeout(r, 0))
    const audio = audios[0]

    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const onlineTab = [...container.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === 'QQ音乐')
    act(() => { onlineTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    // default tab is 我的歌单 → switch to 推荐歌单
    const recTab = [...container.querySelectorAll('.dsh-music-qq-viewtab')].find((b) => b.textContent === '推荐歌单')
    act(() => { recTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const row = [...container.querySelectorAll('.dsh-music-playlist-card')].find((b) => b.textContent.includes('热门推荐'))
    act(() => { row.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    // queue = [789 告白气球, 790 七里香]; play the first online song
    const song = [...container.querySelectorAll('.dsh-music-track')].find((b) => b.textContent.includes('告白气球'))
    act(() => { song.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(audio.src).toContain('/dsh-music/qq/play/789')
    // the track ends -> auto-advance to the next song in the online queue
    act(() => { audio.emit('ended') })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(audio.src).toContain('/dsh-music/qq/play/790')
  })

  it('auto-skips to the next online song when the current one fails to load', async () => {
    // Regression: a QQ track whose play URL returns an unplayable stream (版权
    // 下架/拿不到地址) used to stop the whole queue with a generic error. It must
    // auto-advance to the next song instead; only a single-song queue stops.
    const audios = []
    class ErrAudio extends FakeAudio {
      constructor() { super(); audios.push(this) }
      emit(type) { (this.listeners[type] || []).forEach((fn) => fn({ target: this })) }
    }
    vi.resetModules(); registered = []; lastFilesUrl = null; manifest = baseManifest(); qqLoggedIn = true
    window.__ModuleLoader__ = { load: (def) => { factory = def.factory } }
    vi.stubGlobal('Audio', ErrAudio)
    vi.stubGlobal('fetch', fetchStub)
    vi.stubGlobal('requestAnimationFrame', () => 0)
    vi.stubGlobal('cancelAnimationFrame', () => {})
    vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '' }))
    vi.stubGlobal('setInterval', () => 0)
    vi.stubGlobal('clearInterval', () => {})
    window.confirm = () => true; window.prompt = () => null
    await import('../lib/client.js')
    const modExports = factory((name) => (name === 'react' ? React : undefined))
    const slots = { inject: (n, cb) => cb(), register: (meta, ef) => { registered.push({ id: meta.id, elementFactory: ef }); return ef } }
    modExports.apply({ get: (k) => (k === 'slots' ? slots : undefined), effect: (fn) => fn() })
    await new Promise((r) => setTimeout(r, 0))
    const audio = audios[0]

    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const onlineTab = [...container.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === 'QQ音乐')
    act(() => { onlineTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const recTab = [...container.querySelectorAll('.dsh-music-qq-viewtab')].find((b) => b.textContent === '推荐歌单')
    act(() => { recTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const row = [...container.querySelectorAll('.dsh-music-playlist-card')].find((b) => b.textContent.includes('热门推荐'))
    act(() => { row.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    // queue = [789 告白气球, 790 七里香]; play the first online song
    const song = [...container.querySelectorAll('.dsh-music-track')].find((b) => b.textContent.includes('告白气球'))
    act(() => { song.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(audio.src).toContain('/dsh-music/qq/play/789')
    // 789 加载失败（版权下架）→ 自动跳到下一首 790
    act(() => { audio.emit('error') })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(audio.src).toContain('/dsh-music/qq/play/790')
  })

  it('resets the skip counter when a skipped song plays successfully', async () => {
    // Regression: after auto-skipping a bad track (790), if the next track (789)
    // plays fine the consecutive-error counter must reset. Without the reset, a
    // 好歌↔坏歌 loop triples the count over three rounds and trips the
    // whole-queue-stop guard, halting playback even though 789 plays fine.
    const audios = []
    class ResetAudio extends FakeAudio {
      constructor() { super(); audios.push(this) }
      emit(type) { (this.listeners[type] || []).forEach((fn) => fn({ target: this })) }
    }
    vi.resetModules(); registered = []; lastFilesUrl = null; manifest = baseManifest(); qqLoggedIn = true
    window.__ModuleLoader__ = { load: (def) => { factory = def.factory } }
    vi.stubGlobal('Audio', ResetAudio)
    vi.stubGlobal('fetch', fetchStub)
    vi.stubGlobal('requestAnimationFrame', () => 0)
    vi.stubGlobal('cancelAnimationFrame', () => {})
    vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '' }))
    vi.stubGlobal('setInterval', () => 0)
    vi.stubGlobal('clearInterval', () => {})
    window.confirm = () => true; window.prompt = () => null
    await import('../lib/client.js')
    const modExports = factory((name) => (name === 'react' ? React : undefined))
    const slots = { inject: (n, cb) => cb(), register: (meta, ef) => { registered.push({ id: meta.id, elementFactory: ef }); return ef } }
    modExports.apply({ get: (k) => (k === 'slots' ? slots : undefined), effect: (fn) => fn() })
    await new Promise((r) => setTimeout(r, 0))
    const audio = audios[0]

    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const onlineTab = [...container.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === 'QQ音乐')
    act(() => { onlineTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const recTab = [...container.querySelectorAll('.dsh-music-qq-viewtab')].find((b) => b.textContent === '推荐歌单')
    act(() => { recTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const row = [...container.querySelectorAll('.dsh-music-playlist-card')].find((b) => b.textContent.includes('热门推荐'))
    act(() => { row.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    // 播放 789（当作"好歌"）
    const song = [...container.querySelectorAll('.dsh-music-track')].find((b) => b.textContent.includes('告白气球'))
    act(() => { song.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(audio.src).toContain('/dsh-music/qq/play/789')
    // 循环三轮「789 播完→790 坏→跳过→789 播放成功」
    for (let round = 0; round < 3; round++) {
      act(() => { audio.emit('ended') })          // 789 播完 → 切到 790
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      expect(audio.src).toContain('/dsh-music/qq/play/790')
      act(() => { audio.emit('error') })          // 790 失败 → 跳过
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      expect(audio.src).toContain('/dsh-music/qq/play/789')
      act(() => { audio.emit('play') })           // 789 成功播放 → 计数清零
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    }
    // 三轮都正常跳过、从未误报整列失败；最终停在 789 且无错误
    expect(audio.src).toContain('/dsh-music/qq/play/789')
    expect(container.textContent).not.toContain('音频加载或解码失败')
  })

  it('stops with an error when the only online song fails to load', async () => {
    // A single-song QQ queue that fails must NOT loop forever: it stops and
    // surfaces the error, so the user knows why playback halted.
    const audios = []
    class SoloAudio extends FakeAudio {
      constructor() { super(); audios.push(this) }
      emit(type) { (this.listeners[type] || []).forEach((fn) => fn({ target: this })) }
    }
    vi.resetModules(); registered = []; lastFilesUrl = null; manifest = baseManifest(); qqLoggedIn = true
    window.__ModuleLoader__ = { load: (def) => { factory = def.factory } }
    vi.stubGlobal('Audio', SoloAudio)
    vi.stubGlobal('fetch', fetchStub)
    vi.stubGlobal('requestAnimationFrame', () => 0)
    vi.stubGlobal('cancelAnimationFrame', () => {})
    vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '' }))
    vi.stubGlobal('setInterval', () => 0)
    vi.stubGlobal('clearInterval', () => {})
    window.confirm = () => true; window.prompt = () => null
    await import('../lib/client.js')
    const modExports = factory((name) => (name === 'react' ? React : undefined))
    const slots = { inject: (n, cb) => cb(), register: (meta, ef) => { registered.push({ id: meta.id, elementFactory: ef }); return ef } }
    modExports.apply({ get: (k) => (k === 'slots' ? slots : undefined), effect: (fn) => fn() })
    await new Promise((r) => setTimeout(r, 0))
    const audio = audios[0]

    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    // 只播单曲（queue 只有这一首）：搜索点一首歌
    const onlineTab = [...container.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === 'QQ音乐')
    act(() => { onlineTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const searchTab = [...container.querySelectorAll('.dsh-music-qq-viewtab')].find((b) => b.textContent === '搜索')
    act(() => { searchTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const searchInput = container.querySelector('.dsh-music-qq-input')
    expect(searchInput).toBeTruthy()
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(searchInput, '晴天')
      searchInput.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const searchBtn = [...container.querySelectorAll('.dsh-music-settings-btn')].find((b) => b.textContent === '搜索')
    act(() => { searchBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const srow = [...container.querySelectorAll('.dsh-music-track')].find((b) => b.textContent.includes('晴天'))
    expect(srow).toBeTruthy()
    act(() => { srow.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(audio.src).toContain('/dsh-music/qq/play/123')
    // 单曲失败 → 不循环跳歌，停止并报错
    act(() => { audio.emit('error') })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(audio.src).toContain('/dsh-music/qq/play/123')
    expect(container.textContent).toContain('音频加载或解码失败')
  })

  it('stops after trying the whole queue when every online song fails', async () => {
    // Guard against an infinite skip loop: a 2-song queue where BOTH fail must
    // advance through the whole queue (789→790→wrap), then stop with the error
    // instead of cycling forever.
    const audios = []
    class AllBadAudio extends FakeAudio {
      constructor() { super(); audios.push(this) }
      emit(type) { (this.listeners[type] || []).forEach((fn) => fn({ target: this })) }
    }
    vi.resetModules(); registered = []; lastFilesUrl = null; manifest = baseManifest(); qqLoggedIn = true
    window.__ModuleLoader__ = { load: (def) => { factory = def.factory } }
    vi.stubGlobal('Audio', AllBadAudio)
    vi.stubGlobal('fetch', fetchStub)
    vi.stubGlobal('requestAnimationFrame', () => 0)
    vi.stubGlobal('cancelAnimationFrame', () => {})
    vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '' }))
    vi.stubGlobal('setInterval', () => 0)
    vi.stubGlobal('clearInterval', () => {})
    window.confirm = () => true; window.prompt = () => null
    await import('../lib/client.js')
    const modExports = factory((name) => (name === 'react' ? React : undefined))
    const slots = { inject: (n, cb) => cb(), register: (meta, ef) => { registered.push({ id: meta.id, elementFactory: ef }); return ef } }
    modExports.apply({ get: (k) => (k === 'slots' ? slots : undefined), effect: (fn) => fn() })
    await new Promise((r) => setTimeout(r, 0))
    const audio = audios[0]

    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const onlineTab = [...container.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === 'QQ音乐')
    act(() => { onlineTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const recTab = [...container.querySelectorAll('.dsh-music-qq-viewtab')].find((b) => b.textContent === '推荐歌单')
    act(() => { recTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const row = [...container.querySelectorAll('.dsh-music-playlist-card')].find((b) => b.textContent.includes('热门推荐'))
    act(() => { row.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const song = [...container.querySelectorAll('.dsh-music-track')].find((b) => b.textContent.includes('告白气球'))
    act(() => { song.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(audio.src).toContain('/dsh-music/qq/play/789')
    // 789 失败 → 跳到 790
    act(() => { audio.emit('error') })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(audio.src).toContain('/dsh-music/qq/play/790')
    // 790 也失败 → 队列走完，回绕回 789（这一圈已试完）
    act(() => { audio.emit('error') })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    // 789 再失败 → 已达队列长度，停止并报错（不再循环）
    act(() => { audio.emit('error') })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(container.textContent).toContain('音频加载或解码失败')
    // 停止后即使再报错也不再跳到别处（src 不再变化）
    const srcAfterStop = audio.src
    act(() => { audio.emit('error') })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(audio.src).toBe(srcAfterStop)
  })

  it('resumes a restored online QQ track when play is clicked after refresh', async () => {
    // Regression: after a refresh restore the QQ track is remembered, but audio.src
    // was empty so clicking play had nothing to load. togglePlay must reload the
    // online stream URL for a qq: current track.
    const audios = []
    class DispatchAudio extends FakeAudio {
      constructor() { super(); audios.push(this) }
    }
    vi.resetModules(); registered = []; lastFilesUrl = null; manifest = baseManifest(); qqLoggedIn = true
    window.__ModuleLoader__ = { load: (def) => { factory = def.factory } }
    vi.stubGlobal('Audio', DispatchAudio)
    vi.stubGlobal('fetch', fetchStub)
    vi.stubGlobal('requestAnimationFrame', () => 0)
    vi.stubGlobal('cancelAnimationFrame', () => {})
    vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '' }))
    vi.stubGlobal('setInterval', () => 0)
    vi.stubGlobal('clearInterval', () => {})
    window.confirm = () => true; window.prompt = () => null
    await import('../lib/client.js')
    const modExports = factory((name) => (name === 'react' ? React : undefined))
    const slots = { inject: (n, cb) => cb(), register: (meta, ef) => { registered.push({ id: meta.id, elementFactory: ef }); return ef } }
    modExports.apply({ get: (k) => (k === 'slots' ? slots : undefined), effect: (fn) => fn() })
    await new Promise((r) => setTimeout(r, 0))
    const audio = audios[0]
    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const onlineTab = [...container.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === 'QQ音乐')
    act(() => { onlineTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    // default tab is 我的歌单 → switch to 推荐歌单
    const recTab = [...container.querySelectorAll('.dsh-music-qq-viewtab')].find((b) => b.textContent === '推荐歌单')
    act(() => { recTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const row = [...container.querySelectorAll('.dsh-music-playlist-card')].find((b) => b.textContent.includes('热门推荐'))
    act(() => { row.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const song = [...container.querySelectorAll('.dsh-music-track')].find((b) => b.textContent.includes('告白气球'))
    act(() => { song.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(audio.src).toContain('/dsh-music/qq/play/789')
    // simulate a refresh-restore: fresh audio element, current track still the QQ one
    audio.src = ''
    audio.paused = true
    // click the play button -> togglePlay must reload the online stream URL and play
    const playBtn = [...container.querySelectorAll('.dsh-music-bar-btn')].find((b) => b.title === '播放/暂停')
    expect(playBtn).toBeTruthy()
    act(() => { playBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(audio.src).toContain('/dsh-music/qq/play/789')
  })

  it('starts the QQ login poll after generating a QR (ref-based, no stale closure)', async () => {
    // Regression: schedulePoll/pollLogin previously read qrKey/loginMode from a stale
    // React render closure, so after setQrKey(d.key) the poll saw an empty key and NEVER
    // fired — the modal stayed at the scan screen forever. This asserts the poll is issued.
    const checkCalls = []
    const baseFetch = globalThis.fetch
    const fetcher = vi.fn((url, opts) => {
      const u = String(url)
      if (u === '/dsh-music/qq/login/start') return jsonRes({ ok: true, key: 'type=wx&uuid=U&state=S', image: 'data:image/jpeg;base64,xxx', mode: 'wx' })
      if (u.includes('/dsh-music/qq/login/check')) { checkCalls.push(u); return jsonRes({ ok: true, status: 'waiting', message: '等待扫码中', extra: {} }) }
      return baseFetch(u, opts)
    })
    vi.stubGlobal('fetch', fetcher)
    vi.useFakeTimers()
    try {
      const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
      const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
      const container = document.createElement('div')
      document.body.appendChild(container)
      const root = createRoot(container)
      act(() => { root.render(React.createElement('div', null, bar, panel)) })
      act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      const onlineTab = [...container.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === 'QQ音乐')
      act(() => { onlineTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await Promise.resolve() })
      const wxBtn = [...container.querySelectorAll('.dsh-music-qq-login-btn')].find((b) => b.textContent === '微信登录')
      expect(wxBtn).toBeTruthy()
      act(() => { wxBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      // flush the async /start POST into the refs, then fire the 1.5s poll timer
      await act(async () => { await Promise.resolve(); await Promise.resolve() })
      act(() => { vi.advanceTimersByTime(2000) })
      await act(async () => { await Promise.resolve(); await Promise.resolve() })
      expect(checkCalls.length).toBeGreaterThan(0)
      expect(checkCalls[0]).toContain('/dsh-music/qq/login/check?key=')
    } finally {
      vi.useRealTimers()
      vi.unstubAllGlobals()
    }
  })

  it('lands on the main UI after QR login even if a playlist layer was persisted', async () => {
    // Regression: after login the panel used to restore the previously-persisted
    // playlist layer instead of showing the main UI. Login success must reset to main.
    // The persisted layer now lives in the Host prefs; seed it before boot.
    prefsServer = { 'dsh-music-qq-ui': JSON.stringify({ layer: 'playlist', plId: '', plName: '' }) }
    vi.resetModules(); registered = []; prefsPosts = []; lastFilesUrl = null
    await bootClient()
    const baseFetch = globalThis.fetch
    const fetcher = vi.fn((url, opts) => {
      const u = String(url)
      if (u === '/dsh-music/qq/login/start') return jsonRes({ ok: true, key: 'type=wx&uuid=U&state=S', image: 'data:image/jpeg;base64,xxx', mode: 'wx' })
      if (u.includes('/dsh-music/qq/login/check')) return jsonRes({ ok: true, status: 'success', uin: '123456', nickname: '我' })
      return baseFetch(u, opts)
    })
    vi.stubGlobal('fetch', fetcher)
    vi.useFakeTimers()
    try {
      const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
      const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
      const container = document.createElement('div')
      document.body.appendChild(container)
      const root = createRoot(container)
      act(() => { root.render(React.createElement('div', null, bar, panel)) })
      act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      const onlineTab = [...container.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === 'QQ音乐')
      act(() => { onlineTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await Promise.resolve(); await Promise.resolve() })
      // start the QR login
      const qqBtn = [...container.querySelectorAll('.dsh-music-qq-login-btn')].find((b) => b.textContent === 'QQ 登录')
      act(() => { qqBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      // flush /start, then fire the 1.5s poll which returns success
      await act(async () => { await Promise.resolve(); await Promise.resolve() })
      act(() => { vi.advanceTimersByTime(2000) })
      await act(async () => { await Promise.resolve(); await Promise.resolve() })
      // should be on the MAIN UI now, not the playlist layer
      expect(container.textContent).toContain('推荐歌单') // a main-UI sub-tab
      expect([...container.querySelectorAll('.dsh-music-settings-btn')].some((b) => b.textContent === '← 返回')).toBe(false) // not the playlist layer
      // login success reset the persisted layer to 'main'; let the debounced
      // flush (scheduled before fake timers were enabled) complete in real time
      vi.useRealTimers()
      await act(async () => { await new Promise((r) => setTimeout(r, 950)) })
      expect(JSON.parse(prefsServer['dsh-music-qq-ui']).layer).toBe('main')
    } finally {
      vi.useRealTimers()
      vi.unstubAllGlobals()
    }
  })

  it('preserves the QQ playlist layer when switching tabs within a session', async () => {
    // Regression: QQOnlinePanel used to unmount on tab switch; on remount it restored
    // the persisted 'playlist' layer, so switching away and back yanked the user
    // around. With the panel kept mounted (CSS-hidden), layer is component state
    // that survives tab switches: entering the playlist layer and switching away
    // then back must KEEP the user in that layer.
    qqLoggedIn = true
    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    const onlineTab = [...container.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === 'QQ音乐')
    act(() => { onlineTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    // enter the playlist layer once -> persisted as 'playlist' (flushed on debounce)
    const enterPl = [...container.querySelectorAll('.dsh-music-settings-btn')].find((b) => b.textContent === '播放列表')
    act(() => { enterPl.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    await act(async () => { await new Promise((r) => setTimeout(r, 950)) })
    expect(JSON.parse(prefsServer['dsh-music-qq-ui']).layer).toBe('playlist')
    // switch to 本地音乐 tab (QQOnlinePanel stays mounted, just hidden)
    const musicTab = [...container.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === '本地音乐')
    act(() => { musicTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    // switch back to QQ音乐 tab -> the playlist layer must be PRESERVED
    const qqTab = [...container.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === 'QQ音乐')
    act(() => { qqTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect([...container.querySelectorAll('.dsh-music-settings-btn')].some((b) => b.textContent === '← 返回')).toBe(true) // still in the playlist layer
  })

  it('shows a genuine autoplay-block error exactly once (no duplicate in the settings block)', async () => {
    // A REAL autoplay block (NotAllowedError) must still surface the message —
    // but only once, in the panel list area, never duplicated in the settings block.
    const audios = []
    class BlockedAudio extends FakeAudio {
      constructor() { super(); audios.push(this) }
      play() {
        this.paused = false
        return Promise.reject(Object.assign(new Error("play() failed because the user didn't interact with the document first: https://goo.gl/xX8pDD"), { name: 'NotAllowedError' }))
      }
    }
    vi.resetModules()
    registered = []
    lastFilesUrl = null
    manifest = baseManifest()
    window.__ModuleLoader__ = { load: (def) => { factory = def.factory } }
    vi.stubGlobal('Audio', BlockedAudio)
    vi.stubGlobal('fetch', fetchStub)
    vi.stubGlobal('requestAnimationFrame', () => 0)
    vi.stubGlobal('cancelAnimationFrame', () => {})
    vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '' }))
    vi.stubGlobal('setInterval', () => 0)
    vi.stubGlobal('clearInterval', () => {})
    window.confirm = () => true
    window.prompt = () => null
    await import('../lib/client.js')
    const modExports = factory((name) => (name === 'react' ? React : undefined))
    const slots = {
      inject: (name, cb) => { cb() },
      register: (meta, elementFactory) => { registered.push({ id: meta.id, elementFactory }); return elementFactory },
    }
    modExports.apply({ get: (k) => (k === 'slots' ? slots : undefined), effect: (fn) => fn() })
    await new Promise((r) => setTimeout(r, 0))

    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    const trackBtn = container.querySelector('.dsh-music-track')
    expect(trackBtn).toBeTruthy()

    act(() => { trackBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 })) })
    // flush the rejected play() promise -> error state -> re-render
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })

    // the autoplay-block message IS shown (genuine block), exactly once.
    // Note: with all tabs kept mounted (CSS-hidden), the hidden AI讲书 pane may
    // render its own unrelated error (e.g. 未配置xiaomi提供方), so count only
    // the errors whose text is the autoplay-block message.
    const blockErrors = [...container.querySelectorAll('.dsh-music-error')].filter((el) => el.textContent.includes('浏览器拦截'))
    expect(blockErrors.length).toBe(1)
    expect(blockErrors[0].textContent).toContain('自动播放')
  })

  it('keeps the QQ playlist layer when the panel is closed and reopened', async () => {
    // Regression: closing the panel used to unmount it (return null), wiping the
    // QQ panel's component state. With the panel kept mounted (CSS-hidden), the
    // playlist layer must survive a close + reopen cycle.
    qqLoggedIn = true
    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    const onlineTab = [...container.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === 'QQ音乐')
    act(() => { onlineTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    // enter the playlist layer
    const enterPl = [...container.querySelectorAll('.dsh-music-settings-btn')].find((b) => b.textContent === '播放列表')
    expect(enterPl).toBeTruthy()
    act(() => { enterPl.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect([...container.querySelectorAll('.dsh-music-settings-btn')].some((b) => b.textContent === '← 返回')).toBe(true)
    // close the panel (CSS-hide, not unmount)
    act(() => { container.querySelector('button[title="关闭"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    // reopen -> still in the QQ playlist layer (component state preserved)
    act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const qqTab = [...container.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === 'QQ音乐')
    act(() => { qqTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect([...container.querySelectorAll('.dsh-music-settings-btn')].some((b) => b.textContent === '← 返回')).toBe(true)
  })

  it('renders the 系统配置 tab with lyric/spectrum/progress toggles defaulting on and persists changes', async () => {
    // Fresh boot: no prefs set -> both toggles default ON.
    prefsServer = {}; vi.resetModules(); registered = []; prefsPosts = []; lastFilesUrl = null
    await bootClient()
    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })

    // switch to the new 系统配置 tab
    const configTab = [...container.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === '系统配置')
    expect(configTab).toBeTruthy()
    act(() => { configTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })

    // five toggle rows (歌词显示 / 频谱显示 / 音质徽章显示 / 进度条显示 / 播放条背景显示)，默认全开；
    // 跑马灯/边缘渐隐是内置行为，不再提供开关。
    const toggles = [...container.querySelectorAll('.dsh-music-toggle')]
    expect(toggles.length).toBe(5)
    expect(toggles[0].getAttribute('aria-checked')).toBe('true') // 歌词显示
    expect(toggles[1].getAttribute('aria-checked')).toBe('true') // 频谱显示
    expect(toggles[2].getAttribute('aria-checked')).toBe('true') // 音质徽章显示
    expect(toggles[3].getAttribute('aria-checked')).toBe('true') // 进度条显示
    expect(toggles[4].getAttribute('aria-checked')).toBe('true') // 播放条背景显示

    // 歌词动效分段选择器：四个选项，默认 none（无动效）选中（它排在频谱样式选择器之前）
    const segBtns = [...container.querySelectorAll('.dsh-music-config-seg-btn')]
    expect(segBtns.slice(0, 4).map((b) => b.textContent)).toEqual(['无动效', '上滑淡入', '模糊浮入', '卡拉OK'])
    expect(segBtns.slice(0, 4).findIndex((b) => b.classList.contains('on'))).toBe(0)
    act(() => { segBtns[3].dispatchEvent(new MouseEvent('click', { bubbles: true })) }) // 卡拉OK
    await act(async () => { await new Promise((r) => setTimeout(r, 950)) }) // debounce flush
    const fxPost = prefsPosts.find((p) => p.prefs && p.prefs['dsh-music-lyric-fx'])
    expect(fxPost).toBeTruthy()
    expect(fxPost.prefs['dsh-music-lyric-fx']).toBe('karaoke')

    // 频谱样式分段选择器：柱状图/波形图，默认「柱状图」选中；切到「波形图」并持久化。
    expect(segBtns.slice(4).map((b) => b.textContent)).toEqual(['柱状图', '波形图'])
    expect(segBtns.findIndex((b) => b.textContent === '柱状图' && b.classList.contains('on'))).toBe(4)
    act(() => { segBtns[5].dispatchEvent(new MouseEvent('click', { bubbles: true })) }) // 波形图
    await act(async () => { await new Promise((r) => setTimeout(r, 950)) }) // debounce flush
    const vizPost = prefsPosts.find((p) => p.prefs && p.prefs['dsh-music-viz-mode'])
    expect(vizPost).toBeTruthy()
    expect(vizPost.prefs['dsh-music-viz-mode']).toBe('wave')
    expect(prefsServer['dsh-music-viz-mode']).toBe('wave')

    // turn OFF the lyric toggle
    act(() => { toggles[0].dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    // turn OFF the progress toggle
    act(() => { toggles[3].dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    // turn OFF the quality toggle
    act(() => { toggles[2].dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    // turn OFF the bar-bg toggle
    act(() => { toggles[4].dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 950)) }) // debounce flush
    const lyricPost = prefsPosts.find((p) => p.prefs && p.prefs['dsh-music-show-lyric'])
    expect(lyricPost).toBeTruthy()
    expect(lyricPost.prefs['dsh-music-show-lyric']).toBe('0')
    expect(prefsServer['dsh-music-show-lyric']).toBe('0')
    const progressPost = prefsPosts.find((p) => p.prefs && p.prefs['dsh-music-show-progress'])
    expect(progressPost).toBeTruthy()
    expect(progressPost.prefs['dsh-music-show-progress']).toBe('0')
    expect(prefsServer['dsh-music-show-progress']).toBe('0')
    const qualityPost = prefsPosts.find((p) => p.prefs && p.prefs['dsh-music-show-quality'])
    expect(qualityPost).toBeTruthy()
    expect(qualityPost.prefs['dsh-music-show-quality']).toBe('0')
    expect(prefsServer['dsh-music-show-quality']).toBe('0')
    const barBgPost = prefsPosts.find((p) => p.prefs && p.prefs['dsh-music-show-bar-bg'])
    expect(barBgPost).toBeTruthy()
    expect(barBgPost.prefs['dsh-music-show-bar-bg']).toBe('0')
    expect(prefsServer['dsh-music-show-bar-bg']).toBe('0')

    // 歌词显示关闭 → 动效配置行联动隐藏（频谱样式选择器仍在，showViz 为开）；重新打开后恢复，
    // 且保留刚才选的 karaoke。
    expect(container.querySelectorAll('.dsh-music-config-seg-btn').length).toBe(2) // 仅频谱样式
    act(() => { toggles[0].dispatchEvent(new MouseEvent('click', { bubbles: true })) }) // lyric ON
    const segRestored = [...container.querySelectorAll('.dsh-music-config-seg-btn')]
    expect(segRestored.length).toBe(6)
    expect(segRestored.findIndex((b) => b.classList.contains('on'))).toBe(3) // karaoke remembered
    act(() => { toggles[0].dispatchEvent(new MouseEvent('click', { bubbles: true })) }) // OFF again

    // restart: the saved OFF value must be restored (not defaulted back to on)
    prefsServer = { ...prefsServer, 'dsh-music-show-lyric': '0', 'dsh-music-show-viz': '1', 'dsh-music-show-progress': '0', 'dsh-music-show-quality': '0', 'dsh-music-show-bar-bg': '0' }
    vi.resetModules(); registered = []; prefsPosts = []; lastFilesUrl = null
    await bootClient()
    const panel2 = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const bar2 = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const container2 = document.createElement('div')
    document.body.appendChild(container2)
    const root2 = createRoot(container2)
    act(() => { root2.render(React.createElement('div', null, bar2, panel2)) })
    act(() => { container2.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    const configTab2 = [...container2.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === '系统配置')
    act(() => { configTab2.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const toggles2 = [...container2.querySelectorAll('.dsh-music-toggle')]
    expect(toggles2[0].getAttribute('aria-checked')).toBe('false') // lyric restored OFF
    expect(toggles2[1].getAttribute('aria-checked')).toBe('true')  // viz restored ON
    expect(toggles2[2].getAttribute('aria-checked')).toBe('false') // quality restored OFF
    expect(toggles2[3].getAttribute('aria-checked')).toBe('false') // progress restored OFF
    expect(toggles2[4].getAttribute('aria-checked')).toBe('false') // bar-bg restored OFF
    // 歌词显示恢复为 OFF → 动效配置行随之隐藏；重新打开歌词后出现，且跨重启
    // 恢复了之前选择的 karaoke。
    const segBtns2 = [...container2.querySelectorAll('.dsh-music-config-seg-btn')]
    expect(segBtns2.length).toBe(2) // 仅频谱样式（showViz=ON，lyric=OFF）
    act(() => { toggles2[0].dispatchEvent(new MouseEvent('click', { bubbles: true })) }) // lyric ON
    const segShown2 = [...container2.querySelectorAll('.dsh-music-config-seg-btn')]
    expect(segShown2.length).toBe(6)
    expect(segShown2.findIndex((b) => b.classList.contains('on'))).toBe(3) // karaoke restored
    // 频谱样式也在跨重启后恢复为之前选择的「波形图」。
    expect(segShown2.findIndex((b) => b.textContent === '波形图' && b.classList.contains('on'))).toBe(5)
  })

  it('renders the 沉浸感 slider defaulting to 50% and persists/restores a custom value', async () => {
    // default: immerse slider present at 50%
    prefsServer = {}; vi.resetModules(); registered = []; prefsPosts = []; lastFilesUrl = null
    await bootClient()
    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    const configTab = [...container.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === '系统配置')
    act(() => { configTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })

    const range = container.querySelector('.dsh-music-config-range')
    expect(range).toBeTruthy()
    expect(Number(range.value)).toBe(50)
    expect(container.querySelector('.dsh-music-config-val').textContent).toBe('50%')

    // default 50% 沉浸 -> bar opacity var is 1 - 0.5 = 0.5 (半透明)
    const barEl = container.querySelector('.dsh-music-bar')
    expect(Number(barEl.style.getPropertyValue('--dsh-music-immerse'))).toBeCloseTo(0.5, 5)

    // set it to 20% -> persists 0.2 to the Host (React onChange fires on 'input')
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(range, '20')
      range.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => { await new Promise((r) => setTimeout(r, 950)) }) // debounce flush
    const immersePost = prefsPosts.find((p) => p.prefs && p.prefs['dsh-music-immerse'])
    expect(immersePost).toBeTruthy()
    expect(Number(immersePost.prefs['dsh-music-immerse'])).toBeCloseTo(0.2, 5)
    expect(Number(prefsServer['dsh-music-immerse'])).toBeCloseTo(0.2, 5)
    // 20% 沉浸 -> opacity 1 - 0.2 = 0.8（趋向不透明，方向正确）
    expect(Number(barEl.style.getPropertyValue('--dsh-music-immerse'))).toBeCloseTo(0.8, 5)

    // restart: the saved 0.2 must be restored (slider shows 20%)
    prefsServer = { ...prefsServer, 'dsh-music-immerse': '0.2' }
    vi.resetModules(); registered = []; prefsPosts = []; lastFilesUrl = null
    await bootClient()
    const panel2 = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const bar2 = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const container2 = document.createElement('div')
    document.body.appendChild(container2)
    const root2 = createRoot(container2)
    act(() => { root2.render(React.createElement('div', null, bar2, panel2)) })
    act(() => { container2.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    const configTab2 = [...container2.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === '系统配置')
    act(() => { configTab2.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const range2 = container2.querySelector('.dsh-music-config-range')
    expect(Number(range2.value)).toBe(20)
    expect(container2.querySelector('.dsh-music-config-val').textContent).toBe('20%')
  })
})
