/**
 * Direct unit tests for qq.getMyPlaylists (imports the REAL lib/qq.js — no mock).
 *
 * QQ 的 GetPlaylistByUin 里「我喜欢」是系统默认歌单（dirId 固定 201），其余是账号
 * 自建歌单；腾讯此接口不含「收藏别人的歌单」条目。锁定 isDefault/kind 映射，供
 * 前端在「我的歌单」卡片上标识「默认 / 自建」（与酷狗同款）。
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { getMyPlaylists } from '../lib/qq.js'

afterEach(() => {
  vi.unstubAllGlobals()
})

function stubMusicu(vPlaylist) {
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    if (!String(url).includes('musicu.fcg')) return { status: 404, text: async () => 'not found', json: async () => null }
    return {
      status: 200,
      text: async () => JSON.stringify({ code: 0, req_0: { code: 0, data: { v_playlist: vPlaylist } } }),
      json: async () => ({ code: 0, req_0: { code: 0, data: { v_playlist: vPlaylist } } }),
    }
  }))
}

const COOKIE = 'uin=123; qqmusic_key=k; tmeLoginType=2'

describe('qq.getMyPlaylists 默认/自建标识', () => {
  it('「我喜欢」(dirId=201) → isDefault=true / kind=default', async () => {
    stubMusicu([
      { tid: 7872415010, dirId: 201, dirName: '我喜欢', songNum: 14, picUrl: 'http://y.gtimg.cn/mediastyle/y/img/cover_love_300.jpg' },
    ])
    const pls = await getMyPlaylists(COOKIE)
    expect(pls).toHaveLength(1)
    expect(pls[0].name).toBe('我喜欢')
    expect(pls[0].dirId).toBe(201)
    expect(pls[0].isDefault).toBe(true)
    expect(pls[0].kind).toBe('default')
  })

  it('自建歌单（dirId≠201）→ isDefault=false / kind=own', async () => {
    stubMusicu([
      { tid: 9767653405, dirId: 1, dirName: 'Test', songNum: 7, picUrl: '' },
      { tid: 9768139172, dirId: 4, dirName: '3333', songNum: 1, picUrl: '' },
      { tid: 9768854528, dirId: 5, dirName: '2222', songNum: 5, picUrl: '' },
    ])
    const pls = await getMyPlaylists(COOKIE)
    expect(pls).toHaveLength(3)
    expect(pls.every((p) => p.isDefault === false)).toBe(true)
    expect(pls.every((p) => p.kind === 'own')).toBe(true)
    expect(pls.map((p) => p.dirId)).toEqual([1, 4, 5])
  })

  it('混排：我喜欢 + 自建各自正确标注', async () => {
    stubMusicu([
      { tid: 7872415010, dirId: 201, dirName: '我喜欢', songNum: 14 },
      { tid: 9768854528, dirId: 5, dirName: '2222', songNum: 5 },
    ])
    const pls = await getMyPlaylists(COOKIE)
    expect(pls.map((p) => [p.name, p.isDefault, p.kind])).toEqual([
      ['我喜欢', true, 'default'],
      ['2222', false, 'own'],
    ])
  })
})
