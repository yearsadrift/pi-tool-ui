import { homedir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
	formatReadLineRange,
	type AgentToolResult,
	type ExtensionAPI,
	type Theme,
	type ThemeBg,
	type ThemeColor,
	type ToolRenderers,
} from "@earendil-works/pi-coding-agent";
import {
	Box,
	type Component,
	getCapabilities,
	hyperlink,
	type MouseEvent,
	type MouseEventResult,
	replaceControlCharacters,
	stripTerminalSequences,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";

const tools = new Set(["read", "bash", "powershell", "edit", "write", "grep", "find", "ls", "codemode"]);
const scriptHeader = /^Script (?:completed|failed)\r?\nWall time [\d.]+ seconds\r?\nOutput:\s*$/;
const shellStatusPattern = /^Command (?:exited with code (\d+)|timed out after .+|aborted|terminated without an exit code)$/;
const shellFooterPattern = /^\[Showing (?:lines |last ).+?\. (?:Full output: (.+)|Could not save the full output: (.+))\]$/;
const genericFooterPattern = /^\[(?:Showing lines |Truncated |Matches truncated|Results truncated|Entries truncated|Line \d+ is )/;
const rowState = Symbol("pi-tool-ui row");
type RenderContext = Parameters<NonNullable<ToolRenderers["renderCall"]>>[2];
type Line = (width: number) => string;

interface RowState {
	args?: Record<string, unknown>;
	callSlot?: ToggleSlot;
	expandedBox?: Box;
	nativeCall?: Component;
	nativeResult?: Component;
	nativeTimerPending?: boolean;
}

interface ResultDetails {
	diff?: string;
	truncation?: {
		truncated?: boolean;
		content?: string;
		totalLines?: number;
		outputLines?: number;
		firstLineExceedsLimit?: boolean;
	};
	fullOutputPath?: string;
	fullOutputError?: string;
	matchLimitReached?: number;
	resultLimitReached?: number;
	entryLimitReached?: number;
	linesTruncated?: boolean;
	imageUnsupportedByModel?: string;
	calls?: { name: string; status: "running" | "ok" | "error" | "cancelled"; error?: string }[];
}

interface MetricSegment {
	text: string;
	color: ThemeColor;
}

class CompactLines implements Component {
	private cache?: { width: number; lines: string[] };

	constructor(private lines: Line[], private padding: number) {}

	invalidate(): void {
		this.cache = undefined;
	}

	render(width: number): string[] {
		if (width < 1) return [];
		if (this.cache?.width === width) return this.cache.lines;

		const padding = Math.min(this.padding, Math.floor((width - 1) / 2));
		const margin = " ".repeat(padding);
		const inner = width - padding * 2;
		const lines = this.lines.map((line) => margin + line(inner) + margin);
		this.cache = { width, lines };
		return lines;
	}
}

class ToggleSlot implements Component {
	private hidden = false;

	constructor(private inner: Component) {}

	hide(): void {
		if (!this.hidden) {
			this.hidden = true;
			this.inner.invalidate();
		}
	}

	invalidate(): void {
		this.inner.invalidate();
	}

	handleMouse(event: MouseEvent): MouseEventResult | undefined {
		if (this.hidden) return undefined;
		return this.inner.handleMouse?.(event);
	}

	render(width: number): string[] {
		if (this.hidden) return [];
		return this.inner.render(width);
	}
}

function getRow(context: RenderContext): RowState {
	return context.state[rowState] ??= {};
}

function oneLine(value: unknown): string {
	return typeof value === "string" ? replaceControlCharacters(stripTerminalSequences(value)).trim() : "";
}

function normalizeSlashes(value: string): string {
	return value.replaceAll("\\", "/");
}

function shortenPath(raw: string, cwd: string): string {
	const cleaned = oneLine(raw);
	if (!cleaned) return "";
	if (!isAbsolute(cleaned)) {
		const rel = normalizeSlashes(cleaned).replace(/^\.\//, "");
		return rel || ".";
	}
	const resolved = resolve(cleaned);
	const relCwd = relative(cwd, resolved);
	if (relCwd === "") return ".";
	if (!relCwd.startsWith("..") && !isAbsolute(relCwd)) {
		return normalizeSlashes(relCwd);
	}
	const home = homedir();
	if (home) {
		const relHome = relative(home, resolved);
		if (relHome === "") return "~";
		if (!relHome.startsWith("..") && !isAbsolute(relHome)) {
			return `~/${normalizeSlashes(relHome)}`;
		}
	}
	return normalizeSlashes(cleaned);
}

function truncatePath(displayPath: string, maxWidth: number): string {
	if (maxWidth <= 0) return "";
	if (visibleWidth(displayPath) <= maxWidth) return displayPath;
	if (maxWidth <= 2) return truncateToWidth(displayPath, maxWidth, "…");
	const parts = displayPath.split("/").filter(Boolean);
	if (parts.length < 2) return truncateToWidth(displayPath, maxWidth, "…");

	let tail = parts[parts.length - 1]!;
	if (visibleWidth(`…/${tail}`) > maxWidth) {
		return truncateToWidth(tail, maxWidth, "…");
	}
	for (let i = parts.length - 2; i >= 0; i--) {
		const candidate = `${parts[i]}/${tail}`;
		if (visibleWidth(`…/${candidate}`) > maxWidth) break;
		tail = candidate;
	}
	return `…/${tail}`;
}

function stylePath(displayPath: string, range: string, maxWidth: number, theme: Theme): string {
	if (maxWidth <= 0) return "";
	const rangeWidth = visibleWidth(range);
	const keepRange = rangeWidth > 0 && maxWidth > rangeWidth + 4;
	const pathBudget = keepRange ? maxWidth - rangeWidth : maxWidth;
	const fitted = truncatePath(displayPath, pathBudget);
	const slash = fitted.lastIndexOf("/");
	const styledPath = slash >= 0
		? theme.fg("dim", fitted.slice(0, slash + 1)) + theme.fg("text", fitted.slice(slash + 1))
		: theme.fg("text", fitted);
	return keepRange ? styledPath + theme.fg("dim", range) : styledPath;
}

function formatDuration(durationMs: number | undefined): string {
	if (typeof durationMs !== "number" || !Number.isFinite(durationMs) || durationMs < 0) return "";
	if (durationMs < 1000) return `${Math.round(durationMs)}ms`;
	if (durationMs < 60_000) return `${(durationMs / 1000).toFixed(1)}s`;
	const minutes = Math.floor(durationMs / 60_000);
	const seconds = Math.round((durationMs % 60_000) / 1000);
	return `${minutes}m${seconds}s`;
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function countDiffLines(diff: string | undefined): { added: number; removed: number } | undefined {
	if (typeof diff !== "string" || !diff) return undefined;
	let added = 0;
	let removed = 0;
	for (const line of diff.split(/\r\n?|\n/)) {
		if (line.startsWith("+") && !line.startsWith("+++")) added++;
		else if (line.startsWith("-") && !line.startsWith("---")) removed++;
	}
	return { added, removed };
}

function summarizeCallNames(calls: NonNullable<ResultDetails["calls"]>): string {
	const counts = new Map<string, number>();
	for (const call of calls) {
		const key = oneLine(call.name);
		if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
	}
	const entries = [...counts.entries()];
	if (entries.length === 0) return "";
	const shown = entries.slice(0, 4).map(([tool, count]) => count > 1 ? `${tool}×${count}` : tool);
	const rest = entries.length - shown.length;
	return rest > 0 ? `${shown.join(", ")} +${rest}` : shown.join(", ");
}

function inferCodemodeTools(code: unknown): string {
	if (typeof code !== "string" || !code) return "";
	const names: string[] = [];
	const seen = new Set<string>();
	for (const match of code.matchAll(/\btools\.([A-Za-z_][A-Za-z0-9_]*)/g)) {
		const name = match[1]!;
		if (!seen.has(name)) {
			seen.add(name);
			names.push(name);
			if (names.length === 3) break;
		}
	}
	return names.join(", ");
}

function faintRail(theme: Theme, color: ThemeColor): string {
	return `\x1b[2m${theme.fg(color, "▏")}\x1b[22m`;
}

function renderMetrics(theme: Theme, segments: MetricSegment[]): { text: string; width: number } {
	if (segments.length === 0) return { text: "", width: 0 };
	const sep = theme.fg("dim", " · ");
	const parts = segments.map((seg) => theme.fg(seg.color, seg.text));
	const text = parts.join(sep);
	return { text, width: visibleWidth(text) };
}

function renderSubject(
	name: string,
	args: Record<string, unknown> | undefined,
	cwd: string,
	maxWidth: number,
	theme: Theme,
	codemodeLabel?: string,
): string {
	if (maxWidth <= 0) return "";

	if (name === "bash" || name === "powershell") {
		const command = oneLine(args?.command) || "…";
		const timeout = typeof args?.timeout === "number" ? ` · ${args.timeout}s` : "";
		const keepTimeout = timeout && maxWidth > visibleWidth(timeout) + 6;
		const cmdBudget = keepTimeout ? maxWidth - visibleWidth(timeout) : maxWidth;
		const styled = theme.fg("toolOutput", truncateToWidth(command, cmdBudget, "…"));
		return keepTimeout ? styled + theme.fg("dim", timeout) : styled;
	}

	if (name === "codemode") {
		const label = codemodeLabel || inferCodemodeTools(args?.code) || "脚本";
		return theme.fg("toolOutput", truncateToWidth(label, maxWidth, "…"));
	}

	const rawPath = oneLine(args?.file_path ?? args?.path);
	const displayPath = shortenPath(rawPath, cwd);

	if (name === "read") {
		const range = formatReadLineRange(args?.offset, args?.limit);
		return stylePath(displayPath || "…", range, maxWidth, theme);
	}

	if (name === "grep" || name === "find") {
		const pattern = oneLine(args?.pattern);
		if (!pattern) return stylePath(displayPath || ".", "", maxWidth, theme);
		const quoted = `"${pattern}"`;
		if (!displayPath || displayPath === ".") {
			return theme.fg("text", truncateToWidth(quoted, maxWidth, "…"));
		}
		const patternWidth = visibleWidth(quoted);
		if (patternWidth + 4 >= maxWidth) {
			return theme.fg("text", truncateToWidth(quoted, maxWidth, "…"));
		}
		const pathBudget = maxWidth - patternWidth - 2;
		const fittedPath = truncatePath(displayPath, pathBudget);
		return `${theme.fg("text", quoted)}  ${theme.fg("dim", fittedPath)}`;
	}

	return stylePath(displayPath || (name === "ls" ? "." : "…"), "", maxWidth, theme);
}

function headerLine(
	theme: Theme,
	options: {
		name: string;
		args: Record<string, unknown> | undefined;
		cwd: string;
		symbol: string;
		statusColor: ThemeColor;
		railColor: ThemeColor;
		metrics: MetricSegment[];
		codemodeLabel?: string;
	},
): Line {
	const { name, args, cwd, symbol, statusColor, railColor, metrics, codemodeLabel } = options;
	return (width) => {
		const basePrefix = `${theme.fg(statusColor, symbol)} ${theme.fg("toolTitle", theme.bold(name))}`;
		const rail = width >= visibleWidth(basePrefix) + 2 ? `${faintRail(theme, railColor)} ` : "";
		const prefix = `${rail}${basePrefix}`;
		const prefixWidth = visibleWidth(prefix);
		if (width <= prefixWidth) return truncateToWidth(prefix, width, "…");

		const gap = width >= prefixWidth + 2 ? "  " : " ";
		const available = width - prefixWidth - gap.length;
		if (available <= 0) return prefix;

		const renderedMetrics = renderMetrics(theme, metrics);
		const showMetrics = renderedMetrics.width > 0 && available >= renderedMetrics.width + 10;
		const metricJoin = showMetrics ? theme.fg("dim", "  · ") + renderedMetrics.text : "";
		const subjectBudget = showMetrics ? available - renderedMetrics.width - 4 : available;
		const subject = renderSubject(name, args, cwd, subjectBudget, theme, codemodeLabel);
		if (!subject) {
			return renderedMetrics.width > 0
				? `${prefix}${gap}${truncateToWidth(renderedMetrics.text, available, "…")}`
				: prefix;
		}
		return `${prefix}${gap}${subject}${metricJoin}`;
	};
}

function detailLine(
	theme: Theme,
	railColor: ThemeColor,
	text: string,
	color: ThemeColor,
	notice = "",
	outputUrl?: string,
): Line {
	return (width) => {
		const rail = width >= 12 ? `${faintRail(theme, railColor)} ` : "";
		const branch = width >= 12 ? "  └─ " : width >= 8 ? "└─ " : width >= 5 ? "└ " : "";
		const prefix = rail + theme.fg("dim", branch);
		const available = width - visibleWidth(prefix);
		if (available <= 0) return truncateToWidth(prefix, width, "…");
		// At narrow widths, keep enough room to recognize the real error or output.
		const label = notice && available >= 10 ? truncateToWidth(notice, Math.floor(available / 2), "…") : "";
		const contentWidth = available - (label ? visibleWidth(label) + 1 : 0);
		const body = theme.fg(color, truncateToWidth(text, contentWidth, "…"));
		const suffix = theme.fg("warning", label);
		return prefix + body + (label ? ` ${outputUrl ? hyperlink(suffix, outputUrl) : suffix}` : "");
	};
}

function fullOutputDetail(
	theme: Theme,
	railColor: ThemeColor,
	preview: string,
	color: ThemeColor,
	path: string,
	cwd: string,
): Line {
	const url = getCapabilities().hyperlinks ? pathToFileURL(resolve(cwd, path)).href : undefined;
	return detailLine(theme, railColor, preview, color, `截断 · 全文 ${shortenPath(path, cwd)}`, url);
}

function buildCodemodeLines(
	args: Record<string, unknown> | undefined,
	result: AgentToolResult<unknown>,
	context: RenderContext,
	theme: Theme,
): Line[] {
	const details = result.details as ResultDetails | undefined;
	const calls = Array.isArray(details?.calls) ? details.calls : [];
	const errors = calls.filter((call) => call.status === "error");
	const cancelled = calls.filter((call) => call.status === "cancelled").length;
	const running = calls.filter((call) => call.status === "running");
	const blocks = result.content.flatMap((block) => block.type === "text" && !scriptHeader.test(block.text) ? [block.text] : []);
	const issue = Boolean(result.isError || context.isError);
	const hasNestedError = errors.length > 0;
	const scriptError = issue ? blocks.findLast((text) => /^Script error:\s*/.test(text)) : undefined;
	const lastError = errors.at(-1);
	const nestedError = lastError ? [oneLine(lastError.name), oneLine(lastError.error)].filter(Boolean).join(" ") : "";

	const symbol = issue ? "×" : hasNestedError ? "!" : context.isPartial ? "◐" : "✓";
	const statusColor: ThemeColor = issue || hasNestedError ? "error" : context.isPartial ? "warning" : "success";
	const railColor: ThemeColor = issue || hasNestedError ? "error" : context.isPartial ? "warning" : "dim";

	const breakdown = summarizeCallNames(calls);
	const codemodeLabel = breakdown || undefined;

	const metrics: MetricSegment[] = [];
	if (calls.length > 0) {
		metrics.push({ text: `${calls.length} 次`, color: "dim" });
	}
	if (issue) {
		metrics.push({ text: "脚本失败", color: "error" });
	} else if (hasNestedError) {
		metrics.push({ text: `${errors.length} 失败`, color: "error" });
	} else if (context.isPartial) {
		const active = oneLine(running.at(-1)?.name);
		metrics.push({ text: active ? `正在执行 ${active}` : "运行中", color: "warning" });
	} else if (cancelled > 0) {
		metrics.push({ text: `${cancelled} 取消`, color: "warning" });
	} else if (calls.length === 0) {
		metrics.push({ text: "完成", color: "dim" });
	}
	const duration = formatDuration(context.durationMs);
	if (duration) metrics.push({ text: duration, color: "dim" });

	const lines: Line[] = [
		headerLine(theme, {
			name: "codemode",
			args,
			cwd: context.cwd,
			symbol,
			statusColor,
			railColor,
			metrics,
			codemodeLabel,
		}),
	];

	if (issue) {
		const error = (scriptError?.replace(/^Script error:\s*/, "") ?? blocks.at(-1))?.split(/\r?\n/, 1)[0];
		const message = oneLine(error) || nestedError || "脚本执行失败";
		lines.push(
			details?.fullOutputPath
				? fullOutputDetail(theme, railColor, message, "error", details.fullOutputPath, context.cwd)
				: detailLine(theme, railColor, message, "error"),
		);
	} else if (hasNestedError) {
		const message = nestedError || `${errors.length} 个子调用失败`;
		lines.push(
			details?.fullOutputPath
				? fullOutputDetail(theme, railColor, message, "error", details.fullOutputPath, context.cwd)
				: detailLine(theme, railColor, message, "error"),
		);
	} else if (details?.fullOutputPath) {
		const tail = oneLine(blocks.at(-1)?.split(/\r?\n/).filter(Boolean).at(-1)) || `${calls.length} 个子调用`;
		lines.push(fullOutputDetail(theme, railColor, tail, "toolOutput", details.fullOutputPath, context.cwd));
	}

	return lines;
}

function buildToolLines(
	name: string,
	args: Record<string, unknown> | undefined,
	result: AgentToolResult<unknown>,
	context: RenderContext,
	theme: Theme,
): Line[] {
	const shell = name === "bash" || name === "powershell";
	const details = result.details as ResultDetails | undefined;
	const isError = Boolean(result.isError || context.isError);
	const output = result.content.flatMap((block) => block.type === "text" ? [block.text] : []).join("\n");
	const truncatedText = details?.truncation?.content;
	const rawText = !isError && typeof truncatedText === "string" && truncatedText ? truncatedText : output;
	const rawLines = stripTerminalSequences(rawText).split(/\r\n?|\n/);
	const lines = rawLines.map(oneLine).filter(Boolean);
	const tail = lines.at(-1);

	const shellStatusMatch = shell && isError && tail ? tail.match(shellStatusPattern) : undefined;
	const shellStatus = shellStatusMatch ? lines.pop() : undefined;
	const exitCode = shellStatusMatch?.[1];

	// Shell timeouts and aborts can carry the native truncation footer only in their error text.
	const footer = shell ? lines.at(-1)?.match(shellFooterPattern) : undefined;
	if (footer) lines.pop();

	const fullOutputPath = details?.fullOutputPath ?? footer?.[1];
	const fullOutputError = details?.fullOutputError ?? footer?.[2];
	const truncated = Boolean(
		footer ||
		details?.truncation?.truncated ||
		details?.matchLimitReached ||
		details?.resultLimitReached ||
		details?.entryLimitReached ||
		details?.linesTruncated,
	);
	const image = result.content.find((block) => block.type === "image");

	const symbol = isError ? "×" : context.isPartial ? "◐" : "✓";
	const statusColor: ThemeColor = isError ? "error" : context.isPartial ? "warning" : "success";
	const railColor: ThemeColor = isError ? "error" : context.isPartial ? "warning" : "dim";

	// Count meaningful content lines (excluding trailing Pi truncation footers).
	const contentLines = rawLines.filter((l, idx) => {
		const trimmed = l.trim();
		if (!trimmed) return false;
		if (idx >= rawLines.length - 3 && (shellFooterPattern.test(trimmed) || genericFooterPattern.test(trimmed))) {
			return false;
		}
		return true;
	});

	const metrics: MetricSegment[] = [];
	const duration = formatDuration(context.durationMs);

	if (isError) {
		if (exitCode) metrics.push({ text: `exit ${exitCode}`, color: "error" });
	} else if (context.isPartial) {
		metrics.push({ text: "运行中", color: "warning" });
	} else if (name === "read") {
		if (image) {
			metrics.push({ text: `图片 ${oneLine(image.mimeType)}`, color: "muted" });
		} else if (details?.truncation?.firstLineExceedsLimit) {
			metrics.push({ text: "首行超限", color: "warning" });
		} else if (details?.truncation?.truncated && details.truncation.outputLines && details.truncation.totalLines) {
			metrics.push({ text: `${details.truncation.outputLines}/${details.truncation.totalLines} 行`, color: "dim" });
		} else if (contentLines.length > 0) {
			const count = rawText.trimEnd() ? rawText.replace(/\r\n?/g, "\n").replace(/\n$/, "").split("\n").length : 0;
			metrics.push({ text: `${count} 行`, color: "dim" });
		} else {
			metrics.push({ text: "空文件", color: "dim" });
		}
		if (truncated && !fullOutputPath && !details?.truncation?.firstLineExceedsLimit) {
			metrics.push({ text: "截断", color: "warning" });
		}
	} else if (name === "edit") {
		const counts = countDiffLines(details?.diff);
		if (counts) {
			if (counts.added > 0) metrics.push({ text: `+${counts.added}`, color: "toolDiffAdded" });
			if (counts.removed > 0) metrics.push({ text: `−${counts.removed}`, color: "toolDiffRemoved" });
			if (counts.added === 0 && counts.removed === 0) metrics.push({ text: "无变更", color: "dim" });
		} else {
			metrics.push({ text: "已修改", color: "dim" });
		}
	} else if (name === "write") {
		if (typeof args?.content === "string") {
			const writeLines = args.content.length === 0 ? 0 : args.content.replace(/\r\n?/g, "\n").replace(/\n$/, "").split("\n").length;
			const bytes = Buffer.byteLength(args.content, "utf8");
			metrics.push({ text: `${writeLines} 行`, color: "dim" });
			if (bytes >= 1024) metrics.push({ text: formatBytes(bytes), color: "dim" });
		} else {
			metrics.push({ text: "已写入", color: "dim" });
		}
	} else if (name === "grep") {
		const empty = contentLines.length === 0 || (contentLines.length === 1 && /^No matches found/i.test(contentLines[0]!));
		metrics.push({ text: empty ? "无匹配" : `${contentLines.length} 处匹配`, color: "dim" });
		if (truncated && !fullOutputPath) metrics.push({ text: "截断", color: "warning" });
	} else if (name === "find") {
		const empty = contentLines.length === 0 || (contentLines.length === 1 && /^No files found/i.test(contentLines[0]!));
		metrics.push({ text: empty ? "无结果" : `${contentLines.length} 个文件`, color: "dim" });
		if (truncated && !fullOutputPath) metrics.push({ text: "截断", color: "warning" });
	} else if (name === "ls") {
		const empty = contentLines.length === 0 || (contentLines.length === 1 && /^\(empty directory\)$/i.test(contentLines[0]!));
		metrics.push({ text: empty ? "空目录" : `${contentLines.length} 项`, color: "dim" });
		if (truncated && !fullOutputPath) metrics.push({ text: "截断", color: "warning" });
	} else if (shell) {
		if (details?.truncation?.truncated && details.truncation.totalLines) {
			metrics.push({ text: `${details.truncation.totalLines} 行`, color: "dim" });
		} else if (contentLines.length > 0 && !(contentLines.length === 1 && contentLines[0] === "(no output)")) {
			metrics.push({ text: `${contentLines.length} 行`, color: "dim" });
		} else {
			metrics.push({ text: "无输出", color: "dim" });
		}
		if (truncated && !fullOutputPath && !fullOutputError) {
			metrics.push({ text: "截断", color: "warning" });
		}
	}

	if (duration) metrics.push({ text: duration, color: "dim" });

	const out: Line[] = [
		headerLine(theme, {
			name,
			args,
			cwd: context.cwd,
			symbol,
			statusColor,
			railColor,
			metrics,
		}),
	];

	// Determine whether a 2nd branch detail line is genuinely needed.
	let preview = shell && !isError ? lines.at(-1) : lines[0];
	if (shellStatus) {
		const lastOutput = lines.at(-1);
		preview = lastOutput && lastOutput !== "(no output)" ? `${shellStatus} · ${lastOutput}` : shellStatus;
	} else if (preview && lines.length > 1) {
		preview = shell && !isError ? `… ${preview}` : `${preview} …`;
	}

	if (isError) {
		const errText = preview || "执行失败";
		if (typeof fullOutputPath === "string" && fullOutputPath) {
			out.push(fullOutputDetail(theme, railColor, errText, "error", fullOutputPath, context.cwd));
		} else if (fullOutputError) {
			out.push(detailLine(theme, railColor, errText, "error", `截断 · 保存失败 ${oneLine(fullOutputError)}`));
		} else {
			out.push(detailLine(theme, railColor, errText, "error", truncated ? "截断" : ""));
		}
	} else if (typeof fullOutputPath === "string" && fullOutputPath) {
		out.push(fullOutputDetail(theme, railColor, preview || "输出已截断", context.isPartial ? "warning" : "toolOutput", fullOutputPath, context.cwd));
	} else if (fullOutputError) {
		out.push(detailLine(theme, railColor, preview || "输出已截断", "toolOutput", `截断 · 保存失败 ${oneLine(fullOutputError)}`));
	} else if (details?.imageUnsupportedByModel) {
		out.push(detailLine(theme, railColor, `图片 ${oneLine(image?.mimeType) || "image"}`, "muted", `模型不支持图片 · ${oneLine(details.imageUnsupportedByModel)}`));
	} else if (details?.truncation?.firstLineExceedsLimit) {
		out.push(detailLine(theme, railColor, preview || "首行超出大小限制", "warning", "截断"));
	} else if (context.isPartial && shell && preview) {
		out.push(detailLine(theme, railColor, preview, "toolOutput", truncated ? "截断" : ""));
	}

	return out;
}

function getNativeBoxBg(theme: Theme, isPartial: boolean, isError: boolean): (text: string) => string {
	const token: ThemeBg = isPartial ? "toolPendingBg" : isError ? "toolErrorBg" : "toolSuccessBg";
	return (text) => theme.bg(token, text);
}

export default function (pi: ExtensionAPI): void {
	pi.registerToolRenderer((name, next) => {
		const base = next();
		if (!tools.has(name) || !base?.renderCall || !base.renderResult) return base;
		const tool = pi.getAllTools().find((tool) => tool.name === name);
		if (tool?.sourceInfo.path !== `builtin:${name}`) return base;

		const { renderCall, renderResult } = base;
		const nativeSelf = base.renderShell === "self";
		const shell = name === "bash" || name === "powershell";
		const edit = name === "edit";
		const codemode = name === "codemode";
		const nativeTimer = shell || codemode;

		return {
			...base,
			renderShell: "self",
			renderCall(args, theme, context) {
				const row = getRow(context);
				row.args = args as Record<string, unknown> | undefined;

				// Edit's result renderer updates its call's diff component. Shell tools
				// record the start here. Codemode highlights the script on demand.
				if (context.expanded || edit || shell) {
					row.nativeCall = renderCall(args, theme, { ...context, lastComponent: row.nativeCall });
					if (context.expanded) {
						if (nativeSelf) {
							row.callSlot = undefined;
							return row.nativeCall;
						}
						const box = new Box(context.outputPad, 1, getNativeBoxBg(theme, context.isPartial, context.isError));
						box.addChild(row.nativeCall);
						row.callSlot = new ToggleSlot(box);
						return row.callSlot;
					}
				}

				const pendingLine = headerLine(theme, {
					name,
					args: row.args,
					cwd: context.cwd,
					symbol: context.isError ? "×" : "◐",
					statusColor: context.isError ? "error" : "warning",
					railColor: context.isError ? "error" : "warning",
					metrics: [{ text: context.executionStarted ? "运行中" : "等待结果", color: context.isError ? "error" : "warning" }],
				});
				row.callSlot = new ToggleSlot(new CompactLines([pendingLine], context.outputPad));
				return row.callSlot;
			},
			renderResult(result, options, theme, context) {
				const row = getRow(context);
				const isError = Boolean(result.isError || context.isError);

				// A native timer may stay active after a tool was expanded during execution.
				// Pass it the final result even if the row has been collapsed in the meantime.
				if (options.expanded || edit || (row.nativeTimerPending && !options.isPartial)) {
					row.nativeResult = renderResult(result, options, theme, { ...context, lastComponent: row.nativeResult });
					row.nativeTimerPending = nativeTimer && options.isPartial;
					if (options.expanded) {
						if (nativeSelf) return row.nativeResult;
						row.callSlot?.hide();
						const box = row.expandedBox ??= new Box(context.outputPad, 1, getNativeBoxBg(theme, options.isPartial, isError));
						box.setPaddingX(context.outputPad);
						box.setBgFn(getNativeBoxBg(theme, options.isPartial, isError));
						box.clear();
						if (row.nativeCall) box.addChild(row.nativeCall);
						box.addChild(row.nativeResult);
						return box;
					}
				}

				row.callSlot?.hide();
				const args = row.args ?? (context.args as Record<string, unknown> | undefined);
				const lines = codemode
					? buildCodemodeLines(args, result, context, theme)
					: buildToolLines(name, args, result, context, theme);
				return new CompactLines(lines, context.outputPad);
			},
		};
	});
}
