/**
 * Unit/integration tests for the QQ 音乐 online routes added to lib/index.js.
 *
 * The real lib/qq.js makes network calls to Tencent endpoints, so it is mocked
 * here; the global `fetch` used by the /qq/play proxy is also stubbed so the
 * route can be exercised against a fake upstream stream without network.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

vi.mock('../lib/qq.js', () => ({
  createQRLogin: vi.fn(),
  createWXQRLogin: vi.fn(),
  checkQRLogin: vi.fn(),
  checkWXQRLogin: vi.fn(),
  search: vi.fn(),
  detectVip: vi.fn(),
  getDownloadURL: vi.fn(),
  getRecommendedPlaylists: vi.fn(),
  getPlaylistCategories: vi.fn(),
  getCategoryPlaylists: vi.fn(),
  searchPlaylist: vi.fn(),
  getPlaylistSongs: vi.fn(),
  getMyPlaylists: vi.fn(),
  addQQFav: vi.fn(),
  removeQQFav: vi.fn(),
  addSongToPlaylist: vi.fn(),
  createPlaylist: vi.fn(),
  deletePlaylist: vi.fn(),
  deleteSongFromPlaylist: vi.fn(),
  getQQFavIds: vi.fn(),
  getTopLists: vi.fn(),
  getTopListSongs: vi.fn(),
  getNewSongs: vi.fn(),
}))

import * as QQ from '../lib/qq.js'
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
  const home = mkdtempSync(join(tmpdir(), 'dsh-qq-test-'))
  mkdirSync(join(home, 'Music'), { recursive: true })
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
  return { home, handler, cleanup }
}

beforeEach(() => {
  vi.mocked(QQ.createQRLogin).mockResolvedValue({ key: 'qrsig=abc', imageDataUrl: 'data:image/png;base64,xxx', expiresAt: Date.now() + 60000 })
  vi.mocked(QQ.createWXQRLogin).mockResolvedValue({ key: 'type=wx&uuid=U&state=S', imageDataUrl: 'data:image/jpeg;base64,yyy', expiresAt: Date.now() + 60000 })
  vi.mocked(QQ.search).mockResolvedValue({ results: [{ id: '123', songmid: '123', title: '晴天', artists: ['周杰伦'], album: '叶惠美', payplay: 0, source: 'qq' }], total: 1, page: 1 })
  vi.mocked(QQ.detectVip).mockResolvedValue(true)
  vi.mocked(QQ.getDownloadURL).mockResolvedValue({ url: 'https://ws.stream.qqmusic.qq.com/up.mp3', filename: 'M500123123.mp3' })
  vi.mocked(QQ.getRecommendedPlaylists).mockResolvedValue([{ id: '111', name: '推荐歌单', creator: '作者', cover: '', trackCount: 10, source: 'qq' }])
  vi.mocked(QQ.getPlaylistCategories).mockResolvedValue([{ id: '1', name: '国语', group: '语种' }, { id: '2', name: '欧美', group: '语种' }])
  vi.mocked(QQ.getCategoryPlaylists).mockResolvedValue([{ id: '222', name: '分类歌单', creator: '作者', cover: '', trackCount: 8, source: 'qq' }])
  vi.mocked(QQ.searchPlaylist).mockResolvedValue({ results: [{ id: '333', name: '搜索歌单', creator: '作者', cover: '', trackCount: 5, source: 'qq' }], total: 1, page: 1 })
  vi.mocked(QQ.getPlaylistSongs).mockResolvedValue({ id: '111', name: '推荐歌单', creator: '作者', trackCount: 1, source: 'qq', songs: [{ id: '123', songmid: '123', title: '晴天', artists: ['周杰伦'], payplay: 0, source: 'qq' }] })
  vi.mocked(QQ.getMyPlaylists).mockResolvedValue([{ id: '444', name: '我的收藏', creator: '我', cover: '', trackCount: 3, source: 'qq', dirId: 444, tid: 444 }])
  vi.mocked(QQ.addQQFav).mockResolvedValue(true)
  vi.mocked(QQ.removeQQFav).mockResolvedValue(true)
  vi.mocked(QQ.addSongToPlaylist).mockResolvedValue(true)
  vi.mocked(QQ.deleteSongFromPlaylist).mockResolvedValue(true)
  vi.mocked(QQ.deletePlaylist).mockResolvedValue(true)
  vi.mocked(QQ.createPlaylist).mockResolvedValue({ id: 555, name: '新歌单' })
  vi.mocked(QQ.getQQFavIds).mockResolvedValue({ ids: [123, 456], mids: ['a', 'b'] })
  vi.mocked(QQ.getTopLists).mockResolvedValue([{ id: '0', name: '巅峰榜', toplists: [{ id: '62', name: '飙升榜', cover: 'https://x.jpg', listenNum: 123 }] }])
  vi.mocked(QQ.getTopListSongs).mockResolvedValue({ id: '62', name: '飙升榜', total: 100, hasMore: true, cover: '', updateTime: '', songs: [{ id: 'm1', songmid: 'm1', title: '飙升歌', artists: ['歌手'], payplay: 0, source: 'qq' }] })
  vi.mocked(QQ.getNewSongs).mockResolvedValue({ type: 5, label: '最新', songs: [{ id: 'n1', songmid: 'n1', title: '新歌', artists: ['歌手'], payplay: 0, source: 'qq' }] })
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('dsh-music-player QQ online routes', () => {
  it('reports not-logged-in via /dsh-music/qq/status', async () => {
    const { handler, cleanup } = boot()
    try {
      const res = makeRes()
      await handler(makeReq({ url: '/dsh-music/qq/status' }), res)
      expect(JSON.parse(res.body)).toMatchObject({ loggedIn: false })
    } finally { cleanup() }
  })

  it('creates a QR session via /dsh-music/qq/login/start (qq mode)', async () => {
    const { handler, cleanup } = boot()
    try {
      const res = makeRes()
      await handler(makeReq({ method: 'POST', url: '/dsh-music/qq/login/start', body: JSON.stringify({ mode: 'qq' }) }), res)
      const data = JSON.parse(res.body)
      expect(data.ok).toBe(true)
      expect(data.mode).toBe('qq')
      expect(data.key).toBe('qrsig=abc')
      expect(data.image).toContain('data:image/png;base64')
    } finally { cleanup() }
  })

  it('wechat login/start returns a jpeg data-url image', async () => {
    const { handler, cleanup } = boot()
    try {
      const res = makeRes()
      await handler(makeReq({ method: 'POST', url: '/dsh-music/qq/login/start', body: JSON.stringify({ mode: 'wx' }) }), res)
      const data = JSON.parse(res.body)
      expect(data.mode).toBe('wx')
      expect(data.image).toContain('data:image/jpeg;base64')
      expect(data.key).toContain('type=wx')
    } finally { cleanup() }
  })

  it('logs in via /dsh-music/qq/login/check and persists the cookie (0600)', async () => {
    const { handler, home, cleanup } = boot()
    const cookie = 'uin=123; qqmusic_key=ABC; qm_keyst=ABC'
    vi.mocked(QQ.checkQRLogin).mockResolvedValue({ source: 'qq', key: 'qrsig=abc', status: 'success', cookie, cookies: { uin: '123' }, extra: {} })
    try {
      let res = makeRes()
      await handler(makeReq({ url: '/dsh-music/qq/login/check?key=qrsig%3Dabc' }), res)
      expect(JSON.parse(res.body).status).toBe('success')
      expect(JSON.parse(res.body).loggedIn).toBe(true)
      const file = join(home, '.dsh', 'music-player-qq-cookie.json')
      const saved = JSON.parse(readFileSync(file, 'utf8'))
      expect(saved.cookie).toBe(cookie)
      res = makeRes()
      await handler(makeReq({ url: '/dsh-music/qq/status' }), res)
      expect(JSON.parse(res.body)).toMatchObject({ loggedIn: true, uin: '123' })
    } finally { cleanup() }
  })

  it('reports waiting while the QR is unscanned', async () => {
    const { handler, cleanup } = boot()
    vi.mocked(QQ.checkQRLogin).mockResolvedValue({ source: 'qq', key: 'qrsig=abc', status: 'waiting', message: '', extra: {} })
    try {
      const res = makeRes()
      await handler(makeReq({ url: '/dsh-music/qq/login/check?key=qrsig%3Dabc' }), res)
      expect(JSON.parse(res.body)).toMatchObject({ status: 'waiting' })
    } finally { cleanup() }
  })

  it('logs out via /dsh-music/qq/login/logout', async () => {
    const { handler, home, cleanup } = boot()
    vi.mocked(QQ.checkQRLogin).mockResolvedValue({ source: 'qq', key: 'qrsig=abc', status: 'success', cookie: 'uin=123; qqmusic_key=ABC', extra: {} })
    try {
      await handler(makeReq({ url: '/dsh-music/qq/login/check?key=qrsig%3Dabc' }), makeRes())
      const res = makeRes()
      await handler(makeReq({ method: 'POST', url: '/dsh-music/qq/login/logout' }), res)
      expect(JSON.parse(res.body)).toMatchObject({ loggedIn: false })
      const file = join(home, '.dsh', 'music-player-qq-cookie.json')
      expect(JSON.parse(readFileSync(file, 'utf8')).cookie).toBe('')
    } finally { cleanup() }
  })

  it('searches QQ online via /dsh-music/qq/search (anonymous -> not vip)', async () => {
    const { handler, cleanup } = boot()
    try {
      const res = makeRes()
      await handler(makeReq({ url: '/dsh-music/qq/search?w=%E6%99%B4%E5%A4%A9' }), res)
      const data = JSON.parse(res.body)
      expect(data.ok).toBe(true)
      expect(data.isVip).toBe(false) // no cookie -> refreshQQVip short-circuits to false
      expect(data.results[0].title).toBe('晴天')
      expect(data.total).toBe(1)
      expect(QQ.search).toHaveBeenCalledWith('晴天', '', 1)
    } finally { cleanup() }
  })

  it('forwards the page param and returns total for paged song search', async () => {
    const { handler, cleanup } = boot()
    try {
      vi.mocked(QQ.search).mockResolvedValue({ results: [{ id: '456', songmid: '456', title: '夜曲', artists: ['周杰伦'], album: '十一月的萧邦', payplay: 0, source: 'qq' }], total: 42, page: 3 })
      const res = makeRes()
      await handler(makeReq({ url: '/dsh-music/qq/search?w=%E5%91%A8%E6%9D%B0%E4%BC%A6&page=3' }), res)
      const data = JSON.parse(res.body)
      expect(data.ok).toBe(true)
      expect(QQ.search).toHaveBeenCalledWith('周杰伦', '', 3)
      expect(data.results[0].title).toBe('夜曲')
      expect(data.total).toBe(42)
      expect(data.page).toBe(3)
    } finally { cleanup() }
  })

  it('proxies a QQ audio stream via /dsh-music/qq/play/<mid>', async () => {
    const { handler, cleanup } = boot()
    const fakeBody = (async function* () { yield Buffer.from('ID3AUDIO') })()
    vi.stubGlobal('fetch', vi.fn(async () => ({
      status: 206,
      headers: { get: (h) => h === 'content-type' ? 'audio/mpeg' : (h === 'content-length' ? '8' : h === 'content-range' ? 'bytes 0-7/100' : null) },
      body: fakeBody,
    })))
    try {
      const res = makeRes()
      await handler(makeReq({ url: '/dsh-music/qq/play/123', headers: { range: 'bytes=0-65535' } }), res)
      expect(res.status).toBe(206)
      expect(res.headers['Content-Type']).toBe('audio/mpeg')
      expect(res.body).toBe('ID3AUDIO')
    } finally { cleanup() }
  })

  it('returns 404 for a QQ play with no resolvable URL', async () => {
    const { handler, cleanup } = boot()
    vi.mocked(QQ.getDownloadURL).mockResolvedValue({ url: '', filename: '' })
    try {
      const res = makeRes()
      await handler(makeReq({ url: '/dsh-music/qq/play/99' }), res)
      expect(res.status).toBe(404)
    } finally { cleanup() }
  })

  it('returns recommended playlists via /dsh-music/qq/playlists', async () => {
    const { handler, cleanup } = boot()
    try {
      const res = makeRes()
      await handler(makeReq({ url: '/dsh-music/qq/playlists' }), res)
      const data = JSON.parse(res.body)
      expect(data.ok).toBe(true)
      expect(data.playlists[0].name).toBe('推荐歌单')
    } finally { cleanup() }
  })

  it('returns category playlists via /dsh-music/qq/playlists?category=<id>', async () => {
    const { handler, cleanup } = boot()
    try {
      const res = makeRes()
      await handler(makeReq({ url: '/dsh-music/qq/playlists?category=1&page=1' }), res)
      const data = JSON.parse(res.body)
      expect(data.ok).toBe(true)
      expect(QQ.getCategoryPlaylists).toHaveBeenCalledWith('1', 1, 20, '')
      expect(data.playlists[0].name).toBe('分类歌单')
    } finally { cleanup() }
  })

  it('returns playlist categories via /dsh-music/qq/playlist-categories', async () => {
    const { handler, cleanup } = boot()
    try {
      const res = makeRes()
      await handler(makeReq({ url: '/dsh-music/qq/playlist-categories' }), res)
      const data = JSON.parse(res.body)
      expect(data.ok).toBe(true)
      expect(data.categories).toHaveLength(2)
    } finally { cleanup() }
  })

  it('returns my playlists via /dsh-music/qq/my-playlists (logged-in only)', async () => {
    const { handler, cleanup } = boot()
    try {
      const res = makeRes()
      await handler(makeReq({ url: '/dsh-music/qq/my-playlists' }), res)
      const data = JSON.parse(res.body)
      expect(data.ok).toBe(true)
      expect(QQ.getMyPlaylists).toHaveBeenCalled()
      expect(data.playlists[0].name).toBe('我的收藏')
    } finally { cleanup() }
  })

  it('adds/removes an online QQ song to/from 我喜欢 via /dsh-music/qq/fav', async () => {
    const { handler, cleanup } = boot()
    try {
      const body = JSON.stringify({ action: 'add', song: { songid: 123, songtype: 0 } })
      const res = makeRes()
      await handler(makeReq({ url: '/dsh-music/qq/fav', method: 'POST', headers: { 'content-type': 'application/json' }, body }), res)
      const data = JSON.parse(res.body)
      expect(data.ok).toBe(true)
      expect(data.faved).toBe(true)
      expect(QQ.addQQFav).toHaveBeenCalledWith({ songid: 123, songtype: 0 }, '')
      // remove
      const res2 = makeRes()
      await handler(makeReq({ url: '/dsh-music/qq/fav', method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'remove', song: { songid: 123, songtype: 0 } }) }), res2)
      const d2 = JSON.parse(res2.body)
      expect(QQ.removeQQFav).toHaveBeenCalledWith({ songid: 123, songtype: 0 }, '')
      expect(d2.faved).toBe(false)
    } finally { cleanup() }
  })

  it('returns liked song ids via /dsh-music/qq/liked', async () => {
    const { handler, cleanup } = boot()
    try {
      const res = makeRes()
      await handler(makeReq({ url: '/dsh-music/qq/liked' }), res)
      const data = JSON.parse(res.body)
      expect(data.ok).toBe(true)
      expect(QQ.getQQFavIds).toHaveBeenCalled()
      expect(data.ids).toEqual([123, 456])
    } finally { cleanup() }
  })

  it('adds a song to a user playlist via /dsh-music/qq/playlist-add', async () => {
    const { handler, cleanup } = boot()
    try {
      const body = JSON.stringify({ song: { songid: 123, songtype: 0 }, dirId: 444, tid: 444 })
      const res = makeRes()
      await handler(makeReq({ url: '/dsh-music/qq/playlist-add', method: 'POST', headers: { 'content-type': 'application/json' }, body }), res)
      const data = JSON.parse(res.body)
      expect(data.ok).toBe(true)
      expect(QQ.addSongToPlaylist).toHaveBeenCalledWith({ songid: 123, songtype: 0 }, 444, 444, '')
    } finally { cleanup() }
  })

  it('removes a song from a user playlist via /dsh-music/qq/playlist-remove', async () => {
    const { handler, cleanup } = boot()
    try {
      const body = JSON.stringify({ song: { songid: 123, songtype: 0 }, dirId: 444, tid: 0 })
      const res = makeRes()
      await handler(makeReq({ url: '/dsh-music/qq/playlist-remove', method: 'POST', headers: { 'content-type': 'application/json' }, body }), res)
      const data = JSON.parse(res.body)
      expect(data.ok).toBe(true)
      expect(QQ.deleteSongFromPlaylist).toHaveBeenCalledWith({ songid: 123, songtype: 0 }, 444, 0, '')
    } finally { cleanup() }
  })

  it('creates a playlist via /dsh-music/qq/playlist-create', async () => {
    const { handler, cleanup } = boot()
    try {
      const body = JSON.stringify({ name: '新歌单' })
      const res = makeRes()
      await handler(makeReq({ url: '/dsh-music/qq/playlist-create', method: 'POST', headers: { 'content-type': 'application/json' }, body }), res)
      const data = JSON.parse(res.body)
      expect(data.ok).toBe(true)
      expect(data.playlist.name).toBe('新歌单')
      expect(QQ.createPlaylist).toHaveBeenCalledWith('新歌单', '')
    } finally { cleanup() }
  })

  it('rejects an empty playlist name via /dsh-music/qq/playlist-create', async () => {
    const { handler, cleanup } = boot()
    try {
      const res = makeRes()
      await handler(makeReq({ url: '/dsh-music/qq/playlist-create', method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: '  ' }) }), res)
      expect(res.status).toBe(400)
      expect(JSON.parse(res.body).ok).toBe(false)
    } finally { cleanup() }
  })

  it('deletes a user playlist via /dsh-music/qq/playlist-delete', async () => {
    const { handler, cleanup } = boot()
    try {
      const body = JSON.stringify({ dirId: 444 })
      const res = makeRes()
      await handler(makeReq({ url: '/dsh-music/qq/playlist-delete', method: 'POST', headers: { 'content-type': 'application/json' }, body }), res)
      const data = JSON.parse(res.body)
      expect(data.ok).toBe(true)
      expect(QQ.deletePlaylist).toHaveBeenCalledWith(444, '')
    } finally { cleanup() }
  })

  it('rejects a playlist delete without dirId via /dsh-music/qq/playlist-delete', async () => {
    const { handler, cleanup } = boot()
    try {
      const res = makeRes()
      await handler(makeReq({ url: '/dsh-music/qq/playlist-delete', method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}) }), res)
      expect(res.status).toBe(400)
      expect(JSON.parse(res.body).ok).toBe(false)
    } finally { cleanup() }
  })

  it('surfaces a deletePlaylist failure via /dsh-music/qq/playlist-delete', async () => {
    const { handler, cleanup } = boot()
    try {
      vi.mocked(QQ.deletePlaylist).mockRejectedValue(new Error('「我喜欢」不可删除'))
      const res = makeRes()
      await handler(makeReq({ url: '/dsh-music/qq/playlist-delete', method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ dirId: 201 }) }), res)
      expect(res.status).toBe(502)
      expect(JSON.parse(res.body).ok).toBe(false)
      expect(JSON.parse(res.body).error).toContain('「我喜欢」不可删除')
    } finally { cleanup() }
  })

  it('searches playlists via /dsh-music/qq/playlist-search', async () => {
    const { handler, cleanup } = boot()
    try {
      const res = makeRes()
      await handler(makeReq({ url: '/dsh-music/qq/playlist-search?w=%E5%91%A8%E6%9D%B0%E4%BC%A6' }), res)
      const data = JSON.parse(res.body)
      expect(data.ok).toBe(true)
      expect(QQ.searchPlaylist).toHaveBeenCalledWith('周杰伦', '', 1)
      expect(data.playlists[0].name).toBe('搜索歌单')
    } finally { cleanup() }
  })

  it('forwards the page param and returns total for paged playlist search', async () => {
    const { handler, cleanup } = boot()
    try {
      vi.mocked(QQ.searchPlaylist).mockResolvedValue({ results: [{ id: '777', name: '周杰伦精选', creator: '作者', cover: '', trackCount: 40, source: 'qq' }], total: 30, page: 2 })
      const res = makeRes()
      await handler(makeReq({ url: '/dsh-music/qq/playlist-search?w=%E5%91%A8%E6%9D%B0%E4%BC%A6&page=2' }), res)
      const data = JSON.parse(res.body)
      expect(data.ok).toBe(true)
      expect(QQ.searchPlaylist).toHaveBeenCalledWith('周杰伦', '', 2)
      expect(data.playlists[0].name).toBe('周杰伦精选')
      expect(data.total).toBe(30)
      expect(data.page).toBe(2)
    } finally { cleanup() }
  })

  it('returns a playlist detail with songs via /dsh-music/qq/playlist/<id>', async () => {
    const { handler, cleanup } = boot()
    try {
      const res = makeRes()
      await handler(makeReq({ url: '/dsh-music/qq/playlist/111' }), res)
      const data = JSON.parse(res.body)
      expect(data.ok).toBe(true)
      expect(data.playlist.name).toBe('推荐歌单')
      expect(data.playlist.songs[0].title).toBe('晴天')
    } finally { cleanup() }
  })

  it('returns ranking groups via /dsh-music/qq/top-lists', async () => {
    const { handler, cleanup } = boot()
    try {
      const res = makeRes()
      await handler(makeReq({ url: '/dsh-music/qq/top-lists' }), res)
      const data = JSON.parse(res.body)
      expect(data.ok).toBe(true)
      expect(QQ.getTopLists).toHaveBeenCalled()
      expect(data.groups[0].name).toBe('巅峰榜')
    } finally { cleanup() }
  })

  it('returns ranking songs via /dsh-music/qq/top-songs?topId=62', async () => {
    const { handler, cleanup } = boot()
    try {
      const res = makeRes()
      await handler(makeReq({ url: '/dsh-music/qq/top-songs?topId=62' }), res)
      const data = JSON.parse(res.body)
      expect(data.ok).toBe(true)
      expect(QQ.getTopListSongs).toHaveBeenCalledWith('62', expect.any(String), 0, 30)
      expect(data.toplist.songs[0].title).toBe('飙升歌')
      expect(data.toplist.hasMore).toBe(true)
    } finally { cleanup() }
  })

  it('forwards offset/num for paginated top-songs', async () => {
    const { handler, cleanup } = boot()
    try {
      const res = makeRes()
      await handler(makeReq({ url: '/dsh-music/qq/top-songs?topId=62&offset=30&num=30' }), res)
      const data = JSON.parse(res.body)
      expect(data.ok).toBe(true)
      expect(QQ.getTopListSongs).toHaveBeenCalledWith('62', expect.any(String), 30, 30)
    } finally { cleanup() }
  })

  it('returns new songs via /dsh-music/qq/new-songs?type=5', async () => {
    const { handler, cleanup } = boot()
    try {
      const res = makeRes()
      await handler(makeReq({ url: '/dsh-music/qq/new-songs?type=5' }), res)
      const data = JSON.parse(res.body)
      expect(data.ok).toBe(true)
      expect(QQ.getNewSongs).toHaveBeenCalled()
      expect(data.result.songs[0].title).toBe('新歌')
    } finally { cleanup() }
  })

  it('rejects bad topId via /dsh-music/qq/top-songs', async () => {
    const { handler, cleanup } = boot()
    try {
      const res = makeRes()
      await handler(makeReq({ url: '/dsh-music/qq/top-songs?topId=abc' }), res)
      expect(res.status).toBe(400)
    } finally { cleanup() }
  })
})
