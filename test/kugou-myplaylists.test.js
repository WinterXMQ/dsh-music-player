/**
 * Direct unit tests for getMyPlaylists (imports the REAL lib/kugou.js).
 *
 * The cloudlist v7/get_all_list mixes 自建 (type=0) and 收藏 (type=1) playlists
 * in one list. Fields: creator lives in `list_create_username` (NOT creator_name/
 * nickname), description in `intro` (NOT description), and system defaults are
 * marked by `is_def` (1=默认收藏, 2=我喜欢). Lock the mapping so the UI can show
 * 收藏/自建 tags, real creators, and hide delete for collected/system playlists.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { getMyPlaylists } from '../lib/kugou.js'

afterEach(() => {
  vi.unstubAllGlobals()
})

// 返回与真实 get_all_list 一致的原始条目（自建 / 收藏 / 系统默认混排）。
function stubMyPlaylists(entries) {
  vi.stubGlobal('fetch', vi.fn(async () => ({
    status: 200,
    text: async () => JSON.stringify({ status: 1, data: { info: entries } }),
    json: async () => ({ status: 1, data: { info: entries } }),
  })))
}

const SESSION = {
  mid: '290402895447160996760242034854185275797',
  dfid: '7C2A6C044AFE1BD6E876571C',
  token: 't0k3n',
  userid: '1785839222',
}

const OWN_ENTRY = {
  listid: 1,
  name: '默认收藏',
  type: 0,
  is_def: 1,
  list_create_userid: 1785839222,
  list_create_username: '我',
  intro: '',
  count: 1,
}
const FAV_ENTRY = {
  listid: 2,
  name: '我喜欢',
  type: 0,
  is_def: 2,
  list_create_userid: 1785839222,
  list_create_username: '我',
  intro: '',
  count: 44,
}
const COLLECT_ENTRY = {
  listid: 3,
  name: '周杰伦丨列表循环150首',
  type: 1,
  is_def: 0,
  from_listid: 69,
  list_create_listid: 69,
  list_create_userid: 1030901891,
  list_create_username: '周杰伦粉丝',
  intro: 'VIP歌单选取周杰伦150首歌曲',
  pic: 'http://c1.kgimg.com/custom/{size}/x.jpg',
  count: 150,
}

describe('getMyPlaylists 自建/收藏/系统默认区分', () => {
  it('REGRESSION: creator 取 list_create_username（旧代码读 creator_name 恒为空）', async () => {
    stubMyPlaylists([OWN_ENTRY])
    const pls = await getMyPlaylists(SESSION)
    expect(pls[0].name).toBe('默认收藏')
    expect(pls[0].creator).toBe('') // 自建歌单创建人即本人，界面不展示
    expect(pls[0].kind).toBe('own')
    expect(pls[0].isDefault).toBe(true) // is_def=1 → 默认收藏
  })

  it('REGRESSION: description 取 intro（旧代码读 description 恒为空）', async () => {
    stubMyPlaylists([COLLECT_ENTRY])
    const pls = await getMyPlaylists(SESSION)
    expect(pls[0].description).toBe('VIP歌单选取周杰伦150首歌曲')
  })

  it('收藏歌单 kind=collect 且展示原作者', async () => {
    stubMyPlaylists([COLLECT_ENTRY])
    const pls = await getMyPlaylists(SESSION)
    expect(pls[0].kind).toBe('collect')
    expect(pls[0].creator).toBe('周杰伦粉丝')
    expect(pls[0].isDefault).toBe(false)
    expect(pls[0].id).toBe('3')
    expect(pls[0].cover).toContain('https://')
    expect(pls[0].cover).toContain('/300/') // {size} 占位符替换
  })

  it('「我喜欢」is_def=2 → own + isDefault', async () => {
    stubMyPlaylists([FAV_ENTRY])
    const pls = await getMyPlaylists(SESSION)
    expect(pls[0].kind).toBe('own')
    expect(pls[0].isDefault).toBe(true)
  })

  it('多条目混排：自建/收藏/系统默认各自正确标注', async () => {
    stubMyPlaylists([OWN_ENTRY, FAV_ENTRY, COLLECT_ENTRY])
    const pls = await getMyPlaylists(SESSION)
    expect(pls).toHaveLength(3)
    expect(pls.map((p) => [p.id, p.kind, p.isDefault, p.creator])).toEqual([
      ['1', 'own', true, ''],
      ['2', 'own', true, ''],
      ['3', 'collect', false, '周杰伦粉丝'],
    ])
  })

  it('未登录抛错', async () => {
    await expect(getMyPlaylists({ mid: '123', token: '' })).rejects.toThrow('未登录')
  })
})
