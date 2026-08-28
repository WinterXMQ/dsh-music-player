/**
 * Host-level tests for 酷狗「收藏歌单」歌曲读取：
 *
 * 正确读法：收藏歌单的歌曲不在自己云歌单副本（get_list_all_file 常为空），
 * 必须用 /pubsongs/v2/get_other_list_file_nofilt 传收藏条目的 creatorGid
 * （= 原歌单 global_specialid）。本文件锁定：
 * - getMyPlaylists 的收藏条目带 creatorGid
 * - /dsh-music/kg/my-playlist/<id> 对收藏歌单走 getCollectedPlaylistSongs
 * - 自建歌单仍走 getMyPlaylistSongs
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

vi.mock('../lib/kugou.js', () => ({
  getMyPlaylists: vi.fn(),
  getMyPlaylistSongs: vi.fn(),
  getCollectedPlaylistSongs: vi.fn(),
  getPlaylistSongs: vi.fn(),
  collectPlaylist: vi.fn(),
  createPlaylist: vi.fn(),
  deletePlaylist: vi.fn(),
  addSongToPlaylist: vi.fn(),
  deleteSongFromPlaylist: vi.fn(),
  registerDevice: vi.fn(),
  createDeviceIdentity: vi.fn(),
  refreshSession: vi.fn(),
  loginStart: vi.fn(),
  checkQRLogin: vi.fn(),
  logout: vi.fn(),
}))

import * as KG from '../lib/kugou.js'
import { apply } from '../lib/index.js'

function makeReq({ method = 'GET', url = '/', headers = {}, body = '' }) {
  const req = { method, url, headers }
  req[Symbol.asyncIterator] = async function* () { if (body) yield body }
  return req
}
function makeRes() {
  const res = {
    status: 200, headers: {}, body: null, chunks: [],
    writeHead(status, headers) { res.status = status; res.headers = { ...(headers || {}) } },
    write(chunk) { res.chunks.push(chunk) },
    end(data) { if (data !== undefined) res.body = data; else res.body = Buffer.concat(res.chunks.map((c) => Buffer.from(c))).toString('utf8') },
  }
  return res
}
function makeFs(rootDir) {
  return {
    async resolve(p) { return resolve(p) },
    async stat() { return undefined },
    processPath(t) { return resolve(t) },
    async listDir() { return [] },
    async readBytes() { return Buffer.alloc(0) },
  }
}
function boot() {
  const home = mkdtempSync(join(tmpdir(), 'dsh-kg-collect-'))
  mkdirSync(join(home, 'Music'), { recursive: true })
  mkdirSync(join(home, '.dsh'), { recursive: true })
  const prevHome = process.env.HOME
  const prevDshHome = process.env.DSH_HOME
  process.env.HOME = home
  process.env.DSH_HOME = join(home, '.dsh')
  const registered = []
  const ctx = {
    shell: { resolve: (o) => o, run: async () => ({ stdout: { text: home } }) },
    fs: makeFs(home),
    webServer: { register: (r) => { registered.push(r) } },
    tools: { register: () => {} },
    systemPrompt: { section: () => {} },
    effect: (fn) => fn(),
  }
  apply(ctx)
  const handler = registered.find((r) => r.kind === 'prefix' && r.path === '/dsh-music')?.handler
  const cleanup = () => {
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome
    if (prevDshHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prevDshHome
    try { rmSync(home, { recursive: true, force: true }) } catch {}
  }
  return { home, handler, cleanup, cookieFile: join(home, '.dsh', 'music-player-kugou-cookie.json') }
}

let booted
beforeEach(() => {
  booted = boot()
  writeFileSync(booted.cookieFile, JSON.stringify({
    session: {
      guid: 'g', mid: '290402895447160996760242034854185275797', dfid: 'DFID',
      token: 'tok', userid: '1785839222', vip_type: '', vip_token: '',
    },
    loggedIn: true, savedAt: Date.now(),
  }))
  // 默认：收藏歌单条目带 creatorGid；getCollectedPlaylistSongs 返回歌曲
  vi.mocked(KG.getMyPlaylists).mockResolvedValue([
    { id: '8', name: '超带感欧美节奏', kind: 'collect', isDefault: false, creator: '时光如水', originalId: '188', creatorGid: 'collection_3_1314415167_188_0', trackCount: 32, source: 'kugou', cover: '' },
    { id: '3', name: '我的自建歌单', kind: 'own', isDefault: false, creator: '', trackCount: 2, source: 'kugou', cover: '' },
  ])
  vi.mocked(KG.getCollectedPlaylistSongs).mockResolvedValue([
    { id: 'a', hash: 'AAAA', title: 'All I Wanna Do', artists: ['Martin Jensen'], source: 'kugou' },
    { id: 'b', hash: 'BBBB', title: 'Lullaby', artists: ['Sigala'], source: 'kugou' },
  ])
  vi.mocked(KG.getMyPlaylistSongs).mockResolvedValue([
    { id: 'x', hash: 'XXXX', title: '自建歌', artists: ['甲'], source: 'kugou' },
  ])
})
afterEach(() => {
  vi.clearAllMocks()
  if (booted) booted.cleanup()
})

describe('酷狗收藏歌单：走 get_other_list_file_nofilt（creatorGid）读歌', () => {
  it('REGRESSION: 收藏歌单详情用 getCollectedPlaylistSongs(creatorGid) 而非 getMyPlaylistSongs', async () => {
    const res = makeRes()
    await booted.handler(makeReq({ url: '/dsh-music/kg/my-playlist/8' }), res)
    expect(res.status).toBe(200)
    const d = JSON.parse(res.body)
    expect(d.ok).toBe(true)
    expect(d.playlist.songs.length).toBe(2)
    expect(KG.getCollectedPlaylistSongs).toHaveBeenCalledWith('collection_3_1314415167_188_0', expect.anything())
    expect(KG.getMyPlaylistSongs).not.toHaveBeenCalled()
  })

  it('自建歌单详情仍走 getMyPlaylistSongs（不误用收藏接口）', async () => {
    const res = makeRes()
    await booted.handler(makeReq({ url: '/dsh-music/kg/my-playlist/3' }), res)
    expect(KG.getMyPlaylistSongs).toHaveBeenCalledWith('3', expect.anything())
    expect(KG.getCollectedPlaylistSongs).not.toHaveBeenCalled()
    expect(JSON.parse(res.body).playlist.songs.length).toBe(1)
  })

  it('列表里找不到该 listid（如越权/已删）→ 走 getMyPlaylistSongs 兜底', async () => {
    const res = makeRes()
    await booted.handler(makeReq({ url: '/dsh-music/kg/my-playlist/999' }), res)
    expect(KG.getMyPlaylistSongs).toHaveBeenCalled()
    expect(JSON.parse(res.body).playlist.songs.length).toBe(1)
  })
})

describe('酷狗「我喜欢」集合接口（/dsh-music/kg/liked，供播放条爱心点亮）', () => {
  it('返回我喜欢歌单的 listId + 歌曲 hash 集合 + hash→fileId 映射', async () => {
    vi.mocked(KG.getMyPlaylists).mockResolvedValue([
      { id: '2', name: '我喜欢', kind: 'own', isLike: true, isDef: 2, trackCount: 44, cover: 'data:image/jpeg;base64,xx' },
      { id: '3', name: '自建', kind: 'own', isLike: false, isDef: 0, trackCount: 2, cover: '' },
    ])
    vi.mocked(KG.getMyPlaylistSongs).mockResolvedValue([
      { id: 'a', hash: 'AAAA', title: 'All I Wanna Do', fileId: 2, source: 'kugou' },
      { id: 'b', hash: 'BBBB', title: 'Lullaby', fileId: 3, source: 'kugou' },
    ])
    const res = makeRes()
    await booted.handler(makeReq({ url: '/dsh-music/kg/liked' }), res)
    expect(res.status).toBe(200)
    const d = JSON.parse(res.body)
    expect(d.ok).toBe(true)
    expect(d.listId).toBe(2)
    expect(d.hashes).toEqual(['AAAA', 'BBBB'])
    expect(d.files).toEqual([{ hash: 'AAAA', fileId: 2 }, { hash: 'BBBB', fileId: 3 }])
    expect(KG.getMyPlaylistSongs).toHaveBeenCalledWith('2', expect.anything())
  })

  it('没有我喜欢歌单时返回空集合（ok:true）', async () => {
    vi.mocked(KG.getMyPlaylists).mockResolvedValue([
      { id: '3', name: '自建', kind: 'own', isLike: false, isDef: 0, trackCount: 2, cover: '' },
    ])
    const res = makeRes()
    await booted.handler(makeReq({ url: '/dsh-music/kg/liked' }), res)
    expect(res.status).toBe(200)
    const d = JSON.parse(res.body)
    expect(d.ok).toBe(true)
    expect(d.listId).toBe(0)
    expect(d.hashes).toEqual([])
    expect(d.files).toEqual([])
    expect(KG.getMyPlaylistSongs).not.toHaveBeenCalled()
  })

  it('未登录返回 401', async () => {
    writeFileSync(booted.cookieFile, JSON.stringify({ session: { token: '', userid: '' }, loggedIn: false, savedAt: Date.now() }))
    const res = makeRes()
    await booted.handler(makeReq({ url: '/dsh-music/kg/liked' }), res)
    expect(res.status).toBe(401)
  })
})

describe('酷狗登录已失效（连刷新也报设备不匹配 20018）→ 自动登出 + kgLoginDead 标记', () => {
  it('业务接口报设备不匹配、刷新也报设备不匹配：清空会话并返回 kgLoginDead:true', async () => {
    vi.mocked(KG.getMyPlaylists).mockRejectedValue(new Error('云歌单：登录态与设备不匹配（20017）'))
    vi.mocked(KG.refreshSession).mockRejectedValue(new Error('刷新登录态失败：登录态与设备不匹配（20018）'))
    const res = makeRes()
    await booted.handler(makeReq({ url: '/dsh-music/kg/my-playlists' }), res)
    expect(res.status).toBe(502)
    const d = JSON.parse(res.body)
    expect(d.ok).toBe(false)
    expect(d.kgLoginDead).toBe(true)
    expect(d.error).toContain('请重新扫码登录')
    expect(KG.refreshSession).toHaveBeenCalled()
    // 会话已自动清空：cookie 文件 loggedIn:false，token 置空
    const saved = JSON.parse(readFileSync(booted.cookieFile, 'utf8'))
    expect(saved.loggedIn).toBe(false)
    expect(saved.session.token).toBe('')
  })

  it('刷新成功（会话可续命）→ 重试原接口，不登出、不带标记', async () => {
    vi.mocked(KG.getMyPlaylists)
      .mockRejectedValueOnce(new Error('云歌单：登录态与设备不匹配（20017）'))
      .mockResolvedValueOnce([
        { id: '2', name: '我喜欢', kind: 'own', isLike: true, isDef: 2, trackCount: 44, cover: '' },
        { id: '3', name: '自建', kind: 'own', isLike: false, isDef: 0, trackCount: 2, cover: '' },
      ])
    vi.mocked(KG.refreshSession).mockResolvedValue({ token: 'tok2', userid: '1785839222', vip_type: '', vip_token: '', t1: '' })
    const res = makeRes()
    await booted.handler(makeReq({ url: '/dsh-music/kg/my-playlists' }), res)
    expect(res.status).toBe(200)
    const d = JSON.parse(res.body)
    expect(d.ok).toBe(true)
    expect(d.kgLoginDead).toBeUndefined()
    expect(KG.getMyPlaylists).toHaveBeenCalledTimes(2) // 首次失败 + 刷新后重试
    expect(KG.refreshSession).toHaveBeenCalledTimes(1)
    const saved = JSON.parse(readFileSync(booted.cookieFile, 'utf8'))
    expect(saved.loggedIn).toBe(true) // 未登出
    expect(saved.session.token).toBe('tok2') // 新 token 已落盘
  })

  it('刷新失败但非设备不匹配（如瞬时网络错）→ 不登出、不带标记', async () => {
    vi.mocked(KG.getMyPlaylists).mockRejectedValue(new Error('云歌单：登录态与设备不匹配（20017）'))
    vi.mocked(KG.refreshSession).mockRejectedValue(new Error('刷新登录态失败：网络超时'))
    const res = makeRes()
    await booted.handler(makeReq({ url: '/dsh-music/kg/my-playlists' }), res)
    expect(res.status).toBe(502)
    const d = JSON.parse(res.body)
    expect(d.kgLoginDead).toBeUndefined()
    expect(d.error).toContain('网络超时')
    const saved = JSON.parse(readFileSync(booted.cookieFile, 'utf8'))
    expect(saved.loggedIn).toBe(true) // 未登出
  })
})
