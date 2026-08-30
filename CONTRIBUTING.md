# Contributing / 贡献指南

Thanks for wanting to contribute to **dsh-music-player**! / 感谢你参与 dsh-music-player 的开发！

## Structure / 项目结构

```
dsh-music-player/
├── lib/
│   ├── index.js     # Host 端：音乐扫描、HTTP 流式、歌单 CRUD、music_play 工具
│   ├── qq.js        # QQ 音乐接口封装（登录/搜索/取链/歌词/歌单）
│   ├── lyric.js     # 本地歌曲在线歌词兜底：LRCLIB 封装 + 匹配打分 + QQ→LRCLIB 编排
│   ├── whatsnew.js  # 版本更新弹窗：更新条目数据 + 首装/升级判定（whatsNewState）
│   └── client.js    # Web 端：浏览器里的播放条 / 播放面板 / 频谱 / 歌单
├── docs/
│   ├── playlists-design.md        # 自建歌单功能设计定稿（v3）
│   ├── online-music-feasibility.md# 在线 QQ 音乐功能实现文档
│   ├── online-lyrics-feasibility.md # 本地歌曲在线歌词功能实现文档
│   └── whatsnew-design.md         # 版本更新弹窗设计定稿
├── cordis.patch.yml # 把插件行插入 profile 的 bundle patch
├── test/
│   ├── index.test.js  # Host 端 vitest（假 ctx + 临时目录驱动真实路由）
│   ├── lyric.test.js  # lyric.js 单测（打分/归一化/getOnlineLyric 编排）
│   ├── whatsnew.test.js # whatsnew.js 单测（semver 比较/判定/数据完整性）
│   └── client.test.js # Web 端渲染冒烟/交互测试（jsdom + react-dom）
└── package.json      # 声明 dsh.bundle manifest 与 test/ci scripts
```

## Setup / 环境准备

需要 Node.js ≥ 20（vitest 建议 20.19+） 与 npm。开发依赖：`vitest` + `react`/`react-dom`/`jsdom`（用于前端渲染冒烟测试）：

```sh
npm install
```

> 如果本机 `~/.npm` 缓存里有 root 所有的文件导致 `EPERM`，可以改用项目内缓存绕过：`npm install --cache ./.npm-cache`（该目录已在 `.gitignore`）。

## Running tests / 运行测试

```sh
npm test            # 单次运行 vitest
npm run test:watch  # 监听模式
```

测试策略：`test/index.test.js` 用一个假 `ctx` 驱动 `lib/index.js` 的真实 `apply()`——

- `ctx.fs` 背后是对应一个真实临时目录（`scan`/`stat`/`readBytes` 走真实文件）；
- `ctx.webServer.register` 捕获 HTTP handler，测试再用手写的假 `req`/`res` 逐条打路由（manifest / set-root / Range / seek / HEAD / 404）；
- 「临时 home」通过 `process.env.HOME` 与 `process.env.DSH_HOME` 隔离，测完清理。

改动 `lib/` 后请确保 `npm test` 全绿再提交。

## How it fits together / 它如何被组装

`package.json` 顶层声明了 `dsh.bundle.patch`（指向 `cordis.patch.yml`），这是它作为 DSH bundle 被 `dsh plugin add` 正确启用的关键；`dsh.client` 声明则让 Web 端在浏览器半体加载。

## Making changes / 提交改动

- 每个有意义的改动一个提交，提交信息用动词开头（add / fix / docs / test / ci …）。
- 修改 Host 或 Web 逻辑后，先本地 `dsh plugin --profile <profile> add ./` 以 link 方式快速验证。
- 提交信息示例：`fix(stream): await library scan before resolving a track`

## Releasing / 发布新版本

1. **更新 `lib/whatsnew.js`**：在 `WHATS_NEW` 数组顶部追加本版条目（`version` 与
   `package.json` 保持一致），按 `feature` / `improve` / `fix` 分组写重点变化；
   历史条目只保留最近 `WHATS_NEW_MAX`(10) 条。用户首次安装或升级后，播放面板会
   自动弹出该内容（版本更新弹窗，设计见 `docs/whatsnew-design.md`）。
2. 更新 `package.json` 的 `version`（npm 不允许同名同版本重复发布）。
3. 发布到 npm：`npm publish`（需已配置 npm 账号的 2FA 或 bypass-2FA token）。
4. 可选：把对应 tag 推到 GitHub：`git tag v<version> && git push origin v<version>`。
5. 校验发布内容：`npm pack --dry-run`（应只含 `lib/`、`cordis.patch.yml`、`LICENSE`、`README.md`、`package.json`）。

## License / 许可

[MIT](LICENSE) © kendu76
