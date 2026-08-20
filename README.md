# dsh-music-player

[![Awesome DSH Plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)

DeepSeek Harness 本地音乐库播放器插件（bundle）。

在 Host 进程里扫描本地音乐目录（默认 `~/Music`，可在面板里改），以 HTTP Range 流式（仅显示播放时间，暂无拖动跳转）给浏览器提供音频；浏览器侧给聊天输入区注入**正在播放条**（曲目信息、上一首/播放暂停/下一首/停止、顺序/单曲/乱序循环模式、音量、实时频谱），并提供一个浮动的**播放面板**（曲目列表 / 音乐目录选择与格式提示）。同时注册 `music_play` 模型工具，让 agent 可以直接按关键词播放本地音乐。

## 特性

- 本地音频流式播放（HTTP Range），刷新后断点续播
- 顺序播放、单曲循环、乱序播放三种模式
- 实时 7 段频谱可视化（解码音频包络驱动）
- 播放时申请屏幕唤醒锁，防止听歌时熄屏/休眠（支持 Wake Lock 的浏览器，如 Chrome/Edge）
- 播放列表面板可自由拖动，位置跨刷新记忆
- AI 讲书：本地 `.txt` 小说经 MiMo TTS 合成朗读，自动识别**书名/前言/章节/尾声**结构，播放条带**章节目录**跳转、章节切歌，可选 4 种中文 AI 声音（默认白桦）
- `music_play` 模型工具：agent 可按关键词让浏览器播放
- 支持的格式：`mp3 / m4a / m4b / aac / flac / wav / ogg / opus / webm / aiff`（自动递归扫描子目录，上限 500 首）

## 截图

![播放条](assets/screenshot-bar.png)

![实时频谱](assets/screenshot-spectrum.png)

![播放面板](assets/screenshot-panel.png)

## 安装

需要已安装 `dsh` CLI。

### 从 npm 安装（推荐，已发布到 registry）

```sh
# 把 <profile> 换成实际 profile 名，如 web
dsh plugin --profile <profile> add dsh-music-player
```

### 从 GitHub 安装（备用来源）

```sh
# 把 <profile> 换成实际 profile 名，如 web
dsh plugin --profile <profile> add github:kendu76/dsh-music-player
```

> 项目是手写的纯 JS（`lib/` 直接是发布产物），**没有**需要从源码构建的步骤，因此从 GitHub/npm 直装即可使用，无需像 TypeScript 包那样为构建脚本授权。

安装后重启 DSH，打开 Web GUI：
- 聊天输入区上方会出现「本地音乐播放器」播放条
- 点击右侧「列表」按钮打开播放面板
- 在面板顶部点击「选择音乐目录」并选定音乐目录（默认 `~/Music`），自动递归扫描
- 之后可直接在对话框里让 agent 播放，例如「播放周杰伦的歌」

### 从本地目录 / tarball 安装

```sh
# 本地目录
dsh plugin --profile <profile> add /path/to/dsh-music-player

# 或先打包再安装
pnpm pack
dsh plugin --profile <profile> add ./dsh-music-player-0.1.0.tgz
```

## 配置

插件为「Host 端 + Web 端」双面结构：

- Host 端（`lib/index.js`）：音乐扫描、HTTP 流式、`music_play` 工具、AI 讲书（小说结构解析 + TTS 合成）
- Web 端（`lib/client.js`）：浏览器里的播放条 / 播放面板 / 频谱 / 讲书控制

两者由一个 `cordis.patch.yml` 插入 `music-player` 行并自动组对（在 Web 端 `dsh.client` 声明即指回该行名并加载浏览器半体）：

```yaml
- insert:
    - id: music-player
      name: 'dsh-music-player'
```

播放模式与音量保存在浏览器 `localStorage`，当前曲目与进度也会在刷新后恢复（浏览器的自动播放可能被拦截，点一次 ▶ 即可解锁）。

## AI 讲书

把本地 `.txt` 小说交给 AI 朗读（复用 DSH 已配置的 xiaomi/MiMo TTS）。**AI 语音目前仅支持 xiaomi 提供方（限时免费），请在设置中配置好再使用此功能。**

### 前置

在 DSH 的模型设置里配置一个 xiaomi/MiMo TTS provider（含 api key）。未配置时，小说列表会提示"未配置 xiaomi/MiMo TTS 模型"。

### 使用

1. 打开播放面板，切到「小说」标签，点「选择小说目录」选定包含 `.txt` 的目录（默认与音乐目录相同）。
2. 点击某一本小说开始朗读（`music_play` 工具暂不面向讲书）。
3. 播放条上的讲书控制：
   - **章节目录**（📖 按钮）：自动识别全书结构（书名/前言/章节/尾声），弹出目录，点击任意章节即从该章开头朗读
   - **后退 / 前进**：讲书模式下跳上一章 / 下一章（音乐模式下仍是上一首 / 下一首）
   - **AI 声音**：点音量按钮，在弹层选择声音——冰糖（女）、茉莉（女）、苏打（男）、白桦（男，默认）
4. 刷新页面后从上次位置续读（断点续播）。

支持的格式：`.txt`（自动识别 UTF-8 / UTF-16 / GBK/GB18030 编码，无需手工转码）。

## 开发

需要 Node.js ≥ 20（vitest 建议 20.19+）与 npm。开发依赖仅 `vitest`：

```sh
npm install
npm test        # 跑 vitest 测试套件
```

修改 `lib/` 后，在本机 profile 里用 link 方式本地调试并验证：

```sh
dsh plugin --profile <profile> add ./   # 或直接改 profile 里的 link 目标
```

项目结构、测试策略与发布流程详见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 常见问题

**播放没有声音 / 显示"浏览器拦截了自动播放"？**
浏览器安全策略禁止未经交互的音频播放。首次自动播放被拦截是正常的——在播放条上点一次 ▶ 即可解锁，之后恢复播放。

**音乐面板显示"暂无音乐"或"不是有效的音乐目录"？**
点面板顶部「选择音乐目录」，选一个包含音频文件的实际目录（默认 `~/Music`）。目录路径不可读或不存在时会回退到默认目录而不是报错。

**改了音乐目录/新增了歌曲，但列表没更新？**
播放器在启动时扫描，并在每次“选择音乐目录”时重扫。想强制刷新当前目录，重新打开一次面板或点一次目录设置即可（扫描上限 500 首、递归子目录深度上限 4 层）。

**`music_play` 工具说"音乐库为空"？**
说明还没有可用的音乐目录。请先打开播放面板，点「选择音乐目录」配置一次。

**小说列表提示"未配置 xiaomi/MiMo TTS 模型"？**
AI 语音目前仅支持 xiaomi 提供方（限时免费）。请先在 DSH 模型设置里配置 xiaomi/MiMo provider（含 api key），再使用讲书功能。

**讲书播放时点后退/前进没反应？**
讲书模式下后退/前进是跳上一章/下一章；如果当前小说没有识别出章节结构（目录按钮提示"暂无章节结构"），则无法跳章，只能整本顺序播。

**想支持更多音频格式？**
格式支持由 Host 端 `AUDIO_TYPES` 表驱动，在 `lib/index.js` 里加扩展名与 MIME 即可（播放器本身用浏览器原生 `<audio>` 解码，最终能否播放还取决于浏览器对该编码的支持）。

## License

[MIT](LICENSE) © kendu76
