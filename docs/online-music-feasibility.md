# 在线音乐播放功能 · 实现文档（QQ 音乐）

> 目标：在本插件（dsh-music-player）中新增「播放在线音乐」能力。
> 实现方式：**QQ 音乐（腾讯系）**，Host 端直连 `musicu.fcg` / 传统 `y.qq.com` 端点，
> 浏览器经 `/dsh-music` 同源代理流播。
>
> 状态：**已实现并落地**（登录 / 歌单 / 排行榜 / 新歌 / 搜索 / 收藏「我喜欢」），
> 匿名可用，登录可解锁 VIP/高音质。

---

## 1. 方案选型（为何是 QQ 音乐）

早期文档基于 [metowolf/Meting](https://github.com/metowolf/Meting) 的多平台方案（网易云/酷狗/QQ/酷我/百度）。
实测与最终落地时出现如下变化，故**放弃了 Meting 多平台方案，聚焦 QQ 音乐单一来源**：

| 来源 | 实测结论（早期） | 最终取舍 |
|---|---|---|
| 网易云 | 搜索质量好、匿名可播 128k；VIP 原唱被翻唱顶掉 | 可作候选，但未接入 |
| 酷狗 | 免费曲可播 7/10，接口频繁改版 | 未接入 |
| **QQ 音乐** | 版权最全；匿名搜索正常；**匿名取链成功率低、VIP 门控** | **采用**：扫码/微信登录打通后取链可靠 |
| 酷我 / 百度 | 已失效（接口损坏） | 不接入 |

**为什么最终选择 QQ 音乐并打通登录**：

1. **版权覆盖最全**：大量头部曲目在腾讯系，用户搜索命中率高。
2. **登录链路可打通**：QQ 扫码（`ptqrlogin`）与微信扫码（`open.weixin.qq.com`）两条链路均实测可用，
   登录后走 `musicu.fcg` 的 vkey 取链，VIP/高音质可靠。
3. **接口体系稳定**：`musicu.fcg` 统一网关 + 传统 `fcg_*` 端点，结构清晰，便于维护。

---

## 2. 架构与代理方案

### 2.1 Host 出网（无需额外运行时）

- 插件 Host 端是跑在 DSH 宿主进程里的普通 Node 模块（`lib/index.js` 已直接用 `node:fs` / `node:http`），
  `package.json` 要求 Node ≥ 20 → **全局 `fetch` 可用**。
- 因此 Host 可直接请求 `u.y.qq.com` / `c.y.qq.com` 等外网端点，无需 PHP / 二进制 / 额外运行时。

### 2.2 浏览器端约束（CORS）与同源代理

- 浏览器**不能**直接请求 `music.qq.com` / `u.y.qq.com`（无 CORS 头，且腾讯有防盗链/Referer 校验）。
- 复用插件既有的 `/dsh-music` 前缀代理架构：

```
GET /dsh-music/qq/play/<songmid>     → Host 用 vkey 接口换取真实音频 URL，
                                        再以流式（pipe）回传浏览器（边下边播）
```

- 走代理后 `<audio>` 是**同源**加载：现有实时频谱（`decodeAudioData`）正常工作，与本地文件行为一致。
- 登录 cookie 只存 Host（`~/.dsh/music-player-qq-cookie.json`，0600 权限），不进浏览器，降低泄露面。

---

## 3. 已实现的接口清单（Host 端）

### 3.1 登录 / 状态

| 方法 | 端点 | 说明 |
|---|---|---|
| POST | `/dsh-music/qq/login/start` | 生成二维码会话（`mode=qq` 或 `mode=wx`） |
| GET | `/dsh-music/qq/login/check` | 轮询扫码状态（`waiting/scanned/success/expired/failed`） |
| POST | `/dsh-music/qq/login/logout` | 退出登录，清空 Host cookie |
| GET | `/dsh-music/qq/status` | 登录态 + uin + 昵称 |

- 登录态持久化到 `~/.dsh/music-player-qq-cookie.json`（0600），刷新/重启后仍有效。
- 微信登录响应含大整数 `musicid`（~1e18），用 `parseJsonPreserveBigInt` 保留精度。

### 3.2 搜索 / 播放

| 方法 | 端点 | 说明 |
|---|---|---|
| GET | `/dsh-music/qq/search?w=` | 歌曲搜索（返回带 `songmid` 的歌曲数组） |
| GET | `/dsh-music/qq/play/<songmid>` | 登录态 vkey 取链并流式代理；VIP 登录可播高音质 |

### 3.3 歌单

| 方法 | 端点 | 说明 |
|---|---|---|
| GET | `/dsh-music/qq/playlist-categories` | 分类列表（语种/曲风等，共 60+ 类） |
| GET | `/dsh-music/qq/playlists?category=&page=` | 推荐歌单（空 category）或某分类歌单（分页，每页 20） |
| GET | `/dsh-music/qq/playlist-search?w=` | 歌单搜索 |
| GET | `/dsh-music/qq/playlist/<id>` | 歌单详情（含歌曲列表，带 `songmid`） |
| GET | `/dsh-music/qq/my-playlists` | 我的歌单（登录后，当前账号创建/收藏） |

### 3.4 发现（排行榜 / 新歌）

| 方法 | 端点 | 说明 |
|---|---|---|
| GET | `/dsh-music/qq/top-lists` | 排行榜全部分组（巅峰榜/地区榜/特色榜等） |
| GET | `/dsh-music/qq/top-songs?topId=` | 某榜单歌曲列表（带 `songmid`） |
| GET | `/dsh-music/qq/new-songs?type=` | 新歌速递（type 5 最新 / 1 内地 / 6 港台 / 2 欧美 / 4 韩国） |

### 3.5 收藏「我喜欢」

| 方法 | 端点 | 说明 |
|---|---|---|
| POST | `/dsh-music/qq/fav` | 收藏/取消收藏（`action=add|remove`，写入「我喜欢」dirId 201） |
| GET | `/dsh-music/qq/liked` | 读取「我喜欢」已收藏歌曲的 `songid` + `songmid` 集合 |

---

## 4. 前端 UI（详见 ui-design 文档）

- 播放面板新增顶级 tab「**QQ音乐**」（原「在线」），与「本地音乐」「AI讲书」并列。
- 未登录：仅显示两个居中登录按钮（QQ 登录 / 微信登录）+ 免责声明。
- 登录后主 UI：顶部工具栏（进入播放列表 / 退出登录）+ 6 个子 tab：
  **我的歌单 / 推荐歌单 / 分类歌单 / 排行榜 / 新歌 / 搜索**。
- 歌单/榜单以**卡片式**展示（封面图 + 名称 + 元信息）。
- 搜索支持历史记录；收藏爱心按钮实时反映「我喜欢」状态。

---

## 5. 关键技术点

### 5.1 登录态 comm（musicu.fcg 必需字段）

```js
// 匿名也通，但取链/我的歌单/收藏需登录态：
{
  ct: 11, cv: 14090008, v: 14090008,
  tmeAppID: 'qqmusic', uid: uin, qq: uin, loginUin: uin,
  authst: musickey, tmeLoginType: '1'|'2'   // 登录后注入
}
```

### 5.2 大整数保真（parseJsonPreserveBigInt）

- 微信登录 `musicid` / `uin` 可达 ~1e18，超出 JS 安全整数（2^53）。
- 自定义 JSON 解析器把超范围整数字面量保留为字符串，避免歌单/收藏串号。

### 5.3 HTML 实体解码（decodeEntities）

- QQ 接口返回的歌单名/歌曲名/歌手名/描述/分类名等可能带 `&#...;` / `&amp;` 实体。
- 所有用户可见字符串在 Host 端统一 `decodeEntities` 解码。

### 5.4 收藏匹配键（songmid 优先）

- 判断「当前曲目是否已收藏」：`songmid`（稳定字符串）优先，`songid` 兜底。
- 读接口失败时回退到 localStorage 本地兜底集合，保证爱心状态可靠。

### 5.5 榜单/歌单图片

- 榜单封面用 `frontPicUrl`（300×300 方形，带榜名）；歌单用 `cover`/`imgurl`。
- 所有图片 URL 统一 `http→https`。

---

## 6. 风险与限制

| 风险 | 说明 | 缓解 |
|---|---|---|
| **法律/合规** | 非官方接口 + 流播受版权保护音乐，违反平台 ToS，有侵权/封号风险 | 登录前免责声明；定位「个人试听/学习」；README 明确 |
| **接口稳定性** | 逆向接口随时改版/封 IP | 登录态取链相对稳定；本地音乐库仍为首选 |
| **VIP/DRM/区域** | 部分歌曲需登录才可播，极少数版权下架不可播 | 登录可解锁大部分；失败给明确报错 |
| **账号风控** | 第三方登录可能触发平台风控/封禁 | 明确免责；支持一键退出；cookie 仅 Host 持有 |
| **会话过期** | cookie 时效短，可能需重新扫码 | 失败提示重新登录 |

---

## 7. 与本地播放器的关系

- 在线曲目**不入曲库扫描、不占用 500 首上限**，独立维护（`scope: { kind: 'qq' }`）。
- 在线播放进度（当前曲目 + 队列 + 来源）持久化到 localStorage，刷新后可恢复。
- 在线曲目走同一个 `<audio>` 播放条与频谱，只是来源标记为 QQ 音乐。

---

## 8. 文件结构

| 文件 | 职责 |
|---|---|
| `lib/qq.js` | QQ 音乐接口封装（登录/搜索/歌单/排行榜/新歌/收藏 + 工具函数） |
| `lib/index.js` | `/dsh-music/qq/*` 路由 + cookie 持久化 |
| `lib/client.js` | 浏览器端 QQ 音乐 UI（登录/浏览/搜索/播放/收藏） |
| `test/qq.test.js` / `test/qq-bigint.test.js` | 接口与工具函数测试 |
