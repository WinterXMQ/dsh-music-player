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
async function fetchStub(url, opts) {
  const u = String(url)
  const o = opts || {}
  if (u === '/dsh-music/manifest') return jsonRes(manifest)
  if (u === '/dsh-music/intent') return jsonRes(null)
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
  lastFilesUrl = null
  manifest = baseManifest()
  await bootClient()
})

describe('dsh-music-player client render smoke', () => {
  it('renders the now-playing bar without throwing', () => {
    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const html = renderToString(bar)
    expect(html).toContain('本地音乐播放器')
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
})
