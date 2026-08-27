# 接入酷狗音乐 · 可行性调研报告（已实施）

> 目标：评估在 dsh-music-player 中接入**酷狗音乐**作为第二个在线来源，
> 判断其接口能力能否与现有 QQ 音乐实现（`lib/qq.js`）**逐项对齐**。
>
> 方法：参考开源社区实现（guohuiyuan/music-lib[go-music-dl 底层库]、MakcRe/KuGouMusicApi、lx-music-api-server 等），
> 并在本机对关键端点逐一实测验证（见 §3 标注 ✅实测）。
>
> 结论先行：**能力基本可对齐，但登录态是硬前提**——酷狗比 QQ 更严格：
> 元数据/发现类全部匿名可用，而**播放直链匿名已死**（实测 `url:""`），必须扫码登录拿 token 后经 tracker 取链。

## 实施状态（2025-08-27，已完成）

本报告的方案已按 §7 建议落地实现：

| 模块 | 文件 | 内容 |
|---|---|---|
| 取链/登录/浏览 | `lib/kugou.js` | 设备身份(GUID→MID 大数)、web/android/signKey 签名、酷狗原生扫码登录、搜索、tracker v6/v5 取链、KRC/LRC 歌词、歌单浏览、我的歌单读+写(建单/加歌/移歌/删单) |
| 逐字歌词 | `lib/krc.js` | krc1 头跳过 + 16 字节 XOR + zlib → 行窗口解析 `{t,end,text}`(+words 备用)、`[language:]` 翻译对齐；输出形状与 qrc.js 一致 |
| Host 路由 | `lib/index.js` | `/dsh-music/kg/*`：status/login(start·check·logout)/search/play(流式代理+真实品质头 X-DSH-KG-Quality)/lyric/playlists/playlist-*/my-playlist/top-lists/top-songs |
| 本地歌词兜底 | `lib/lyric.js` | 兜底链变为 QQ → 酷狗(KRC 优先) → LRCLIB |
| 浏览器 UI | `lib/client.js` | 新增「酷狗音乐」侧栏页签：扫码登录、推荐/分类歌单、排行榜(TOP500 等 57 榜)、统一搜索(歌曲+歌单)、我的歌单(可移除歌曲)；播放队列/进度持久化(`dsh-music-kg-playback`)、失败自动跳下一首、KRC 精确行扫色 |
| 测试 | `test/kugou.test.js` + test/lyric.test.js 更新 | 签名向量、MID 大数、KRC 可逆解密/行词解析/翻译对齐、候选打分等 16 项 |

已验证：全量 vitest 通过；起服务实测 13 条路由（出码/轮询/搜索/榜单/歌单详情/KRC 逐字/未登录播放降级 404）。待用户验证：真实扫码后的取链播放与 VIP 高音质（需要本人账号）。



---

## 1. 结论速览

| 维度 | QQ 音乐（现状） | 酷狗音乐（调研结果） | 对齐判定 |
|---|---|---|---|
| 搜索歌曲 | 匿名可用 | 匿名可用（song_search_v2 / complexsearch） | ✅ 更容易 |
| 播放 URL | 登录后 vkey，未登录部分免费歌也可试 | **必须登录**（token+userid），匿名全灭 | ⚠️ 对齐方式不同 |
| 高音质/VIP | VIP 探测 + 多前缀尝试 | qualities 数组一次报齐（128~viper 全档） | ✅ 结构更现代 |
| 普通歌词 | fcg 接口 LRC | 同端点 fmt=lrc | ✅ |
| **逐字歌词** | QRC（3DES+zlib 解密） | KRC（4字节头+16字节XOR+zlib），含翻译/罗马音 | ✅ 复杂度更低 |
| 推荐/分类歌单 | 匿名 | 匿名（mobilecdn/plist/sheet_*） | ✅ |
| 我的歌单 | musicu GetPlaylistByUin | cloudlist.service v7/get_all_list（需登录） | ✅ |
| 建/删歌单、加/删歌 | musicu 写接口 | cloudlist.service v5/v6/v2/v4 写接口（需登录，开源已打通） | ✅ |
| 收藏单曲「我喜欢」 | dirId=201 专用接口 | **无独立端点**，「我喜欢」就是一个默认歌单，用加歌模拟 | ⚠️ 有差异 |
| 排行榜/新歌 | 匿名 | 匿名（mobilecdn rank/*；新版 ocean/v6） | ✅ |
| 扫码登录 | ptlogin 二次 OAuth 换 musickey（繁琐） | **一跳拿 token**：扫码轮询 status=4 直接返回 token+userid | ✅ 比 QQ 简单 |

最大风险面：非官方接口改版快、取链走 App 协议签名、存在 SSA 风控验证（滑块）；老匿名直链通道（getSongInfo.php）已确认死透。

---

## 2. 参考（来源）仓库

| 仓库 | 语言 | 价值定位 |
|---|---|---|
| [guohuiyuan/music-lib](https://github.com/guohuiyuan/music-lib)（[go-music-dl](https://github.com/guohuiyuan/go-music-dl) 底层库） | Go | 与本项目最同构：QR 登录/搜索/取链多级 fallback/云歌单全套，2025 年仍活跃维护 |
| [MakcRe/KuGouMusicApi](https://github.com/MakcRe/KuGouMusicApi)（903★） | Node.js | 约 160 个接口全覆盖（含写操作），签名算法最完整清晰 |
| [xiaoqiangclub/lx-music-api-server](https://github.com/xiaoqiangclub/lx-music-api-server) | Python | KRC 歌词链路与解析实用实现 |
| [HisAtri/LrcApi](https://github.com/HisAtri/LrcApi) | Python | 歌词搜索聚合（酷狗部分为旧链参考） |
| listen1_mobile kugou provider | JS | 最老一代端点参考（发现类仍有用，播放链路已不适用） |

---

## 3. 本机实测记录（2025-08-27，佐证下述结论）

| 实验 | 结果 |
|---|---|
| `songsearch.kugou.com/song_search_v2`（HTTPS） | ✅ 返回 total/lists，且带各档位 hash 与 Privilege/PayType 字段 |
| `mobilecdn.kugou.com/api/v3/search/song` | ✅ HTTPS 空响应，**HTTP 可用**（域名协议不一致需注意） |
| `m.kugou.com/rank/list&json=true` / `plist/index&json=true` | ✅ 匿名返回榜单/歌单广场数据 |
| `lyrics.kugou.com/search` → `download?fmt=lrc` | ✅ 晴天/周杰伦 正确候选（krctype:1），LRC 直接可得 |
| `krcs.kugou.com/download?fmt=krc` → 解密 | ✅ 16 字节 XOR + zlib 得到逐字 KRC 文本 `[0,2250]<0,160,0>晴<160,160,0>天…` |
| `login-user.kugou.com/v2/qrcode`（web 签名） | ✅ 返回 `qrcode` 键值 + base64 PNG 二维码图 |
| `…/v2/get_userinfo_qrcode` 轮询（未扫） | ✅ 返回 `{"data":{"status":1}}`（等待扫码） |
| `m.kugou.com/app/i/getSongInfo.php?cmd=playInfo` | ⚠️ 元数据齐全（privilege=10），**`url:""` 且 bitRate 0 —— 匿名取链确认失效** |
| `wwwapi.kugou.com/play/songinfo`（双盐 web 签名多种参数组合） | ❌ err_code 30020（该路径现已要求登录 cookie t+KugooID） |

---

## 4. 技术细节：签名体系（接入的核心门槛）

酷狗现行主要走 **gateway/tracker 网关协议**（模仿 Android App），一切请求都要带 `signature`。
以下摘自 MakcRe/KuGouMusicApi `util/helper.js`（多个仓库互相印证一致）：

### 4.1 三套 MD5 双夹心签名（salt 前 + 参数串 + salt 后）

```js
// Web 版（老 wwwapi/login-user 域名）
const WEB_SALT  = 'NVPh5oo715z5DIWAeQlhMDsWXXQV4hwt'
sign_web    = md5(WEB_SALT  + sort(k=v).join('')          + WEB_SALT)

// Android 版（标准版 appid=1005 / 概念版 lite appid=3116，gateway 新协议）
const AND_SALT  = 'OIlwieks28dk2k092lksi2UIkp'      // lite: 'LnT6xpN3khm36zse0QzvmgTZ3waWdRSA'
sign_android = md5(AND_SALT + sort(k=v).join('') + JSON.stringify(body) + AND_SALT)

// 设备注册版
sign_register = md5('1014' + values.sort().join('') + '1014')
```

注意坑位：① 是**双侧加盐**（我首次按单侧加盐复刻时返回 30020）；② Android 版排序串里对象要 `JSON.stringify`；
③ POST body 原文参与签名。

### 4.2 取链专用 signKey（tracker v5）

```
key = md5(hash + '57ae12eb6890223e355ccfcb74edf70d' + appid + mid + userid)
```

### 4.3 必带公共参数与请求头

```
公共参数: dfid / mid / uuid:'-' / appid / clientver / clienttime(秒) [+ token + userid]
请求头: User-Agent(Android15-1070-11083-…) / x-router(域名路由) /
        kg-rc:1 / kg-thash:5d816a0 / dfid / clienttime / mid / Cookie(token,userid,KUGOU_API_MID,…)
```

设备标识生成（Node 原生可行）：`GUID = crypto.randomUUID()`；`mid = BigInt('0x'+md5(GUID)).toString()`。
⚠️ mid 是 30+ 位十进制大数，**全程按字符串处理，禁止过 Number()**（比 QQ 微信登录 musicid ~1e18 还大一个量级，可直接用 JS BigInt 无损转换）。`dfid` 可选向 `userservice.kugou.com/risk/v2/r_register_dev` 注册换取（RSA+AES 加密 payload），简化实现可先用随机 24 位大写 hex（music-lib 同款退化方案）。

---

## 5. 各能力项与对应端点

### 5.1 扫码登录（比 QQ 少一层换票）

> ⚠️ **实施阶段实测补强（重要）**：出码前必须先调 `userservice.kugou.com/risk/v2/r_register_dev`
> 注册设备拿真实 dfid（AES 密封 body + RSA 包装 `p` 参数），并把该 dfid/mid 贯穿出码与轮询。
> 用伪造/未注册 dfid 出码的 token 会与设备绑定校验失败：
> 取链 tracker v5/v6 → `20028「本次请求需要验证」` 或 `20018 token api error`；云歌单 v7 → `20017`。
> （MakcRe 官方文档原文：「获取 url 接口数据需要先调用 /register/dev 接口获取 dfid，否则会提示本次请求需要验证」。
> 另注意：Android 签名必须覆盖**公共默认参数+业务参数的全量合并集**，只签业务参数会静默失败。）
>
> ⚠️ **补强 #2（决定性）**：出码 appid 必须用 **Android 型 `1001`**（MakcRe `login_qr_key.js`
> 的默认分支；MoeKoeMusic/kgqd 生产前端均未传 `type=web`）。此前误用网页型 `1014` 签发的
> token 在网关业务面（云歌单/取链）处处受限——这是 20017 反复出现的最终根源。
> 扫码成功后还可用 `v5/login_by_token` 刷新一次兑换标准作用域 token（kgqd 每次使用前同款动作；
> 本项目已在登录成功后自动执行一次，并在云歌单/取链遇 20017/20018 时静默刷新重试）。

与 QQ「ptlogin 扫码后还要 graph.qq.com OAuth → musicu 换 musickey」不同，酷狗一跳到位：

| 步骤 | 端点 | 说明 |
|---|---|---|
| ① 出二维码 | `GET https://login-user.kugou.com/v2/qrcode`（web 签名；appid=1014 为网页型 / 1001 为 App 型，srcappid=2919, plat=4, type=1） | 返回 `data.qrcode`（key）+ `data.qrcode_img`(base64 PNG)。前端直接渲染，或拼 `https://h5.kugou.com/apps/loginQRCode/html/index.html?qrcode=<key>` 让用户用**酷狗 App** 扫 |
| ② 轮询 | `GET https://login-user.kugou.com/v2/get_userinfo_qrcode?plat=4&appid=&srcappid=&qrcode=<key>&dev=` | status：0 过期 / 1 等待 / 2 已扫待确认 / **4 成功并直接返回 `data.token` + `data.userid`** |
| ③ 使用 | 之后所有网关请求带 `token+userid` 参数 + Cookie(`token`,`userid`,`KUGOU_API_MID`,`dfid`) | 即可走高音质取链、个人歌单等 |

✅ 已实测①②可达本机（大陆网络环境）。两条「入场券」可选：

- **路径 A · 原生酷狗二维码（推荐）**：如上两跳拿 `token+userid`；被 WuLve/kgqd 等生产环境（每日签到）长期验证。
- **路径 B · 复用 QQ 扫码基建**：我们已有的 ptqrshow/ptqrlogin 流程本身就能给酷狗用 —— 扫码成功后从 proxy.htm 提取 openid+access_token，POST `login.user.kugou.com/v6/login_by_openplat`（partnerid=1）即可换酷狗 token（微信同款 partnerid=36）。若想省掉酷狗 App 扫码这一步，这条路前端体验与现有 QQ 登录完全一致。

登录态落库建议：存 cookie 形态 `{token, userid, vip_type, vip_token}`（取链 VIP 档时要带 `vip_token`），另持久化 `dfid/mid/GUID` 设备指纹。

**token 有效期与刷新（存在官方式接口，非 QQ 的裸重扫模式）**：
`login_by_token`（v5，MakcRe module/login_token.js）：body 的 p3 = AES-CBC 加密({clienttime, token})，pk = RSA 加密包装密钥，响应 secu_params 解密得**新 token**。社区默认 **24 小时自动刷一次**（Dart 移植版内置该节奏）；⚠️ 官方反感频繁调用，「登录态还在时不要重复调」，且标准版/概念版 token 不通用。

### 5.2 搜索 / 发现（匿名可用）

| 能力 | 端点（示例） | 备注 |
|---|---|---|
| 搜歌 | `http(s)://songsearch.kugou.com/song_search_v2?keyword=&page=&pagesize=` 或 mobilecdn `/api/v3/search/song` | 响应带 `FileHash/HQFileHash/SQFileHash/ResFileHash/SuperFileHash`、Privilege、PayType、Image（`{size}` 占位符） |
| 推荐歌单 | `http://m.kugou.com/plist/index&json=true`（旧）或 `specialrec.service.kugou.com/v2/special_recommend`（新） | specialid / imgurl{size} / playcount |
| 分类+分类歌单 | `mobilecdnbj.kugou.com/api/v3/tag/list` + `/api/v3/tag/specialList` | 旧链匿名即可 |
| 歌单详情 | `mobilecdn.kugou.com/api/v3/special/song?specialid=&page=&pagesize=300` | 歌曲带 hash/SQhash 全档 |
| 榜单 | `mobilecdn.kugou.com/api/v3/rank/list?version=9108` + `/rank/song?rankid=`（TOP500 = 8888）或新版 `ocean/v6/rank/list` | |
| 新歌速递 | 新版 `musicadservice/container/v1/newsong_publish`（rank_id=21608） | 旧链缺，需走网关签名 |

### 5.3 取播放 URL（核心差异点：必须登录态）

hash 来源两代并存：旧链 song_search_v2 直接给各档位 hash（FileHash/HQFileHash/SQFileHash…）；现行网关搜索（complexsearch）每首歌给**单一 `FileHash` + album_audio_id**，取链时提交 `qualities:['128','320','flac','high','multitrack','viper_atmos','viper_tape','viper_clear','super']` 数组，**服务端按账号权限决定返回哪些档**，实际流域名（fs-open.kugou.com 等）在响应里而非硬编码。返回的是 CDN 直链，与 QQ 相同需走 Host 流式代理回浏览器（防 Referer/CORS 与命中防盗链）。

**现行主路（需登录 token，Android 网关签名）：**

| 档位 | quality 值 | 入参 hash | 对应 QQ 概念 |
|---|---|---|---|
| 标准 128k mp3 | `128` | FileHash | M500 |
| HQ 320k mp3 | `320` | HQFileHash | M800 |
| SQ 无损 flac | `flac` | SQFileHash | F000 |
| Hi-Res master | `high` | ResFileHash | Q000/Q001 近似位 |
| 臻品全景声/母带等 | `viper_atmos` / `viper_tape` / `viper_clear` / `super` | SuperFileHash 等 | （QQ 无对应） |

两条取链端点：
- `GET /v5/url`（x-router: trackercdn.kugou.com，带 signKey）
- `POST http://tracker.kugou.com/v6/priv_url`（body 带 `qualities:['128','320','flac','high','multitrack','viper_atmos',…]` 一次请求多档、`tracker_param.key`＝signKey、VIP 时附 vip_token）——响应同时给出各档 url/backup_url，按序择优。**返回的是 CDN 直链，与 QQ 相同需走 Host 流式代理回浏览器（防 Referer/CORS 与命中防盗链）。**

**已被验证死亡的匿名路**（了解即可，防止走弯路）：`getSongInfo.php`（实测 `url:""`）、`wwwapi/play/songinfo`（30020）、trackercdn `/i/v2`（status:2）。

参考实现采用多级 fallback：`VIP(v6/v5) → tracker(key) → songinfoV2 → getSongInfo`，我们在登录态具备的条件下其实只需要前两级 + 明确报错。

### 5.4 歌词：LRC + 逐字 KRC（酷狗的亮点）

两步获取（✅ 全程实测通过）：

```
① GET https://lyrics.kugou.com/search?ver=1&man=yes&client=mobi&keyword=<歌名>&duration=<ms>&hash=<hash>&album_audio_id=
   → { candidates: [{ id, accesskey, song, singer, duration, krctype }] }
② GET https://lyrics.kugou.com/download?ver=1&id=<id>&accesskey=<accesskey>&fmt=lrc|krc&charset=utf8
   → { content: "<base64>" , contenttype }
```

KRC 解密（替代 QQ QRC 的 3DES）：

```
content(base64) → bytes[0..3] = "krc1" 头丢弃
→ buf[i] ^= KEY[i%16]，KEY=[64,71,97,119,94,50,116,71,81,54,49,45,206,210,110,105]
→ zlib.inflateSync(buf.slice(4)) → UTF-8 文本
```

解得文本结构与我们的 QRC 行模型几乎一一对应，映射到 `{t,end,text}` 行结构零障碍：

```
[id:$…] [ar:周杰伦] [ti:晴天] …              ← 元数据头
[0,2250]<0,160,0>晴<160,160,0>天<320,160,0>…  ← 行时间戳 [起始ms,时长ms] + 词标签 <行内偏移ms,词长ms,_>字
```

- 纯 LRC：同端点 `fmt=lrc`（base64 直接解）。
- **翻译歌词/罗马音不是独立档**，内嵌 KRC 头部 `[language:<base64 JSON>]`（type 0=罗马音，type 1=翻译）。想给用户提供翻译，就必须上 KRC 解析而不是 LRC。
- 对齐工作量评估：低于 QRC（无需 3DES/XML，纯文本行正则即可）；新增 `lib/krc.js` 输出与 `lib/qrc.js` 相同的 `lines` 形状即可无缝接进现有 lyric 编排层。

### 5.5 个人歌单与收藏（需登录，均已有开源实现）

| 操作 | 端点（Android 签名 + token/userid） | 备注 |
|---|---|---|
| 我的歌单列表 | `cloudlist.service.kugou.com/v7/get_all_list`（POST {userid,token,type:2,total_ver}） | 自建+收藏都在里面 |
| 创建自建歌单 | `/cloudlist.service/v5/add_list`（type=0 新建 / type=1 收藏别人歌单） | |
| 删除歌单 | `/v2/delete_list` | body AES+RSA 加密（MakcRe module/playlist_del.js 有现成实现） |
| 向歌单加歌 | `/cloudlist.service/v6/add_song`（data 为 `名称|hash|album_id|mixsongid` 逗号分隔数组） | |
| 从歌单删歌 | `/v4/delete_songs`（按 fileid） | |
| 「我喜欢」单曲收藏 | **无独立红心接口** —— 我喜欢本身就是一张默认歌单，用 add_song/delete_songs 模拟；单曲收藏计数仅有读接口 `/count/v1/audio/mget_collect` | 与 QQ 的 dirId=201 心形机制对齐的最自然做法：固定记住该默认 listid，UI 层无感 |

---

## 6. 缺口与风险清单

| # | 差异/风险 | 影响 | 缓解建议 |
|---|---|---|---|
| 0 | **token 与设备绑定**：dfid 必须来自 r_register_dev 真实注册（错误码 20017/20018/20028 即此问题族） | 未注册设备的 token 全线被风控拦截：取链「本次请求需要验证」、云歌单 20017 | `lib/kugou.js#registerDevice` 已实现；login/start 强制「先注册→再出码」，重新扫码一次即修复（已实测注册链路） |
| 1 | 匿名不可播（QQ 可以播一部分免费歌） | 未登录用户打开酷狗 tab 只能浏览不能听 | UI 上沿用 QQ「未登录只显示扫码入口」的模式，无额外开发量 |
| 2 | 网关协议整套签名较 QQ 单一 musicu 重一些 | `lib/kugou.js` 需先落一套稳定 request 层 | 移植 helper.js 四个纯函数（60 行级别），vitest 固化向量测试 |
| 3 | 大量老端点只有 HTTP 明文（mobilecdn/m.kugou.com） | 安全/合规观感差、部分网络环境被劫持 | Host 端统一代理 `/dsh-music/kg/*`，出网尽量挑 HTTPS 版本（songsearch/sheet/ocean 均有 HTTPS） |
| 4 | mid/dfid 设备指纹与风控（SSA ssa-code 头触发滑块校验） | 高频调用可能弹验证码甚至封设备 | 常驻同一组 GUID/MID 存盘复用；错误码识别（1002=频繁、30020 类=需登录）给出友好提示；不做高频刷取 |
| 5 | 「我喜欢」靠默认歌单模拟 | 与 QQ 交互语义略异 | 固定 listid 封装成 fav API，客户端无感知 |
| 6 | token 会过期；但存在官方式刷新接口（login_by_token，AES+RSA，≈24h 节奏），官方反感频繁调用 | 比 QQ 略好：QQ 过期只能重扫，酷狗可静默续期 | 登录成功时记录时间戳，>20h 后台调一次 login_by_token 静默刷新；失败才提示重扫。另注意标准版/概念版 token 不通用 |
| 6b | SSA 风控（响应头 ssa-code → 滑块/短信校验）由高频无指纹请求触发 | 高频刷库可能弹验证码 | 固化 GUID/MID/dfid 持久复用、控频、错误码友好提示（1002=频繁）；MakcRe 有行为指纹模拟生成器可参考但不必实现刷取类功能 |
| 7 | 搜索结果 cover 图片含 `{size}` 占位符、title 含 `<em>` | 小兼容 | Host 统一替换 240/400、去高亮标签 |
| 8 | 法律/合规与 ToS（非官方接口流播版权音乐） | 同 QQ 方案声明 | 沿用现有免责声明章节，酷狗纳入同一使用范围限制 |

---

## 7. 若立项实施：建议工程结构（供排期参考，本次仅调研未动代码）

```
lib/kugou.js        —— 对标 lib/qq.js：createQRLogin/checkQRLogin/search/getDownloadURL/
                       getTopLists/getTopListSongs/getNewSongs/getRecommendedPlaylists/
                       getCategoryPlaylists/searchPlaylist/getPlaylistSongs/getMyPlaylists/
                       createPlaylist/deletePlaylist/addSongToPlaylist/…
lib/kgrequest.js    —— 签名四件套 + gateway fetch 封装（超时/UA/头注入，风格同 qq.js fetchWithTimeout）
lib/krc.js          —— KRC 下载解码 + 行解析（输出形状=qrc.js lines， lyric.js 编排层零改动接入）
lib/index.js        —— 路由镜像 /dsh-music/kg/*（login/start|check、search、play/<hash>?quality=…）
cookie 存储         —— ~/.dsh/music-player-kugou-cookie.json（token/userid/KUGOU_API_MID/dfid，0600）
test/kugou*.test.js —— 签名函数/KRC 解密/实体清理等纯函数级用例
```

分期建议：
- **P0（半日）**：搜索+发现类匿名只读跑通（避开网关签名也能做出可演示 demo）；
- **P1（核心）**：扫码登录（本次已实测路径）+ v6/v5 取链 + Host 代理流播 + LRC/KRC 歌词；
- **P2**：我的歌单/创建/加歌/删歌/「我喜欢」模拟（抄 MakcRe 写接口语义）。

---

## 8. 合规提示

与 QQ 在线功能相同：本调研所述均为非官方接口，涉及平台版权内容，仅限个人学习、技术研究与日常试听；
严禁商业用途与内容再分发；账号风控风险自负。正式实现落地时应随附与 online-music-feasibility.md 相同的使用声明。

## 参考链接汇总

- https://github.com/guohuiyuan/music-lib（kugou/{login,kugou,song,playlist,lyric,cloudlist,download}.go）
- https://github.com/guohuiyuan/go-music-dl
- https://github.com/MakcRe/KuGouMusicApi（util/helper.js、module/*.js）
- https://github.com/MeoProject/lx-music-api-server（utils/platform/kg/__init__.py、modules/{url,refresh}/kg.py —— 盐值/刷新接口独立印证）
- https://docs.rs/crate/kugou_sdk/0.1.0（Rust SDK，盐值与平台常量的第三方独立证实）
- https://github.com/WuLve/kgqd（原生 QR 登录在生产环境长期使用的案例）
- https://github.com/xiaoqiangclub/lx-music-api-server（modules/kg/lyric.py）
- https://github.com/HisAtri/LrcApi
- KRC 格式分析：https://shansing.com/read/392/
