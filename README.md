# pi-tool-ui

> **Pi（`@earendil-works/pi-coding-agent`）工具视图插件 / 扩展（Tool Renderer Extension）**

`pi-tool-ui` 是一款开源的 **Pi 插件**，用于将 Pi 的工具调用收起态渲染为透明、极简的单行摘要，展示状态、路径或命令、diff 增删、退出码、截断/上限、耗时等关键信息。需要查看原文时，随时可点击或按 `Ctrl+O` 展开，完整还原工具原有的输出、彩色 diff、图片或脚本详情。

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

---

## 适用场景

- **追求清爽对话流的 Pi 用户**：去掉收起态默认的大面积彩色底框与多余留白，在单屏内保留更多对话上下文。
- **高频使用搜索、脚本与联网扩展的用户**：收起态即可一目了然地看到 diff 增删数、命令退出码、搜索上限/截断、批量抓取部分失败、`codemode` 费用与子调用进度，避免关键信号被淹没。
- **要求零侵入与原生兼容的用户**：本插件**仅注册渲染器（`pi.registerToolRenderer`）**，不重注册任何工具，不修改工具参数 schema、执行逻辑、结构化输出或模型提示词；展开态和 `/export` 导出完整保留原生体验。

---

## 适配与兼容

| 维度 | 适配说明 |
| --- | --- |
| **宿主软件** | **Pi**（`@earendil-works/pi-coding-agent`）**1.6.1+**，依赖原生 `pi.registerToolRenderer()` 与 `renderShell: "self"` |
| **终端运行模式** | **Fullscreen**（支持鼠标点击单行独立展开、`Ctrl+O` 全局切换、原生滚动与 `Ctrl+End`）与 **Regular**（`Ctrl+O` 切换、终端原生回滚） |
| **配色主题** | 全量使用 Pi 语义主题 token，自动适配 `dark`、`light`、`system` 及各类自定义主题 |
| **终端能力** | 支持 OSC 8 超链接的终端可直接点击路径、URL 与截断全文日志；窄屏中文/宽字符自动按优先级保留关键告警；内联图片遵循 `terminal.showImages` 与 `images.blockImages` |
| **会话导出** | 兼容 Pi `/export` HTML 导出，展开 `write` 与 `codemode` 时完整保留文件内容与脚本源码 |
| **扩展共存** | 通过 `sourceInfo` 白名单精确匹配目标工具，MCP、提问、subagent 及其他第三方工具扩展通过 `next()` 原样透传；零事件监听（不挂额外事件钩子） |
| **实测环境** | Pi 1.6.1 + Windows Orca（Fullscreen / Regular）、`@ff-labs/pi-fff` 0.11.0、`pi-web-access` 0.48.0 |
| **自动化回归** | Pi 1.6.1、1.7.0 均通过 20 项 SDK/渲染测试；1.7.0 的 Orca 实机交互尚未复核 |

---

## 核心特性

- **紧凑工具行、分类配色与列对齐**：常规完成压缩为单行，按工具类别（读文件 / 编辑 / Shell / 搜索 / 脚本 / 联网）使用 Pi 主题语义色区分工具名与左侧细竖线，宽屏（≥ 48 列）下短工具名统一对齐；耗时按 `<1s` / `1–5s` / `≥5s` 三级着色。仅在出错、流式输出、`codemode` 运行中子调用、截断全文、curator 提示或图片兼容警告时另起第二行分枝。
- **统一呼吸动效与实时状态**：等待参数（紫罗兰色）与执行中（琥珀黄色）统一使用全字体兼容的圆点呼吸动效（`·` → `•` → `●` → `•` → `·`），配合左侧细竖线同相位明暗呼吸与 1 秒起实时计时；展开、完成、出错或离屏时自动回收定时器。
- **窄屏分级保留关键信息**：路径优先相对工作目录显示，裁剪时保留文件名；窄屏下按优先级逐级退让次要指标（耗时、辅助标签），优先保住退出码、截断/上限警告、部分失败状态与 diff 增删数。
- **语义化摘要与故障直达**：`bash` 传入 Pi 原生 `displaySummary` 时，正常态优先展示意图摘要，失败时自动切回真实命令；`read` 读取 `SKILL.md` 时显示 `[skill]` 徽标并保留原文件点击链接。

---

## 支持的工具

| 来源 | 工具 | 收起摘要 |
| --- | --- | --- |
| Pi 内置 | `read` | 文件路径（支持 OSC 8 点击、`SKILL.md` 显示 `[skill]` 徽标）、强调色行号范围、行数或图片类型 |
| Pi 内置 | `edit`、`write` | 文件路径、diff 增删行数与多处修改计数、写入行数与较大文件的大小 |
| Pi 内置 | `bash`、`powershell` | 正常优先显示 `displaySummary`、失败切回真实命令，含流式与最终行数、最新输出、退出码或错误 |
| Pi 内置 | `grep`、`find`、`ls` | 高亮查询词、范围与 `glob` 过滤、匹配或结果数量、无结果与具体上限/截断提示 |
| Pi 内置 | `codemode` | 子调用类型与数量、运行中当前子调用分枝预览、图片/费用摘要、并列展示失败与取消计数；展开查看脚本与详情 |
| Pi 内置 | `tool_search` | 查询词与已加载工具数量 |
| `npm:@ff-labs/pi-fff` | `ffgrep`、`fffind`，以及 FFF `override` 模式下的 `grep`、`find` | FFF 命中数、续页/可翻页、近似匹配或正则回退提示；展开使用 FFF 原生视图 |
| `npm:pi-web-access` | `web_search`、`fetch_content`、`get_search_content`、`source_check` | 查询词/域名与分段偏移摘要、来源数/字符量/匹配数/进度、部分或全部失败告警与 curator 回退提示；展开使用原扩展视图 |

---

## 安装

在 Pi 1.6.1+ 环境中直接通过 GitHub 仓库安装：

```sh
pi install git:github.com/yearsadrift/pi-tool-ui
```

也可以克隆到本地目录后安装：

```sh
git clone https://github.com/yearsadrift/pi-tool-ui.git
pi install ./pi-tool-ui
```

安装完成后，在当前 Pi 会话中执行 `/reload` 即可生效。

- 若已安装其他修改同一批工具外观的 UI 扩展，建议在 `pi config` 中停用其工具渲染入口以避免视觉叠加。
- 如希望 `Ctrl+O` 展开工具时不联动展开顶部启动帮助与资源列表，可在 Pi 配置中开启 `"quietStartup": true`。
- 卸载时运行 `pi remove <来源>`（来源名称可用 `pi list` 查看），然后执行 `/reload`。

---

## 本地试用与测试

在仓库目录运行以下命令即可离线体验或运行全套测试。演示使用临时 Pi 配置，按 `Ctrl+D` 退出。测试与演示默认读取 Pi 托管安装的 `current-version`，跟随当前安装版本；托管安装根目录可通过 `PI_MANAGED_INSTALL_ROOT` 指定。也可优先通过 `PI_TOOL_UI_PI_ROOT` 指定 `@earendil-works/pi-coding-agent` 包目录，以验证其他版本或非托管安装（需包含 `dist` 并可解析对应 `@earendil-works/pi-tui`）。测试会核对加载的 Pi 版本与该目录的包版本是否一致。

```sh
npm run demo -- fullscreen
npm run demo -- regular
npm test
```

---

## 开源协议

本项目基于 [MIT License](./LICENSE) 开源。
