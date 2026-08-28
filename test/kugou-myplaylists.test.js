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
import { getMyPlaylists, collectPlaylist, getCollectedPlaylistSongs } from '../lib/kugou.js'

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
  list_create_gid: 'collection_3_1030901891_69_0',
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

  it('系统默认歌单带 isDef/isLike：默认收藏 isDef=1、我喜欢 isDef=2', async () => {
    stubMyPlaylists([OWN_ENTRY, FAV_ENTRY])
    const pls = await getMyPlaylists(SESSION)
    expect(pls[0].isDef).toBe(1) // 默认收藏
    expect(pls[0].isLike).toBe(false)
    expect(pls[1].isDef).toBe(2) // 我喜欢
    expect(pls[1].isLike).toBe(true)
  })

  it('「我喜欢」（is_def=2）无 pic 时用内嵌爱心封面；默认收藏无 pic 保持空封面', async () => {
    stubMyPlaylists([OWN_ENTRY, FAV_ENTRY])
    const pls = await getMyPlaylists(SESSION)
    expect(pls[0].cover).toBe('') // 默认收藏：接口无 pic → 空（前端显示音符占位）
    expect(pls[1].cover).toMatch(/^data:image\/jpeg;base64,/) // 我喜欢：内嵌 QQ 爱心封面
  })

  it('REGRESSION: 默认收藏无 pic 时取歌单第一首歌的封面兜底，且带缓存', async () => {
    // /v7/get_all_list 返回默认收藏（listid=5，无 pic）；/v4/get_list_all_file 返回歌曲（带 cover）
    const songsCalls = []
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      const u = String(url)
      if (u.includes('/v4/get_list_all_file')) {
        songsCalls.push(u)
        return { status: 200, text: async () => JSON.stringify({ status: 1, data: { info: [
          { hash: 'AAAA', name: 'Beyond - 不再犹豫.mp3', singerinfo: [{ name: 'Beyond' }], timelen: 262000, cover: 'http://imge.kugou.com/stdmusic/{size}/20250213/x.jpg', album_id: 1 },
        ] } }), json: async () => ({ status: 1, data: { info: [] } }) }
      }
      return { status: 200, text: async () => JSON.stringify({ status: 1, data: { info: [
        { listid: 5, name: '默认收藏', type: 0, is_def: 1, count: 1 },
      ] } }), json: async () => ({ status: 1, data: { info: [] } }) }
    }))
    const session = { ...SESSION, userid: '999' } // 独立 userid，隔离封面缓存
    const pls = await getMyPlaylists(session)
    expect(pls[0].name).toBe('默认收藏')
    // 歌曲 cover 走 kgCover：{size}→240、http→https
    expect(pls[0].cover).toBe('https://imge.kugou.com/stdmusic/240/20250213/x.jpg')
    const firstCalls = songsCalls.length
    await getMyPlaylists(session)
    expect(songsCalls.length).toBe(firstCalls) // 第二次命中缓存，不再拉取歌单歌曲
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

describe('getMyPlaylists creatorId / originalId', () => {
  it('收藏歌单带 originalId（被收藏的原 specialid）', async () => {
    stubMyPlaylists([COLLECT_ENTRY])
    const pls = await getMyPlaylists(SESSION)
    expect(pls[0].originalId).toBe('69')
  })

  it('自建/系统默认歌单 originalId 为空', async () => {
    stubMyPlaylists([OWN_ENTRY, FAV_ENTRY])
    const pls = await getMyPlaylists(SESSION)
    expect(pls[0].originalId).toBe('')
    expect(pls[1].originalId).toBe('')
  })
})

describe('collectPlaylist（v5/add_list type=1 收藏别人歌单）', () => {
  // 记录上次 v5/add_list 请求的 body + query，供断言收藏语义。
  function stubCollect(response) {
    let last = null
    vi.stubGlobal('fetch', vi.fn(async (url, opts) => {
      const u = new URL(String(url))
      const body = JSON.parse(opts.body || '{}')
      last = { url: String(url), params: Object.fromEntries(u.searchParams), body }
      return { status: 200, text: async () => JSON.stringify(response), json: async () => response }
    }))
    return () => last
  }

  it('type=1 + list_create_userid/list_create_listid/gid（收藏别人歌单）', async () => {
    const getLast = stubCollect({ status: 1, data: { listid: 77 } })
    const r = await collectPlaylist({ specialId: '6409645', creatorId: '2132029040', creatorGid: 'collection_3_2132029040_287_0', name: '周杰伦必听热歌' }, SESSION)
    const last = getLast()
    expect(last.url).toContain('/cloudlist.service/v5/add_list')
    expect(last.body.type).toBe(1) // 1 = 收藏别人歌单（0 = 自建）
    expect(last.body.list_create_userid).toBe('2132029040')
    expect(last.body.list_create_listid).toBe('6409645')
    expect(last.body.list_create_gid).toBe('collection_3_2132029040_287_0')
    expect(last.body.name).toBe('周杰伦必听热歌')
    expect(last.body.userid).toBe('1785839222')
    expect(r).toEqual({ id: 77, name: '周杰伦必听热歌', originalId: '6409645' })
  })

  it('缺少 specialid / 创建者 userid / gid 抛错', async () => {
    await expect(collectPlaylist({ creatorId: '123', name: 'x' }, SESSION)).rejects.toThrow('specialid')
    await expect(collectPlaylist({ specialId: '123', name: 'x' }, SESSION)).rejects.toThrow('创建者 userid')
    await expect(collectPlaylist({ specialId: '123', creatorId: '456', name: '' }, SESSION)).rejects.toThrow('歌单名不能为空')
  })

  it('未登录抛错', async () => {
    await expect(collectPlaylist({ specialId: '123', creatorId: '456', name: 'x' }, { mid: '123', token: '' })).rejects.toThrow('未登录')
  })
})

describe('getMyPlaylists creatorGid（读收藏歌单歌曲的关键）', () => {
  it('收藏歌单带 creatorGid（= 原歌单 global_specialid）', async () => {
    stubMyPlaylists([COLLECT_ENTRY])
    const pls = await getMyPlaylists(SESSION)
    expect(pls[0].creatorGid).toBe('collection_3_1030901891_69_0')
  })

  it('自建/系统默认歌单 creatorGid 为空', async () => {
    stubMyPlaylists([OWN_ENTRY, FAV_ENTRY])
    const pls = await getMyPlaylists(SESSION)
    expect(pls[0].creatorGid).toBe('')
    expect(pls[1].creatorGid).toBe('')
  })
})

describe('getCollectedPlaylistSongs（/pubsongs/v2/get_other_list_file_nofilt）', () => {
  // 模拟 get_other_list_file_nofilt：歌曲在 data.songs（不是 data.info！）。
  function stubCollectedSongs(songs) {
    let lastUrl = null
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      lastUrl = String(url)
      return {
        status: 200,
        text: async () => JSON.stringify({ status: 1, data: { count: songs.length, songs } }),
        json: async () => ({ status: 1, data: { count: songs.length, songs } }),
      }
    }))
    return () => lastUrl
  }

  it('REGRESSION: 传 creatorGid 读收藏歌单歌曲（歌曲在 data.songs）', async () => {
    const getLastUrl = stubCollectedSongs([
      { hash: 'AAAA', name: 'Martin Jensen - All I Wanna Do', singerinfo: [{ name: 'Martin Jensen' }], timelen: 194000, add_mixsongid: 38400225, album_id: 1609448, relate_goods: [] },
      { hash: 'BBBB', name: 'Sigala - Lullaby', singerinfo: [{ name: 'Sigala' }], timelen: 195000, mixsongid: 123, album_id: 1609, relate_goods: [] },
    ])
    const songs = await getCollectedPlaylistSongs('collection_3_1314415167_188_0', SESSION)
    const u = getLastUrl()
    expect(u).toContain('/pubsongs/v2/get_other_list_file_nofilt')
    expect(u).toContain('global_collection_id=collection_3_1314415167_188_0')
    expect(songs.length).toBe(2)
    expect(songs[0].title).toBe('All I Wanna Do') // "歌手 - 标题" 拆开
    expect(songs[0].artists).toEqual(['Martin Jensen'])
    expect(songs[0].mixSongId).toBe(38400225)
  })

  it('缺 gid / 未登录抛错', async () => {
    await expect(getCollectedPlaylistSongs('', SESSION)).rejects.toThrow('gid')
    await expect(getCollectedPlaylistSongs('gid-x', { mid: '123', token: '' })).rejects.toThrow('未登录')
  })
})
