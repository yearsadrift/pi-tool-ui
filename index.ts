import { homedir } from "node:os";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
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
	Text,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";

const searchTools = new Set(["grep", "find", "ffgrep", "fffind"]);
const webTools = new Set(["web_search", "fetch_content", "get_search_content", "source_check"]);
const tools = new Set(["read", "bash", "powershell", "edit", "write", "ls", "codemode", "tool_search", ...searchTools, ...webTools]);
const fffPackage = /^npm:@ff-labs\/pi-fff(?:@[^/]+)?$/;
const webAccessPackage = /^npm:pi-web-access(?:@[^/]+)?$/;
const scriptHeader = /^Script (?:completed|failed)\r?\nWall time [\d.]+ seconds\r?\nOutput:\s*$/;
const shellStatusPattern = /^Command (?:exited with code (\d+)|timed out after .+|aborted|terminated without an exit code)$/;
const shellFooterPattern = /^\[Showing (?:lines |last ).+?\. (?:Full output: (.+)|Could not save the full output: (.+))\]$/;
const genericFooterPattern = /^\[(?:Showing lines |Truncated |Matches truncated|Results truncated|Entries truncated|Line \d+ is )/;
const rowState = Symbol("pi-tool-ui row");
const pulseFrames = ["·", "•", "●", "•"];
const animationIntervalMs = 200;
const maxMissedAnimationTicks = 2;
const toolNamePadWidth = 8;
const minAlignedRowWidth = 48;
const collapsedDisplayNames: Record<string, string> = {
	powershell: "pwsh",
	web_search: "web",
	fetch_content: "fetch",
	get_search_content: "web_read",
	source_check: "verify",
	tool_search: "tools",
};
type RenderContext = Parameters<NonNullable<ToolRenderers["renderCall"]>>[2];
type Line = (width: number) => string;

interface RowState {
	args?: Record<string, unknown>;
	callSlot?: ToggleSlot;
	expandedBox?: Box;
	nativeCall?: Component;
	nativeCallExpanded?: boolean;
	nativeResult?: Component;
	nativeTimerPending?: boolean;
	frame?: number;
	animating?: boolean;
	ticking?: boolean;
	missedTicks?: number;
	invalidate?: () => void;
	pendingStartedAt?: number;
	execStartedAt?: number;
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
	totalMatched?: number;
	linesTruncated?: boolean;
	imageUnsupportedByModel?: string;
	loaded?: string[];
	error?: string;
	phase?: string;
	progress?: number;
	currentQuery?: string;
	curatorUrl?: string;
	shortcut?: string;
	browserOpenError?: string;
	timeoutSeconds?: number;
	queryCount?: number;
	successfulQueries?: number;
	totalResults?: number;
	curated?: boolean;
	summary?: { text?: string };
	fetchId?: string;
	fetchUrls?: string[];
	urlCount?: number;
	successful?: number;
	title?: string;
	totalChars?: number;
	truncated?: boolean;
	imageCount?: number;
	hasImage?: boolean;
	matchCount?: number;
	returnedMatches?: number;
	resultCount?: number;
	contentLength?: number;
	nextOffset?: number;
	calls?: { name: string; args?: string; status: "running" | "ok" | "error" | "cancelled"; error?: string; cost?: number }[];
}

interface MetricSegment {
	text: string;
	color: ThemeColor;
	priority?: 0 | 1 | 2;
}

class CompactLines implements Component {
	private cache?: { width: number; lines: string[] };

	constructor(private lines: Line[], private padding: number, private onRender?: () => void) {}

	invalidate(): void {
		this.cache = undefined;
	}

	render(width: number): string[] {
		this.onRender?.();
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

const activeAnimations = new Set<RowState>();
let animationTimer: ReturnType<typeof setInterval> | undefined;

function getRow(context: RenderContext): RowState {
	return context.state[rowState] ??= {};
}

function tickAnimations(): void {
	for (const row of [...activeAnimations]) {
		if (!row.animating || !row.invalidate || (row.missedTicks ?? 0) >= maxMissedAnimationTicks) {
			activeAnimations.delete(row);
			continue;
		}
		row.missedTicks = (row.missedTicks ?? 0) + 1;
		row.frame = ((row.frame ?? 0) + 1) % pulseFrames.length;
		row.ticking = true;
		try {
			row.invalidate();
		} finally {
			row.ticking = false;
		}
	}
	if (activeAnimations.size === 0 && animationTimer) {
		clearInterval(animationTimer);
		animationTimer = undefined;
	}
}

function prepareAnimation(row: RowState, context: RenderContext): void {
	const now = Date.now();
	row.pendingStartedAt ??= now;
	if (context.executionStarted) row.execStartedAt ??= now;
	row.frame ??= 0;
	row.animating = true;
	row.invalidate = context.invalidate;
}

function scheduleAnimation(row: RowState): void {
	if (!row.animating || !row.invalidate) return;
	row.missedTicks = 0;
	if (!activeAnimations.has(row)) {
		activeAnimations.add(row);
		if (!animationTimer) {
			animationTimer = setInterval(tickAnimations, animationIntervalMs);
			animationTimer.unref?.();
		}
	}
}

function stopAnimation(row: RowState): void {
	row.animating = false;
	row.invalidate = undefined;
	row.missedTicks = 0;
	activeAnimations.delete(row);
	if (activeAnimations.size === 0 && animationTimer) {
		clearInterval(animationTimer);
		animationTimer = undefined;
	}
}

function activeSymbol(row: RowState): string {
	return pulseFrames[(row.frame ?? 0) % pulseFrames.length]!;
}

function getElapsedMs(row: RowState, executionStarted: boolean): number {
	const startedAt = executionStarted ? (row.execStartedAt ?? row.pendingStartedAt) : row.pendingStartedAt;
	return startedAt === undefined ? 0 : Math.max(0, Date.now() - startedAt);
}

function formatLiveElapsed(ms: number): string {
	const totalSeconds = Math.floor(ms / 1000);
	if (totalSeconds < 1) return "";
	if (totalSeconds < 60) return `${totalSeconds}s`;
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	return `${minutes}m${seconds}s`;
}

function durationColor(ms: number | undefined): ThemeColor {
	if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 1000) return "dim";
	return ms >= 5000 ? "warning" : "muted";
}

function formatCharCount(chars: number): string {
	if (chars < 1000) return `${chars} 字`;
	return `${(chars / 1000).toFixed(1)}k 字`;
}

function formatCost(cost: number): string {
	if (!Number.isFinite(cost) || cost <= 0) return "";
	if (cost < 0.01) return `$${cost.toFixed(4).replace(/0+$/, "").replace(/\.$/, "")}`;
	return `$${cost.toFixed(2)}`;
}

function isInvalidStringArg(value: unknown): boolean {
	return value !== undefined && value !== null && typeof value !== "string";
}

function isLinkablePath(raw: string): boolean {
	return Boolean(raw) && !/[*?[\]{}]/.test(raw);
}

function buildFileLink(rawPath: string, cwd: string): string | undefined {
	if (!getCapabilities().hyperlinks || !isLinkablePath(rawPath)) return undefined;
	try {
		return pathToFileURL(resolve(cwd, rawPath)).href;
	} catch {
		return undefined;
	}
}

function shortenUrl(raw: string): string {
	const cleaned = oneLine(raw);
	if (!cleaned) return "";
	try {
		const url = new URL(cleaned);
		const host = url.host.replace(/^www\./i, "");
		const pathname = url.pathname === "/" ? "" : url.pathname.replace(/\/+$/, "");
		return `${host}${pathname}`;
	} catch {
		return cleaned.replace(/^https?:\/\/(?:www\.)?/i, "").replace(/\/+$/, "");
	}
}

function buildWebLink(raw: string): string | undefined {
	if (!getCapabilities().hyperlinks) return undefined;
	const cleaned = oneLine(raw);
	return /^https?:\/\//i.test(cleaned) ? cleaned : undefined;
}

function extractStringList(single: unknown, list: unknown): string[] {
	if (Array.isArray(list)) {
		return list.map(oneLine).filter(Boolean);
	}
	const item = oneLine(single);
	return item ? [item] : [];
}

function formatShellCommand(raw: unknown): { text: string; extraLines: number } {
	if (typeof raw !== "string") return { text: "", extraLines: 0 };
	const lines = stripTerminalSequences(raw)
		.split(/\r\n?|\n/)
		.map((line) => replaceControlCharacters(line).trim())
		.filter(Boolean);
	if (lines.length === 0) return { text: "", extraLines: 0 };
	return { text: lines[0]!, extraLines: lines.length - 1 };
}

function countTextLines(text: string): number {
	return text.length === 0 ? 0 : text.replace(/\r\n?/g, "\n").replace(/\n$/, "").split("\n").length;
}

function displayToolName(name: string): string {
	return collapsedDisplayNames[name] ?? name;
}

function formatNestedCallPreview(call: NonNullable<ResultDetails["calls"]>[number] | undefined, cwd: string): string {
	if (!call) return "";
	const name = oneLine(call.name);
	if (!name) return "";
	const rawArgs = typeof call.args === "string" ? call.args.trim() : "";
	if (!rawArgs || rawArgs === "{}") return "";
	let target = "";
	try {
		const parsed = JSON.parse(rawArgs) as Record<string, unknown> | null;
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			const summary = oneLine(parsed.displaySummary);
			const cmdInfo = formatShellCommand(parsed.command);
			const command = cmdInfo.text ? (cmdInfo.extraLines > 0 ? `${cmdInfo.text} (+${cmdInfo.extraLines} 行)` : cmdInfo.text) : "";
			const filePath = oneLine(parsed.file_path ?? parsed.path);
			const pattern = oneLine(parsed.pattern);
			const query = oneLine(parsed.query) || extractStringList(undefined, parsed.queries)[0] || "";
			const url = oneLine(parsed.url) || extractStringList(undefined, parsed.urls)[0] || "";
			if (summary) target = summary;
			else if (command) target = command;
			else if (pattern && filePath && filePath !== ".") target = `"${pattern}"  ${shortenPath(filePath, cwd)}`;
			else if (pattern) target = `"${pattern}"`;
			else if (filePath) target = shortenPath(filePath, cwd);
			else if (query) target = `"${query}"`;
			else if (url) target = shortenUrl(url);
		}
	} catch {
		target = oneLine(rawArgs);
	}
	return target ? `${name}  ${target}` : "";
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

function stylePath(displayPath: string, range: string, maxWidth: number, theme: Theme, linkUrl?: string): string {
	if (maxWidth <= 0) return "";
	const rangeWidth = visibleWidth(range);
	const keepRange = rangeWidth > 0 && maxWidth > rangeWidth + 4;
	const pathBudget = keepRange ? maxWidth - rangeWidth : maxWidth;
	const fitted = truncatePath(displayPath, pathBudget);
	const slash = fitted.lastIndexOf("/");
	const styledPath = slash >= 0
		? theme.fg("dim", fitted.slice(0, slash + 1)) + theme.fg("text", fitted.slice(slash + 1))
		: theme.fg("text", fitted);
	const linkedPath = linkUrl ? hyperlink(styledPath, linkUrl) : styledPath;
	return keepRange ? linkedPath + theme.fg("accent", range) : linkedPath;
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
	for (const match of code.matchAll(/\b(?:tools\.([A-Za-z_][A-Za-z0-9_]*)|(models\.[A-Za-z_][A-Za-z0-9_]*))/g)) {
		const name = match[1] ?? match[2]!;
		if (!seen.has(name)) {
			seen.add(name);
			names.push(name);
			if (names.length === 3) break;
		}
	}
	return names.join(", ");
}

const actionTools = new Set(["edit", "write", "bash", "powershell", "codemode"]);

function toolAccent(name: string): ThemeColor {
	return actionTools.has(name) ? "syntaxFunction" : "toolTitle";
}

function renderMetrics(theme: Theme, segments: MetricSegment[]): { text: string; width: number } {
	if (segments.length === 0) return { text: "", width: 0 };
	const sep = theme.fg("dim", " · ");
	const parts = segments.map((seg) => theme.fg(seg.color, seg.text));
	const text = parts.join(sep);
	return { text, width: visibleWidth(text) };
}

function fitMetrics(theme: Theme, segments: MetricSegment[], maxWidth: number): { text: string; width: number } {
	if (segments.length === 0 || maxWidth <= 0) return { text: "", width: 0 };
	const full = renderMetrics(theme, segments);
	if (full.width <= maxWidth) return full;

	const kept = [...segments];
	for (const dropPriority of [2, 1, 0] as const) {
		for (let i = kept.length - 1; i >= 0; i--) {
			if ((kept[i]!.priority ?? 1) !== dropPriority) continue;
			kept.splice(i, 1);
			if (kept.length === 0) return { text: "", width: 0 };
			const candidate = renderMetrics(theme, kept);
			if (candidate.width <= maxWidth) return candidate;
		}
	}
	return { text: "", width: 0 };
}

function styleSkill(skillName: string, range: string, maxWidth: number, theme: Theme, linkUrl?: string): string {
	if (maxWidth <= 0) return "";
	const rangeWidth = visibleWidth(range);
	const keepRange = rangeWidth > 0 && maxWidth > rangeWidth + 4;
	const budget = keepRange ? maxWidth - rangeWidth : maxWidth;
	const badge = "[skill] ";
	const badgeWidth = visibleWidth(badge);
	let styled: string;
	if (budget > badgeWidth + 2) {
		const fittedName = truncateToWidth(skillName, budget - badgeWidth, "…");
		styled = theme.fg("accent", "[skill]") + " " + theme.fg("text", fittedName);
	} else {
		styled = theme.fg("text", truncateToWidth(skillName, budget, "…"));
	}
	const linked = linkUrl ? hyperlink(styled, linkUrl) : styled;
	return keepRange ? linked + theme.fg("accent", range) : linked;
}

function styleUrl(displayUrl: string, maxWidth: number, theme: Theme, linkUrl?: string): string {
	if (maxWidth <= 0) return "";
	const fitted = truncatePath(displayUrl, maxWidth);
	const slash = fitted.indexOf("/");
	const styled = slash >= 0
		? theme.fg("mdLink", fitted.slice(0, slash)) + theme.fg("muted", fitted.slice(slash))
		: theme.fg("mdLink", fitted);
	return linkUrl ? hyperlink(styled, linkUrl) : styled;
}

function styleCodemodeLabel(label: string, maxWidth: number, theme: Theme): string {
	const fitted = truncateToWidth(label, maxWidth, "…");
	let out = "";
	let last = 0;
	for (const match of fitted.matchAll(/×\d+|\+\d+/g)) {
		const index = match.index!;
		if (index > last) out += theme.fg("toolOutput", fitted.slice(last, index));
		out += theme.fg("accent", match[0]);
		last = index + match[0].length;
	}
	if (last < fitted.length) out += theme.fg("toolOutput", fitted.slice(last));
	return out;
}

function renderQuotedList(items: string[], maxWidth: number, theme: Theme, emptyFallback = "…"): string {
	if (items.length === 0) return theme.fg("dim", truncateToWidth(emptyFallback, maxWidth, "…"));
	const extra = items.length > 1 ? ` +${items.length - 1}` : "";
	const extraWidth = visibleWidth(extra);
	const keepExtra = extraWidth > 0 && maxWidth > extraWidth + 6;
	const budget = keepExtra ? maxWidth - extraWidth : maxWidth;
	const quoted = theme.fg("syntaxVariable", truncateToWidth(`"${items[0]}"`, budget, "…"));
	return keepExtra ? quoted + theme.fg("dim", extra) : quoted;
}

function renderSubject(
	name: string,
	args: Record<string, unknown> | undefined,
	cwd: string,
	maxWidth: number,
	theme: Theme,
	codemodeLabel?: string,
	preferRawCommand = false,
): string {
	if (maxWidth <= 0) return "";

	if (name === "bash" || name === "powershell") {
		const parsedCmd = formatShellCommand(args?.command);
		const rawCmd = parsedCmd.text;
		const invalidCmd = isInvalidStringArg(args?.command);
		const summary = oneLine(args?.displaySummary);
		const useSummary = Boolean(summary) && (!preferRawCommand || !rawCmd);
		if (!useSummary && invalidCmd) {
			return theme.fg("error", truncateToWidth("[无效参数]", maxWidth, "…"));
		}
		const primary = (useSummary ? summary : rawCmd) || summary || "…";
		const color: ThemeColor = useSummary ? "text" : "toolOutput";
		const extraLines = !useSummary && parsedCmd.extraLines > 0 ? ` (+${parsedCmd.extraLines} 行)` : "";
		const timeout = typeof args?.timeout === "number" ? ` · ${args.timeout}s` : "";
		let suffix = "";
		if (extraLines && maxWidth > visibleWidth(extraLines) + 6) {
			suffix = extraLines;
		}
		if (timeout && maxWidth > visibleWidth(suffix + timeout) + 6) {
			suffix += timeout;
		}
		const cmdBudget = suffix ? maxWidth - visibleWidth(suffix) : maxWidth;
		const styled = theme.fg(color, truncateToWidth(primary, cmdBudget, "…"));
		return suffix ? styled + theme.fg("dim", suffix) : styled;
	}

	if (name === "codemode") {
		const label = codemodeLabel || inferCodemodeTools(args?.code) || "脚本";
		return styleCodemodeLabel(label, maxWidth, theme);
	}

	if (name === "tool_search") {
		if (isInvalidStringArg(args?.query)) {
			return theme.fg("error", truncateToWidth("[无效参数]", maxWidth, "…"));
		}
		const query = oneLine(args?.query);
		return query ? theme.fg("syntaxVariable", truncateToWidth(`"${query}"`, maxWidth, "…")) : theme.fg("dim", "…");
	}

	if (name === "web_search") {
		return renderQuotedList(extractStringList(args?.query, args?.queries), maxWidth, theme);
	}

	if (name === "source_check") {
		const claim = oneLine(args?.claim);
		return claim ? theme.fg("syntaxVariable", truncateToWidth(`"${claim}"`, maxWidth, "…")) : renderQuotedList(extractStringList(undefined, args?.queries), maxWidth, theme);
	}

	if (name === "fetch_content") {
		const urls = extractStringList(args?.url, args?.urls);
		if (urls.length === 0) return theme.fg("dim", "…");
		const extra = urls.length > 1 ? ` +${urls.length - 1}` : "";
		const extraWidth = visibleWidth(extra);
		const keepExtra = extraWidth > 0 && maxWidth > extraWidth + 6;
		const budget = keepExtra ? maxWidth - extraWidth : maxWidth;
		const linked = styleUrl(shortenUrl(urls[0]!), budget, theme, buildWebLink(urls[0]!));
		return keepExtra ? linked + theme.fg("dim", extra) : linked;
	}

	if (name === "get_search_content") {
		const offsetVal = typeof args?.offset === "number" && Number.isFinite(args.offset) && args.offset > 0
			? ` @${Math.floor(args.offset)}`
			: "";
		const offsetWidth = visibleWidth(offsetVal);
		const keepOffset = offsetWidth > 0 && maxWidth > offsetWidth + 6;
		const budget = keepOffset ? maxWidth - offsetWidth : maxWidth;
		let main: string;
		const findTerms = extractStringList(args?.findText, Array.isArray(args?.findText) ? args.findText : undefined);
		if (findTerms.length > 0) {
			main = renderQuotedList(findTerms, budget, theme);
		} else {
			const query = oneLine(args?.query);
			if (query) {
				main = theme.fg("syntaxVariable", truncateToWidth(`"${query}"`, budget, "…"));
			} else {
				const url = oneLine(args?.url);
				if (url) {
					main = styleUrl(shortenUrl(url), budget, theme, buildWebLink(url));
				} else {
					const responseId = oneLine(args?.responseId);
					main = theme.fg("dim", truncateToWidth(responseId ? responseId.slice(0, 8) : "…", budget, "…"));
				}
			}
		}
		return keepOffset ? main + theme.fg("accent", offsetVal) : main;
	}

	const rawPathArg = args?.file_path ?? args?.path;
	const invalidPath = isInvalidStringArg(rawPathArg);
	const rawPath = oneLine(rawPathArg);
	const displayPath = shortenPath(rawPath, cwd);
	const fileLink = buildFileLink(rawPath, cwd);

	if (name === "read") {
		if (invalidPath) return theme.fg("error", truncateToWidth("[无效参数]", maxWidth, "…"));
		const range = formatReadLineRange(args?.offset, args?.limit);
		if (rawPath) {
			const resolvedPath = resolve(cwd, rawPath);
			if (basename(resolvedPath) === "SKILL.md") {
				const skillDir = basename(dirname(resolvedPath)) || "SKILL.md";
				return styleSkill(skillDir, range, maxWidth, theme, fileLink);
			}
		}
		return stylePath(displayPath || "…", range, maxWidth, theme, fileLink);
	}

	if (searchTools.has(name)) {
		if (isInvalidStringArg(args?.pattern)) {
			return theme.fg("error", truncateToWidth("[无效参数]", maxWidth, "…"));
		}
		const pattern = oneLine(args?.pattern);
		const glob = name === "grep" ? oneLine(args?.glob) : "";
		if (!pattern) {
			if (invalidPath) return theme.fg("error", truncateToWidth("[无效参数]", maxWidth, "…"));
			return stylePath(displayPath || ".", "", maxWidth, theme, fileLink);
		}
		const quoted = `"${pattern}"`;
		const scopePath = displayPath && displayPath !== "." ? displayPath : "";
		const globSuffix = glob ? `(${glob})` : "";
		if (!scopePath && !globSuffix) {
			return theme.fg("syntaxVariable", truncateToWidth(quoted, maxWidth, "…"));
		}
		const patternWidth = visibleWidth(quoted);
		if (patternWidth + 4 >= maxWidth) {
			return theme.fg("syntaxVariable", truncateToWidth(quoted, maxWidth, "…"));
		}
		const scopeBudget = maxWidth - patternWidth - 2;
		if (scopePath && globSuffix) {
			const globWidth = visibleWidth(globSuffix);
			if (scopeBudget > globWidth + 5) {
				const fittedPath = truncatePath(scopePath, scopeBudget - globWidth - 1);
				const styledPath = theme.fg("dim", fittedPath);
				return `${theme.fg("syntaxVariable", quoted)}  ${fileLink ? hyperlink(styledPath, fileLink) : styledPath} ${theme.fg("dim", globSuffix)}`;
			}
			const fittedPath = truncatePath(scopePath, scopeBudget);
			const styledPath = theme.fg("dim", fittedPath);
			return `${theme.fg("syntaxVariable", quoted)}  ${fileLink ? hyperlink(styledPath, fileLink) : styledPath}`;
		}
		if (scopePath) {
			const fittedPath = truncatePath(scopePath, scopeBudget);
			const styledPath = theme.fg("dim", fittedPath);
			return `${theme.fg("syntaxVariable", quoted)}  ${fileLink ? hyperlink(styledPath, fileLink) : styledPath}`;
		}
		return `${theme.fg("syntaxVariable", quoted)}  ${theme.fg("dim", truncateToWidth(globSuffix, scopeBudget, "…"))}`;
	}

	if (invalidPath) return theme.fg("error", truncateToWidth("[无效参数]", maxWidth, "…"));
	return stylePath(displayPath || (name === "ls" ? "." : "…"), "", maxWidth, theme, fileLink);
}

function headerLine(
	theme: Theme,
	options: {
		name: string;
		args: Record<string, unknown> | undefined;
		cwd: string;
		symbol: string;
		statusColor: ThemeColor;
		metrics: MetricSegment[];
		codemodeLabel?: string;
		preferRawCommand?: boolean;
	},
): Line {
	const { name, args, cwd, symbol, statusColor, metrics, codemodeLabel, preferRawCommand = false } = options;
	return (width) => {
		const label = displayToolName(name);
		const paddedName = width >= minAlignedRowWidth && label.length < toolNamePadWidth
			? label.padEnd(toolNamePadWidth)
			: label;
		const prefix = `${theme.fg(statusColor, symbol)} ${theme.fg(toolAccent(name), theme.bold(paddedName))}`;
		const prefixWidth = visibleWidth(prefix);
		if (width <= prefixWidth) return truncateToWidth(prefix, width, "…");

		const gap = width >= prefixWidth + 2 ? "  " : " ";
		const available = width - prefixWidth - gap.length;
		if (available <= 0) return prefix;

		const renderedMetrics = fitMetrics(theme, metrics, available - 10);
		const showMetrics = renderedMetrics.width > 0;
		const metricJoin = showMetrics ? theme.fg("dim", "  · ") + renderedMetrics.text : "";
		const subjectBudget = showMetrics ? available - renderedMetrics.width - 4 : available;
		const subject = renderSubject(name, args, cwd, subjectBudget, theme, codemodeLabel, preferRawCommand);
		if (!subject) {
			const fallbackMetrics = fitMetrics(theme, metrics, available);
			return fallbackMetrics.width > 0
				? `${prefix}${gap}${fallbackMetrics.text}`
				: prefix;
		}
		return `${prefix}${gap}${subject}${metricJoin}`;
	};
}

function detailLine(
	theme: Theme,
	text: string,
	color: ThemeColor,
	notice = "",
	outputUrl?: string,
): Line {
	return (width) => {
		const branch = width >= 12 ? "  └─ " : width >= 8 ? "└─ " : width >= 5 ? "└ " : "";
		const prefix = theme.fg("dim", branch);
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
	preview: string,
	color: ThemeColor,
	path: string,
	cwd: string,
): Line {
	const url = getCapabilities().hyperlinks ? pathToFileURL(resolve(cwd, path)).href : undefined;
	return detailLine(theme, preview, color, `截断 · 全文 ${shortenPath(path, cwd)}`, url);
}

function buildCodemodeLines(
	args: Record<string, unknown> | undefined,
	result: AgentToolResult<unknown>,
	context: RenderContext,
	theme: Theme,
	row: RowState,
): Line[] {
	const details = result.details as ResultDetails | undefined;
	const calls = Array.isArray(details?.calls) ? details.calls : [];
	const errors = calls.filter((call) => call.status === "error");
	const cancelled = calls.filter((call) => call.status === "cancelled").length;
	const running = calls.filter((call) => call.status === "running");
	const blocks = result.content.flatMap((block) => block.type === "text" && !scriptHeader.test(block.text) ? [block.text] : []);
	const issue = Boolean(result.isError || context.isError);
	const hasNestedError = errors.length > 0;
	const animating = context.isPartial && !issue;
	const scriptError = issue ? blocks.findLast((text) => /^Script error:\s*/.test(text)) : undefined;
	const lastError = errors.at(-1);
	const nestedError = lastError ? [oneLine(lastError.name), oneLine(lastError.error)].filter(Boolean).join(" ") : "";

	const symbol = animating ? activeSymbol(row) : "●";
	const pendingColor: ThemeColor = context.executionStarted ? "warning" : "accent";
	const statusColor: ThemeColor = issue || hasNestedError ? "error" : context.isPartial ? pendingColor : cancelled > 0 ? "warning" : "success";

	const breakdown = summarizeCallNames(calls);
	const codemodeLabel = breakdown || undefined;
	const imageCount = result.content.filter((block) => block.type === "image").length;
	const totalCost = calls.reduce(
		(sum, call) => sum + (typeof call.cost === "number" && Number.isFinite(call.cost) && call.cost > 0 ? call.cost : 0),
		0,
	);

	const metrics: MetricSegment[] = [];
	if (calls.length > 0) {
		metrics.push({ text: `${calls.length} 次`, color: "muted", priority: 1 });
	}
	if (issue) {
		metrics.push({ text: "脚本失败", color: "error", priority: 0 });
	} else {
		if (hasNestedError) {
			metrics.push({ text: `${errors.length} 失败`, color: "error", priority: 0 });
		}
		if (context.isPartial) {
			const active = oneLine(running.at(-1)?.name);
			metrics.push({ text: active ? `正在执行 ${active}` : "运行中", color: "warning", priority: 1 });
		}
		if (cancelled > 0) {
			metrics.push({ text: `${cancelled} 取消`, color: "warning", priority: 0 });
		}
		if (!hasNestedError && !context.isPartial && cancelled === 0 && calls.length === 0) {
			metrics.push({ text: "完成", color: "dim", priority: 1 });
		}
	}
	if (!issue && imageCount > 0) {
		metrics.push({ text: `${imageCount} 图`, color: "syntaxVariable", priority: 1 });
	}
	const costText = formatCost(totalCost);
	if (costText) {
		metrics.push({ text: costText, color: "syntaxVariable", priority: 2 });
	}
	const elapsedMs = animating ? getElapsedMs(row, context.executionStarted) : context.durationMs;
	const duration = animating ? formatLiveElapsed(elapsedMs ?? 0) : formatDuration(context.durationMs);
	if (duration) metrics.push({ text: duration, color: durationColor(elapsedMs), priority: 2 });

	const lines: Line[] = [
		headerLine(theme, {
			name: "codemode",
			args,
			cwd: context.cwd,
			symbol,
			statusColor,
			metrics,
			codemodeLabel,
		}),
	];

	if (issue) {
		const rawError = scriptError?.replace(/^Script error:\s*/, "") ?? blocks.at(-1);
		const firstLine = rawError?.split(/\r?\n/).map(oneLine).find(Boolean);
		const message = firstLine || nestedError || "脚本执行失败";
		lines.push(
			details?.fullOutputPath
				? fullOutputDetail(theme, message, "error", details.fullOutputPath, context.cwd)
				: detailLine(theme, message, "error"),
		);
	} else if (hasNestedError) {
		const message = nestedError || `${errors.length} 个子调用失败`;
		lines.push(
			details?.fullOutputPath
				? fullOutputDetail(theme, message, "error", details.fullOutputPath, context.cwd)
				: detailLine(theme, message, "error"),
		);
	} else if (details?.fullOutputPath) {
		const tail = oneLine(blocks.at(-1)?.split(/\r?\n/).filter(Boolean).at(-1)) || `${calls.length} 个子调用`;
		lines.push(fullOutputDetail(theme, tail, "toolOutput", details.fullOutputPath, context.cwd));
	} else if (animating) {
		const activePreview = formatNestedCallPreview(running.at(-1), context.cwd);
		if (activePreview) {
			lines.push(detailLine(theme, activePreview, "toolOutput"));
		}
	}

	return lines;
}

function buildToolLines(
	name: string,
	args: Record<string, unknown> | undefined,
	result: AgentToolResult<unknown>,
	context: RenderContext,
	theme: Theme,
	fffSearch: boolean,
	webAccess: boolean,
	row: RowState,
): Line[] {
	const shell = name === "bash" || name === "powershell";
	const details = result.details as ResultDetails | undefined;
	const isError = Boolean(result.isError || context.isError || (webAccess && !context.isPartial && typeof details?.error === "string" && details.error));
	const animating = context.isPartial && !isError;
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
		details?.truncated ||
		details?.matchLimitReached ||
		details?.resultLimitReached ||
		details?.entryLimitReached ||
		details?.linesTruncated,
	);
	const image = result.content.find((block) => block.type === "image");

	const fetchMulti = name === "fetch_content" && !context.isPartial && !isError && typeof details?.urlCount === "number" && details.urlCount > 1;
	const fetchSuccessful = fetchMulti && typeof details.successful === "number" ? details.successful : undefined;
	const fetchAllFailed = fetchMulti && (fetchSuccessful ?? 0) === 0;
	const fetchPartialFailed = fetchMulti && (fetchSuccessful ?? 0) > 0 && (fetchSuccessful ?? 0) < details.urlCount!;

	const searchMulti = name === "web_search" && !context.isPartial && !isError && typeof details?.queryCount === "number" && details.queryCount > 0 && typeof details.successfulQueries === "number";
	const searchAllFailed = searchMulti && details.successfulQueries === 0;
	const searchPartialFailed = searchMulti && details.successfulQueries! > 0 && details.successfulQueries! < details.queryCount!;

	const allFailed = fetchAllFailed || searchAllFailed;
	const partialFailed = fetchPartialFailed || searchPartialFailed;

	const symbol = animating ? activeSymbol(row) : "●";
	const pendingColor: ThemeColor = context.executionStarted ? "warning" : "accent";
	const statusColor: ThemeColor = isError || allFailed ? "error" : context.isPartial ? pendingColor : partialFailed ? "warning" : "success";

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
	const elapsedMs = animating ? getElapsedMs(row, context.executionStarted) : context.durationMs;
	const duration = animating ? formatLiveElapsed(elapsedMs ?? 0) : formatDuration(context.durationMs);

	if (isError) {
		if (exitCode) metrics.push({ text: `exit ${exitCode}`, color: "error", priority: 0 });
	} else if (context.isPartial) {
		if (webAccess) {
			const phase = details?.phase;
			const pct = typeof details?.progress === "number" && details.progress > 0 && details.progress < 1
				? ` ${Math.round(details.progress * 100)}%`
				: "";
			if (phase === "curating" || phase === "waiting-for-approval" || phase === "curator-fallback") {
				metrics.push({ text: "等待确认", color: "warning", priority: 0 });
			} else if (phase === "generating-summary") {
				metrics.push({ text: "生成摘要", color: "accent", priority: 1 });
			} else if (name === "fetch_content") {
				metrics.push({ text: `抓取中${pct}`, color: "warning", priority: 1 });
			} else if (name === "web_search") {
				metrics.push({ text: `搜索中${pct}`, color: "warning", priority: 1 });
			} else {
				metrics.push({ text: "运行中", color: "warning", priority: 1 });
			}
		} else {
			metrics.push({ text: "运行中", color: "warning", priority: 1 });
			if (shell && contentLines.length > 0 && !(contentLines.length === 1 && contentLines[0] === "(no output)")) {
				metrics.push({ text: `${contentLines.length} 行`, color: "syntaxVariable", priority: 1 });
			}
		}
	} else if (name === "read") {
		if (image) {
			metrics.push({ text: `图片 ${oneLine(image.mimeType)}`, color: "syntaxVariable", priority: 1 });
		} else if (details?.truncation?.firstLineExceedsLimit) {
			metrics.push({ text: "首行超限", color: "warning", priority: 0 });
		} else if (details?.truncation?.truncated && details.truncation.outputLines && details.truncation.totalLines) {
			metrics.push({ text: `${details.truncation.outputLines}/${details.truncation.totalLines} 行`, color: "muted", priority: 1 });
		} else if (contentLines.length > 0) {
			const count = rawText.trimEnd() ? rawText.replace(/\r\n?/g, "\n").replace(/\n$/, "").split("\n").length : 0;
			metrics.push({ text: `${count} 行`, color: "muted", priority: 1 });
		} else {
			metrics.push({ text: "空文件", color: "dim", priority: 1 });
		}
		if (truncated && !fullOutputPath && !details?.truncation?.firstLineExceedsLimit) {
			metrics.push({ text: "截断", color: "warning", priority: 0 });
		}
	} else if (name === "edit") {
		const counts = countDiffLines(details?.diff);
		if (counts) {
			if (counts.added > 0) metrics.push({ text: `+${counts.added}`, color: "toolDiffAdded", priority: 0 });
			if (counts.removed > 0) metrics.push({ text: `−${counts.removed}`, color: "toolDiffRemoved", priority: 0 });
			if (counts.added === 0 && counts.removed === 0) metrics.push({ text: "无变更", color: "dim", priority: 1 });
		} else {
			metrics.push({ text: "已修改", color: "muted", priority: 1 });
		}
		if (Array.isArray(args?.edits) && args.edits.length > 1) {
			metrics.push({ text: `${args.edits.length} 处`, color: "dim", priority: 2 });
		}
	} else if (name === "write") {
		if (typeof args?.content === "string") {
			const writeLines = countTextLines(args.content);
			const bytes = Buffer.byteLength(args.content, "utf8");
			metrics.push({ text: `${writeLines} 行`, color: "muted", priority: 1 });
			if (bytes >= 1024) metrics.push({ text: formatBytes(bytes), color: "syntaxVariable", priority: 2 });
		} else {
			metrics.push({ text: "已写入", color: "muted", priority: 1 });
		}
	} else if (searchTools.has(name)) {
		const find = name === "find" || name === "fffind";
		const noMatches = find ? /^No files found/i : /^No matches found/i;
		const total = fffSearch ? details?.totalMatched : contentLines.length;
		const empty = !contentLines.length || total === 0 ||
			((fffSearch || contentLines.length === 1) && noMatches.test(contentLines[0]!));
		const summary = empty ? (find ? "无结果" : "无匹配")
			: typeof total === "number" && Number.isSafeInteger(total) && total > 0
				? `${total} ${find ? "个文件" : "处匹配"}`
				: (find ? "有结果" : "有匹配");
		metrics.push({ text: summary, color: empty ? "dim" : "muted", priority: 1 });
		if (fffSearch) {
			if (oneLine(args?.cursor)) metrics.push({ text: "续页", color: "accent", priority: 2 });
			const notice = lines.at(-1) ?? "";
			if (lines[0] === "[0 exact matches. Maybe you meant this?]") metrics.push({ text: "近似匹配", color: "warning", priority: 0 });
			if (notice.startsWith("[Invalid regex:")) metrics.push({ text: "正则回退", color: "warning", priority: 0 });
			if (notice.startsWith("[Query ") && notice.includes("produced only weak scattered fuzzy matches.")) {
				metrics.push({ text: "弱匹配", color: "warning", priority: 0 });
			}
			if (notice.startsWith("[") && /Continue with cursor="[^"]+"|cursor="[^"]+" to continue/.test(notice)) {
				metrics.push({ text: "可翻页", color: "accent", priority: 2 });
			}
		}
		const limitReached = details?.matchLimitReached ?? details?.resultLimitReached;
		if (typeof limitReached === "number" && limitReached > 0 && !fullOutputPath) {
			metrics.push({ text: `上限 ${limitReached}`, color: "warning", priority: 0 });
		} else if (truncated && !fullOutputPath) {
			metrics.push({ text: "截断", color: "warning", priority: 0 });
		}
	} else if (name === "tool_search") {
		const loaded = Array.isArray(details?.loaded) ? details.loaded.length : undefined;
		if (typeof loaded === "number") {
			metrics.push({ text: loaded === 0 ? "无匹配" : `加载 ${loaded} 个工具`, color: loaded === 0 ? "dim" : "syntaxVariable", priority: 1 });
		} else {
			const empty = contentLines.length === 0 || /^No matching tools/i.test(contentLines[0]!);
			metrics.push({ text: empty ? "无匹配" : "已加载", color: empty ? "dim" : "muted", priority: 1 });
		}
	} else if (name === "web_search") {
		if (typeof details?.queryCount === "number" && (details.queryCount > 1 || searchAllFailed)) {
			const okQueries = details.successfulQueries ?? details.queryCount;
			const queryColor: ThemeColor = searchAllFailed ? "error" : searchPartialFailed ? "warning" : "dim";
			const queryPriority: 0 | 2 = searchAllFailed || searchPartialFailed ? 0 : 2;
			metrics.push({ text: `${okQueries}/${details.queryCount} 组`, color: queryColor, priority: queryPriority });
		}
		if (typeof details?.totalResults === "number") {
			metrics.push({ text: details.totalResults > 0 ? `${details.totalResults} 来源` : "无结果", color: details.totalResults > 0 ? "syntaxVariable" : "dim", priority: 1 });
		} else {
			metrics.push({ text: contentLines.length > 0 ? "已完成" : "无结果", color: contentLines.length > 0 ? "muted" : "dim", priority: 1 });
		}
		if (details?.summary?.text) metrics.push({ text: "已摘要", color: "accent", priority: 2 });
		if (details?.curated) metrics.push({ text: "已精选", color: "accent", priority: 2 });
		if (details?.fetchId && details.fetchUrls?.length) {
			metrics.push({ text: `抓取 ${details.fetchUrls.length} 页`, color: "muted", priority: 2 });
		}
	} else if (name === "fetch_content") {
		if (details?.urlCount === 1) {
			if (typeof details.totalChars === "number") {
				metrics.push({ text: formatCharCount(details.totalChars), color: "muted", priority: 1 });
			}
			const imgCount = details.imageCount ?? (details.hasImage ? 1 : 0);
			if (imgCount > 0) metrics.push({ text: `${imgCount} 图`, color: "syntaxVariable", priority: 1 });
			if (details.truncated) metrics.push({ text: "截断", color: "warning", priority: 0 });
		} else if (typeof details?.urlCount === "number") {
			const pageColor: ThemeColor = fetchAllFailed ? "error" : fetchPartialFailed ? "warning" : "muted";
			const pagePriority: 0 | 1 = fetchAllFailed || fetchPartialFailed ? 0 : 1;
			metrics.push({ text: `${details.successful ?? 0}/${details.urlCount} 页`, color: pageColor, priority: pagePriority });
		} else {
			metrics.push({ text: contentLines.length > 0 ? "已抓取" : "无内容", color: contentLines.length > 0 ? "muted" : "dim", priority: 1 });
		}
	} else if (name === "get_search_content") {
		if (typeof details?.matchCount === "number") {
			metrics.push({ text: details.matchCount > 0 ? `${details.matchCount} 处匹配` : "无匹配", color: details.matchCount > 0 ? "syntaxVariable" : "dim", priority: 1 });
		} else if (typeof details?.resultCount === "number") {
			metrics.push({ text: `${details.resultCount} 条结果`, color: "muted", priority: 1 });
		} else if (typeof details?.contentLength === "number") {
			metrics.push({ text: formatCharCount(details.contentLength), color: "muted", priority: 1 });
		} else {
			metrics.push({ text: contentLines.length > 0 ? "已读取" : "无内容", color: contentLines.length > 0 ? "muted" : "dim", priority: 1 });
		}
		if (details?.nextOffset !== undefined) metrics.push({ text: "可翻页", color: "accent", priority: 2 });
	} else if (name === "source_check") {
		metrics.push({ text: contentLines.length > 0 ? "已核查" : "无结果", color: contentLines.length > 0 ? "muted" : "dim", priority: 1 });
	} else if (name === "ls") {
		const empty = contentLines.length === 0 || (contentLines.length === 1 && /^\(empty directory\)$/i.test(contentLines[0]!));
		metrics.push({ text: empty ? "空目录" : `${contentLines.length} 项`, color: empty ? "dim" : "muted", priority: 1 });
		if (typeof details?.entryLimitReached === "number" && details.entryLimitReached > 0 && !fullOutputPath) {
			metrics.push({ text: `上限 ${details.entryLimitReached}`, color: "warning", priority: 0 });
		} else if (truncated && !fullOutputPath) {
			metrics.push({ text: "截断", color: "warning", priority: 0 });
		}
	} else if (shell) {
		if (details?.truncation?.truncated && details.truncation.totalLines) {
			metrics.push({ text: `${details.truncation.totalLines} 行`, color: "muted", priority: 1 });
		} else if (contentLines.length > 0 && !(contentLines.length === 1 && contentLines[0] === "(no output)")) {
			metrics.push({ text: `${contentLines.length} 行`, color: "muted", priority: 1 });
		} else {
			metrics.push({ text: "无输出", color: "dim", priority: 1 });
		}
		if (truncated && !fullOutputPath && !fullOutputError) {
			metrics.push({ text: "截断", color: "warning", priority: 0 });
		}
	}

	if (duration) metrics.push({ text: duration, color: durationColor(elapsedMs), priority: 2 });

	const out: Line[] = [
		headerLine(theme, {
			name,
			args,
			cwd: context.cwd,
			symbol,
			statusColor,
			metrics,
			preferRawCommand: isError,
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
		const errText = oneLine(details?.error) || preview || "执行失败";
		if (typeof fullOutputPath === "string" && fullOutputPath) {
			out.push(fullOutputDetail(theme, errText, "error", fullOutputPath, context.cwd));
		} else if (fullOutputError) {
			out.push(detailLine(theme, errText, "error", `截断 · 保存失败 ${oneLine(fullOutputError)}`));
		} else {
			out.push(detailLine(theme, errText, "error", truncated ? "截断" : ""));
		}
	} else if (typeof fullOutputPath === "string" && fullOutputPath) {
		out.push(fullOutputDetail(theme, preview || "输出已截断", context.isPartial ? "warning" : "toolOutput", fullOutputPath, context.cwd));
	} else if (fullOutputError) {
		out.push(detailLine(theme, preview || "输出已截断", "toolOutput", `截断 · 保存失败 ${oneLine(fullOutputError)}`));
	} else if (details?.imageUnsupportedByModel) {
		out.push(detailLine(theme, `图片 ${oneLine(image?.mimeType) || "image"}`, "muted", `模型不支持图片 · ${oneLine(details.imageUnsupportedByModel)}`));
	} else if (details?.truncation?.firstLineExceedsLimit) {
		out.push(detailLine(theme, preview || "首行超出大小限制", "warning", "截断"));
	} else if (context.isPartial && webAccess && (details?.curatorUrl || details?.phase === "curator-fallback")) {
		const hintParts: string[] = [];
		if (details.shortcut) hintParts.push(`${details.shortcut} 重开`);
		if (typeof details.timeoutSeconds === "number" && details.timeoutSeconds > 0) {
			hintParts.push(`${details.timeoutSeconds}s 后自动提交`);
		}
		const openErr = oneLine(details.browserOpenError);
		if (openErr) {
			const body = details.curatorUrl ? `${details.curatorUrl} (${openErr})` : openErr;
			const notice = hintParts.join(" · ") || "浏览器打开失败";
			out.push(detailLine(theme, body, "warning", notice, details.curatorUrl ? buildWebLink(details.curatorUrl) : undefined));
		} else if (details.curatorUrl) {
			const notice = hintParts.join(" · ") || "浏览器中确认";
			out.push(detailLine(theme, details.curatorUrl, "accent", notice, buildWebLink(details.curatorUrl)));
		} else if (hintParts.length > 0) {
			out.push(detailLine(theme, hintParts.join(" · "), "warning"));
		}
	} else if (context.isPartial && webAccess && details?.currentQuery) {
		out.push(detailLine(theme, `"${oneLine(details.currentQuery)}"`, "toolOutput"));
	} else if (context.isPartial && shell && preview) {
		out.push(detailLine(theme, preview, "toolOutput", truncated ? "截断" : ""));
	}

	return out;
}

function fallbackCallComponent(name: string, args: unknown, theme: Theme): Component {
	const header = theme.fg("toolTitle", theme.bold(name));
	if (!args || typeof args !== "object") return new Text(header, 0, 0);
	const entries = Object.entries(args as Record<string, unknown>);
	if (entries.length === 0) return new Text(header, 0, 0);
	const lines = entries.map(([key, value]) => {
		const text = typeof value === "string" ? value : (JSON.stringify(value, null, 2) ?? String(value));
		return `  ${key}: ${text.replace(/\t/g, "   ").replace(/\r/g, "").split("\n").join("\n    ")}`;
	});
	return new Text(`${header}\n${theme.fg("muted", lines.join("\n"))}`, 0, 0);
}

function fallbackResultComponent(result: AgentToolResult<unknown>, theme: Theme, isError = false): Component {
	const output = result.content.flatMap((block) => block.type === "text" ? [block.text] : []).join("\n");
	if (!output) return new Text("", 0, 0);
	const color: ThemeColor = isError ? "error" : "toolOutput";
	const cleaned = stripTerminalSequences(output).replace(/\r\n?/g, "\n");
	const styled = cleaned.split("\n").map((line) => theme.fg(color, replaceControlCharacters(line.replace(/\t/g, "   ")))).join("\n");
	return new Text(styled, 0, 0);
}

function getNativeBoxBg(theme: Theme, isPartial: boolean, isError: boolean): (text: string) => string {
	const token: ThemeBg = isPartial ? "toolPendingBg" : isError ? "toolErrorBg" : "toolSuccessBg";
	return (text) => theme.bg(token, text);
}

export default function (pi: ExtensionAPI): void {
	pi.registerToolRenderer((name, next) => {
		const base = next();
		if (!base || !tools.has(name)) return base;
		const source = pi.getAllTools().find((tool) => tool.name === name)?.sourceInfo;
		const builtin = source?.path === `builtin:${name}` || (name === "tool_search" && source?.path === "builtin:tool-search");
		const fffSearch = searchTools.has(name) && fffPackage.test(source?.source ?? "");
		const webAccess = webTools.has(name) && webAccessPackage.test(source?.source ?? "");
		if (!builtin && !fffSearch && !webAccess) return base;
		if (!webAccess && name !== "tool_search" && (!base.renderCall || !base.renderResult)) return base;

		const renderCall = base.renderCall ?? ((args: unknown, theme: Theme) => fallbackCallComponent(name, args, theme));
		const renderResult = base.renderResult ?? ((result: AgentToolResult<unknown>, _opts: unknown, theme: Theme, ctx?: RenderContext) =>
			fallbackResultComponent(result, theme, Boolean(result.isError || ctx?.isError)));
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
				if (context.expanded || ((edit || shell) && (!row.ticking || !row.nativeCall))) {
					row.nativeCall = renderCall(args, theme, { ...context, lastComponent: row.nativeCall });
					row.nativeCallExpanded = context.expanded;
					if (context.expanded) {
						stopAnimation(row);
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

				const animating = context.isPartial && !context.isError;
				if (animating) {
					prepareAnimation(row, context);
				} else {
					stopAnimation(row);
				}

				const pendingColor: ThemeColor = context.isError ? "error" : context.executionStarted ? "warning" : "accent";
				const streamingWrite = !context.isError && !context.executionStarted && !context.argsComplete && name === "write" && typeof row.args?.content === "string" && row.args.content.length > 0;
				const streamingCode = !context.isError && !context.executionStarted && !context.argsComplete && codemode && typeof row.args?.code === "string" && row.args.code.length > 0;
				const streamingEdit = !context.isError && !context.executionStarted && !context.argsComplete && edit && Array.isArray(row.args?.edits) && row.args.edits.length > 0;
				const metrics: MetricSegment[] = [];
				if (streamingWrite) {
					metrics.push({ text: "生成中", color: pendingColor, priority: 1 });
					metrics.push({ text: `${countTextLines(row.args!.content as string)} 行`, color: "syntaxVariable", priority: 1 });
				} else if (streamingCode) {
					metrics.push({ text: "生成中", color: pendingColor, priority: 1 });
					metrics.push({ text: `${countTextLines(row.args!.code as string)} 行`, color: "syntaxVariable", priority: 1 });
				} else if (streamingEdit) {
					metrics.push({ text: "生成中", color: pendingColor, priority: 1 });
					metrics.push({ text: `${(row.args!.edits as unknown[]).length} 处`, color: "syntaxVariable", priority: 1 });
				} else {
					metrics.push({ text: context.executionStarted ? "运行中" : "等待结果", color: pendingColor, priority: 1 });
				}
				const elapsedMs = animating ? getElapsedMs(row, context.executionStarted) : undefined;
				const elapsed = animating ? formatLiveElapsed(elapsedMs ?? 0) : "";
				if (elapsed) metrics.push({ text: elapsed, color: durationColor(elapsedMs), priority: 2 });

				const pendingLine = headerLine(theme, {
					name,
					args: row.args,
					cwd: context.cwd,
					symbol: animating ? activeSymbol(row) : "●",
					statusColor: pendingColor,
					metrics,
				});
				row.callSlot = new ToggleSlot(
					new CompactLines([pendingLine], context.outputPad, animating ? () => scheduleAnimation(row) : undefined),
				);
				return row.callSlot;
			},
			renderResult(result, options, theme, context) {
				const row = getRow(context);
				const details = result.details as ResultDetails | undefined;
				const isError = Boolean(result.isError || context.isError || (webAccess && !options.isPartial && typeof details?.error === "string" && details.error));

				// A native timer may stay active after a tool was expanded during execution.
				// Pass it the final result even if the row has been collapsed in the meantime.
				if (options.expanded || (edit && (!row.ticking || !row.nativeResult)) || (row.nativeTimerPending && !options.isPartial)) {
					if (options.expanded && !nativeSelf && (!row.nativeCall || !row.nativeCallExpanded)) {
						const callArgs = row.args ?? (context.args as Record<string, unknown> | undefined);
						row.nativeCall = renderCall(callArgs, theme, { ...context, expanded: true, lastComponent: row.nativeCall });
						row.nativeCallExpanded = true;
					}
					row.nativeResult = renderResult(result, options, theme, { ...context, lastComponent: row.nativeResult });
					row.nativeTimerPending = nativeTimer && options.isPartial;
					if (options.expanded) {
						stopAnimation(row);
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

				const animating = options.isPartial && !isError;
				if (animating) {
					prepareAnimation(row, context);
				} else {
					stopAnimation(row);
				}

				row.callSlot?.hide();
				const args = row.args ?? (context.args as Record<string, unknown> | undefined);
				const lines = codemode
					? buildCodemodeLines(args, result, context, theme, row)
					: buildToolLines(name, args, result, context, theme, fffSearch, webAccess, row);
				return new CompactLines(lines, context.outputPad, animating ? () => scheduleAnimation(row) : undefined);
			},
		};
	});
}
