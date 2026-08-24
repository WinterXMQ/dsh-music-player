/**
 * Direct unit tests for deletePlaylist (imports the REAL lib/qq.js — no mock).
 *
 * deletePlaylist hits musicu.fcg's music.musicasset.PlaylistBaseWrite / DelPlaylist.
 * Global fetch is stubbed so the write request (and its retCode handling) can be
 * exercised without network.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { deletePlaylist } from '../lib/qq.js'

afterEach(() => {
  vi.unstubAllGlobals()
})

function stubFetch(jsonResponse) {
  let lastBody = null
  vi.stubGlobal('fetch', vi.fn(async (_url, opts) => {
    lastBody = JSON.parse(opts.body)
    return { json: async () => jsonResponse }
  }))
  return () => lastBody
}

describe('deletePlaylist', () => {
  it('requires a valid dirId', async () => {
    await expect(deletePlaylist(0, 'uin=1; qqmusic_key=k')).rejects.toThrow('缺少歌单 dirId')
    await expect(deletePlaylist('abc', 'uin=1; qqmusic_key=k')).rejects.toThrow('缺少歌单 dirId')
  })

  it('refuses to delete the 我喜欢 playlist (dirId 201)', async () => {
    await expect(deletePlaylist(201, 'uin=1; qqmusic_key=k')).rejects.toThrow('「我喜欢」不可删除')
  })

  it('posts DelPlaylist to PlaylistBaseWrite and succeeds on retCode 0', async () => {
    const getLastBody = stubFetch({ code: 0, req_0: { code: 0, data: { retCode: 0 } } })
    const ok = await deletePlaylist(444, 'uin=1; qqmusic_key=k')
    expect(ok).toBe(true)
    const body = getLastBody()
    expect(body.req_0.module).toBe('music.musicasset.PlaylistBaseWrite')
    expect(body.req_0.method).toBe('DelPlaylist')
    expect(body.req_0.param).toEqual({ dirId: 444 })
    // 写操作需要 g_tk(CSRF)，由 musickey 计算后注入 comm。
    expect(body.comm.g_tk).toBeTypeOf('number')
  })

  it('throws on a non-zero retCode', async () => {
    stubFetch({ code: 0, req_0: { code: 0, data: { retCode: -1 } } })
    await expect(deletePlaylist(444, 'uin=1; qqmusic_key=k')).rejects.toThrow('歌单操作失败（retCode=-1')
  })

  it('throws without a login cookie', async () => {
    await expect(deletePlaylist(444, '')).rejects.toThrow('未登录')
  })
})
