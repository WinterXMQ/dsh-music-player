/**
 * Direct unit tests for getTopListSongs pagination (imports the REAL lib/kugou.js).
 *
 * The mobilecdn rank/song API reports the total in `data.total` (e.g. TOP500 → 500)
 * and has NO `count` field. Global fetch is stubbed to exercise offset/hasMore/total
 * logic — and to lock the regression: reading `data.count` made total collapse to the
 * current page size, so hasMore was always false and the 排行榜 had no 加载更多.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { getTopListSongs } from '../lib/kugou.js'

afterEach(() => {
  vi.unstubAllGlobals()
})

// Stub a mobilecdn rank/song response: total 在 data.total（无 data.count），
// 与真实接口一致。返回上次请求的 URL 供断言 page/pagesize。
function stubFetch(songCount, totalNum) {
  let lastUrl = null
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    lastUrl = String(url)
    const u = new URL(url)
    const page = parseInt(u.searchParams.get('page') || '1', 10)
    const size = parseInt(u.searchParams.get('pagesize') || '30', 10)
    const offset = (page - 1) * size
    const info = Array.from({ length: songCount }, (_, i) => ({
      hash: String(offset + i).padStart(32, '0'),
      songname: '歌' + (offset + i),
      authors: [{ author_name: '歌手' }],
      duration: 200,
    }))
    return { json: async () => ({ status: 1, data: { name: 'TOP500', total: totalNum, info } }) }
  }))
  return () => lastUrl
}

describe('getTopListSongs pagination', () => {
  it('REGRESSION: total 取 data.total（无 count 字段）→ 首页 hasMore=true', async () => {
    // 真实接口只给 data.total=500、没有 data.count。旧代码读 count → total 退化为
    // 当前页长度(30) → hasMore: 30<30 = false → 榜单永远没有「加载更多」。
    const getLastUrl = stubFetch(30, 500)
    const r = await getTopListSongs('8888', {}, 0, 30)
    expect(getLastUrl()).toContain('rankid=8888')
    expect(getLastUrl()).toContain('page=1')
    expect(getLastUrl()).toContain('pagesize=30')
    expect(r.total).toBe(500)
    expect(r.hasMore).toBe(true) // 0 + 30 < 500
    expect(r.songs.length).toBe(30)
    expect(r.name).toBe('TOP500')
    expect(r.songs[0].artists).toEqual(['歌手'])
  })

  it('末页 hasMore=false', async () => {
    stubFetch(20, 500)
    const r = await getTopListSongs('8888', {}, 480, 30)
    expect(r.songs.length).toBe(20)
    expect(r.hasMore).toBe(false) // 480 + 20 = 500
  })

  it('offset/num → page 计算正确', async () => {
    const getLastUrl = stubFetch(30, 500)
    await getTopListSongs('8888', {}, 60, 30)
    expect(getLastUrl()).toContain('page=3') // floor(60/30)+1
  })

  it('bad rankid 抛错、非 ok status 抛错', async () => {
    await expect(getTopListSongs('abc', {})).rejects.toThrow('bad rankid')
    vi.stubGlobal('fetch', vi.fn(async () => ({ json: async () => ({ status: -1 }) })))
    await expect(getTopListSongs('8888', {})).rejects.toThrow('酷狗榜单获取失败')
  })
})
