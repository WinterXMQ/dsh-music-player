# 在线音乐播放功能 · 可行性分析

> 目标：在本插件（dsh-music-player）中新增「播放在线音乐」能力（网易云音乐、酷狗音乐等），
> 以 [metowolf/Meting](https://github.com/metowolf/Meting) 开源项目的能力为基础。
>
> 状态：分析完成，结论为**技术可行、工作量可控**，主要风险集中在**接口稳定性与版权合规**。

## 0. 结论摘要

- **技术上完全可行**。Meting 官方已于 2025 年把项目重构为 **Node.js 版本**并发布 npm 包
  `@meting/core`（零外部依赖、内置各平台加密/签名、用 Node 原生 `fetch`），与本插件
  「纯 JS、Node ≥ 20、无构建步骤」的定位完全匹配——不需要再依赖 PHP 运行时。
- **架构上天然契合**。插件 Host 端已有 `/dsh-music` 前缀的 HTTP 代理（`webServer` 路由），
  正好用来承载「搜索代理 + 音频流式代理」；浏览器端只需复用现有 `<audio>` 播放条与 `music_play`
  工具，改动集中在 Host 端。
- **真正的风险不在「能不能做」，而在「能用多久、是否合规」**：非官方接口随时可能改版/封 IP、
  VIP/DRM 歌曲拿不到完整链接、流播受版权保护的音乐有 ToS 与侵权风险。这决定该功能应定位为
  **默认关闭的实验性功能 + 明确免责声明**，而不是核心卖点。

## 1. Meting 项目能力盘点

| 项 | 说明 |
|---|---|
| 项目 | [metowolf/Meting](https://github.com/metowolf/Meting)（原 PHP，现官方 Node.js 重构版） |
| npm 包 | `@meting/core`（当前 1.6.1，2026-02 发布，**0 外部依赖**，纯 Node 原生模块） |
| 支持平台 | `netease`（网易云）、`tencent`（QQ 音乐）、`kugou`（酷狗）、`baidu`（百度音乐）、`kuwo`（酷我） |
| 核心 API | `search()` / `song()` / `album()` / `artist()` / `playlist()` / `url(id, br)` / `lyric()` / `pic()` |
| 统一格式 | `format(true)` 后输出统一结构：`{ id, name, artist[], album, pic_id, url_id, lyric_id, source }` |
| 内置加密 | 网易 EAPI（AES-128-ECB + MD5 签名）、各平台签名/请求头伪装，**无需自行逆向** |
| 底层 | 全局 `fetch` + `AbortController`（20s 超时、3 次重试），Node ≥ 18 可用 |

> 说明：分析基于 2026-03 时的 metowolf/Meting `master` 分支与 npm registry 元数据。
> 该库仍活跃维护（最近提交 2026-03-29，未归档），上游持续跟进各平台接口变动。

## 2. 技术可行性分析

### 2.1 运行环境（Host 出网）

- 本插件 Host 端是跑在 DSH 宿主进程里的**普通 Node 模块**（`lib/index.js` 已直接用
  `node:fs` / `node:os` / `node:path`），`package.json` 要求 Node ≥ 20 → **全局 `fetch` 可用**。
- 因此 Host 可直接发外网 HTTPS/HTTP 请求，`@meting/core` 内部正是用 `fetch`。**无需新增运行时、
  无需二进制、无需 PHP**。

### 2.2 依赖引入方式（三选一）

| 方式 | 优点 | 缺点 |
|---|---|---|
| **A. `npm i @meting/core` 作 dependency（推荐）** | 自动跟上上游对各平台接口的修复 | 多一个运行时依赖 |
| B. vendor 进 `lib/` | 保持「单目录、零依赖」哲学 | 失去自动更新，需手动同步，约 +40KB 代码 |
| C. 自建 PHP Meting API 服务再 HTTP 调用 | 不写 Node 逆向逻辑 | 需要用户装 PHP 运行时，违背纯 JS 定位，**不推荐** |

### 2.3 浏览器端约束（CORS）与代理方案

- 浏览器**不能**直接请求 `music.163.com` / `mobilecdn.kugou.com`（无 CORS 头）。
- 但本插件架构天然解决：Host 已用 `/dsh-music` 前缀代理。新增两条 Host 路由：

```
POST /dsh-music/online/search            → Host 调 Meting 搜索，返回统一格式歌曲列表
GET  /dsh-music/online/play/<key>        → Host 用 Meting.url() 换取真实音频 URL，
                                            再以流式方式 pipe 回浏览器（边下边播）
```

- 走代理后 `<audio>` 是**同源**加载：
  - 现有实时频谱（`decodeAudioData` 解码）可以正常工作（它要求同源或 CORS）；
  - 规避了第三方 CDN 的防盗链/Referer 校验；
  - 行为与本地文件一致（都走 `/dsh-music`），前端改动最小。
- `webServer` 路由 handler 使用标准 `node:http` 的 `ServerResponse`，**支持 `res.write()` 流式输出**，
  在线音频可真正边下边播，不必像本地文件那样整段读入内存。

## 3. 平台逐个分析

### 网易云音乐 `netease` —— 最成熟，作为首选

- 搜索：`music.163.com/api/cloudsearch/pc`（EAPI 加密），Meting 已内置。
- 播放地址：`/api/song/enhance/player/url`（`ids` + `br`），匿名 cookie 通常可拿 **128kbps mp3**。
- 限制：
  - **VIP/付费歌曲**会返回错误或空 URL → 需要降级策略（换平台 / 低音质 / 提示不可播）。
  - 少部分 `.ncm` DRM 加密文件不可直链（API 返回的普通 URL 一般是 mp3/m4a/flac，影响有限）。
  - 播放 URL **有时效**（通常数小时）→ 需缓存并支持失效后重取。

### 酷狗音乐 `kugou` —— 可用但更脆

- 搜索：`mobilecdn.kugou.com/api/v3/search/song`（GET + UA 伪装）；播放：`m.kugou.com/app/i/getSongInfo.php`（按 hash）。
- 酷狗接口**历史上改版频繁**（hash 算法、cookie `kg_mid` 等），Meting 上游在跟进，但相比网易更容易
  「某个版本突然失效」。

### QQ 音乐 `tencent` —— 版权命中最高但限制最严

- 版权最全（大量头部曲目在腾讯系），但**匿名请求拿到完整播放地址的成功率低**（部分需绿钻 cookie）。
- 适合做「搜索展示/兜底」，播放成功率偏低。

### 百度 `baidu` / 酷我 `kuwo` —— 备选降级源

- 覆盖度低，但可作为免费降级源（网易 VIP 失败时尝试）。

## 4. 与现有插件的集成改动点

### Host（`lib/index.js`）

1. 引入 `@meting/core`，按来源初始化 Meting 实例（可选配置 cookie）。
2. 新增**搜索缓存（LRU）+ 播放 URL 缓存（带过期）**，避免高频打接口触发风控。
3. 新增两个路由（见 2.3）：`/online/search`、`/online/play/<key>`；`play` 失败自动**换源降级**。
4. `music_play` 工具扩展：本地无匹配 → 在线搜索 → 取首个可播结果（可加 `source` 参数限定平台），
   复用现有 `pendingIntent` 机制让浏览器播放在线曲目（无需改动意图轮询架构）。
5. 在线曲目**不入曲库扫描**，独立维护（单独列表或标记 `source`），避免与本地 500 首上限耦合。

### Client（`lib/client.js`）

- 播放列表支持「在线」来源（或与曲库混排并打来源标签：网易云/酷狗/…）。
- 展示歌手/专辑/来源标签；在线曲目走 `/dsh-music/online/play`。
- 播放失败（VIP/失效）给出明确提示并可选自动换源。

### 配置与文档

- 开关：**默认关闭**，用户显式开启；默认平台网易云，其余可选。
- 免责声明：仅个人试听/学习，版权归原作者及平台所有；使用即同意承担相应风险。

## 5. 风险与限制（重要，需预期管理）

| 风险 | 说明 | 缓解 |
|---|---|---|
| **法律/合规** | 非官方接口 + 流播受版权保护音乐，违反平台 ToS，有侵权风险 | 默认关闭、仅个人试听、README 明确免责 |
| **接口稳定性** | 逆向接口随时改版/封 IP，酷狗/QQ 尤甚 | 依赖 Meting 上游；本地音乐库仍为首选 |
| **VIP/DRM/区域** | 部分歌曲播不了或只有低音质 | 多源降级 + 明确报错文案 |
| **速率限制** | 搜索/换链频率过高可能被临时风控 | 缓存 + 限速 + 失败退避 |
| **隐私** | 请求携带匿名设备指纹类 header（无用户账号信息） | 低风险，文档说明即可 |

## 5.5 实测验证结果（2026-08-22，`@meting/core` 1.6.1）

> 方法：临时目录安装 `@meting/core` 1.6.1，实测搜索 → 取播放地址 → 真实 HTTP Range 请求验证音频可达。

| 平台 | 搜索 | 播放地址 | 实测结论 |
|---|---|---|---|
| **网易云 `netease`** | ✅ | ✅ 5/5 | **全链路跑通**。免费歌曲稳定拿到 128kbps（个别 320kbps）mp3，Range 请求返回 206 + `audio/mpeg` + ID3 头，确认真实可播 |
| **酷狗 `kugou`** | ✅ | ✅ 7/10 | **跑通（免费歌曲）**。无登录走 legacy 免费接口，返回 `fsios.tx.kugou.com` 真实 mp3（128–320kbps）；VIP 歌曲返回空 |
| **QQ `tencent`** | ✅ | ❌ | 搜索正常，但匿名请求拿不到播放地址（`msgpay:6` = VIP 门控），符合预期 |
| **酷我 `kuwo`** | ⚠️ | ❌ | 接口已失效：`{"success":false,"message":"The request is illegal!"}`，且搜索格式返回空对象 |
| **百度 `baidu`** | ⚠️ | ❌ | 提供方已损坏：搜索返回空对象，`url()` 返回 null / 抛异常 |

**关键观察：**

1. **网易云搜索的命中质量**：免费原唱（陈粒/朴树/赵雷/李健/房东的猫）均排在 #1；但 **VIP 原唱（如周杰伦《晴天》《七里香》）被降权，前 8 名全是翻唱/Remix**。→ agent 播放 VIP 歌手时会播到翻唱版本，需要「提示 + 换源」策略。
2. **URL 时效**：网易/酷狗返回的 URL 带时间戳 token（如 `20260822010013`），**数小时内失效** → 必须短缓存、失效重取。
3. **结论**：当前可落地来源为 **网易云（主）+ 酷狗（辅）**；酷我/百度已坏、QQ 被 VIP 门控——这印证了「非官方接口稳定性风险」是真实且持续存在的。

## 5.6 VIP 登录打通（网易云）· 实测与方案

> 2026-08-22 实测：**网易云扫码登录链路完全可用**，VIP 流程可以打通（仅限网易云；酷狗/QQ 的 VIP 登录复杂度高、风险大，暂缓）。

### 5.6.1 实测确认的登录链路（eapi 加密，`type:"3"`）

| 步骤 | 端点（eapi） | 实测结果 |
|---|---|---|
| 1. 取 unikey | `POST /eapi/login/qrcode/unikey`，body `{"type":"3"}` | ✅ 实测 `{"code":200,"unikey":"839683ea-…"}` |
| 2. 生成二维码 | 无服务端 create，**由客户端用链接 `https://music.163.com/login?codekey=<unikey>` 本地生成 QR** | ✅ 浏览器端用 QR 库渲染即可 |
| 3. 轮询扫码状态 | `POST /eapi/login/qrcode/client/login`，body `{"key":<unikey>,"type":"3"}` | ✅ 实测 `801 等待扫码` / `800 已过期`；`803 已扫码待确认` / `200 成功` 为标准流程状态，**需真实扫码后才能端到端确认** |

> 说明：`803`（已扫码待手机确认）与 `200`（登录成功，Set-Cookie 携带 `MUSIC_U` 会话）属于网易标准流程中的状态码，本次未用真实账号扫码验证这两个分支，但 `801/800` 已实测可达，流程完整。

- 登录成功时，`Set-Cookie` 响应头携带会话（`MUSIC_U` 等）——**Host 端需捕获响应头**，cookie 不进浏览器、只存 Host。
- 关键修正：**当前网易已弃用 weapi 匿名端点**（打 `/weapi/*` 一律空 200），登录/搜索/URL 全部走 **eapi**；`@meting/core` 的网易提供方正是 eapi，且自带 `.cookie(cookie)` 方法可直接注入会话。

### 5.6.2 打通后的收益（推论，机制已被广泛验证）

- 传入 VIP cookie 后，`/api/song/enhance/player/url` 返回 **320kbps（甚至无损）**，VIP 歌曲可播；
- **搜索质量提升**：登录态下原唱（VIP）歌曲恢复排名，缓解 5.5 的「翻唱顶掉原唱」问题；
- 仍有限制：极少数版权下架/独占曲目不可播（非账号权限能解决）。

### 5.6.3 实现方案（新增改动）

- **Host（`lib/index.js`）**：
  - 新增 `eapi` 加密工具（AES-128-ECB + `e82ckenh8dichen8`，摘要用 `/api/...` 原始路径——见 5.6.1，勿用 `/eapi/` 路径做签名）。
  - 新增路由：`POST /dsh-music/netease/login/start`（返回 unikey）、`POST /dsh-music/netease/login/check`（轮询，成功时捕获 `Set-Cookie`）、`POST /dsh-music/netease/login/logout`。
  - cookie 持久化到 `~/.dsh/music-player-netease-cookie.json`（沿用 state 模式，**文件权限 0600**，仅 Host 读写）。
  - 给网易 Meting 实例 `.cookie(...)` 注入；未登录走匿名 cookie。
- **Client（`lib/client.js`）**：播放面板新增「网易云登录」入口 → 显示二维码（引入轻量 QR 库或复用现成 CDN）→ 轮询状态 → 成功提示。
- **配置/文档**：登录完全可选；README 明确「第三方接口登录有**账号风控风险**（平台可能封禁/限流），请自担风险」。
- **酷狗/QQ VIP**：酷狗需 `token`+`KugooID` 登录态（`urlDecodeNew` 已预留），QQ 更复杂——**本期不做**，文档标注「不支持 VIP 登录」。

### 5.6.4 风险（较匿名更需预期管理）

| 风险 | 说明 | 缓解 |
|---|---|---|
| **账号风控/封禁** | 用第三方接口登录并流播违反 ToS，平台可能对账号限流/封禁 | 明确免责；默认匿名可用；登录为可选增强 |
| **cookie 安全** | 会话凭据泄露=账号被盗用 | 0600 文件权限、仅 Host 持有、支持一键退出 |
| **会话过期** | cookie 失效需重新扫码 | 失败时提示重新登录 |

## 5.6.5 QQ 音乐登录可行性（补充调研，2026-08-22）

**结论：技术上可行，但比网易云复杂一个数量级，且 `@meting/core` 不含登录能力，本期不建议做。**

| 层级 | 做法 | 复杂度 | 说明 |
|---|---|---|---|
| A（最简） | **手动粘贴 cookie**（用户从浏览器 y.qq.com 登录态复制 `uin`/`skey` 等） | 低 | lx-music 等所有现成工具的标准做法；meting tencent 提供方已会从 Cookie 读取 `uin` |
| B（完整） | **自动扫码登录** | 高 | 已有维护项目 `@yakult-green-tea/qq-music-api`（v3.0.0，2026-08-17 发布，可内嵌 Node）实现完整扫码；需引入独立依赖 |

- **为什么复杂**：QQ 登录是**跨域 3 阶段握手**——QR 取自 `ssl.ptlogin2.qq.com`（需 `hash33` 算 `ptqrtoken`）→ 轮询 `ptqrlogin` → `graph.qq.com/oauth2.0/authorize` 换 `p_skey`/`gtk` → 最终 `musicu.fcg`（QQConnectLogin）登录。网易云只需 2 个 eapi 端点（已实测跑通）。
- **VIP 取链可靠性存疑**：meting tencent 提供方走 legacy `musicu.fcg` vkey 接口（不带 `sign` 参数），匿名部分免费歌 128k 可用；登录后 VIP 取链是否稳定需真实账号实测，且腾讯会定期更换 `sign` 算法。
- **风险更高**：QQ 音乐对第三方登录的风控历史上比网易云更激进，cookie 时效短、绑定设备。
- **建议**：QQ 本期仅作「匿名免费曲目」来源；若用户坚持要 QQ VIP，优先方案 A（粘贴 cookie），B 作为远期可选并自担风控成本。

## 5.6.6 汽水音乐 API（qishui-api）· 实测（2026-08-22）

> 来源：[guowenye/qishui-api](https://github.com/guowenye/qishui-api)（汽水音乐=抖音系音乐 App 的非官方 Node API，Express 服务，Node ≥ 18，MIT）。已 clone + `npm install` 实测。

| 端点 | 匿名可用 | 实测结论 |
|---|---|---|
| `/recommend/playlist`、`/playlist/detail` | ✅ | 推荐歌单、歌单详情含曲目（真实数据） |
| `/song/detail`、`/audio/info`、`/download/url`（按 track_id） | ✅ | 免费曲目返回**未加密 m4a**（`ftypM4A`），支持 Range/206，**浏览器可直接播放** |
| `/lyric` | ✅ | 歌词 |
| `/discover`、`/radio/*` | ✅ | 发现页/电台 |
| `/auth/qrcode` + `/auth/qrcode/status` | ✅ | **扫码登录可用**：返回 base64 PNG 二维码 + 轮询状态（用**抖音 App** 扫码，非汽水 App） |
| `/search`、`/search/mixed`、`/search/playlist` | ❌ | **匿名不可用**：PC 接口需要 X-Helios/X-Medusa 签名，填 device_id/install_id/fp 也无效（两个上游主机直连均空响应） |
| `/media/player` | ⚠️ | App 播放信息接口，匿名返回空 `player_infos`，需登录态 |
| `/auth/me`、`/me/playlists` | 🔒 | 需登录 sessionid 后才可 |

**关键特性与限制：**

1. **搜索是最大短板**：匿名无法按歌名搜索（X-Helios 是 ByteDance 的请求签名，需逆向其前端签名算法）；用户只能靠 **track_id / 分享链接 / 浏览歌单** 来播放——和「输入歌名就播」的体验差很远。
2. **免费音质仅 64kbps**（URL `br=64`），低于网易云匿名 128k。
3. **VIP/加密曲目**：会带 `spade_a`（AES 密钥）+ 加密音频，需本地 `/decrypt/spade` + `/audio/decrypt`（AES-CTR）解密——项目已实现，但意味着不能直接喂给 `<audio>`，要 Host 解密后转发。
4. **登录**：扫码流程可用，但**登录后搜索是否可用未验证**（需要真实抖音账号扫码；且登录未必绕过 X-Helios 签名）。

**对插件集成的结论：**

- 作为**「曲目播放来源」（按 track_id/分享链接/歌单）**：✅ 可行且实现简单（未加密音频直接流播，复用本地播放架构）。
- 作为**「歌名搜索播放来源」**：❌ 匿名不可用，登录态能否解锁搜索需真实账号验证，X-Helios 签名是硬门槛。
- **建议**：汽水音乐作为**远期备选来源**（用于「粘贴分享链接播放」等特定场景），不做主搜索来源；网易云仍是主搜索+VIP 来源。

## 6. 工作量估算与里程碑

> 里程碑以 **UI 设计稿（docs/online-music-ui-design.md §9）的 M1–M6** 为权威任务拆分，此处合并给出预估。

| 里程碑 | 内容 | 预估 |
|---|---|---|
| M1 | 「在线」tab 骨架 + 匿名网易云搜索 + 播放（Host `/online/search`、`/online/play`） | 0.5 天 |
| M2 | 来源 chips + 酷狗接入 + 聚合合并 + 换源降级 + 播放条来源标签 | 0.5–1 天 |
| M3 | 音质/VIP 标签 + 翻唱提示 + 错误/空/部分失败态 | 0.5 天 |
| M4 | 在线总开关 + requestId 并发保护 + cooldown 持久化 | 0.25–0.5 天 |
| M5 | 搜索缓存 + URL 缓存 + 并发去重 | 0.25–0.5 天 |
| **M6（VIP 登录，可选）** | Host eapi 登录端点 + cookie 持久化 + `.cookie()` 注入；浏览器扫码 UI + 轮询；免责声明 | **1–1.5 天** |

**合计约 3–4.5 个工作日**（含可选 VIP 登录）。首次集成的难度低，真正持续的投入在「某平台接口失效后的跟进维护」。

## 7. 建议

1. **采用 `@meting/core` 官方 Node 包**（方式 A），默认只开网易云，其余平台作可选来源。
2. **在线播放默认关闭**，配置里开启；本地音乐库保持优先，不因在线功能影响既有体验。
3. 实现**换源降级**（网易 VIP 失败 → 酷狗免费版），并做好 URL 过期缓存（酷我/百度已实测失效，不再作为降级源）。
4. 明确**免责声明**与「仅供个人学习试听」定位，规避法律风险。
5. 把在线曲目做成**独立来源**，与本地曲库/歌单解耦，避免 500 首上限、收藏/持久化等既有逻辑被波及。
