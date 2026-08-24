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
// records the last /dsh-music/files path requested (to assert the initial dir)
let lastFilesUrl = null
// test hook: sections served for /dsh-music/book/*/meta (set before bootClient so
// the refresh-restore path — which fetches meta during load — sees them too)
let bookMetaSections = []
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
// test hook: /dsh-music/qq/lyric?songmid= response (QQ lyric + optional trans).
let qqLyricFixture = null
async function fetchStub(url, opts) {
  const u = String(url)
  const o = opts || {}
  if (String(u).startsWith('/dsh-music/qq/')) qqFetchLog.push(u.split('?')[0])
  if (u.startsWith('/dsh-music/lyric?path=')) {
    return jsonRes(lyricFixture || { ok: false, hasLrc: false })
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
    return jsonRes({ id: 'b1', name: '测试小说', total: 25, title: '测试小说', author: '佚名', sections: bookMetaSections })
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
  localStorage.clear()
  lastFilesUrl = null
  bookMetaSections = []
  qqLoggedIn = false
  favCalls = []
  delPlaylistCalls = []
  delPlaylistFail = false
  qqFetchLog = []
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

  it('slides the right-side control buttons in/out on bar hover with a 1s slide-out delay', async () => {
    // Regression: the bar's right-side controls (heart/prev/play/next/stop/mode/
    // volume/panel) must be hidden by default and slide in on mouseenter, slide
    // out on mouseleave with a 1s delay (prevents accidental hide on a quick
    // mouse-out) — while the time text stays visible.
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
    // 默认隐藏：无 .on，时间仍在
    expect(controls.classList.contains('on')).toBe(false)
    expect(container.textContent).toContain('a.mp3')
    // 用假定时器控制 1s 滑出延迟。
    vi.useFakeTimers()
    try {
      // 鼠标进入播放条 → 控制按钮滑入（加 .on）。React 的 onMouseEnter/onMouseLeave
      // 由原生 mouseover/mouseout 事件驱动（relatedTarget 为空 = 从外部进入/离开）。
      act(() => { barEl.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })) })
      expect(controls.classList.contains('on')).toBe(true)
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
    vi.useFakeTimers()
    try {
      // 鼠标移入 → 立即不透明（去 dimmed），控件组随之滑入
      act(() => { barEl.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })) })
      expect(barEl.classList.contains('dimmed')).toBe(false)
      expect(controls.classList.contains('on')).toBe(true)
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

  it('draws a real precomputed FFT spectrum (8 bars) on the 46px canvas from the decoded track', async () => {
    // The spectrum is computed offline (real FFT per 50ms window) during decodeAudioData
    // and drawn as 8 log-spaced bars following currentTime. It must work WITHOUT touching
    // the Web Audio output graph — the AnalyserNode routing approach broke this environment's
    // Chromium media pipeline (getTopURL TypeError). FakeXHR delivers the arraybuffer, the
    // fake AudioContext decodes it into a 440Hz sine, and a rAF tick must draw 8 bars.
    class FakeXHR {
      constructor() { this.response = new ArrayBuffer(1) }
      open() {}
      send() { if (typeof this.onload === 'function') this.onload() }
    }
    class FakeAudioContext {
      constructor() { this.state = 'running' }
      decodeAudioData() {
        const sr = 8000
        const ch = new Float32Array(sr)
        for (let i = 0; i < sr; i++) ch[i] = 0.6 * Math.sin((2 * Math.PI * 440 * i) / sr)
        return Promise.resolve({ sampleRate: sr, duration: 1, numberOfChannels: 1, getChannelData: () => ch })
      }
      close() { this.state = 'closed' }
    }
    // FakeAudio.play() sets paused=false but never fires 'play' — subclass to dispatch it
    // so s.playing becomes true and the viz canvas actually mounts.
    class PlayAudio extends FakeAudio {
      play() { this.paused = false; for (const fn of (this.listeners.play || [])) fn(); return Promise.resolve() }
    }
    const rects = []
    const fakeCtx = {
      clearRect: () => {},
      fillRect: (x, y, w, h) => { rects.push({ x, y, w, h }) },
      fillStyle: '',
    }
    vi.resetModules(); registered = []; localStorage.clear(); lastFilesUrl = null; manifest = baseManifest()
    window.__ModuleLoader__ = { load: (def) => { factory = def.factory } }
    let rafCb = null
    vi.stubGlobal('Audio', PlayAudio)
    vi.stubGlobal('AudioContext', FakeAudioContext)
    vi.stubGlobal('XMLHttpRequest', FakeXHR)
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
      // playing -> the 46px viz canvas is mounted
      const canvas = container.querySelector('.dsh-music-viz')
      expect(canvas).toBeTruthy()
      expect(canvas.width).toBe(46)
      // the decode populated the per-window FFT bands; a rAF tick draws 8 bars
      // (plus optional 2px peak caps at the top — count only the bottom-anchored bars)
      rects.length = 0
      act(() => { rafCb() })
      const bottom = canvas.height - 1
      const bars = rects.filter((r) => r.y + r.h === bottom)
      expect(bars.length).toBe(8)
      expect(bars.every((r) => r.h >= 2)).toBe(true)
      expect(fakeCtx.fillStyle).toBe('#2f9e6e')
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
    // default: no inline geometry (CSS 380px / auto height)
    expect(panelEl.style.width).toBe('')
    const pointer = (type, x, y) => {
      const ev = new Event(type, { bubbles: true })
      ev.clientX = x; ev.clientY = y; ev.button = 0; ev.pointerId = 1
      return ev
    }
    // drag the corner handle 100px right and 150px down
    act(() => { handle.dispatchEvent(pointer('pointerdown', 800, 600)) })
    act(() => { handle.dispatchEvent(pointer('pointermove', 900, 750)) })
    expect(parseInt(panelEl.style.width, 10)).toBe(560)   // 460 + 100
    expect(parseInt(panelEl.style.height, 10)).toBeGreaterThanOrEqual(200) // clamped min
    expect(panelEl.style.maxHeight).toBe('none') // explicit height wins over 72vh
    const saved = JSON.parse(localStorage.getItem('dsh-music-panel-pos'))
    expect(saved).toMatchObject({ w: 560 })
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
    localStorage.clear()
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
    localStorage.setItem('dsh-music-books-playback', JSON.stringify({
      '测试小说.txt': { from: 10, base: 300, pos: 3, total: 25, ts: 999999999 },
    }))
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
    // the section badge shows the restored chapter without any play interaction
    const badge = container.querySelector('.dsh-music-bar-section')
    expect(badge).toBeTruthy()
    expect(badge.textContent).toContain('第三章 转')
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
    localStorage.clear()
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
    expect(container.querySelector('.dsh-music-qq-input')).toBeNull()
    expect(container.querySelector('.dsh-music-qq-viewtabs')).toBeNull()
    // both login buttons are the enlarged login-btn style and carry a risk disclaimer
    const btns = [...container.querySelectorAll('.dsh-music-qq-login-btn')]
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
    expect(JSON.parse(localStorage.getItem('dsh-music-qq-history'))).toContain('周杰伦')
    // focus the input again → history dropdown appears with the keyword
    act(() => { input.dispatchEvent(new Event('focusin', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const histItems = [...container.querySelectorAll('.dsh-music-qq-hist-item')]
    expect(histItems.some((b) => b.textContent === '周杰伦')).toBe(true)
    // clicking a history item fills the box and runs a new search
    const item = histItems.find((b) => b.textContent === '周杰伦')
    act(() => { item.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(container.textContent).toContain('晴天')
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
    expect(JSON.parse(localStorage.getItem('dsh-music-qq-ui')).layer).toBe('playlist')
    // 返回主 UI
    act(() => { back.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(container.textContent).toContain('推荐歌单')
    expect(JSON.parse(localStorage.getItem('dsh-music-qq-ui')).layer).toBe('main')
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

  it('shows the QQ online lyric in the bar (idle state) with translation merged', async () => {
    // P2：在线 QQ 歌词。QQ 播放走 startQQPlayback（不走 startPlay），歌词从
    // /dsh-music/qq/lyric 按 songmid 取；有逐句翻译时合并为「原文 ／ 翻译」。
    const audios = []
    class LyricAudio extends FakeAudio {
      constructor() { super(); audios.push(this) }
      emit(type) { (this.listeners[type] || []).forEach((fn) => fn({ target: this })) }
    }
    vi.resetModules(); registered = []; localStorage.clear(); lastFilesUrl = null; manifest = baseManifest(); qqLoggedIn = true
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

  it('clears the QQ artist from the bar when switching to a local track or novel', async () => {
    // Regression: after playing a QQ song (artists set), playing a local track
    // (no artists) or a novel used to leave the stale QQ artist on the bar,
    // because currentArtists was not reset. It must be cleared.
    const audios = []
    class QAudio extends FakeAudio {
      constructor() { super(); audios.push(this) }
      emit(type) { (this.listeners[type] || []).forEach((fn) => fn({ target: this })) }
    }
    vi.resetModules(); registered = []; localStorage.clear(); lastFilesUrl = null; manifest = baseManifest(); qqLoggedIn = true
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
    vi.resetModules(); registered = []; localStorage.clear(); lastFilesUrl = null; manifest = baseManifest(); qqLoggedIn = true
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
    // savePlayback must persist the online QQ state (previously skipped)
    const saved = JSON.parse(localStorage.getItem('dsh-music-playback'))
    expect(saved.kind).toBe('qq')
    expect(saved.id).toBe('qq:789')
    expect(Array.isArray(saved.queue)).toBe(true)
    expect(saved.queue.length).toBe(2)
    // and the scope is remembered as qq (so refresh opens the online view)
    expect(JSON.parse(localStorage.getItem('dsh-music-scope')).kind).toBe('qq')
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
    vi.resetModules(); registered = []; localStorage.clear(); lastFilesUrl = null; manifest = baseManifest(); qqLoggedIn = true
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
    vi.resetModules(); registered = []; localStorage.clear(); lastFilesUrl = null; manifest = baseManifest(); qqLoggedIn = true
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
    vi.resetModules(); registered = []; localStorage.clear(); lastFilesUrl = null; manifest = baseManifest(); qqLoggedIn = true
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
    vi.resetModules(); registered = []; localStorage.clear(); lastFilesUrl = null; manifest = baseManifest(); qqLoggedIn = true
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
    vi.resetModules(); registered = []; localStorage.clear(); lastFilesUrl = null; manifest = baseManifest(); qqLoggedIn = true
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
    vi.resetModules(); registered = []; localStorage.clear(); lastFilesUrl = null; manifest = baseManifest(); qqLoggedIn = true
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
    localStorage.setItem('dsh-music-qq-ui', JSON.stringify({ layer: 'playlist', plId: '', plName: '' }))
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
      expect(JSON.parse(localStorage.getItem('dsh-music-qq-ui')).layer).toBe('main')
    } finally {
      vi.useRealTimers()
      vi.unstubAllGlobals()
    }
  })

  it('preserves the QQ playlist layer when switching tabs within a session', async () => {
    // Regression: QQOnlinePanel used to unmount on tab switch; on remount it restored
    // the persisted 'playlist' layer from localStorage, so switching away and back
    // yanked the user around. With the panel kept mounted (CSS-hidden), layer is
    // component state that survives tab switches: entering the playlist layer and
    // switching away then back must KEEP the user in that layer.
    localStorage.clear()
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
    // enter the playlist layer once -> persisted as 'playlist'
    const enterPl = [...container.querySelectorAll('.dsh-music-settings-btn')].find((b) => b.textContent === '播放列表')
    act(() => { enterPl.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(JSON.parse(localStorage.getItem('dsh-music-qq-ui')).layer).toBe('playlist')
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
    localStorage.clear()
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
})
