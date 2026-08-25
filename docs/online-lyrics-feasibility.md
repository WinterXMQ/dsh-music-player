# 本地歌曲在线歌词 · 可行性分析

> 目标：**本地音乐找不到同名 `.lrc` 歌词时，自动在线搜索并获取歌词**（含逐句翻译），
> 让本地曲目也能像在线 QQ 歌曲一样显示实时歌词；可选把歌词保存为本地 `.lrc` 文件。
>
> 状态：**模式 A（自动静默兜底 + Host 缓存）已实现并落地**。
> 来源：**QQ 音乐匿名接口**（歌词 `fcg_query_lyric_new` + 歌曲搜索 `client_search_cp`，含逐句翻译）
> → **LRCLIB**（免费、无需 key、同步 LRC），无需登录。
> 「保存为本地 .lrc」「候选切换（模式 C）」为后续可选项，暂未实现。

---

## 0. 使用声明（重要，请务必阅读）

歌词为版权方所有（歌词文本/翻译版权归著作权人及 QQ 音乐平台）。本功能**仅供个人学习、
技术研究、日常个人试听使用**；**严禁商业用途、公开传播、二次分发**。使用本功能即表示您
已知悉并同意：因使用非官方接口导致的账号风控、法律与版权纠纷由使用者自行承担，本项目作者
不承担任何直接或间接责任。如不同意请勿使用。

---

## 1. 结论

**完全可行，且工作量不大。** 项目的关键构件——QQ 匿名**歌曲搜索**、QQ 匿名**歌词取词**
（含逐句翻译）、Host 端 **LRC 解析**、客户端**歌词展示管线**——全部已经存在并在在线播放
链路中运行。本功能的唯一实质增量是「**把本地歌曲映射到 QQ 歌曲（songmid）**」这一段。

---

## 2. 现状盘点（已具备的能力）

| 能力 | 位置 | 说明 |
|---|---|---|
| 本地歌词 | `GET /dsh-music/lyric?path=`（`lib/index.js:2602`） | `findLrcForAudio()` 找同名 `.lrc`；无则返回 `{ ok:false, hasLrc:false }` |
| 在线 QQ 歌词 | `GET /dsh-music/qq/lyric?songmid=`（`lib/index.js:2588`） | `QQ.getLyric(songmid)`（`lib/qq.js:408`），**匿名可访问**，返回 LRC 文本 + 可选逐句翻译 `trans` |
| 在线歌曲搜索 | `GET /dsh-music/qq/search?w=`（`lib/index.js:2394`） | `QQ.search()`（`lib/qq.js:325`），**匿名可用**，返回 `songmid/歌名/歌手/时长(interval)` |
| LRC 解析 | `parseLrc()`（`lib/index.js:1005`） | 标准 `.lrc` → `[{t,text}]`，支持多时间戳/offset |
| 客户端展示 | `loadLyricForTrack` / `loadQQLyric` / `mergeLyricTrans`（`lib/client.js:978-1018`） | 本地与 QQ 两路已共用同一渲染位；`mergeLyricTrans` 把逐句翻译并入同行「原文 ／ 翻译」 |

在线播放功能文档见 [online-music-feasibility.md](online-music-feasibility.md)（同一套代理架构与免责声明）。

---

## 3. 核心难点：本地歌曲没有 songmid

QQ 歌词按 `songmid` 索引，本地文件没有。因此需三步：

1. **派生关键词**：用文件名 stem（客户端已用 `stripExt(name)` 显示）；可选增强：解析 ID3v2
   `TIT2`（标题）/`TPE1`（歌手）帧做更精准的「歌名 + 歌手」搜索——当前 `readAudioMeta`
   只解析音质（`lib/index.js:250`），尚未取标题/歌手，属于加分项而非必需。
2. **搜索 + 匹配**：`QQ.search(keyword)` 取前 N（如 5）条，按以下信号打分选最优：
   - 标题相似度（归一化空格/标点后相等或包含）；
   - 歌手命中（`artists` 与文件名/ID3 歌手一致）；
   - 时长 `interval`（秒）与本地曲目时长相近（辅助信号，本地时长需另测或省略）。
   返回 `{ matched, candidates }`。
3. **取词**：`QQ.getLyric(best.songmid)` → `parseLrc` → 复用现有渲染管线。

---

## 4. 三种 UX 模式（推荐 A）

- **A · 全自动静默兜底（推荐）**：本地无 `.lrc` → 自动搜索取词 → 直接显示；播放条歌词旁加
  一个「在线」小标识。零操作，与现有 QQ 在线歌词体验完全一致。缺点：匹配错时用户不可见来源。
- **B · 候选确认**：低置信度时弹出候选列表让用户选择哪一首的歌词。最准，UI/交互成本高。
- **C · 混合**：自动用 Top1，置信度低时歌词区域可点击弹出候选切换。折中，推荐作为 A 的后续增强。

建议先落地 A（含缓存），再按需加 C。

---

## 5. 数据 / 存储设计

- **匹配结果缓存**：按 `track.path`（稳定）缓存 `{ keyword, songmid, matchedTitle, ts }`
  到 Host（可并入 `~/.dsh/music-player-prefs.json` 或独立 `-lyrics-cache.json`），避免每次
  播放重复搜索/取词。缓存失败/空结果也缓存（带短 TTL），防止反复请求。
- **是否落盘**：建议**默认不写文件**——在线即取即显 + Host 缓存即可，与「在线内容不落本地」
  的现有架构一致（当前 QQ 歌词也不存盘）。另提供**显式「保存为本地 .lrc」**按钮（二次确认 +
  免责提示），把歌词写到 `<音频stem>.lrc`，之后即走本地歌词路径。不自动批量写盘，规避磁盘副作用
  与合规风险。

---

## 6. 接口设计（草案）

```text
GET /dsh-music/lyric/online?path=<登记路径>&title=<歌名>&artist=<歌手>
  # 守卫：isRegisteredAudioPath 同 /dsh-music/lyric；先查本地 .lrc，有则直接返回本地
  # 成功: { ok:true, hasLyric:true, source:'online'|'local', lrc:[{t,text}],
  #         trans:[...], matched:{title, artists, songmid, confidence} }
  # 无结果: { ok:true, hasLyric:false }
  # 失败(网络/限流): { ok:false, error } → 客户端静默保持无歌词

POST /dsh-music/lyric/save   # 可选
  # body: { path, songmid } → 取词并写 <stem>.lrc（0600），返回 { ok, name }
```

客户端 `loadLyricForTrack`：本地返回 `hasLrc:false` 时，追加调用 `/lyric/online`，
`mergeLyricTrans(d.lrc, d.trans)` 后进同一渲染管线（来源标识已按需移除，不显示来源）。
`qq.js` **无需改动**（`search`/`getLyric` 直接复用）。

---

## 7. 风险与缓解

| 风险 | 说明 | 缓解 |
|---|---|---|
| **版权/合规** | 歌词为版权内容，通过非官方接口获取 | 沿用在线功能免责声明；不自动批量落盘，保存需显式确认 |
| **匹配准确率** | 翻唱/现场/纯音乐/命名特殊 → Top1 可能错 | 标题+歌手+时长联合打分；低置信度静默或提示「歌词可能不匹配」；失败静默不打扰 |
| **接口稳定性/限流** | 匿名接口可能限流/改版 | 请求轻量；按 path 缓存命中避免重复请求；失败回退到现状（无歌词） |
| **新增依赖** | — | 无：复用全局 `fetch` + 现有 `qq.js` |

---

## 8. 工作量拆解（已落地）

| 模块 | 内容 | 状态 |
|---|---|---|
| `lib/lyric.js`（新增） | LRCLIB 封装（search/get）+ 归一化/打分/pickBest + `getOnlineLyric`（QQ → LRCLIB 编排） | ✅ |
| Host `lib/index.js` | `/lyric/online` 端点（本地优先 + 守卫 + LRU 缓存） | ✅ |
| `lib/qq.js` | 无需改 | — |
| 客户端 `lib/client.js` | `loadLyricForTrack` 本地缺失 → `loadOnlineLyric` 兜底（文件名拆分歌名/歌手） | ✅ |
| 测试 | `test/lyric.test.js`（打分/编排单测）+ `index.test.js` 路由 6 例 + `client.test.js` 渲染 2 例 | ✅ |
| 文档 | README 特性 + 本文档 | ✅ |

> 未做（后续可选）：**「保存为本地 .lrc」按钮**（写 `<stem>.lrc`，二次确认 + 免责）、
> **候选切换（模式 C）**、把匹配结果缓存持久化到 Host 文件（当前为进程内 LRU：正命中 6h / 空命中 30min / 上限 500 条）。

---

## 9. 结论

- **技术可行性：高**。构件齐全，无需新增依赖/登录；核心增量只是「本地歌曲 → 搜索 → 匹配 → 取词」。
- **匹配准确率**：以标题为主信号 + 歌手/时长辅助打分，分数 ≥ 52 才采信（避免错配歌词）；实测 QQ 命中率高、LRCLIB 兜底覆盖冷门。
- **已实现**：模式 A（自动静默兜底 + Host LRU 缓存），全量测试 271 例通过。

---

## 附录 A：LRCLIB 实测记录（2025-08 实测）

> 结论先行：**LRCLIB 完全可用**——免费、无需 key、CORS 开启、返回标准 LRC，
> 中文热门歌覆盖良好。适合作为多源兜底链中的「专门免费歌词 API」来源。

### A.1 接口实测

| 接口 | 行为 | 实测 |
|---|---|---|
| `GET /api/search?q=<关键词>` | 模糊搜索，返回数组（≤20 条） | **200**；无结果返回 `[]`（非 404） |
| `GET /api/get?artist_name=&track_name=&duration=` | **精确匹配**单条 | 匹配 → **200**；`artist_name` 与 `track_name` **都必填**（缺任一 **400**），`duration` 可选；找不到 → **404** `{"message":"Failed to find specified track","name":"TrackNotFound"}` |
| `GET /api/get/<id>` | 按 id 取单条 | **200**；不存在 → **404** |

- **必须百分号编码 URL 参数**：直接放未编码中文 → **400**。实现时用 `URLSearchParams`（自动编码）。
- `get` 无模糊兜底 → 本项目应以 `search` 为主（模糊），再按歌手/时长打分选优；`get` 仅用于已确定 artist+track 时。

### A.2 返回结构（search/get 同构的单条记录）

```json
{
  "id": 16363, "name": "七里香", "trackName": "七里香",
  "artistName": "周杰伦", "albumName": "七里香",
  "duration": 297.0, "instrumental": false,
  "plainLyrics": "…", "syncedLyrics": "[00:27.38] 窗外的麻雀…"
}
```

- `syncedLyrics` 为**标准 LRC**（含 `[ti:]`/`[ar:]`/`[offset:]` 元数据与 `[mm:ss.xx]` 时间戳）→ 可直接喂给现有 `parseLrc()`。
- `instrumental: true|false` 可跳过纯音乐；`duration`（秒）可作匹配辅助信号。
- `plainLyrics` 无时间戳，仅作兜底（非同步，只能整首显示）。

### A.3 中文覆盖

- 热门中文歌覆盖良好：以周杰伦《七里香》为例，搜索返回 10+ 条（含简/繁、不同歌手名写法）。
- 冷门/新歌覆盖一般，欧美歌较强 → 与 QQ/网易/酷狗互补，做成多源链更有价值。

### A.4 限流与缓存

- **限流存在但宽松**：单次突发 40+ 请求全部 200（未见 429），每请求耗时 ~1.3-1.5s。
- 响应头暴露 `access-control-expose-headers: retry-after`（被限流时会回 `Retry-After`）。
- 官方建议：**缓存响应（LRU）、按需请求**。实现时按 `track.path` 做 Host 侧缓存即可满足。

### A.5 对实现的启示

1. 优先用 `search`（模糊）→ 打分选优；`get` 仅在 artist+track 都确定时用（如来自 ID3 标签）。
2. 必须 `URLSearchParams` 构造请求（防中文 400）。
3. `syncedLyrics` 直接 `parseLrc()`，无需新解析器；`trans` 翻译可由 QQ 源提供。
4. 做 LRU 缓存 + 失败静默回退，与现有「无歌词」体验一致。
