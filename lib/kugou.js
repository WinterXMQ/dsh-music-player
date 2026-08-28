/**
 * lib/kugou.js — 酷狗音乐「扫码登录 + 在线搜索 + 登录态取链」底层模块。
 *
 * 纯 Node（Node ≥ 20，用全局 fetch 与 node:crypto），无第三方依赖，无编译步骤。
 * 能力面与 lib/qq.js 对齐：搜索 / 取链 / 歌词(LRC+逐字 KRC) / 歌单发现与个人歌单
 * 写操作 / 排行榜。实现参考（均经本机实测核验，详见 docs/kugou-integration-research.md）：
 *   - guohuiyuan/music-lib kugou/*（go-music-dl 底层库）：QR 登录、取链多级回退
 *   - MakcRe/KuGouMusicApi util/{helper,crypto,request}.js + module/*.js：签名算法与写操作报文
 *   - 匿名只读端点（mobilecdn/m.kugou.com/songsearch）为老一代 M 站接口，无需签名
 *
 * 签名体系（三套 MD5 双侧加盐，勿混用；完整说明见 docs 文档 §4）：
 *   web     ：MD5(WEB_SALT + sort("k=v"串) + WEB_SALT)            —— 登录二维码相关
 *   android ：MD5(AND_SALT + sort(键)("k=v"串) + body + AND_SALT) —— gateway/tracker 业务接口
 *   trackKey：MD5(hash + 固定盐 + appid + mid + userid)           —— tracker 取链 key 参数
 *
 * ⚠️ 合规：均为非官方接口 + 流播受版权保护音乐，仅用于个人试听/学习，违反平台 ToS，
 * 风险自担；账号风控风险（SSA 验证码/封禁）由使用者承担。
 */

import crypto from 'node:crypto'
import * as KRC from './krc.js'

// =====================================================================
// 常量与基础工具
// =====================================================================

export const WEB_SALT = 'NVPh5oo715z5DIWAeQlhMDsWXXQV4hwt'          // web 版签名盐
export const AND_SALT = 'OIlwieks28dk2k092lksi2UIkp'                 // Android 标准版签名盐
const TRACK_KEY_SALT_V5 = '57ae12eb6890223e355ccfcb74edf70d'         // v5/url 的 key 参数盐
const TRACK_KEY_SALT_V6 = '185672dd44712f60bb1736df5a377e82'         // v6/priv_url 的 tracker_param.key 盐
const PARAMS_KEY_SALT_BASE = `${1005}${AND_SALT}${20489}`            // signParamsKey 头部（标准版）
const PLAYLIST_RSA_PUB = [
  '-----BEGIN PUBLIC KEY-----',
  'MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDIAG7QOELSYoIJvTFJhMpe1s/gbjDJX51HBNnEl5HXqTW6lQ7LC8jr9fWZTwusknp+sVGzwd40MwP6U5yDE27M/X1+UR4tvOGOqp94TJtQ1EPnWGWXngpeIW5GxoQGao1rmYWAu6oi1z9XkChrsUdC6DJE5E221wf/4WLFxwAtRQIDAQAB',
  '-----END PUBLIC KEY-----',
].join('\n')

const UA_ANDROID = 'Android15-1070-11083-46-0-DiscoveryDRADProtocol-wifi'
const UA_WEB = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'

const APPID = 1005             // 酷狗标准版 appid（概念版 lite 为 3116，本项目只用标准版）
const CLIENTVER = 20489        // 标准版版本号
const SRCAPPID = 2919          // 二维码会话用 srcappid
const QR_APPID_CREATE = '1001' // 出码 appid：Android 型（MoeKoe/kgqd 生产同款）。网页型 1014 签发的 token 在网关业务面受限（20017/20028）
const QR_APPID_CHECK = '1005'  // 轮询 appid：MakcRe login_qr_check 同款（util 导出的标准版 appid）

export function md5Hex(s) { return crypto.createHash('md5').update(String(s), 'utf8').digest('hex') }

async function fetchWithTimeout(url, opts = {}, timeoutMs = 12000) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal })
  } finally {
    clearTimeout(timer)
  }
}

// ===================== 签名三件套（纯函数，导出供测试固化向量） =====================

/** web 版签名：参数映射为 "k=v" 后整体字符串排序再拼接（注意：先拼后排序）。 */
export function signWeb(params) {
  const pairs = Object.keys(params || {}).map((k) => `${k}=${params[k]}`).sort().join('')
  return md5Hex(`${WEB_SALT}${pairs}${WEB_SALT}`)
}

/** android 版签名：键排序后拼接 "k=v"（对象值 JSON.stringify）；POST 时 body 原文参与。 */
export function signAndroid(params, data = '') {
  const bodyPart = typeof data === 'string' ? data : JSON.stringify(data)
  const ordered = Object.keys(params || {}).map((k) => {
    const v = params[k]
    return [k, (typeof v === 'object' && v !== null) ? JSON.stringify(v) : String(v)]
  })
  ordered.sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0) : (a[0] < b[0] ? -1 : 1)))
  return md5Hex(`${AND_SALT}${ordered.map(([k, v]) => `${k}=${v}`).join('')}${bodyPart}${AND_SALT}`)
}

/** tracker 取链 key（v5 query 参数 key 与 v6 body tracker_param.key 分别使用两枚盐）。 */
export function trackSignKey(hash, mid, userid = 0, { v6 = false, appid = APPID } = {}) {
  const salt = v6 ? TRACK_KEY_SALT_V6 : TRACK_KEY_SALT_V5
  return md5Hex(`${String(hash).toLowerCase()}${salt}${appid}${mid}${Number(userid) || 0}`)
}

/** signParamsKey：删除歌单等接口的 key 参数（MD5(appid+salt+clientver+clienttime)）。 */
export function signParamsKey(clienttime) {
  return md5Hex(`${PARAMS_KEY_SALT_BASE}${clienttime}`)
}

/**
 * 设备身份：GUID(uuid v4) → MID(MD5 视作十六进制大整数的十进制字符串，39 位左右)。
 * ⚠️ MID 超出 Number 安全范围（~10^38），全程只能当字符串处理；BigInt 转换无损。
 */
export function computeMid(guid) { return BigInt('0x' + md5Hex(guid)).toString() }

export function createDeviceIdentity() {
  const guid = crypto.randomUUID()
  const mid = computeMid(guid)
  const dfid = md5Hex(`${process.hrtime.bigint()}dsh`).toUpperCase().slice(0, 24)
  return { guid, mid, dfid }
}

/** 校验调用方传来的 session 形状并补默认值（cookie 里只有部分字段也能工作）。 */
function normSession(session) {
  const s = session && typeof session === 'object' ? session : {}
  if (!s.mid || !/^\d+$/.test(String(s.mid))) {
    throw new Error('kugou session 缺少有效设备标识（mid）')
  }
  return { ...s, dfid: s.dfid || '-', userid: s.userid || 0, token: s.token || '' }
}

// =====================================================================
// 请求封装
// =====================================================================

// 公共网关 query 参数（android 签名栈必需），登录后注入 token/userid。
function gatewayDefaults(session, overrideClientver = null) {
  const s = normSession(session)
  const d = {
    dfid: s.dfid,
    mid: s.mid,
    uuid: '-',
    appid: APPID,
    clientver: overrideClientver || CLIENTVER,
    clienttime: String(Math.floor(Date.now() / 1000)),
  }
  if (s.token) d.token = s.token
  if (s.userid && s.userid !== '0') d.userid = String(s.userid)
  return { s, d }
}

const GATEWAY_HEADERS = (s, clienttime) => ({
  'User-Agent': UA_ANDROID,
  dfid: s.dfid,
  mid: s.mid,
  clienttime,
  'kg-rc': '1',
  'kg-thash': '5d816a0',
  'kg-rec': '1',
  'kg-rf': 'B9EDA08A64250DEFFBCADDEE00F8F25F',
})

/**
 * Android 网关请求（GET 或 POST JSON）。path 自带后端命名空间（如 /ocean/v6/rank/list，
 * 已实测匿名可用）；带 body 时走 POST 并把 body 原文并入签名。
 */
async function kgGateway(path, params, session, { method = 'GET', data = null, headers = {}, timeoutMs = 12000 } = {}) {
  const { s, d } = gatewayDefaults(session)
  const merged = { ...d, ...(params || {}) }
  const bodyText = data === null || data === undefined
    ? ''
    : (Buffer.isBuffer(data) || typeof data !== 'object') ? String(data) : JSON.stringify(data)
  const q = new URLSearchParams({ ...merged, signature: signAndroid(merged, bodyText) })
  const res = await fetchWithTimeout(`https://gateway.kugou.com${path}?${q.toString()}`, {
    method,
    headers: { ...GATEWAY_HEADERS(s, merged.clienttime), ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}), ...headers },
    ...(method === 'POST' ? { body: bodyText } : {}),
  }, timeoutMs)
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* 保持 null */ }
  return { status: res.status, json, text }
}

// =====================================================================
// 扫码登录（原生酷狗二维码；已实测：出码端点返回 base64 PNG，轮询 status=4 直接给 token）
// =====================================================================

export async function createQRLogin(device = {}) {
  const dev = device.mid ? device : createDeviceIdentity()
  const params = {
    appid: QR_APPID_CREATE, // Android 型出码（关键：token 才能通吃网关业务面）
    type: '1',
    plat: '4',
    qrcode_txt: 'https://h5.kugou.com/apps/loginQRCode/html/index.html?appid=1005&',
    srcappid: String(SRCAPPID),
    dfid: device.dfid || dev.dfid || '-', // 已注册的真 dfid 优先（token 将绑定该设备）
    mid: dev.mid,
    uuid: '-',
    clienttime: String(Math.floor(Date.now() / 1000)),
    clientver: String(CLIENTVER),
  }
  const q = new URLSearchParams({ ...params, signature: signWeb(params) })
  const res = await fetchWithTimeout(`https://login-user.kugou.com/v2/qrcode?${q.toString()}`, {
    headers: { 'User-Agent': UA_WEB },
  })
  const j = await res.json().catch(() => null)
  const code = j && j.data && j.data.qrcode
  if (!code) throw new Error(`酷狗二维码获取失败（errcode=${(j && j.error_code) || res.status}）`)
  let imageDataUrl = ''
  const img = j.data && j.data.qrcode_img
  if (typeof img === 'string' && img.startsWith('data:image')) imageDataUrl = img
  return {
    source: 'kugou', key: String(code),
    imageDataUrl,
    url: `https://h5.kugou.com/apps/loginQRCode/html/index.html?qrcode=${encodeURIComponent(code)}`,
    expiresAt: Date.now() + 4 * 60 * 1000,
    extra: { device: { guid: dev.guid, mid: dev.mid, dfid: dev.dfid } },
  }
}

// 轮询状态码：0 过期 / 1 等待 / 2 已扫待确认 / 4 成功（成功时响应体携带 token+userid）
function mapQRStatus(code) { return { 0: 'expired', 1: 'waiting', 2: 'scanned', 4: 'success' }[Number(code)] || 'failed' }

export async function checkQRLogin(keyStr, device = {}) {
  const v = new URLSearchParams(keyStr)
  const key = (v.get('key') || v.get('qrcode') || keyStr || '').trim()
  if (!key) throw new Error('酷狗扫码 key 缺失')
  const dev = device.mid ? device : createDeviceIdentity()
  const params = {
    plat: '4',
    appid: QR_APPID_CHECK, // 轮询 appid 与出码可不同（MakcRe 即 1005）
    srcappid: String(SRCAPPID),
    qrcode: key,
    dev: device.dev || '',
    dfid: device.dfid || '-', // 与出码时同一设备身份（dfid 绑定校验）
    mid: dev.mid,
    uuid: '-',
    clienttime: String(Math.floor(Date.now() / 1000)),
    clientver: String(CLIENTVER),
  }
  const q = new URLSearchParams({ ...params, signature: signWeb(params) })
  const res = await fetchWithTimeout(`https://login-user.kugou.com/v2/get_userinfo_qrcode?${q.toString()}`, {
    headers: { 'User-Agent': UA_WEB },
  })
  const j = await res.json().catch(() => null)
  const code = Number(j && j.data && j.data.status)
  const result = {
    source: 'kugou',
    key: `key=${encodeURIComponent(key)}`,
    status: mapQRStatus(j ? code : 'x'),
    message: '',
    extra: { code },
  }
  result.message = { expired: '二维码已过期', waiting: '等待扫码中', scanned: '已扫码，请在酷狗 App 中确认', success: '登录成功' }[result.status] || (j && j.error) || '状态未知'
  if (result.status === 'success' && j.data && j.data.token) {
    result.tokenInfo = {
      token: String(j.data.token),
      userid: String(j.data.userid || ''),
      vip_type: String((j.data.vip_type != null && j.data.vip_type) || ''),
      vip_token: String((j.data.vip_token != null && j.data.vip_token) || ''),
    }
  }
  return result
}

// =====================================================================
// 搜索 / 发现（匿名可用；song_search_v2 为 HTTPS 实测可靠，mobilecdn 老接口仅 HTTP）
// =====================================================================

export function decodeEntities(str) {
  if (typeof str !== 'string' || str === '') return str
  return str
    .replace(/&#(\d+);/g, (m, n) => { const cp = Number(n); return Number.isFinite(cp) && cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m })
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&nbsp;/g, '\u00a0')
}
const dec = decodeEntities
const emStrip = (s) => dec(String(s ?? '').replace(/<\/?em(?:\s[^>]*)?>/gi, ''))
const kgCover = (u, size = 240) => dec(String(u ?? '').replace(/\{size\}/g, String(size)).replace(/^http:/, 'https:'))
const lowHash = (h) => String(h || '').trim().toLowerCase()

/** 从 "歌手 - 标题" 型 filename 拆出歌手/标题（酷狗歌单详情的歌曲名藏在这里）。 */
export function splitFileName(fn) {
  const s = dec(String(fn || '')).replace(/\.(mp3|flac|m4a|ogg|ape|wav)$/i, '')
  const i = s.indexOf(' - ')
  if (i <= 0) return { title: s, artists: [] }
  return { title: s.slice(i + 3).trim(), artists: [s.slice(0, i).trim()] }
}

/** 统一歌曲形状（对齐 qq.js 结果字段 + 酷狗特有 hash 组）。 */
export function normalizeSong(o, opts = {}) {
  const hash = lowHash(opts.hashKey ? o[opts.hashKey] : o.hash)
  const arts = Array.isArray(o.authors)
    ? o.authors.map((a) => emStrip(a.author_name)).filter(Boolean)
    : (() => {
        const raw = o.SingerName != null ? o.SingerName : (o.singername || o.nickname || '')
        // 先剥离 <em> 高亮标签再按分隔符拆分：若先 split，`</em>` 里的 `/` 会把
        // "<em>周杰伦</em>" 切成 ["<em>周杰伦<", "em>"]，emStrip 只能清出残缺的
        // "周杰伦< / em>"（正是「歌手名后带 </em>」的根因）。
        return emStrip(String(raw)).split(/、|\/|,/).map((x) => x.trim()).filter(Boolean)
      })()
  let title = emStrip(o.songname != null && o.songname !== '' ? o.songname : (o.SongName ?? ''))
  if (title === '' && o.filename) {
    const sp = splitFileName(o.filename)
    // filename 里的标题/歌手同样可能带 <em> 高亮（按歌手名搜索时整段被包），
    // 拆出来的 title/artists 也要统一过 emStrip，避免原样漏进 UI。
    title = emStrip(sp.title)
    if (arts.length === 0) arts.splice(0, 0, ...sp.artists.map(emStrip))
  }
  const durSec = Number(opts.durationKey ? o[opts.durationKey] : o.duration)
  const albumAudioId = Number(o.album_audio_id || o.Audioid || o.audio_id || 0) || 0
  return {
    id: hash,
    hash,
    hqHash: lowHash(o.HQFileHash ?? o['320hash'] ?? o.hqhash ?? ''),
    sqHash: lowHash(o.SQFileHash ?? o.sqhash ?? ''),
    hiResHash: lowHash(o.ResFileHash ?? o.hash_high ?? ''),
    superHash: lowHash(o.SuperFileHash ?? o.hash_super ?? ''),
    title,
    artists: arts,
    album: emStrip(o.albumname || o.AlbumName || o.album_name || o.albuminfo?.albumname || ''),
    interval: Number.isFinite(durSec) ? durSec : 0,
    albumAudioId,
    mixSongId: Number(o.MixSongID || o.mixsongid || 0) || 0,
    albumId: Number(o.album_id || o.AlbumID || 0) || 0,
    privilege: Number(o.Privilege ?? o.privilege ?? 0) || 0,
    payType: Number(o.PayType ?? o.pay_type ?? 0) || 0,
    cover: kgCover(o.Image || o.album_sizable_cover || o.sizable_avatar || ''),
    source: 'kugou',
  }
}

/** 歌曲搜索（匿名，HTTPS）。返回 { results, total, page }，每页 20 条与 qq.search 对齐。 */
export async function search(keyword, _cookie = '', page = 1) {
  const p = Math.max(1, parseInt(page, 10) || 1)
  const q = new URLSearchParams({
    keyword: String(keyword || ''), page: String(p), pagesize: '20',
    format: 'json', platform: 'WebFilter', userid: '-1', clientver: '', filter: '2',
    iscorrection: '1', privilege_filter: '0', tag: 'em', _: String(Date.now()),
  })
  const res = await fetchWithTimeout(`https://songsearch.kugou.com/song_search_v2?${q.toString()}`, {
    headers: { 'User-Agent': UA_WEB, Referer: 'https://www.kugou.com/' },
  })
  const j = await res.json().catch(() => null)
  if (!j || Number(j.status) !== 1 || !j.data) throw new Error(`酷狗搜索失败（status=${j && j.status}）`)
  const lists = Array.isArray(j.data.lists) ? j.data.lists : []
  return {
    results: lists.map((o) => normalizeSong(o, { durationKey: 'Duration', hashKey: 'FileHash' })).filter((x) => x.hash),
    total: Number(j.data.total) || lists.length,
    page: p,
  }
}

// -------------------- 榜单 --------------------

/** 排行榜全量列表（Android 网关匿名实测通过；同时保留 mobilecdn HTTP 兜底）。 */
export async function getTopLists(_session = {}) {
  let infos = null
  try {
    const r = await kgGateway('/ocean/v6/rank/list', { plat: 2, withsong: 1, parentid: 0 }, _session)
    if (r.json && r.json.status === 1 && r.json.data && Array.isArray(r.json.data.info)) infos = r.json.data.info
  } catch { /* 网关失败回落老接口 */ }
  if (!infos) {
    const res = await fetchWithTimeout('http://mobilecdn.kugou.com/api/v3/rank/list?version=9108&area_code=1', {
      headers: { 'User-Agent': UA_WEB, Referer: 'http://m.kugou.com/' },
    })
    const j = await res.json().catch(() => null)
    infos = (j && j.status === 1 && j.data && j.data.info) || []
  }
  const toplists = infos.filter((t) => t.rankid).map((t) => ({
    id: String(t.rankid),
    name: emStrip(t.rankname),
    intro: dec(t.intro || ''),
    cover: kgCover(t.imgurl || t.img_cover || t.banner_9, 300),
    listenNum: Number(t.play_times) || 0,
    totalNum: Number(t.count) || 0,
    updateTime: dec(t.update_frequency || ''),
    period: dec(t.rank_id_publish_date || ''),
  }))
  return [{ id: '', name: '', toplists }]
}

/** 榜单详情歌曲（分页 offset/num，对齐 qq.getTopListSongs 返回形状）。 */
export async function getTopListSongs(rankId, _session = {}, offset = 0, num = 30) {
  const off = Math.max(0, parseInt(offset, 10) || 0)
  const size = Math.max(1, Math.min(50, parseInt(num, 10) || 30))
  const page = Math.floor(off / size) + 1
  const rankid = String(rankId).trim()
  if (!/^[0-9]+$/.test(rankid)) throw new Error('bad rankid')
  const res = await fetchWithTimeout(
    `http://mobilecdn.kugou.com/api/v3/rank/song?version=9108&area_code=1&rankid=${rankid}&page=${page}&pagesize=${size}&plat=0`,
    { headers: { 'User-Agent': UA_WEB, Referer: 'http://m.kugou.com/' } },
  )
  const j = await res.json().catch(() => null)
  if (!j || Number(j.status) !== 1 || !j.data) throw new Error('酷狗榜单获取失败')
  const songs = (j.data.info || []).map((o) => normalizeSong(o)).filter((x) => x.hash)
  // 榜单总数在 data.total（如 TOP500=500），而不是 count（该接口没有 count 字段）。
  // 旧代码只读 count → total 永远等于当前页长度 → hasMore 恒 false → 榜单没有「加载更多」。
  const total = Math.max(Number(j.data.total) || Number(j.data.count) || songs.length + off, songs.length + off)
  return {
    id: rankid,
    name: emStrip(j.data.name || j.data.rankname || ''),
    cover: kgCover(j.data.imgurl || '', 300),
    intro: '',
    updateTime: dec(j.data.update_frequency || '') || dec(j.data.publish_date || ''),
    total,
    hasMore: off + songs.length < total,
    songs,
  }
}

// -------------------- 歌单（推荐/分类/搜索/详情，均匿名）--------------------

const PL_LINK = (specialId) => `https://www.kugou.com/yy/special/single/${specialId}.html`

function normalizePlaylistItem(o) {
  return {
    id: String(o.specialid ?? o.special_id ?? o.id ?? ''),
    name: emStrip(o.specialname || o.name || ''),
    cover: kgCover(o.imgurl || o.img || o.sizable_cover, 300),
    playCount: Number(o.playcount ?? o.play_count ?? o.collectcount ?? 0) || 0,
    trackCount: Number(o.songcount ?? o.count ?? 0) || 0,
    creator: emStrip(o.username || o.nickname || ''),
    description: dec(typeof o.intro === 'string' ? o.intro : ''),
    source: 'kugou',
    link: PL_LINK(o.specialid ?? o.id),
  }
}

/** 推荐歌单（热门精选，匿名；HTTP-only 老接口，Host 出网无碍）。 */
export async function getRecommendedPlaylists(_cookieOrSession = {}, page = 1) {
  const p = Math.max(1, parseInt(page, 10) || 1)
  const res = await fetchWithTimeout(`http://m.kugou.com/plist/index?json=true&page=${p}`, {
    headers: { 'User-Agent': UA_WEB, Referer: 'http://m.kugou.com/' },
  })
  const j = await res.json().catch(() => null)
  const list = ((j && j.plist && j.plist.list && j.plist.list.info) || [])
  return { playlists: list.map(normalizePlaylistItem).filter((x) => x.id), total: (j && j.plist && j.plist.list && j.plist.list.total) || list.length, page: p }
}

/** 确保有可用的设备会话（网关签名必需 mid/dfid）。传入的 session 缺 mid 时，
 *  临时创建设备身份并注册真实 dfid（匿名浏览分类也走 Android 网关签名）。 */
async function ensureDeviceSession(session = {}) {
  if (session && session.mid) return session
  const dev = createDeviceIdentity()
  let s = { mid: dev.mid, dfid: dev.dfid || '-', guid: dev.guid, token: '', userid: 0 }
  try {
    const reg = await registerDevice(s)
    if (reg && reg.dfid) s.dfid = reg.dfid
  } catch { /* 签名兜底用临时 dfid 即可 */ }
  return s
}

/** 歌单分类（酷狗权威接口 pubsongs/v1/get_tags_by_type，Android 网关签名）。
 *  返回两级结构：[{ id, name, children: [{ id, name }] }]。
 *  id 编码为 `"<父tag_id>:<子tag_id>"`（一级子分类 id 为 `<tag_id>:`），
 *  供 getCategoryPlaylists 解析后把 tagid(子) 与 id(父) 传给 specialList。
 */
export async function getPlaylistCategories(session = {}) {
  const s = await ensureDeviceSession(session)
  const body = { tag_type: 'collection', tag_id: 0, source: 3 }
  const r = await kgGateway('/pubsongs/v1/get_tags_by_type', {}, s, {
    method: 'POST', data: body, headers: { 'x-router': 'gateway.kugou.com' },
  })
  const j = r && r.json
  if (!j || !Array.isArray(j.data)) throw new Error(`酷狗分类获取失败（status=${r && r.status}）`)
  const cats = []
  for (const g of j.data) {
    const gname = (g.tag_name || '').trim()
    const gid = g.tag_id != null && g.tag_id !== '' ? String(g.tag_id) : ''
    if (!gname || gid === '') continue
    const kids = []
    for (const c of (Array.isArray(g.son) ? g.son : [])) {
      if (c.tag_id == null || !c.tag_name) continue
      kids.push({ id: gid + ':' + String(c.tag_id), name: (c.tag_name || '').trim() })
    }
    cats.push({ id: gid + ':', name: gname, children: kids })
  }
  return cats
}

/** 分类歌单：解析 `"<父tag_id>:<子tag_id>"`，把 tagid(子) 与 id(父) 同时传给 specialList 分页。 */
export async function getCategoryPlaylists(categoryId, page = 1, limit = 20, _session = {}) {
  const p = Math.max(1, parseInt(page, 10) || 1)
  const n = Math.max(1, Math.min(50, parseInt(limit, 10) || 20))
  let id = '', tagid = '0'
  if (categoryId != null && String(categoryId).indexOf(':') !== -1) {
    const [a, b] = String(categoryId).split(':')
    id = a || ''
    tagid = b || '0'
  } else if (categoryId) {
    id = String(categoryId)
  }
  const q = new URLSearchParams({ plat: '0', page: String(p), tagid: String(tagid), pagesize: String(n), sort: '2', ugc: '1', id })
  const res = await fetchWithTimeout(`http://mobilecdnbj.kugou.com/api/v3/tag/specialList?${q.toString()}`, {
    headers: { 'User-Agent': UA_WEB, Referer: 'http://m.kugou.com/' },
  })
  const j = await res.json().catch(() => null)
  if (!j || Number(j.status) !== 1 || !j.data) throw new Error('酷狗分类歌单获取失败')
  const list = Array.isArray(j.data.info) ? j.data.info : []
  return list.map(normalizePlaylistItem).filter((x) => x.id)
}

/** 歌单搜索。 */
export async function searchPlaylist(keyword, _session = '', page = 1) {
  const p = Math.max(1, parseInt(page, 10) || 1)
  const q = new URLSearchParams({ keyword: String(keyword || ''), platform: 'WebFilter', format: 'json', page: String(p), pagesize: '20', filter: '0' })
  const res = await fetchWithTimeout(`http://mobilecdn.kugou.com/api/v3/search/special?${q.toString()}`, {
    headers: { 'User-Agent': UA_WEB, Referer: 'http://m.kugou.com/' },
  })
  const j = await res.json().catch(() => null)
  if (!j || Number(j.status) !== 1 || !j.data) throw new Error('酷狗歌单搜索失败')
  const list = Array.isArray(j.data.info) ? j.data.info : []
  return { results: list.map(normalizePlaylistItem).filter((x) => x.id), total: Number(j.data.total) || list.length, page: p }
}

/** 歌单详情 + 全部歌曲（specialid；filename 是 "歌手 - 标题"，逐项拆开）。 */
export async function getPlaylistSongs(specialId, _session = {}) {
  const sid = String(specialId).trim()
  if (!/^[0-9]+$/.test(sid)) throw new Error('bad specialid')
  // 歌单元数据（名称/封面）从 tag specialList 结构拿不到稳点，走同名 gcid 页面太重；
  // 直接以 special/song 第一页的 trans_param/globalid 不可靠 —— 用 m 站 v3 special/info：
  const metaRes = await fetchWithTimeout(`http://mobilecdn.kugou.com/api/v3/special/info?specialid=${sid}&version=9108`, {
    headers: { 'User-Agent': UA_WEB, Referer: 'http://m.kugou.com/' },
  }).then((r) => r.json()).catch(() => null)
  const meta = (metaRes && metaRes.status === 1 && metaRes.data) || {}

  const res = await fetchWithTimeout(`http://mobilecdn.kugou.com/api/v3/special/song?specialid=${sid}&page=1&pagesize=300&version=9108&area_code=1`, {
    headers: { 'User-Agent': UA_WEB, Referer: 'http://m.kugou.com/' },
  })
  const j = await res.json().catch(() => null)
  if (!j || Number(j.status) !== 1 || !j.data) throw new Error('酷狗歌单详情获取失败')
  const songs = (j.data.info || []).map((o) => normalizeSong(o)).filter((x) => x.hash)
  return {
    id: sid,
    name: emStrip(meta.specialname || ''),
    creator: emStrip(meta.nickname || ''),
    description: dec(typeof meta.intro === 'string' ? meta.intro : ''),
    cover: kgCover(meta.imgurl, 300),
    trackCount: Number(j.data.total) || Number(j.data.count) || songs.length,
    source: 'kugou',
    link: PL_LINK(sid),
    songs,
  }
}

// =====================================================================
// 取链（播放直链）：核心差异点 —— 匿名路已被确认死亡，必须登录态
// 主路 v6/priv_url（多音质一次提交）；备路 v5/url（单档循环）。
// =====================================================================

// 从 tracker 应答元素中提取第一个可用流地址（兼容 url 数组/字符串、backup 字段）。
function pickStreamUrl(e) {
  if (!e || typeof e !== 'object') return ''
  for (const k of ['url', 'play_url', 'backupUrl', 'backup_url']) {
    let v = e[k]
    if (typeof v === 'string') v = [v]
    if (!Array.isArray(v)) continue
    for (const u of v) {
      if (typeof u !== 'string' || u === '') continue
      if (/^https?:\/\//.test(u)) return u
      if (u.startsWith('//')) return 'https:' + u
    }
  }
  return ''
}

// 音质标签与 QQ 音乐的三档一致（无损 / 高音质 / 标准），保证播放条音质徽章格式统一。
const QUALITY_LABELS = { flac: '无损', high: '无损', 320: '高音质', 128: '标准', super: '无损', multitrack: '无损' }

/**
 * 登录态取链。song: {hash, sqHash?, albumAudioId?, albumId?}；prefer 档位从优到劣。
 * 返回 { url, quality, bitrate } 或 { url:'' }（拿不到明确抛错交给上层提示）。
 */
export async function getDownloadURL(song, session = {}, prefer = ['flac', '320', '128']) {
  const s = normSession(session)
  const primaryHash = lowHash(song.hash) || lowHash(song.hqHash) || lowHash(song.sqHash)
  if (!primaryHash) throw new Error('缺少歌曲 hash')
  const ladder = ['flac', 'high', '320', '128']
  const want = prefer.filter((x) => ladder.includes(x))
  const qualities = want.length > 0 ? [...new Set([...want, ...ladder])] : ladder
  const hashForQuality = (quality) => ({
    128: primaryHash,
    320: lowHash(song.hqHash) || primaryHash,
    flac: lowHash(song.sqHash) || primaryHash,
    high: lowHash(song.hiResHash) || primaryHash,
    super: lowHash(song.superHash) || primaryHash,
    multitrack: primaryHash,
  })[quality] || primaryHash

  const albumAudioId = Number(song.albumAudioId) || 0
  const albumId = Number(song.albumId) || 0

  // ---- 主路：v5/url 单档循环（x-router: trackercdn.kugou.com）。----
  // 2025-08 实测：v5 为唯一稳定通道（真 dfid+标准 token 时各档按账号权限授予）。
  let lastExplain = ''
  for (const quality of ['flac', 'high', '320', '128']) {
    const qHash = hashForQuality(quality)
    const { d } = gatewayDefaults(s)
    const params = {
      ...d,
      area_code: 1,
      behavior: 'play',
      cmd: 26,
      pid: 2,
      pidversion: 3001,
      hash: qHash,
      album_id: albumId,
      album_audio_id: albumAudioId,
      quality,
      ssa_flag: 'is_fromtrack',
      version: 11430,
      page_id: 151369488,
      ppage_id: '463467626,350369493,788954147',
      IsFreePart: 0,
      cdnBackup: 1,
      module: '',
      clientver: 11430,
      key: trackSignKey(qHash, s.mid, s.userid, { appid: APPID }),
    }
    let json = null
    try {
      const q = new URLSearchParams({ ...params, signature: signAndroid(params) })
      const res = await fetchWithTimeout(`https://gateway.kugou.com/v5/url?${q.toString()}`, {
        headers: { ...GATEWAY_HEADERS(normSession(s), params.clienttime), 'x-router': 'trackercdn.kugou.com' },
      })
      json = await res.json().catch(() => null)
    } catch {
      lastExplain = lastExplain || `v5/${quality} 网络异常`
      continue
    }
    if (!json || Number(json.status) !== 1) {
      lastExplain = explainKgError(json, 200)
      continue // 无权限/无该档 → 尝试下一档
    }
    // 应答形状兼容：可能是数组、扁平对象（含 url/backupUrl 字段）
    const candidates = []
      .concat(Array.isArray(json.data) ? json.data : [])
      .concat([json])
      .filter((e) => e && typeof e === 'object')
    for (const e of candidates) {
      const url = pickStreamUrl(e)
      if (url) {
        return { url, quality: QUALITY_LABELS[quality] || quality, bitrate: Number(e.bitrate) || Number(json.bitrate) || 0, hash: qHash }
      }
    }
  }

  // ---- 兜底：v6/priv_url（多档一次提交；body 契约不稳，失败静默降级）----
  try {
    const body = {
      area_code: '1',
      behavior: 'play',
      qualities,
      resource: {
        album_audio_id: albumAudioId,
        collect_list_id: '3',
        collect_time: Date.now(),
        hash: primaryHash,
        id: 0,
        page_id: 1,
        type: 'audio',
      },
      token: s.token,
      tracker_param: {
        all_m: 1,
        auth: '',
        is_free_part: 0,
        key: trackSignKey(primaryHash, s.mid, s.userid, { v6: true }),
        module_id: 0,
        need_climax: 1,
        need_xcdn: 1,
        open_time: '',
        pid: '411',
        pidversion: '3001',
        priv_vip_type: '6',
        viptoken: s.vipToken || s.vip_token || '',
      },
      userid: String(s.userid || ''),
      vip: Number(s.vipType || s.vip_type || 0) || 0,
    }
    for (const base of ['https://tracker.kugou.com', 'http://tracker.kugou.com']) {
      const { d } = gatewayDefaults(s)
      const merged = { ...d }
      const q = new URLSearchParams({ ...merged, signature: signAndroid(merged, JSON.stringify(body)) })
      const res = await fetchWithTimeout(`${base}/v6/priv_url?${q.toString()}`, {
        method: 'POST',
        headers: { ...GATEWAY_HEADERS(normSession(s), merged.clienttime), 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const j2 = await res.json().catch(() => null)
      if (!(j2 && Number(j2.status) === 1)) continue
      const entries = Array.isArray(j2.data) ? j2.data : []
      for (let i = 0; i < entries.length; i++) {
        const labelByIndex = qualities[i]
        const url = pickStreamUrl(entries[i])
        if (!url) continue
        const bitrate = Number(entries[i].bitrate) || Number(entries[i].kbps) || 0
        return { url, quality: QUALITY_LABELS[labelByIndex] || String(labelByIndex), bitrate, hash: hashForQuality(labelByIndex) }
      }
      break
    }
  } catch { /* 兜底失败静默 */ }

  throw new Error('酷狗取链失败：' + (lastExplain || '未获得播放地址（VIP/版权限制或需重新扫码登录）'))
}

// =====================================================================
// 歌词：LRC（fmt=lrc）/ 逐字 KRC（fmt=krc → lib/krc.js 解密解析 + 内嵌翻译）
// =====================================================================

async function searchLyricCandidates({ hash = '', keyword = '', durationSec = 0, albumAudioId = 0 }) {
  const q = new URLSearchParams({
    ver: '1', man: 'yes', client: 'mobi', keyword: String(keyword || ''), duration: '',
    hash: String(hash || ''), album_audio_id: String(albumAudioId || ''),
  })
  const res = await fetchWithTimeout(`https://krcs.kugou.com/search?${q.toString()}`, {
    headers: { 'User-Agent': UA_WEB, Referer: 'http://m.kugou.com/' },
  })
  const j = await res.json().catch(() => null)
  if (!j || Number(j.status) !== 200 || !Array.isArray(j.candidates)) return []
  return j.candidates
}

async function downloadLyric(id, accesskey, fmt) {
  const q = new URLSearchParams({ ver: '1', fmt, client: 'mobi', id: String(id), accesskey: String(accesskey), charset: 'utf8' })
  const res = await fetchWithTimeout(`https://krcs.kugou.com/download?${q.toString()}`, {
    headers: { 'User-Agent': UA_WEB, Referer: 'http://m.kugou.com/' },
  })
  const j = await res.json().catch(() => null)
  if (!j || Number(j.status) !== 200 || !j.content) throw new Error('歌词下载失败')
  return Buffer.from(j.content, 'base64')
}

/** 普通 LRC：搜索候选 → fmt=lrc 下载，返回 { lyric }。 */
export async function getLyric({ hash = '', keyword = '', durationSec = 0, title = '', artist = '' }) {
  const kw = keyword || [title, artist].filter(Boolean).join(' ')
  const candidates = await searchLyricCandidates({ hash, keyword: kw, durationSec })
  const best = KRC.pickLyricCandidate(candidates, { durationSec, title })
  if (!best) throw new Error('酷狗未找到歌词候选')
  const buf = await downloadLyric(best.id, best.accesskey, 'lrc')
  const lyric = buf.toString('utf8')
  if (!lyric.trim()) throw new Error('酷狗歌词为空')
  return { lyric }
}

/** 逐字 KRC：解密 + 解析成与 qrc.js 相同的行窗口结构；翻译可选内嵌返回。 */
export async function getWordLines({ hash = '', keyword = '', durationSec = 0, title = '', artist = '' }) {
  const kw = keyword || [title, artist].filter(Boolean).join(' ')
  const candidates = await searchLyricCandidates({ hash, keyword: kw, durationSec })
  const best = KRC.pickLyricCandidate(candidates, { durationSec, title })
  if (!best) throw new Error('酷狗未找到 KRC 候选')
  const buf = await downloadLyric(best.download_id || best.id, best.accesskey, 'krc')
  const plain = KRC.decryptKrc(buf)
  if (!plain || !plain.includes('[')) throw new Error('KRC 解密失败')
  const parsed = KRC.parseKrc(plain)
  if (!parsed || parsed.lines.length === 0) return null // 无时间轴内容，让调用方回落 LRC
  const out = { kind: 'krc', lines: parsed.lines.map(({ words, ...rest }) => rest) }
  if (parsed.translations && parsed.translations.length > 0) out.translations = parsed.translations
  return out
}

// =====================================================================
// 设备注册（r_register_dev）：真实 dfid 是登录后所有敏感接口的前提。
// 未注册设备上出码登录的 token 会处处撞风控 —— 取链 20028「本次请求需要验证」、
// 云歌单 20017（MakcRe 官方文档原文：获取 url 接口需先调 /register/dev 拿 dfid）。
// 加密方案与删除歌单同族：AES-128-CBC(密钥派生自随机短盐) 加密 body，RSA 包装密钥进 p 参数。
// =====================================================================

/** 随机 6 位小写字母数字短盐（与参考实现 randomString(6) 同长度）。 */
function kxRandomSeed() {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789'
  let out = ''
  const bytes = crypto.randomBytes(6)
  for (let i = 0; i < 6; i++) out += alphabet[bytes[i] % alphabet.length]
  return out
}

/** AES-128-CBC 封装 JSON 对象：返回 { seed, str }（str 为 base64 密文，原文参与签名）。 */
function kxAesSeal(obj) {
  const seed = kxRandomSeed()
  const digest = md5Hex(seed)
  const encKey = Buffer.from(digest.slice(0, 16), 'utf8')
  const encIv = Buffer.from(digest.slice(16, 32), 'utf8')
  const cipher = crypto.createCipheriv('aes-128-cbc', encKey, encIv)
  const buf = Buffer.concat([cipher.update(JSON.stringify(obj), 'utf8'), cipher.final()])
  return { seed, str: buf.toString('base64') }
}

/** RSA-PKCS1(v1.5) 包裹（HEX 大写输出），用于携带 AES 短盐。 */
function kxRsaWrap(payloadObj) {
  return crypto.publicEncrypt(
    { key: PLAYLIST_RSA_PUB, padding: crypto.constants.RSA_PKCS1_PADDING },
    Buffer.from(JSON.stringify(payloadObj), 'utf8'),
  ).toString('hex').toUpperCase()
}

/** 解开服务端回传的同族 AES 密封应答（raw ArrayBuffer → 明文 JSON）。 */
function kxAesUnseal(rawBuf, seed) {
  const digest = md5Hex(seed)
  const decKey = Buffer.from(digest.slice(0, 16), 'utf8')
  const decIv = Buffer.from(digest.slice(16, 32), 'utf8')
  const decipher = crypto.createDecipheriv('aes-128-cbc', decKey, decIv)
  const out = Buffer.concat([decipher.update(rawBuf), decipher.final()])
  return JSON.parse(out.toString('utf8'))
}

/**
 * 注册设备身份，换取真实 dfid。匿名可调（uid/token 传空串即可），imei/uuid 绑定 GUID。
 * 返回 { dfid }；失败抛错（调用方决定是否降级继续用伪造 dfid）。
 */
export async function registerDevice(session = {}) {
  const s = normSession(session)
  const sealed = kxAesSeal({
    availableRamSize: 4983533568,
    availableRomSize: 48114719,
    availableSDSize: 48114717,
    basebandVer: '',
    batteryLevel: 100,
    batteryStatus: 3,
    brand: 'Redmi',
    buildSerial: 'unknown',
    device: 'marble',
    imei: s.guid || '',
    imsi: '',
    manufacturer: 'Xiaomi',
    uuid: s.guid || '',
    accelerometer: false, accelerometerValue: '',
    gravity: false, gravityValue: '',
    gyroscope: false, gyroscopeValue: '',
    light: false, lightValue: '',
    magnetic: false, magneticValue: '',
    orientation: false, orientationValue: '',
    pressure: false, pressureValue: '',
    step_counter: false, step_counterValue: '',
    temperature: false, temperatureValue: '',
  })
  const p = kxRsaWrap({ aes: sealed.seed, uid: String(s.userid || ''), token: s.token || '' })
  const params = { part: '1', platid: '1', p }
  // 直连 userservice（非网关）：请求体是 base64 字符串原文，参与 android 签名。
  // ⚠️ 签名必须覆盖「公共默认参数 + 业务参数」的全量合并集，只签业务参数会验签失败。
  const { d } = gatewayDefaults(s)
  const merged = { ...d, ...params }
  const q = new URLSearchParams({ ...merged, signature: signAndroid(merged, sealed.str) })
  const res = await fetchWithTimeout(`https://userservice.kugou.com/risk/v2/r_register_dev?${q.toString()}`, {
    method: 'POST',
    headers: { ...GATEWAY_HEADERS(normSession(s), d.clienttime), 'Content-Type': 'text/plain' },
    body: sealed.str,
  }, 15000)
  const raw = Buffer.from(await res.arrayBuffer())
  if (raw.length === 0) throw new Error(`设备注册失败（HTTP ${res.status} 无内容）`)
  let parsed
  try {
    parsed = kxAesUnseal(raw, sealed.seed)
  } catch {
    throw new Error(`设备注册失败（应答不可解 HTTP ${res.status}）`)
  }
  if (!parsed || Number(parsed.status) !== 1 || !(parsed.data && parsed.data.dfid)) {
    throw new Error('设备注册失败：' + ((parsed && (parsed.error || parsed.error_message)) || JSON.stringify(parsed).slice(0, 120)))
  }
  return { dfid: String(parsed.data.dfid) }
}

/** 把服务端业务错误码翻译成人话（统一贯穿各接口）。 */
export function explainKgError(json, httpStatus) {
  const code = Number(json && (json.error_code ?? json.errcode))
  const msg = (json && (json.error || json.message)) || ''
  if (code === 20017 || code === 20018) return `登录态与设备不匹配（${code}），请退出登录后重新扫码`
  if (code === 20028 || /需要验证/.test(String(msg))) return '触发酷狗安全验证，请稍后重试；若持续出现请重新扫码登录'
  if (code === 1002) return '操作过于频繁（风控限流），请稍后再试'
  return `${msg || ('error_code=' + code)}（HTTP ${httpStatus}）`
}

// =====================================================================
// Token 刷新（v5/login_by_token）：kgqd 生产环境每次用前先刷新。
// 把扫码签发的 token 兑换为标准作用域 token，顺带回填 vip_type/vip_token/t1，
// 可消除部分网关接口的 20017 类拒绝。方案（MakcRe module/login_token.js 移植）：
//   p3 = AES(固定 key32/iv16) 加密 {clienttime, token} → HEX
//   params = AES(md5(randKey)前32位 作 AES-256 key、其后16位作 iv) 加密 {} → HEX
//   pk = RSA-NO-PADDING(右侧补零到模长) 加密 {clienttime_ms, params 盐}
//   应答 data.secu_params 用同一派生密钥解出新 token 集合
// =====================================================================

function kxAes256Hex(jsonObj, keyStr) {
  const encKey = Buffer.from(keyStr, 'utf8')                       // 32 字符 hex 串按 utf8 → AES-256
  const encIv = Buffer.from(keyStr.slice(keyStr.length - 16), 'utf8')
  const cipher = crypto.createCipheriv('aes-256-cbc', encKey, encIv)
  return Buffer.concat([cipher.update(JSON.stringify(jsonObj), 'utf8'), cipher.final()]).toString('hex')
}

function kxRandomSeed16() {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789'
  let out = ''
  const bytes = crypto.randomBytes(16)
  for (let i = 0; i < 16; i++) out += alphabet[bytes[i] % alphabet.length]
  return out
}

export async function refreshSession(session = {}) {
  const s = normSession(session)
  if (!s.token) throw new Error('未登录，无法刷新登录态')
  const ms = Date.now()
  const p3 = kxAes256Hex({ clienttime: Math.floor(ms / 1000), token: s.token }, '90b8382a1bb4ccdcf063102053fd75b8')
  const paramSeed = kxRandomSeed16()
  const paramKeyFull = md5Hex(paramSeed)                 // 32 位 → AES-256 密钥（utf8）；末 16 位作 iv
  const encIv = paramKeyFull.slice(paramKeyFull.length - 16, paramKeyFull.length)
  const c2 = crypto.createCipheriv('aes-256-cbc', Buffer.from(paramKeyFull, 'utf8'), Buffer.from(encIv, 'utf8'))
  const paramsHex = Buffer.concat([c2.update('{}', 'utf8'), c2.final()]).toString('hex')
  // RSA-NO-PADDING：右侧补零到「模长字节数」后直接 modexp（等价参考实现的 manual pad + rawEncrypt）
  const pub = PLAYLIST_RSA_PUB
  const json = JSON.stringify({ clienttime_ms: ms, key: paramSeed })
  const pubKeyObj = crypto.createPublicKey(pub)
  const modBits = (pubKeyObj.asymmetricKeyDetails && pubKeyObj.asymmetricKeyDetails.modulusLength) || 1024
  const modLen = Math.ceil(modBits / 8)
  if (Buffer.byteLength(json, 'utf8') > modLen) throw new Error('登录刷新：pk 载荷超长')
  const padded = Buffer.alloc(modLen)
  Buffer.from(json, 'utf8').copy(padded, 0)
  const pk = crypto.publicEncrypt({ key: pubKeyObj, padding: crypto.constants.RSA_NO_PADDING }, padded).toString('hex')

  const dataMap = {
    dfid: s.dfid || '-',
    p3,
    plat: 1,
    t1: 0,
    t2: 0,
    t3: 'MCwwLDAsMCwwLDAsMCwwLDA=',
    pk,
    params: paramsHex,
    userid: String(s.userid || '0'),
    clienttime_ms: ms,
  }
  const bodyText = JSON.stringify(dataMap)
  const { d } = gatewayDefaults(s)
  const merged = { ...d, ...dataMap }
  const q = new URLSearchParams({ ...merged, signature: signAndroid(merged, bodyText) })
  const res = await fetchWithTimeout(`http://login.user.kugou.com/v5/login_by_token?${q.toString()}`, {
    method: 'POST',
    headers: { ...GATEWAY_HEADERS(normSession(s), d.clienttime), 'Content-Type': 'application/json' },
    body: bodyText,
  }, 15000)
  const j = await res.json().catch(() => null)
  if (!j || Number(j.status) !== 1 || !(j.data && (j.data.secu_params || j.data.token))) {
    throw new Error('刷新登录态失败：' + explainKgError(j, res.status))
  }
  if (!j.data.secu_params) {
    return { token: String(j.data.token || ''), userid: String(j.data.userid || s.userid), vip_type: '', vip_token: '', t1: '' }
  }
  // 解开 secu_params：HEX → AES-256-CBC(同 params 派生密钥)
  const decKeyFull = md5Hex(paramSeed)
  const d2 = crypto.createDecipheriv('aes-256-cbc', Buffer.from(decKeyFull, 'utf8'), Buffer.from(decKeyFull.slice(16), 'utf8'))
  const plain = Buffer.concat([d2.update(Buffer.from(String(j.data.secu_params), 'hex')), d2.final()]).toString('utf8')
  let obj
  try { obj = JSON.parse(plain) } catch { obj = { token: plain } }
  return {
    token: String(obj.token || ''),
    userid: String(obj.userid || s.userid),
    vip_type: String(obj.vip_type != null ? obj.vip_type : ''),
    vip_token: String(obj.vip_token != null ? obj.vip_token : ''),
    t1: String(obj.t1 != null ? obj.t1 : ''),
  }
}

// =====================================================================
// 个人歌单（cloudlist.service，需登录 token/userid）
// =====================================================================

const CL_PATH = (p) => `/cloudlist.service${p}`

/** 我的歌单列表（创建 + 收藏都在一个云歌单列表里；type 2 = 全部）。 */
export async function getMyPlaylists(session = {}, page = 1, pagesize = 60) {
  const s = normSession(session)
  if (!s.token) throw new Error('未登录，无法读取我的歌单')
  const body = { userid: String(s.userid || ''), token: s.token, total_ver: 979, type: 2, page: Math.max(1, page | 0), pagesize }
  const r = await kgGateway('/v7/get_all_list', { plat: 1, userid: Number(s.userid) || 0, token: s.token }, s, { method: 'POST', data: body, headers: { 'x-router': 'cloudlist.service.kugou.com' } })
  const j = r.json
  if (!j || Number(j.status) !== 1 || !j.data) {
    throw new Error('获取我的歌单失败：' + explainKgError(j, r.status))
  }
  const info = Array.isArray(j.data.info) ? j.data.info : []
  return info.map((o) => normalizePlaylistItem({
    specialid: o.listid ?? o.id,
    name: o.name,
    imgurl: o.pic || o.imgurl || o.cover,
    songcount: o.count ?? o.source_count,
    username: o.creator_name || o.nickname || '',
    intro: o.description || '',
  })).filter((x) => x.id)
}

/**
 * 我的歌单详情（云歌单 v4/get_list_all_file，需登录）。
 * ⚠️ body 必须是小写 json 标签（listid/userid/area_code/…）——参考实现的 Go 结构体
 * 导出名是 PascalCase，线上按小写标签收包，抄错会得到 20010 param error。
 * 返回歌曲额外带 fileId（v4/delete_songs 移除必需）；高档位 hash 从 relate_goods 按码率回填。
 */
export async function getMyPlaylistSongs(listId, session = {}) {
  const s = normSession(session)
  const listid = Number(listId) || 0
  if (!listid) throw new Error('缺少歌单 listid')
  if (!s.token) throw new Error('未登录，无法读取歌单内容')
  const r = await kgGateway('/v4/get_list_all_file', { plat: 1, userid: Number(s.userid) || 0, token: s.token }, s, {
    method: 'POST',
    data: {
      listid: String(listid),
      userid: String(s.userid || ''),
      area_code: 1,
      show_relate_goods: 1,
      pagesize: 300,
      allplatform: 1,
      show_cover: 1,
      type: 0,
      token: s.token,
      page: 1,
    },
    headers: { 'x-router': 'cloudlist.service.kugou.com' },
  })
  const j = r.json
  if (!j || Number(j.status) !== 1 || !j.data) {
    throw new Error('获取歌单歌曲失败：' + explainKgError(j, r.status))
  }
  const info = Array.isArray(j.data.info) ? j.data.info : []
  const songs = info.map((o) => {
    // 云歌单只有主 hash；高音质档位在 relate_goods（{hash,bitrate,…}）里，按码率归档
    let hqHash = '', sqHash = ''
    for (const g of (Array.isArray(o.relate_goods) ? o.relate_goods : [])) {
      const b = Number(g.bitrate) || 0
      const gh = lowHash(g.hash)
      if (!gh) continue
      if (b >= 700 && !sqHash) sqHash = gh       // 无损 ≥ ~700kbps
      else if (b >= 300 && !hqHash) hqHash = gh  // 320k mp3
    }
    const n = normalizeSong({
      hash: o.hash,
      songname: '',
      SingerName: '',
      authors: (Array.isArray(o.singerinfo) ? o.singerinfo : []).map((x) => ({ author_name: x.name })),
      filename: o.name,                          // "歌手 - 标题.mp3"
      duration: Math.round(Number(o.timelen) / 1000), // 云歌单 timelen 为毫秒
      album_audio_id: o.audio_id != null && o.audio_id !== '' ? o.audio_id : o.mixsongid,
      album_id: o.album_id,
      MixSongID: o.mixsongid,
      cover: o.cover || (o.trans_param && o.trans_param.union_cover),
      privilege: o.media_privilege != null ? o.media_privilege : o.privilege,
    })
    return { ...n, hqHash, sqHash, fileId: Number(o.fileid) || 0 }
  }).filter((x) => x.hash)
  return songs
}

/** 创建自建歌单（type 0 新建；is_pri 0 公开 / 1 私密）。返回 { id, name }。 */
export async function createPlaylist(name, session = {}) {
  const s = normSession(session)
  const dirName = String(name || '').trim()
  if (dirName === '') throw new Error('歌单名不能为空')
  if (!s.token) throw new Error('未登录，无法创建歌单')
  const clienttime = Math.floor(Date.now() / 1000)
  const body = {
    name: dirName, type: 0, source: 1, is_pri: 0,
    total_ver: 0, userid: String(s.userid || ''), token: s.token,
    list_create_userid: '', list_create_listid: 0, list_create_gid: '', from_shupinmv: 0,
  }
  const r = await kgGateway('/cloudlist.service/v5/add_list', { last_time: clienttime, last_area: 'gztx', userid: Number(s.userid) || 0, token: s.token }, s, { method: 'POST', data: body })
  const j = r.json
  if (!j || Number(j.status) !== 1) throw new Error('创建歌单失败：' + ((j && j.error) || r.status))
  const d = j.data || {}
  const newId = Number(d.listid ?? (d.info && (d.info.listid ?? d.info.id)) ?? 0) || 0
  return { id: newId, name: dirName }
}

/** 删除自建歌单（v2/delete_list：AES 加密 body + RSA 包裹 p 参数；加密方案源自 MakcRe crypto.js）。 */
export async function deletePlaylist(listId, session = {}) {
  const s = normSession(session)
  const listid = Number(listId) || 0
  if (!listid) throw new Error('缺少歌单 listid')
  if (!s.token) throw new Error('未登录，无法删除歌单')
  const clienttime = Math.floor(Date.now() / 1000)
  const dataMap = { listid, total_ver: 0, type: 1 }
  const sealed = kxAesSeal(dataMap)
  const p = kxRsaWrap({ aes: sealed.seed, uid: String(s.userid || ''), token: s.token })
  const params = {
    clienttime: String(clienttime),
    key: signParamsKey(String(clienttime)),
    last_area: 'gztx',
    last_time: String(clienttime),
    p,
  }
  const bodyText = sealed.str // base64 密文原文参与 android 签名
  const r = await kgGateway('/v2/delete_list', params, s, { method: 'POST', data: bodyText, headers: { 'x-router': 'cloudlist.service.kugou.com' } })
  if (r.text && /^\{\}/.test(r.text.trim()) === false) {
    let okJson = null
    try { okJson = JSON.parse(r.text) } catch { /* 加密应答忽略 */ }
    if (okJson && Number(okJson.status) === 0) {
      throw new Error('删除歌单失败：' + (okJson.error || okJson.msg || okJson.status_v2 || 'unknown'))
    }
  }
  return true
}

/** 把歌曲加入某个我的歌单（v6/add_song；data 元素为「歌名|hash|album_id|mixsongid」四元组展开）。 */
export async function addSongToPlaylist(song, listId, session = {}) {
  const s = normSession(session)
  const listid = Number(listId) || 0
  if (!listid) throw new Error('缺少歌单 listid')
  if (!s.token) throw new Error('未登录，无法加入歌单')
  const hash = lowHash(song.hash || song.hqHash)
  if (!hash) throw new Error('缺少歌曲 hash')
  const mixsongid = Number(song.mixSongId || song.albumAudioId || 0) || 0
  const clienttime = Math.floor(Date.now() / 1000)
  const body = {
    userid: String(s.userid || ''),
    token: s.token,
    listid,
    list_ver: 0,
    type: 0,
    slow_upload: 1,
    scene: 'false;null',
    data: [{
      number: 1,
      name: String(song.title || '').replace(/[|,]/g, ' ') || '未知歌曲',
      hash,
      size: 0,
      sort: 0,
      timelen: Number(song.interval) || 0,
      bitrate: 0,
      album_id: Number(song.albumId || 0) || 0,
      mixsongid,
    }],
  }
  const r = await kgGateway('/cloudlist.service/v6/add_song', { last_time: clienttime, last_area: 'gztx', userid: Number(s.userid) || 0, token: s.token }, s, { method: 'POST', data: body })
  const j = r.json
  if (!j || Number(j.status) !== 1) throw new Error('加入歌单失败：' + ((j && (j.error || j.message)) || r.status))
  return true
}

/** 从我的歌单移除歌曲（v4/delete_songs；需要该歌在歌单中的 fileid，来自歌单歌曲列表项）。 */
export async function deleteSongFromPlaylist(fileId, listId, session = {}) {
  const s = normSession(session)
  const listid = Number(listId) || 0
  const fileid = Number(fileId) || 0
  if (!listid || !fileid) throw new Error('缺少 listid/fileid')
  if (!s.token) throw new Error('未登录，无法移除歌曲')
  const clienttime = Math.floor(Date.now() / 1000)
  const body = {
    listid,
    userid: String(s.userid || ''),
    data: [{ fileid }],
    type: 0,
    token: s.token,
    list_ver: 0,
  }
  const r = await kgGateway('/cloudlist.service/v4/delete_songs', { last_time: clienttime, last_area: 'gztx', userid: Number(s.userid) || 0, token: s.token }, s, { method: 'POST', data: body })
  const j = r.json
  if (!j || Number(j.status) !== 1) throw new Error('移除歌曲失败：' + ((j && (j.error || j.message)) || r.status))
  return true
}
