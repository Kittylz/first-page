# 桌面宠物 · 网页版

邵艾伦、太对了和峰哥的浏览器桌宠。点一下说话、拖动换位置、右键打开设置菜单，三只之间会按桌面版的规则自动接话。

这是 [Alan-Desktop-Pets-Windows](https://github.com/wanzhijie1/Alan-Desktop-Pets-Windows) 的网页移植：素材与行为取自原 Windows 版，交互层用 HTML/CSS/JavaScript 重写，纯静态、无后端、无依赖、不需要构建。

## 功能

- **点击说话**：随机播放一句，字幕气泡同步显示，人物带说话动画（邵艾伦/峰哥纵向挤压，太对了左右摇摆）。
- **拖动移动**：鼠标或手指把人物拖到任意位置，位置、大小、音量都会记住（`localStorage`）。
- **右键菜单**（手机长按 0.55 秒）：切换随机/固定播放、挑一句、筛选轮播内容、调音量、改大小、减少动态效果、开关捧哏联动、移回右下角。
- **三宠接话**：邵艾伦 → 太对了 → 峰哥 → 太对了，第四句后结束；单点峰哥由太对了接一句；单点太对了只说自己。接话延迟按每句语音的结束点计算，让两句话首尾相接。
- **无障碍**：人物是真正的按钮，可用 Tab 聚焦、回车说话、Shift+F10 打开菜单，字幕通过 `aria-live` 播报。

## 和 Windows 版的关系

| | Windows 版 | 本仓库 |
| --- | --- | --- |
| 运行时 | .NET Framework 4.8 + WPF | 浏览器 |
| 音频 | WinMM `waveOut` + 预解码 PCM | Web Audio `AudioBufferSourceNode` |
| 三宠通信 | 命名管道 + 命名事件（跨进程） | 页内事件总线（同一页面） |
| 接话规则 | `BridgeRules.ShouldReply` | `js/core.js` 中的 `shouldReply`，逐条移植 |
| 选句逻辑 | `PlaybackSelector` / `ShuffleBag` | `js/core.js` 中同名类，逐条移植 |
| 设置 | `%LOCALAPPDATA%\<角色>\settings.json` | `localStorage` |

音频没有重新编码：邵艾伦和峰哥用原 WAV（峰哥的双声道下混为单声道，和桌面版运行时的处理一致），太对了用原始 M4A。`assets/pets.json` 里的 `speechStart` / `speechEnd` 由 `FastAudio.cs` 的同一套 RMS 算法离线算出，用来对齐接话时间。

## 本地运行

页面用了 ES module 和 `fetch`，需要经由 HTTP 打开，直接双击 `index.html` 会被浏览器拦。任选一种：

```bash
python -m http.server 8123
# 或
npx serve .
```

然后访问 <http://127.0.0.1:8123/>。

浏览器要求一次用户点击才能播放声音（自动播放策略），所以首屏有一个「让邵艾伦说一句」按钮；点人物本身同样可以解锁音频。

## 测试

核心逻辑不依赖 DOM，可以直接用 Node 跑回归：

```bash
node js/test-core.mjs
```

覆盖选句池、固定播放、排除项修复、四句链路边界、取消语义、接话延迟和每只宠物各自的尺寸区间，共 141 项断言。

## 目录

```
index.html          页面骨架
css/site.css        全部样式（含移动端与 prefers-reduced-motion）
js/core.js          纯逻辑：选句、链路规则、取消日志、接话计时
js/app.js           渲染、Web Audio、菜单、拖动、持久化
js/test-core.mjs    逻辑回归测试
assets/pets.json    三只宠物的素材清单（含离线算好的语音区间）
assets/<角色>/       头像与音频
```

## 授权

代码沿用上游 MIT 许可，详见 [LICENSE](LICENSE) 与 [NOTICE.md](NOTICE.md)。人物形象与语音素材来自上游项目，不在 MIT 许可范围内。
