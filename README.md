# pi-tool-ui

`pi-tool-ui` 是适用于 **Pi 1.6.1** 的工具视图扩展。收起时用透明的单行摘要显示状态、路径或命令，以及耗时、命中数等信息。需要看原文时，可以展开同一条调用，查看工具原有的完整输出、diff 或图片。

```text
 ▏ ✓ read      src/index.ts:1-80  · 80 行 · 12ms
 ▏ ✓ edit      src/index.ts  · +14 · −6 · 18ms
 ▏ ✓ ffgrep    "renderShell"  src  · 3 处匹配 · 42ms
 ▏ ✓ codemode  read×2, ls×2, bash  · 5 次 · 0.2s
 ▏ • bash      运行渲染测试  · 运行中 · 16 行 · 3s
 ▏   └─ Running rendering tests…
 ▏ ✓ web_search  "Pi 1.6.1 themes" +2  · 3/3 组 · 14 来源 · 1.8s
 ▏ × read      missing.txt
 ▏   └─ ENOENT: no such file or directory, …
```

## 功能

- **紧凑工具行、分类配色与列对齐。** 常规完成只显示一行，按工具类别（读文件/编辑/Shell/搜索/脚本/联网）自动使用 Pi 主题语义色区分工具名与左侧细竖线，短工具名在宽屏下对齐至统一列宽，耗时按快/中/慢分级着色；错误详情、Shell 实时输出、`codemode` 当前子调用、输出保存位置、curator 链接和图片兼容提示可在下方另起一行。
- **统一呼吸动效与实时状态。** 等待参数（紫罗兰色）与执行中（琥珀黄色）统一使用全字体兼容的圆点呼吸动效（`·` → `•` → `●` → `•` → `·`），配合左侧细竖线同相位明暗呼吸与实时计时（1 秒起显示）。完成后显示 Pi 记录的实际耗时。
- **适应终端宽度与直达链接。** 使用 Pi 的主题色与字符宽度规则，路径尽量相对工作目录显示，长路径裁剪时优先保留文件名；支持 OSC 8 的终端可直接点击文件路径、URL 或截断「全文」跳转。
- **语义化命令摘要。** `bash` 传入 Pi 原生 `displaySummary` 时，收起态优先展示该意图摘要，展开或出错时保留完整命令。

## 支持的工具

| 来源 | 工具 | 收起摘要 |
| --- | --- | --- |
| Pi 内置 | `read` | 文件路径（支持 OSC 8 点击）、强调色行号范围、行数或图片类型 |
| Pi 内置 | `edit`、`write` | 文件路径、diff 增删行数、写入行数与较大文件的大小 |
| Pi 内置 | `bash`、`powershell` | 优先显示 `displaySummary`（回退命令）、流式与最终行数、最新输出、退出码或错误 |
| Pi 内置 | `grep`、`find`、`ls` | 高亮查询词与范围、匹配或结果数量、无结果与截断提示 |
| Pi 内置 | `codemode` | 子调用类型与数量、运行中当前子调用分枝预览、脚本或子调用失败。展开可查看脚本、调用详情和输出 |
| Pi 内置 | `tool_search` | 查询词与已加载工具数量 |
| `npm:@ff-labs/pi-fff` | `ffgrep`、`fffind`，以及 FFF 的 `override` 模式下的 `grep`、`find` | FFF 提供的命中数、翻页、近似匹配或正则表达式回退提示。展开使用 FFF 的原始视图 |
| `npm:pi-web-access` | `web_search`、`fetch_content`、`get_search_content`、`source_check` | 查询词/域名摘要、来源数/字符量/匹配数/进度与 curator 链接提示。展开使用原扩展视图 |

MCP、提问、subagent 和其他第三方工具由各自的扩展渲染。工具执行、参数、结构化输出和会话记录由 Pi 与原工具负责，例如 `codemode` 仍可收到 Bash 的结构化结果和 `read` 返回的图片对象。

## 兼容与交互

- **Pi 版本。** 适配并验证 Pi 1.6.1，使用 `pi.registerToolRenderer()` 接入。FFF 的实测版本为 0.11.0。
- **Fullscreen。** 可点击工具行独立展开，也可用 `Ctrl+O` 全局展开或收起。滚动和 `Ctrl+End` 沿用 Pi 的视口行为。
- **Regular。** 用 `Ctrl+O` 展开或收起，滚动回看由终端宿主管理。实际快捷键以 Pi 的 `app.tools.expand` 绑定为准。
- **图片预览。** Pi 的内联图片遵循 `terminal.showImages` 和终端图形支持情况。支持内联图片的终端在收起文本摘要后仍可显示图片。关闭 `terminal.showImages` 只影响终端预览，模型接收图片由 `images.blockImages` 控制。

两种终端模式均已在 **Windows 的 Orca** 环境验证。自动化测试还覆盖中文窄屏、错误摘要、截断链接、原生展开、鼠标命中、流式输出以及 `codemode` 结构化结果。

## 安装

在 Pi 1.6.1 环境中安装 GitHub 仓库。私有仓库需要当前 Git 登录账号具有读取权限。

```sh
pi install git:github.com/yearsadrift/pi-tool-ui
```

也可以克隆到本地，再从仓库的父目录安装。

```sh
git clone https://github.com/yearsadrift/pi-tool-ui.git
pi install ./pi-tool-ui
```

在当前 Pi 会话执行 `/reload` 生效。若已有其他扩展负责同一批工具的外观，可在 `pi config` 中关闭其工具显示入口。卸载时运行 `pi remove`，参数使用 `pi list` 中显示的安装来源，然后执行 `/reload`。

## 本地试用与测试

在仓库目录运行以下命令。演示使用临时 Pi 配置和离线示例，按 `Ctrl+D` 退出。试用和测试默认查找 Pi 托管安装中的 1.6.1。其他环境可将 `PI_TOOL_UI_PI_ROOT` 设为 `@earendil-works/pi-coding-agent` 1.6.1 的包目录，该目录应包含 `dist`，并能解析同一套安装的 `@earendil-works/pi-tui`。

```sh
npm run demo -- fullscreen
npm run demo -- regular
npm test
```
