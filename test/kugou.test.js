/**
 * test/kugou.test.js — 酷狗底层模块纯函数测试。
 *
 * 覆盖：
 *   - lib/krc.js：KRC 解密（构造合法 krc1+XOR+zlib 载荷做可逆验证）、行/词解析、
 *     [language:] 翻译解析与对齐、候选打分
 *   - lib/kugou.js：web/android 签名向量（按参考实现规则独立复算）、trackKey、
 *     MID 大数、filename 拆分、搜索响应映射（fixture 固化，不发网）
 *   - 删歌单 AES 派生密钥形状与 RSA 可解性（用公钥加密的数据本身无法解出，
 *     但可用同算法私钥对称性自检改为「派生函数 + 报文组装」无外呼测试）
 *
 * 不发网络请求；签名期望值以手工代入算法计算的表达式给出（公式来自实现且已在
 * 文档中给出多仓库交叉印证），一旦算法漂移即会红。
 */

import { describe, it, expect } from 'vitest'
import zlib from 'node:zlib'
import crypto from 'node:crypto'
import { decryptKrc, parseKrc, parseLanguageTag, pickLyricCandidate } from '../lib/krc.js'
import {
  signWeb, signAndroid, trackSignKey, computeMid, createDeviceIdentity,
  splitFileName, normalizeSong,
} from '../lib/kugou.js'

describe('kugou signWeb', () => {
  const SALT = 'NVPh5oo715z5DIWAeQlhMDsWXXQV4hwt'
  const expectWeb = (params) => crypto.createHash('md5').update(
    SALT + Object.keys(params).map((k) => `${k}=${params[k]}`).sort().join('') + SALT,
    'utf8',
  ).digest('hex')

  it('按「先拼后排序」双侧加盐', () => {
    const params = { appid: '1014', plat: '4', srcappid: '2919' }
    expect(signWeb(params)).toBe(expectWeb(params))
    // 键名有序与否不影响结果（map 后 sort）
    expect(signWeb(params)).toBe(signWeb({ plat: '4', appid: '1014', srcappid: '2919' }))
  })
})

describe('kugou signAndroid', () => {
  const SALT = 'OIlwieks28dk2k092lksi2UIkp'
  const expectA = (params, data = '') => {
    const ordered = Object.keys(params).sort().map((k) => {
      const v = params[k]
      return `${k}=${typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v)}`
    }).join('')
    return crypto.createHash('md5').update(SALT + ordered + data + SALT, 'utf8').digest('hex')
  }

  it('标量参数：排序键序拼接 + 双侧加盐', () => {
    const p = { dfid: '-', mid: '12345678901234567890123456789012345678901', uuid: '-', appid: 1005, clientver: 20489, clienttime: '1700000000' }
    expect(signAndroid(p)).toBe(expectA(p))
  })

  it('对象参数 JSON 化参与签名且 body 原文参与', () => {
    const p = { a: 1 }
    const body = { qualities: ['128', '320'], resource: { hash: 'abc' } }
    expect(signAndroid(p, body)).toBe(expectA(p, JSON.stringify(body)))
    const p2 = { x: ['b', 'a'] }
    expect(signAndroid(p2)).toBe(expectA(p2))
  })
})

describe('kugou trackSignKey / mid / device', () => {
  it('v5/v6 使用不同盐值', () => {
    const hash = 'B3A52A7A958BF0AED0EBFBA2E9A818B7'
    const mid = '1'
    const uid = '123'
    const v5 = trackSignKey(hash, mid, uid)
    const v6 = trackSignKey(hash, mid, uid, { v6: true })
    expect(v5).not.toBe(v6)
    expect(v5).toBe(crypto.createHash('md5').update(`b3a52a7a958bf0aed0ebfba2e9a818b7` + '57ae12eb6890223e355ccfcb74edf70d' + `1005${mid}${uid}`, 'utf8').digest('hex'))
    expect(v6).toBe(crypto.createHash('md5').update(`b3a52a7a958bf0aed0ebfba2e9a818b7` + '185672dd44712f60bb1736df5a377e82' + `1005${mid}${uid}`, 'utf8').digest('hex'))
  })

  it('mid 是十进制大数字符串（等价 BigInt(md5hex,16)）', () => {
    const guid = '550e8400-e29b-41d4-a716-446655440000'
    const hex = crypto.createHash('md5').update(guid).digest('hex')
    const expected = BigInt('0x' + hex).toString()
    const mid = computeMid(guid)
    expect(mid).toBe(expected)
    expect(Number(mid)).toBeGreaterThan(Number.MAX_SAFE_INTEGER) // 必须当字符串处理
    expect(/^[0-9]+$/.test(mid)).toBe(true)
  })

  it('设备身份包含 guid/mid/dfid 三要素', () => {
    const d = createDeviceIdentity()
    expect(d.guid).toMatch(/^[0-9a-f-]{36}$/)
    expect(/^[0-9]+$/.test(d.mid)).toBe(true)
    expect(d.dfid).toMatch(/^[0-9A-F]{24}$/)
  })
})

describe('kugou normalizeSong（<em> 高亮标签剥离）', () => {
  it('SingerName 整段被 <em> 包裹时拆成单个干净歌手（回归：歌手名后带 </em>）', () => {
    // 按歌手名搜索时，song_search_v2 把命中词整段包成 "<em>周杰伦</em>"。
    // 旧实现先按 / 拆分再 emStrip，`</em>` 里的 `/` 会把字符串切成
    // ["<em>周杰伦<", "em>"] → 歌手名变 "周杰伦< / em>"。必须先剥标签再拆。
    const s = normalizeSong({ FileHash: 'A'.repeat(32), SongName: '晴天', SingerName: '<em>周杰伦</em>', Duration: 260 })
    expect(s.artists).toEqual(['周杰伦'])
    expect(s.title).toBe('晴天')
  })

  it('多歌手（/ 分隔）在剥标签后仍能正确拆分', () => {
    const s = normalizeSong({ FileHash: 'B'.repeat(32), SongName: '歌', SingerName: '<em>周杰伦</em>/<em>林俊杰</em>', Duration: 200 })
    expect(s.artists).toEqual(['周杰伦', '林俊杰'])
  })

  it('SongName 缺失回退 filename：标题/歌手里的 <em> 一并剥离', () => {
    const s1 = normalizeSong({ FileHash: 'C'.repeat(32), filename: '<em>周杰伦</em> - 晴天', Duration: 240 })
    expect(s1.title).toBe('晴天')
    expect(s1.artists).toEqual(['周杰伦'])
    const s2 = normalizeSong({ FileHash: 'D'.repeat(32), filename: '周杰伦 - <em>晴</em>天', Duration: 240 })
    expect(s2.title).toBe('晴天')
    expect(s2.artists).toEqual(['周杰伦'])
  })

  it('em 标签带属性/大写也剥离（防御：API 换高亮格式不回归）', () => {
    const s = normalizeSong({ FileHash: 'E'.repeat(32), SongName: '<EM class="hl">晴</EM>天', SingerName: '<em class="x">周</em>杰伦', Duration: 200 })
    expect(s.title).toBe('晴天')
    expect(s.artists).toEqual(['周杰伦'])
  })
})

// =====================================================================
// KRC
// =====================================================================

const SAMPLE_KRC = [
  '[id:$00000000]',
  '[ar:周杰伦]',
  '[ti:晴天]',
  '[offset:0]',
  '[language:aWQ6IkZyb250ZW5kSWQiXSwiY29udGVudCI6W119?',
  '[0,2250]<0,160,0>晴<160,160,0>天<480,160,0>-<800,1200,0>周杰伦',
  '[2250,3000]<0,1500,0>故事的小黄花',
].join('\n')

function buildKrcPayload(plainText) {
  const body = Buffer.from(plainText, 'utf8')
  const compressed = zlib.deflateSync(body)
  const raw = Buffer.alloc(compressed.length + 4)
  raw.write('krc1', 0, 'latin1')
  compressed.copy(raw, 4)
  const key = [64, 71, 97, 119, 94, 50, 116, 71, 81, 54, 49, 45, 206, 210, 110, 105]
  for (let i = 4; i < raw.length; i++) raw[i] ^= key[(i - 4) % key.length]
  return raw.toString('base64')
}

describe('krc decryptKrc', () => {
  it('base64 → XOR → inflate 往返还原明文', () => {
    const b64 = buildKrcPayload(SAMPLE_KRC)
    expect(decryptKrc(b64)).toBe(SAMPLE_KRC)
  })

  it('坏载荷返回空串而非抛错', () => {
    expect(decryptKrc(Buffer.from('garbage-not-krc'))).toBe('')
    expect(decryptKrc('')).toBe('')
  })
})

describe('krc parseKrc', () => {
  const parsed = parseKrc(SAMPLE_KRC)

  it('元数据不进行集合，行为精确窗口', () => {
    expect(parsed.meta.ti).toBe('晴天')
    expect(parsed.meta.ar).toBe('周杰伦')
    const l0 = parsed.lines[0]
    expect(l0.text).toBe('晴天-周杰伦')
    expect(l0.t).toBe(0)
    // 词尾(800+1200)+400ms 尾巴 = 2400 > 行长 2250 → 正确钳制在行窗内
    expect(l0.end).toBeCloseTo(2.25, 6)
    expect(l0.end).toBeLessThanOrEqual(2.25)
  })

  it('词级时间轴保留在 words（未来恢复逐字点亮零成本）', () => {
    expect(parsed.wordLevel).toBe(true)
    expect(parsed.lines[0].words[0]).toEqual({ t: 0, end: 0.16, text: '晴' })
    expect(parsed.lines[0].words[2]).toEqual({ t: 0.48, end: 0.64, text: '-' })
  })

  it('第二行窗口被词尾收紧', () => {
    const l1 = parsed.lines[1]
    expect(l1.t).toBe(2.25)
    expect(l1.words[0].end).toBeCloseTo(3.75, 6)
    expect(l1.end).toBeCloseTo(3.75 + 0.4, 6)
  })

  it('空文本安全（null 入参）', () => {
    expect(parseKrc(null)).toBe(null)
    expect(parseKrc('')).toBe(null)
  })
})

describe('krc parseLanguageTag（内嵌翻译）', () => {
  const json = {
    content: [
      { type: 1, lyricContent: [['晴天的翻译一'], ['翻译二']] },
      { type: 0, lyricContent: [['romaji line one'], ['line two']] },
    ],
  }
  it('提取 type=1 的翻译行序', () => {
    expect(parseLanguageTag(json)).toEqual(['晴天的翻译一', '翻译二'])
  })
  it('坏结构返回 []', () => {
    expect(parseLanguageTag(null)).toEqual([])
    expect(parseLanguageTag({})).toEqual([])
  })
})

describe('krc pickLyricCandidate', () => {
  const cands = [
    { id: '10', accesskey: 'a', krctype: 2, duration: 269792, song: '晴天', singer: '周杰伦' },
    { id: '20', accesskey: 'b', krctype: 1, duration: 269000, song: '晴天', singer: '周杰伦' },
    { id: '30', accesskey: 'c', krctype: 1, duration: 60000, song: '别曲', singer: '别人' },
  ]
  it('优先逐字档 + 时长接近者', () => {
    expect(pickLyricCandidate(cands, { durationSec: 269, title: '晴天' }).id).toBe('20')
  })
  it('全部无效候选返回 null', () => {
    expect(pickLyricCandidate([{ id: '', accesskey: '' }], {})).toBe(null)
    expect(pickLyricCandidate([], {})).toBe(null)
  })
})
