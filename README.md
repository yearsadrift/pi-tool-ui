# Pi 工具 UI

适用于 Pi 1.6.1 的本地工具显示包。收起时采用透明无底框的极简细竖线布局：等待与运行中带有顺滑旋转指示、轻呼吸竖线及实时耗时；常规完成调用压缩为单行，自带路径精简、文件行数、diff 增删数、子调用汇总和耗时；仅在出错、流式运行中、截断全文或图片兼容提示时展开第二行分枝。

```text
 ▏ ✓ read  pi-tool-ui/index.ts:1-80  · 80 行 · 12ms
 ▏ ✓ edit  pi-tool-ui/index.ts  · +14 · −6 · 18ms
 ▏ ✓ codemode  read×2, ls×2, bash  · 5 次 · 0.2s
 ▏ × read  测试-不存在.txt
 ▏   └─ ENOENT: no such file or directory, …
```

- 支持 Pi 原生的 `read`、`bash`、`powershell`、`edit`、`write`、`grep`、`find`、`ls` 和 `codemode`。收起的 `codemode` 展示子调用分布与耗时，失败时在第二行显示真实错误；展开可看完整脚本、子调用和输出。MCP、提问和 subagent 沿用各自的 renderer。
- 通过 npm 安装 `@ff-labs/pi-fff` 时，`ffgrep` 和 `fffind` 的收起态也会显示透明单行摘要。展开后由 FFF 显示完整命中和翻页提示。
- 通过 Pi 1.6.1 原生 `renderShell: "self"` 去掉收起态的大面积底色框和上下空行，不修改 `Container`、`ScrollView`、`MouseRegion` 或 `setExpanded`。
- `Ctrl+O` 是 Pi 1.6.1 默认的展开快捷键，实际按键以用户配置为准。Fullscreen 下也可以点击调用行。展开后恢复 Pi 原生底框、输出、diff 和图片。Regular 的滚动回看由终端宿主管理，fullscreen 的视口与 `Ctrl+End` 由 Pi 管理。
- 收起时按终端列宽裁剪，长路径优先保留文件名。结果被工具截断时会显示提示；支持 OSC 8 的终端可以从「全文」进入原生 Bash 或 PowerShell 保存的输出文件。

## 隔离试用

在仓库目录中运行以下任一命令。试用使用临时 Pi 配置和离线示例，不需要模型账号。按 `Ctrl+D` 退出即可回到原终端。

```powershell
npm run demo -- fullscreen
npm run demo -- regular
```

试用和测试默认使用 Pi 托管安装中的 1.6.1。其他安装方式可将 `PI_TOOL_UI_PI_ROOT` 指向包含 `dist` 的 `@earendil-works/pi-coding-agent` 1.6.1 包目录，并使用该安装的 `@earendil-works/pi-tui`。

## 验证

```powershell
npm test
```

测试使用 Pi 1.6.1 的组件、扩展加载器、工具执行路径和 QuickJS codemode。覆盖透明单行与自适应双行、窄屏中文、出错和截断、原生展开对照、PNG、同名覆盖与专用 renderer，以及 fullscreen 中的点击、流式更新和 `Ctrl+End`。

## 启用与回退

正式切换前备份 Pi 配置并保存 `/pi-health` 快照。在需要的配置范围内停用其他工具显示扩展的入口，然后运行 `pi install ./pi-tool-ui`，或将本地仓库的绝对路径加入 Pi 设置的 `packages`。执行 `/reload` 后检查扩展加载列表，确认工具视图和现有状态栏正常，再与切换前的体检快照比较。

回退时从同一配置范围移除该本地包路径，恢复原先使用的工具显示扩展，再执行 `/reload`。试用标签页使用独立配置，退出后由脚本清理其临时文件。
