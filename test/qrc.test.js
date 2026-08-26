/**
 * test/qrc.test.js — QQ 音乐逐字歌词（QRC）解密与解析测试。
 *
 * 加密回环用例验证「算法实现自洽」；fixture 用例（真实线上密文，晴天 songID=97773
 * 抓取于 2026-08）验证「与 QQ 音乐服务端兼容」——这是互操作正确性的最终基准。
 * 若未来服务端调整导致 fixture 解不开，应以重新抓取的真实密文更新 fixture。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import * as QRC from '../lib/qrc.js'
import * as QQ from '../lib/qq.js'

const readFixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8').trim()

describe('qrc round-trip (encrypt/decrypt 自洽)', () => {
  it('decryptHex(encryptHex(text)) === text —— 含多字节字符与跨块长度', () => {
    const samples = [
      '<?xml version="1.0" encoding="utf-8"?><QrcInfos><LyricInfo LyricCount="1">x</LyricInfo></QrcInfos>',
      '[1000,250]但偏偏雨渐渐大到我看你不见(1000,250)',
      'a',                                    // < 8 字节 → 零填充路径
      '',                                     // 空
      '中文'.repeat(500) + 'end…',             // 多块 + BOM 不存在
    ]
    for (const s of samples) expect(QRC.decryptHex(QRC.encryptHex(s))).toBe(s)
  })

  it('BOM 头部被剥离', () => {
    const withBom = '\uFEFF[0,100]hello(0,100)'
    expect(QRC.decryptHex(QRC.encryptHex(withBom))).toBe('[0,100]hello(0,100)')
  })

  it('非法输入抛错', () => {
    expect(() => QRC.decryptHex('')).toThrow()
    expect(() => QRC.decryptHex('abc')).toThrow()     // 奇数长度
    expect(() => QRC.decryptHex('abcd')).toThrow()    // 非 8 的倍数
  })
})

describe('parseQrc', () => {
  it('解析行窗口与逐词时间轴；跳过 XML/元数据/空行', () => {
    const plain = [
      '<?xml version="1.0" encoding="utf-8"?>',
      '<QrcInfos><QrcHeadInfo SaveTime="269" Version="100"/><LyricInfo LyricCount="1">',
      '<Lyric_1>',
      '[offset:0]',
      '',
      '[190871,1984]For (190871,361)the (191232,172)first (191404,376)time(191780,1075)',
      '[193459,4198]What\'s (193459,412)past (193871,574)is (194445,506)past(194951,2706)',
      '</Lyric_1>',
      '</LyricInfo></QrcInfos>',
    ].join('\n')
    const lines = QRC.parseQrc(plain)
    expect(lines).toHaveLength(2)
    expect(lines[0]).toMatchObject({ startMs: 190871, durMs: 1984, text: 'For the first time' })
    expect(lines[0].words.map((w) => w.text)).toEqual(['For ', 'the ', 'first ', 'time'])
    expect(lines[0].words[2]).toMatchObject({ startMs: 191404, durMs: 376 })
    expect(lines[1].text).toBe("What's past is past")
    // 行末尾时间 = startMs + durMs
    expect(lines[1].startMs + lines[1].durMs).toBe(197657)
  })

  it('无逐词标记的 [ms,dur] 行保留为整行文本、words 为空', () => {
    const lines = QRC.parseQrc('[1000,2000]纯文本行\n')
    expect(lines).toHaveLength(1)
    expect(lines[0].text).toBe('纯文本行')
    expect(lines[0].words).toEqual([])
  })

  it('噪声行与空文本行被丢弃', () => {
    expect(QRC.parseQrc('[ti:晴天]\n[12345,0](500,500)\n\nrandom junk\n')).toEqual([])
  })

  it(' Fixture 密文端到端：解密→解析出晴天歌词', () => {
    const hex = readFixture('qrc-qingtian.hex')
    const text = QRC.decryptHex(hex)
    expect(text).toContain('<QrcInfos>')
    const lines = QRC.parseQrc(text)
    expect(lines.length).toBeGreaterThan(50)
    // 标题信息行出现在开头（官方 App 开场同款）
    expect(lines[0].startMs).toBe(0)
    expect(lines[0].text).toContain('晴天')
    // 演唱行时序单调不减
    for (let i = 1; i < lines.length; i++) {
      expect(lines[i].startMs).toBeGreaterThanOrEqual(lines[i - 1].startMs - 5)
    }
    // 末行结束贴近歌曲时长（269s）
    const last = lines[lines.length - 1]
    expect((last.startMs + last.durMs) / 1000).toBeGreaterThan(240)
    // 单字词时间轴精确到毫秒（「录音助理」段实测值）
    const flat = lines.flatMap((l) => l.words)
    const lu = flat.find((w) => w.text === '录')
    expect(lu && lu.startMs > 20000 && lu.startMs < 26000).toBe(true)
  })
})

describe('qq.getQrcLyric（mock 网络层）', () => {
  const originalFetch = globalThis.fetch
  const okEnvelope = (dataObj) => new Response(JSON.stringify({ code: 0, req: { code: 0, data: dataObj } }), { status: 200, headers: { 'content-type': 'application/json' } })

  it('qrc_t≠0 时返回秒时基的行窗口', async () => {
    const cipher = QRC.encryptHex('<QrcInfos>\n[1500,2000]你好世界(1500,500)(2000,500)\n</QrcInfos>')
    let capturedParam = null
    globalThis.fetch = async (_url, opts = {}) => {
      const body = JSON.parse(opts.body)
      capturedParam = body.req.param
      return okEnvelope({ lyric: cipher, qrc_t: 1761231326, lrc_t: 0 })
    }
    try {
      const out = await QQ.getQrcLyric({ songid: 97773, interval: 269, title: '晴天', artist: '周杰伦', album: '叶惠美' }, '')
      expect(out.kind).toBe('qrc')
      expect(out.lines).toHaveLength(1)
      expect(out.lines[0]).toEqual({ t: 1.5, end: 3.5, text: '你好世界' })
      // 参数形态：数字 songID + base64 名字
      expect(capturedParam.songID).toBe(97773)
      expect(capturedParam.interval).toBe(269)
      expect(capturedParam.qrc).toBe(1)
      expect(capturedParam.songName).toBe(Buffer.from('晴天', 'utf8').toString('base64'))
    } finally { globalThis.fetch = originalFetch }
  })

  it('qrc_t=0（无逐字数据）返回 null —— 让调用方回落 LRC 路径', async () => {
    globalThis.fetch = async () => okEnvelope({ lyric: 'base64lrcdata', qrc_t: 0, lrc_t: 1728477663 })
    try {
      expect(await QQ.getQrcLyric({ songid: 200253690, interval: 206, title: '卡农' })).toBeNull()
    } finally { globalThis.fetch = originalFetch }
  })

  it('req.code≠0 或缺 data 抛错（由编排层静默回落）', async () => {
    globalThis.fetch = async () => new Response(JSON.stringify({ code: 0, req: { code: 2001, message: 'rejected' } }), { status: 200 })
    try {
      await expect(QQ.getQrcLyric({ songid: 97773, interval: 269, title: '晴天' })).rejects.toThrow(/req\.code/)
    } finally { globalThis.fetch = originalFetch }
  })
})
