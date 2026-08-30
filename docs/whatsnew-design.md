# 版本更新弹窗（What's New）· 设计定稿（v2）

> 目标：首次安装或升级本插件的用户，在播放面板首次加载时弹出一个窗口，介绍当前版本的变化与重点特性；
> 已看过当前版本的用户不再打扰。另在「关于」页提供手动入口，可随时重看完整更新日志。
>
> 状态：已确认并实现。§9 三个待拍板问题均已按推荐方案定稿：
> ① 内容维护在 `lib/whatsnew.js`；② 老用户（prefs 非空无记录）按「升级模式」弹当前版更新内容；
> ③ 首屏数据就绪后延迟 ~600ms 自动弹。
> 实现与设计的差异：版本比较与判定（`cmpSemver`/`whatsNewState`）实际放在 Host 端 `lib/whatsnew.js`
> 计算后随 manifest 下发结论 `whatsNewState`，客户端只执行不比较（client.js 无法 import 模块，见下）。

## 1. 总体方案

| 项 | 决定（建议） |
|---|---|
| 触发判定 | Host 经 `/dsh-music/manifest` 下发 `version` + `whatsNew` 内容 + `seenVersion`；客户端比对后决定是否弹、以哪种模式弹 |
| 已看标记 | Host 端 serverPrefs 新增键 `dsh-music-seen-version`（值为看过的版本号字符串）。**不用 localStorage**——dsh-desktop 每次启动换端口 → origin 每次变，localStorage 读不回来（`lib/index.js` serverPrefs 注释里已记录此坑），而 prefs 文件在 `DSH_HOME` 下跨重启稳定 |
| 弹窗内容 | 新增数据模块 `lib/whatsnew.js`：按版本维护结构化更新条目（不解析 Markdown，零依赖）。发版时在数组顶部加一条 |
| UI | 复用现有弹窗模式：`portalToBody` + `dsh-music-picker-overlay` 遮罩 + 居中面板，Esc / 点遮罩 / 按钮均可关闭；不阻断数据加载 |
| 手动入口 | 「关于」页新增「更新日志」行 + 版本徽章可点击，随时重看 |

## 2. 数据：`lib/whatsnew.js`

结构化条目，数组按新→旧排序，只保留最近 N=10 条（更早的截断不展示）：

```js
export const WHATS_NEW = [
  {
    version: '0.8.0',
    date: '2026-02-20',
    title: '更聪明的播放，更清晰的声音',   // 一句话主题，可选
    sections: [
      { type: 'feature', items: ['新增：……'] },
      { type: 'improve', items: ['……'] },
      { type: 'fix',     items: ['……'] },
    ],
  },
  // …历史版本…
]

// 供 Host 查询：返回指定版本的条目（找不到返回 null）与历史列表（已截断）。
export function whatsNewFor(version) { /* … */ }
```

- `type` 渲染为分组标签：`feature` ✨ 新特性 / `improve` ⚡ 优化 / `fix` 🐛 修复；未知类型按 `improve` 兜底。
- **欢迎内容**同文件维护一个特殊条目 `WELCOME`（不占版本历史）：3~4 条核心卖点（本地音乐流式播放 / AI 讲书 / 在线 QQ·酷狗 / `music_play` 工具点歌），供首次安装模式使用。
- 选 `lib/whatsnew.js` 而非解析 `CHANGELOG.md` 的原因：结构化、无需引 Markdown 解析依赖、Host 直接 import；GitHub 侧 CHANGELOG 仍可另行维护，互不冲突。

## 3. Host 侧改动（`lib/index.js`）

1. **serverPrefs 白名单**：`PREF_ALLOW` 增加 `'dsh-music-seen-version'`；`sanitizePrefs` 对该键做格式校验（`/^[0-9A-Za-z.+\-]{1,32}$/`，即版本号形态），脏值丢弃。漏加会被静默丢弃 → 表现为「每次启动都弹」，这是本项目已踩过的坑模式，测试要覆盖。
2. **manifest 下发**（`/dsh-music/manifest` 与 `/dsh-music/rescan` 两处同步加）：

```jsonc
{
  // …现有字段…
  version: PKG_VERSION,
  whatsNew: { version, date, title, sections } | null,  // 当前版本的条目，无则 null
  whatsNewHistory: [ /* 最近 ≤10 条，含当前版 */ ],
  whatsNewWelcome: WELCOME,                             // 首装欢迎内容
  whatsNewState: 'fresh' | 'upgrade' | 'seen' | 'downgrade', // 判定结论（实现时从客户端移到 Host，见 §4）
}
```

3. 写入复用现有 `POST /dsh-music/prefs` 合并语义，**不新增路由**：客户端关闭弹窗时 `savePref('dsh-music-seen-version', version)` 即可。
4. ~~Host 不做任何判定逻辑~~ **实现时改为 Host 判定**：`cmpSemver` + `whatsNewState()` 落在 `lib/whatsnew.js`，由 `whatsNewPayload()`（每次下发前重读 prefs 保证新鲜）算出结论随 manifest 下发。原因：client.js 是 `window.__ModuleLoader__` 工厂脚本、无法 import 本模块，判定放 Host 可避免 `cmpSemver` 在两端各复制一份；客户端拿到结论只执行（`fresh`/`upgrade` 弹、`seen` 不弹、`downgrade` 静默补写标记）。

## 4. 客户端执行逻辑（`lib/client.js`）

store 新增：`whatsNew`、`whatsNewHistory`、`whatsNewWelcome`、`whatsNewState`、`whatsNewOpen`、`whatsNewMode`（`'welcome' | 'upgrade' | 'history'`），初始 `whatsNewOpen: false`；两处 manifest 消费点（`loadTracks` / `rescanLibrary`）把新字段塞入 store（rescan 只同步内容、不重新触发）。

**触发时机**：`loadServerPrefs` + 首次 manifest 都完成后（现有 `prefsReady` 时序），延迟 ~600ms 弹出（让面板先渲染完成，避免抢在首帧前）。用一次性闭包标记（`whatsNewAutoShown`）保证**每次页面加载至多触发一次**——rescan / 换目录的 manifest 刷新不重弹。

```
scheduleWhatsNewAuto():  # 600ms 后执行
  st = store.whatsNewState               # Host 判定结论
  st ∉ {fresh, upgrade}                  → st == downgrade 时静默 savePref(seen-version, 当前版)；不弹
  st == upgrade 且 whatsNew 条目为空      → 不弹（本版没写条目）
  → openWhatsNew(st == fresh ? 'welcome' : 'upgrade')
```

- `cmpSemver(a, b)`：内置 ~15 行 semver 比较（逐段数值 + prerelease 低于正式版），不引依赖。
- **首装启发式**：无 seen-version 记录时，若 prefs 里已有其他键（音量/播放进度等）→ 视为「从旧版本升级上来的老用户」走 `upgrade` 模式；prefs 全空才是真·首装走 `welcome`。这解决了「0.8.0 之前安装的用户没有 seen-version 记录」的歧义。
- **关闭** = `set({ whatsNewOpen: false })` + `savePref('dsh-music-seen-version', 当前版本号)`。写失败（无 DSH_HOME 等极端场景）只表现为下次还会弹，无害降级。手动从「关于」页打开（`history` 模式）时同样顺带写标记，语义无害。

## 5. UI 设计

复用 `dsh-music-picker-overlay` 遮罩 + 新样式 `.dsh-music-whatsnew`（居中固定面板，宽 ~440px，参考 `.dsh-music-panel` 的变量与圆角风格），`Esc` / 点击遮罩 / 底部按钮三种关闭方式。

```
┌──────────────────────────────────────────┐
│  ♪  DSH音乐播放器                [NEW] ✕  │   ← 插件名常驻头部（welcome 标题已含名则省略）
│     新版本 v0.8.0                          │
│     更聪明的播放，更清晰的声音 · 2026-02-20 │
│ ──────────────────────────────────────── │
│  ✨ 新特性                                │
│    • 在线歌词支持逐字卡拉OK动效            │
│  ⚡ 优化                                  │
│    • 目录扫描速度提升…                     │
│  🐛 修复                                  │
│    • …                                   │
│                                          │
│  ▸ 历史版本（折叠，点开列出 whatsNewHistory）│
│                                          │
│              [ 开始体验 ]                 │
└──────────────────────────────────────────┘
```

- `upgrade` 模式：如上，标题「新版本 v0.8.0」，按钮「开始体验」。
- `welcome` 模式：标题「欢迎使用 DSH 音乐播放器」，正文换 `WELCOME` 卖点条目，按钮「开始使用」。
- `history` 模式（关于页手动打开）：不区分新/旧，完整列出历史版本分组，按钮「关闭」。
- 「关于」页新增一行 `更新日志 | 查看 ›`（复用 `linkRow` 行样式，改为按钮而非外链），放在「关于」卡片内；头部版本徽章 `v0.8.0` 同样可点。

## 6. 边界与取舍

| 场景 | 行为 |
|---|---|
| 跨多版本升级（0.5 → 0.8） | 只自动弹当前版条目；历史折叠列表可展开逐条看，**不逐版连弹** |
| 降级安装（seen 0.8.0 → 装回 0.7.2） | 不弹，静默把 seen-version 改写为当前版，避免来回升降级反复打扰 |
| 该版本没写条目（忘了更新 whatsnew.js） | `whatsNew` 为 null → 不弹；关于页「更新日志」仅显示历史条目 |
| 多窗口 / 多标签页 | 各自弹一次、各自可关，互不同步（无 localStorage 可用；要同步需引入轮询，不值得）。先关的那个写入生效，后弹的窗口关闭时写同值，幂等 |
| prefs 文件不可写（无 DSH_HOME） | 每次启动都会再弹，可接受降级，不影响其他功能 |
| 弹窗与播放中操作冲突 | 弹窗 portal 到 body、独立于面板；弹出前延迟 600ms、随时可关，不阻断音频加载与 `music_play` intent 轮询 |

## 7. 测试要点（vitest，沿用现有 `test/` 组织）

1. `whatsnew.js`：`whatsNewFor` 命中 / 未命中 / 历史截断 ≤10；条目字段缺省兜底。
2. `sanitizePrefs`：`dsh-music-seen-version` 合法值通过；脏值（超长 / 非版本字符 / 非字符串）丢弃；未登记键被丢的回归用例。
3. `decision()` 纯函数表驱动：首装 / 升级 / 同版 / 降级 / 无内容 / prefs 非空无记录（老用户）六种输入。
4. `cmpSemver`：`0.9.0 > 0.10.0` 为假（逐段数值比较）、prerelease `0.8.0-beta.1 < 0.8.0`、等长不等段。
5. manifest 路由快照：三个新字段存在且 `rescan` 与 `manifest` 一致。

## 8. 实现里程碑

1. `lib/whatsnew.js` 数据模块（含 `WELCOME` + 当前版示例条目）+ 单测。
2. Host：`PREF_ALLOW`/`sanitizePrefs` + manifest 两个路由下发新字段 + 单测。
3. Client：store 字段、`cmpSemver`/`decision` 纯函数、`WhatsNewModal` 组件与样式、关于页入口 + 单测。
4. 发版流程补充：`CONTRIBUTING.md` 加一条「发版前在 `lib/whatsnew.js` 顶部追加本版条目，与 package.json version 同步」。

工作量估计：单独一个 PR，核心改动 ~300 行（含样式与测试）。

## 9. 待确认问题（已于 v2 定稿）

1. **内容维护位置**：✅ `lib/whatsnew.js` 代码内维护（不解析 CHANGELOG.md）。
2. **老用户首弹形态**：✅ 无记录但 prefs 非空的老用户按「升级模式」弹当前版更新内容。
3. **打扰程度**：✅ 首屏数据就绪后延迟 ~600ms 自动弹；「关于」页入口作为补充。

> 实现落点（对应上方里程碑 1-4）：`lib/whatsnew.js`（数据 + `cmpSemver` + `whatsNewState`）、
> `lib/index.js`（`PREF_ALLOW`/`sanitizePrefs` + `whatsNewPayload()` 注入 manifest/rescan）、
> `lib/client.js`（`scheduleWhatsNewAuto`/`openWhatsNew`/`dismissWhatsNew` + `WhatsNewModal`
> + 关于页入口 + `.dsh-music-whatsnew` 样式）、`CONTRIBUTING.md`（发版流程第 1 步）。
> 测试：`test/whatsnew.test.js`、`test/index.test.js`（manifest 四件套/判定/脏值丢弃/rescan）、
> `test/client.test.js`（自动弹/欢迎/seen 不弹/downgrade 静默补写/关于页手动入口）。
