# Screenshots / 截图

放在这里的截图用于 dsh-market 插件市场的 AppStore 风格详情页展示（通过 awesome-dsh-plugin 的 `data/screenshots.json` 引用），也会出现在本仓库。

截图必须是 **PNG**，且保存在本仓库（这样用 `raw.githubusercontent.com` 的 https 链接即可被 awesome 列表接受）。

请在浏览器里打开 DSH Web GUI、**播放一首本地音乐**后，用系统截图（macOS `Cmd+Shift+4` / `Cmd+Shift+3`）截取以下画面，按下面命名存进本目录：

| 文件名 | 截图内容 | 建议 |
|---|---|---|
| `screenshot-bar.png` | 聊天输入区上方的**播放条**（正在播放的歌名 + 时间 + 模式/音量/列表按钮） | 横向裁切，看得清歌名与按钮 |
| `screenshot-panel.png` | **播放面板**（曲目列表 + 音乐目录设置） | 打开右侧「列表」按钮后截 |
| `screenshot-spectrum.png` | 播放时带**实时频谱**的播放条 | 播放时截，频谱条在动（7 段绿色竖条） |

期望效果（dsh-market 详情页）：
```jsonc
// awesome-dsh-plugin 的 data/screenshots.json 条目（提交 awesome PR 时挂上）
{
 "https://github.com/kendu76/dsh-music-player": [
   "https://raw.githubusercontent.com/kendu76/dsh-music-player/main/assets/screenshot-bar.png",
   "https://raw.githubusercontent.com/kendu76/dsh-music-player/main/assets/screenshot-panel.png",
   "https://raw.githubusercontent.com/kendu76/dsh-music-player/main/assets/screenshot-spectrum.png"
 ]
}
```

> 任意一张缺失或不佳都没关系——补齐后随版本一起更新即可。
