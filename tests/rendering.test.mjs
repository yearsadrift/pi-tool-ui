import assert from "node:assert/strict";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { after, test } from "node:test";
import { builtIns, createSession, importPi, loadHost, packageDir, png, workspace } from "./pi-host.mjs";

const paths = await workspace();
const { api, tui, withBuiltInRenderers } = await loadHost(paths.agentDir);
const { KeybindingsManager } = await importPi("core/keybindings.js");
const { theme } = await importPi("modes/interactive/theme/theme.js");
const { createInteractiveTui } = await importPi("modes/interactive/tui-renderer.js");
const { createChatViewport } = await importPi("modes/interactive/chat-viewport.js");
const { session } = await createSession(api, paths, { codemode: true });
api.initTheme("dark");
tui.setKeybindings(new KeybindingsManager());
after(async () => { session.dispose(); await rm(paths.cwd, { recursive: true, force: true }); });

const plain = (lines) => lines.map((line) => tui.stripTerminalSequences(line).trim()).filter(Boolean);
const result = (text, extra = {}) => ({ content: [{ type: "text", text }], details: undefined, ...extra });
const native = (name) => withBuiltInRenderers(name, session.getToolDefinition(name));
const decorate = (name) => session.extensionRunner.resolveToolRenderers(name, () => native(name));

function toolRow(name, args, { ui = { requestRender() {} }, definition = decorate(name), showImages = false, id = name } = {}) {
	return new api.ToolExecutionComponent(name, id, args, { showImages }, definition, ui, paths.cwd);
}

test("built-ins use transparent self-framed single-line layout when settled and drop background slabs", () => {
	const bgToken = theme.getBgAnsi("toolSuccessBg");
	const labelOf = (name) => name === "powershell" ? "pwsh" : name;
	const padName = (name) => {
		const label = labelOf(name);
		return label.length < 8 ? label.padEnd(8) : label;
	};
	for (const name of builtIns) {
		const shell = name === "bash" || name === "powershell";
		const subject = shell ? "echo Chinese-output" : "中文-文件.txt";
		const args = shell ? { command: subject } : name === "write" ? { path: subject, content: "a\nb\nc" } : { path: subject };
		const row = toolRow(name, args);

		// Pending & streaming args before result: 1 clean line (plus Pi's single leading blank separator)
		const pendingRaw = row.render(90);
		assert.equal(pendingRaw.length, 2, name + " pending total rows");
		if (name === "write") {
			assert.deepEqual(plain(pendingRaw), [`· ${padName(name)}  ${subject}  · 生成中 · 3 行`]);
			row.setArgsComplete();
			assert.deepEqual(plain(row.render(90)), [`· ${padName(name)}  ${subject}  · 等待结果`]);
		} else {
			assert.deepEqual(plain(pendingRaw), [`· ${padName(name)}  ${subject}  · 等待结果`]);
		}

		row.markExecutionStarted();
		assert.deepEqual(plain(row.render(90)), [`· ${padName(name)}  ${subject}  · 运行中`]);

		// Streaming shell shows live output on 2nd branch line and live line count; other tools stay compact
		row.updateResult(result("测试实时输出"), true);
		if (shell) {
			assert.deepEqual(plain(row.render(90)), [`· ${padName(name)}  ${subject}  · 运行中 · 1 行`, "└─ 测试实时输出"]);
		} else {
			assert.equal(plain(row.render(90)).length, 1, name + " partial");
		}

		// Finalized normal call: 1 compact transparent line (no toolSuccessBg slab, no left rail, green dot)
		row.updateResult(result("测试最终输出", { durationMs: 42 }));
		const settledRaw = row.render(90);
		assert.equal(settledRaw.length, 2, name + " settled total rows (1 blank + 1 line)");
		assert.equal(plain(settledRaw).length, 1, name + " settled content lines");
		assert.match(plain(settledRaw)[0], new RegExp(`^● ${padName(name)}  `));
		assert.match(plain(settledRaw)[0], /42ms$/);
		assert.ok(settledRaw[1].includes(theme.fg("success", "●")), name + " settled should show green dot");
		assert.ok(!settledRaw.join("\n").includes("▏"), name + " should not render left vertical rail");
		if (bgToken) {
			assert.ok(!settledRaw.join("\n").includes(bgToken), name + " should not paint toolSuccessBg when collapsed");
		}
	}
});

test("per-tool smart metrics, colored diff stats, relative paths and tail-preserving path truncation", () => {
	// read with relative cwd shortening + line count + duration
	const readRow = toolRow("read", { path: join(paths.cwd, "sub", "中文.ts"), offset: 10, limit: 25 });
	readRow.updateResult(result("l1\nl2\nl3", { durationMs: 12 }));
	assert.deepEqual(plain(readRow.render(90)), ["● read      sub/中文.ts:10-34  · 3 行 · 12ms"]);

	// edit with colored +added / -removed diff counts
	const editRow = toolRow("edit", { path: join(paths.cwd, "src", "app.ts"), edits: [{ oldText: "a", newText: "b" }] });
	editRow.updateResult(result("ok", { details: { diff: "- 1 old1\n- 2 old2\n+ 1 new1\n+ 2 new2\n+ 3 new3" }, durationMs: 18 }));
	const editRaw = editRow.render(90).join("\n");
	assert.deepEqual(plain(editRow.render(90)), ["● edit      src/app.ts  · +3 · −2 · 18ms"]);
	assert.ok(editRaw.includes(theme.fg("toolDiffAdded", "+3")));
	assert.ok(editRaw.includes(theme.fg("toolDiffRemoved", "−2")));

	// write with line count and KB size
	const writeRow = toolRow("write", { path: "notes.md", content: "x".repeat(2048) + "\nsecond" });
	writeRow.updateResult(result("ok", { durationMs: 5 }));
	assert.deepEqual(plain(writeRow.render(90)), ["● write     notes.md  · 2 行 · 2.0 KB · 5ms"]);

	// grep / find / ls counts
	const grepRow = toolRow("grep", { path: "src", pattern: "renderShell" });
	grepRow.updateResult(result("a.ts:1:renderShell\nb.ts:4:renderShell"));
	assert.deepEqual(plain(grepRow.render(90)), ['● grep      "renderShell"  src  · 2 处匹配']);

	const findRow = toolRow("find", { path: ".", pattern: "*.ts" });
	findRow.updateResult(result("a.ts\nb.ts\nc.ts"));
	assert.deepEqual(plain(findRow.render(90)), ['● find      "*.ts"  · 3 个文件']);

	const lsRow = toolRow("ls", { path: "." });
	lsRow.updateResult(result("a.ts\nb.ts"));
	assert.deepEqual(plain(lsRow.render(90)), ["● ls        .  · 2 项"]);

	// Deep path preserves basename when truncated
	const deepPath = "very/deeply/nested/workspace/directory/structure/components/tool-execution.js";
	const deepRow = toolRow("read", { path: deepPath });
	deepRow.updateResult(result("line 1"));
	const narrow = plain(deepRow.render(48))[0];
	assert.match(narrow, /…\/.*tool-execution\.js/);
	assert.ok(tui.visibleWidth(deepRow.render(48)[1]) <= 48);
});

test("renders bash displaySummary, OSC 8 file hyperlinks, and duration color tiers", () => {
	const bashRow = toolRow("bash", { command: "npm --prefix pi-tool-ui test", displaySummary: "运行测试套件" });
	bashRow.updateResult(result("ok\nok", { durationMs: 6200 }));
	const bashRaw = bashRow.render(90).join("\n");
	assert.deepEqual(plain(bashRow.render(90)), ["● bash      运行测试套件  · 2 行 · 6.2s"]);
	assert.ok(bashRaw.includes(theme.fg("syntaxFunction", theme.bold("bash    "))), "mutating/executing tools should use warm gold syntaxFunction");
	assert.ok(bashRaw.includes(theme.fg("warning", "6.2s")), "slow calls (>=5s) should tint duration warning");

	const mediumRow = toolRow("read", { path: "中文-一.txt" });
	mediumRow.updateResult(result("line 1", { durationMs: 1800 }));
	const readRaw = mediumRow.render(90).join("\n");
	assert.ok(readRaw.includes(theme.fg("toolTitle", theme.bold("read    "))), "read-only tools should use clean neutral toolTitle");
	assert.ok(readRaw.includes(theme.fg("success", "●")), "settled success should show green dot");
	assert.ok(readRaw.includes(theme.fg("muted", "1.8s")));

	const editColored = toolRow("edit", { path: "中文-一.txt", edits: [{ oldText: "a", newText: "b" }] });
	editColored.updateResult(result("ok"));
	assert.ok(editColored.render(90).join("\n").includes(theme.fg("syntaxFunction", theme.bold("edit    "))));

	const grepColored = toolRow("grep", { path: "src", pattern: "needle" });
	grepColored.updateResult(result("src/a.ts:1:needle"));
	const grepRaw = grepColored.render(90).join("\n");
	assert.ok(grepRaw.includes(theme.fg("toolTitle", theme.bold("grep    "))));
	assert.ok(grepRaw.includes(theme.fg("syntaxVariable", '"needle"')));

	const caps = tui.getCapabilities();
	tui.setCapabilities({ ...caps, hyperlinks: true });
	try {
		const linked = toolRow("read", { path: "中文-一.txt", offset: 1, limit: 2 });
		linked.updateResult(result("a\nb"));
		const line = linked.render(90)[1];
		assert.ok(line.includes(pathToFileURL(join(paths.cwd, "中文-一.txt")).href), "file path should emit OSC 8 hyperlink");
		assert.ok(line.includes(theme.fg("accent", ":1-2")), "read line range should use accent color");

		const globSearch = toolRow("grep", { path: "src/**/*.ts", pattern: "foo" });
		globSearch.updateResult(result("src/a.ts:1:foo"));
		assert.ok(!globSearch.render(90)[1].includes("\x1b]8;;"), "glob paths must not emit file:// hyperlinks");
	} finally {
		tui.setCapabilities(caps);
	}
});

test("FFF search results use the compact layout with the original expanded renderers", async () => {
	const { createExtensionRuntime, loadExtensions } = await importPi("core/extensions/loader.js");
	const runtime = createExtensionRuntime();
	let source = "npm:@ff-labs/pi-fff@0.11.0";
	runtime.getAllTools = () => ["ffgrep", "fffind", "grep", "find"].map((name) => ({ name, sourceInfo: { source } }));
	const loaded = await loadExtensions([join(packageDir, "index.ts")], paths.cwd, undefined, runtime);
	assert.deepEqual(loaded.errors, []);
	const [renderer] = loaded.extensions[0].toolRenderers;
	const base = {
		renderCall: () => new tui.Text("FFF search", 0, 0),
		renderResult: (value) => new tui.Text(value.content[0].text, 0, 0),
	};
	const contextOutput = "src/file.ts\n 13- preceding context\n 14: needle\n 15- following context";
	const found = result(contextOutput + '\n\n[Continue with cursor="fff_c1"]', { details: { totalMatched: 1 } });
	const cases = [
		["ffgrep", found, "1 处匹配 · 可翻页"],
		["ffgrep", result("No matches found\n\n[Invalid regex: bad bracket, used literal match]", { details: { totalMatched: 0 } }), "无匹配 · 正则回退"],
		["fffind", result("No files found matching pattern"), "无结果"],
		["fffind", result('src/file.ts\n\n[2 more matches available. cursor="1" to continue]', { details: { totalMatched: 3 } }), "3 个文件 · 可翻页"],
		["grep", result(contextOutput, { details: { totalMatched: 1 } }), "1 处匹配"],
	];
	for (const [name, value, summary] of cases) {
		const args = { pattern: "needle", path: "src" };
		const row = toolRow(name, args, { definition: renderer(name, () => base) });
		row.updateResult(value);
		assert.deepEqual(plain(row.render(100)), [`● ${name.padEnd(8)}  "needle"  src  · ${summary}`]);
		assert.ok(!row.render(100).some((line) => line.includes(theme.getBgAnsi("toolSuccessBg"))));
		row.setExpanded(true);
		const reference = toolRow(name, args, { definition: base });
		reference.updateResult(value);
		reference.setExpanded(true);
		assert.deepEqual(row.render(100), reference.render(100));
	}

	const error = toolRow("ffgrep", { pattern: "needle" }, { definition: renderer("ffgrep", () => base) });
	error.updateResult(result("无法访问指定路径", { isError: true }));
	assert.match(plain(error.render(80))[1], /无法访问指定路径/);
	source = "npm:some-other-search-package";
	assert.equal(renderer("ffgrep", () => base), base);
	assert.equal(renderer("find", () => base), base);
});

test("pi-web-access and builtin tool_search use transparent compact rows while preserving curator hints and expanded views", async () => {
	const { createExtensionRuntime, loadExtensions } = await importPi("core/extensions/loader.js");
	const runtime = createExtensionRuntime();
	let webSource = "npm:pi-web-access@0.48.0";
	runtime.getAllTools = () => [
		{ name: "web_search", sourceInfo: { source: webSource } },
		{ name: "fetch_content", sourceInfo: { source: webSource } },
		{ name: "get_search_content", sourceInfo: { source: webSource } },
		{ name: "source_check", sourceInfo: { source: webSource } },
		{ name: "tool_search", sourceInfo: { path: "builtin:tool-search" } },
	];
	const loaded = await loadExtensions([join(packageDir, "index.ts")], paths.cwd, undefined, runtime);
	assert.deepEqual(loaded.errors, []);
	const [renderer] = loaded.extensions[0].toolRenderers;
	const base = {
		renderCall: () => new tui.Text("WEB CALL", 0, 0),
		renderResult: (value) => new tui.Text(value.content[0].text, 0, 0),
	};

	const ws = toolRow("web_search", { queries: ["Pi themes", "Pi TUI", "Pi extensions"] }, { definition: renderer("web_search", () => base) });
	ws.markExecutionStarted();
	ws.updateResult(result("waiting", { details: { phase: "curating", curatorUrl: "http://127.0.0.1:4321", shortcut: "ctrl+shift+w" } }), true);
	const curating = plain(ws.render(100));
	assert.match(curating[0], /^· web       "Pi themes" \+2  · 等待确认/);
	assert.match(curating[1], /http:\/\/127\.0\.0\.1:4321.*ctrl\+shift\+w 重开/);

	const wsDone = result("Full web search results", { details: { queryCount: 3, successfulQueries: 3, totalResults: 14, summary: { text: "ok" } }, durationMs: 1800 });
	ws.updateResult(wsDone);
	assert.deepEqual(plain(ws.render(100)), ['● web       "Pi themes" +2  · 3/3 组 · 14 来源 · 已摘要 · 1.8s']);
	assert.ok(!ws.render(100).some((line) => line.includes(theme.getBgAnsi("toolSuccessBg"))));
	ws.setExpanded(true);
	const wsRef = toolRow("web_search", { queries: ["Pi themes", "Pi TUI", "Pi extensions"] }, { definition: base });
	wsRef.updateResult(wsDone);
	wsRef.setExpanded(true);
	assert.deepEqual(ws.render(100), wsRef.render(100));

	const fetchRow = toolRow("fetch_content", { url: "https://www.github.com/earendil-works/pi" }, { definition: renderer("fetch_content", () => base) });
	fetchRow.updateResult(result("page", { details: { urlCount: 1, totalChars: 12400, imageCount: 2, truncated: true }, durationMs: 900 }));
	assert.deepEqual(plain(fetchRow.render(100)), ["● fetch     github.com/earendil-works/pi  · 12.4k 字 · 2 图 · 截断 · 900ms"]);

	const getRow = toolRow("get_search_content", { responseId: "abc123456", findText: "renderShell" }, { definition: renderer("get_search_content", () => base) });
	getRow.updateResult(result("matched", { details: { matchCount: 4, returnedMatches: 4 } }));
	assert.deepEqual(plain(getRow.render(100)), ['● web_read  "renderShell"  · 4 处匹配']);

	// source_check and tool_search do not supply custom renderCall/renderResult on base
	const toolSearchRow = toolRow("tool_search", { query: "calendar" }, { definition: renderer("tool_search", () => ({ name: "tool_search" })) });
	toolSearchRow.updateResult(result("Loaded 2 tools", { details: { loaded: ["gcal_list", "gcal_create"] }, durationMs: 3 }));
	assert.deepEqual(plain(toolSearchRow.render(100)), ['● tools     "calendar"  · 加载 2 个工具 · 3ms']);
	toolSearchRow.setExpanded(true);
	assert.match(plain(toolSearchRow.render(100)).join("\n"), /Loaded 2 tools/);

	const sourceCheckRow = toolRow("source_check", { claim: "Pi uses OKHSL" }, { definition: renderer("source_check", () => ({ name: "source_check" })) });
	sourceCheckRow.updateResult(result("Evidence passage"));
	assert.deepEqual(plain(sourceCheckRow.render(100)), ['● verify    "Pi uses OKHSL"  · 已核查']);

	webSource = "npm:other-web-package";
	assert.equal(renderer("web_search", () => base), base);
});

test("animates waiting and running rows with breathing dot, live elapsed time, and clean stop", async () => {
	const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
	const frames = [];
	const rawLines = [];
	let renders = 0;
	let row;
	const ui = {
		requestRender() {
			renders++;
			const lines = row.render(90);
			rawLines.push(lines[1]);
			frames.push(plain(lines)[0]);
		},
	};
	row = toolRow("bash", { command: "sleep 1" }, { ui, id: "anim-bash" });
	const initial = row.render(90);
	frames.push(plain(initial)[0]);
	rawLines.push(initial[1]);
	assert.equal(frames[0], "· bash      sleep 1  · 等待结果");

	// Waiting uses gentle 200ms breathing dots (· -> • -> ● -> •) without width jitter
	await sleep(680);
	assert.ok(renders >= 3, `expected >= 3 animation ticks, got ${renders}`);
	assert.ok(frames.some((line) => line.startsWith("• bash")), frames.join("\n"));
	assert.ok(frames.some((line) => line.startsWith("● bash")), frames.join("\n"));
	const widths = new Set(rawLines.map((line) => tui.visibleWidth(line)));
	assert.equal(widths.size, 1, "waiting animation must not shift line width");

	// Verify live elapsed seconds appear after 1s while waiting, then reset and keep unified pulse dots in accent color across waiting & running
	const realNow = Date.now;
	let offset = 1500;
	Date.now = () => realNow() + offset;
	try {
		row.invalidate();
		const waitingRaw = row.render(90)[1];
		assert.match(plain([waitingRaw])[0], /等待结果 · 2s$/);
		assert.ok(waitingRaw.includes(theme.fg("accent", "等待结果")), "waiting state should use unified accent color");
		row.markExecutionStarted();
		const runningRaw = row.render(90)[1];
		const runningLine = plain([runningRaw])[0];
		assert.match(runningLine, /^[·•●] bash/);
		assert.match(runningLine, /运行中$/);
		assert.ok(runningRaw.includes(theme.fg("accent", "运行中")), "running state should keep unified accent color");
		offset += 3100;
		row.updateResult(result("仍在运行"), true);
		const liveRaw = row.render(90);
		const live = plain(liveRaw);
		assert.match(live[0], /运行中 · 1 行 · 3s$/);
		assert.ok(liveRaw[1].includes(theme.fg("accent", "运行中")), "partial result running state should keep unified accent color");
		assert.equal(live[1], "└─ 仍在运行");
	} finally {
		Date.now = realNow;
	}

	// Expanding pauses our collapsed animation ticks; collapsing resumes them
	row.setExpanded(true);
	const rendersWhileExpanded = renders;
	await sleep(300);
	assert.equal(renders, rendersWhileExpanded, "collapsed animation must pause while expanded");
	row.setExpanded(false);
	row.render(90);
	await sleep(300);
	assert.ok(renders > rendersWhileExpanded, "collapsed animation must resume after collapsing partial row");

	// Settling stops the animation completely
	row.updateResult(result("完成输出", { durationMs: 420 }));
	assert.deepEqual(plain(row.render(90)), ["● bash      sleep 1  · 1 行 · 420ms"]);
	const rendersAfterSettle = renders;
	await sleep(300);
	assert.equal(renders, rendersAfterSettle, "animation must stop after settling");

	// Detached/unrendered rows automatically stop ticking instead of leaking intervals
	let detachedTicks = 0;
	const detached = toolRow("read", { path: "中文-一.txt" }, { ui: { requestRender() { detachedTicks++; } }, id: "anim-detached" });
	detached.render(90);
	await sleep(700);
	const afterAutoStop = detachedTicks;
	assert.ok(afterAutoStop >= 1 && afterAutoStop <= 3, `expected auto-stop within 2-3 ticks, got ${afterAutoStop}`);
	await sleep(300);
	assert.equal(detachedTicks, afterAutoStop, "unrendered row must stop ticking automatically");
});

test("keeps the tool name, error color and real failure at narrow Unicode widths", () => {
	const row = toolRow("powershell", { command: "Write-Output " + "宽路径 👩‍💻 é ".repeat(500) });
	row.updateResult(result("\x1b[32m缺失文件或权限失败\x1b[0m\nstack trace", { isError: true }));
	const full = row.render(120).join("\n");
	assert.ok(full.includes(theme.fg("error", "●")), "error row should show red dot");
	assert.ok(full.includes(theme.fg("error", "缺失文件或权限失败 …")));
	assert.ok(!full.includes("\x1b[32m"), "foreign ANSI formatting reached the compact view");
	for (const width of [14, 21, 38, 70]) {
		const lines = row.render(width);
		assert.equal(plain(lines).length, 2);
		assert.match(plain(lines)[0], /^● pwsh/);
		assert.match(plain(lines)[1], /缺失/);
		assert.ok(lines.every((line) => tui.visibleWidth(line) <= width));
	}
});

test("retains the native truncation notice when a read has no preview content", async () => {
	const path = join(paths.cwd, "long-line.txt");
	await writeFile(path, "x".repeat(55 * 1024));
	const outcome = await session.getToolDefinition("read").execute("long-line", { path }, undefined, undefined,
		session.extensionRunner.createToolContext("long-line"));
	assert.equal(outcome.details.truncation.firstLineExceedsLimit, true);
	const row = toolRow("read", { path });
	row.updateResult(outcome);
	assert.match(plain(row.render(90))[1], /Line 1 is .*截断/);
	row.setExpanded(true);
	assert.match(plain(row.render(90)).join("\n"), /First line exceeds/);
});

test("keeps a full-output link, truncation and shell failures across current and saved results", () => {
	const caps = tui.getCapabilities();
	tui.setCapabilities({ ...caps, hyperlinks: true });
	try {
		const fullOutputPath = join(paths.cwd, "完整输出.log");
		const row = toolRow("bash", { command: "fixture command" });
		row.updateResult(result("line one\n\n最新输出", { details: { truncation: { truncated: true }, fullOutputPath } }), true);
		const url = pathToFileURL(fullOutputPath).href;
		for (const width of [36, 100]) {
			const line = row.render(width).find((line) => line.includes("最新输出"));
			assert.match(tui.stripTerminalSequences(line), /截断/);
			assert.ok(line.includes(url));
			assert.ok(tui.visibleWidth(line) <= width);
		}
		row.updateResult(result("原始错误\n\n[Showing lines 2-10 of 10. Full output: " + fullOutputPath + "]\n\nCommand exited with code 7", { isError: true }));
		const raw = row.render(170).join("\n");
		assert.ok(raw.includes(url));
		assert.match(tui.stripTerminalSequences(raw), /exit 7/);
		assert.match(tui.stripTerminalSequences(raw), /Command exited with code 7 · 原始错误.*截断/);
		row.updateResult(result("tail output", { details: { fullOutputError: "Access denied" } }));
		assert.match(plain(row.render(100))[1], /保存失败 Access denied/);
	} finally { tui.setCapabilities(caps); }
});

test("the actual truncated Bash output file is available from the compact view", async (t) => {
	const ctx = session.extensionRunner.createToolContext("long-output");
	const command = "printf 'head of fixture\\n'; for i in {1..2010}; do printf 'output-%04d\\n' \"$i\"; done";
	const outcome = await session.getToolDefinition("bash").execute("long-output", { command }, undefined, undefined, ctx);
	const fullOutputPath = outcome.details?.fullOutputPath;
	assert.ok(fullOutputPath);
	t.after(() => rm(fullOutputPath, { force: true }));
	const full = await readFile(fullOutputPath, "utf8");
	assert.match(full, /^head of fixture/);
	assert.match(full, /output-2010/);
	const caps = tui.getCapabilities();
	tui.setCapabilities({ ...caps, hyperlinks: true });
	try {
		const row = toolRow("bash", { command });
		row.updateResult(outcome);
		const line = row.render(110).find((line) => line.includes("output-2010"));
		assert.ok(line.includes(pathToFileURL(fullOutputPath).href));
		assert.match(tui.stripTerminalSequences(line), /截断 · 全文/);
	} finally { tui.setCapabilities(caps); }
});

test("expanded frames match Pi's native result and call pixel-for-pixel while surviving repeated toggles", () => {
	const cases = {
		read: [{ path: "code.txt", offset: 3, limit: 20 }, result("中文完整内容\nlast line")],
		bash: [{ command: "echo test\nprintf test" }, result("line 1\nline 2", { durationMs: 450 })],
		powershell: [{ command: "Write-Output test" }, result("first\nlast", { durationMs: 450 })],
		edit: [{ path: "中文-一.txt", edits: [{ oldText: "old", newText: "new" }] }, result("Successfully replaced 1 block", { details: { diff: "- 1 old\n+ 1 new", firstChangedLine: 1 } })],
		write: [{ path: "code.txt", content: Array.from({ length: 22 }, (_, i) => "Line " + i).join("\n") }, result("Successfully wrote")],
		grep: [{ path: ".", pattern: "target" }, result("file.txt:2:target\nfile.txt:9:target")],
		find: [{ path: ".", pattern: "*.txt" }, result("code.txt\n中文-一.txt")],
		ls: [{ path: "." }, result("code.txt\n中文-一.txt")],
	};
	for (const [name, [args, outcome]] of Object.entries(cases)) {
		const base = toolRow(name, args, { definition: native(name) });
		const row = toolRow(name, args);
		for (const component of [base, row]) component.updateResult(outcome);
		base.setExpanded(true);
		for (let i = 0; i < 3; i++) {
			assert.equal(plain(row.render(92)).length, 1, name + " collapsed should be 1 crisp line");
			row.setExpanded(true);
			assert.deepEqual(row.render(92), base.render(92), name + " expanded must match native Pi");
			row.setExpanded(false);
		}
	}
});

test("codemode collapses clean runs to one breakdown line and surfaces nested or script failures on a branch line", () => {
	const args = { code: Array.from({ length: 20 }, (_, i) => `text("SCRIPT-${i}");`).join("\n") };
	const row = toolRow("codemode", args);
	const cleanOutcome = {
		content: [
			{ type: "text", text: "Script completed\nWall time 0.1 seconds\nOutput:\n" },
			{ type: "text", text: "ok" },
		],
		details: {
			calls: [
				{ name: "read", args: "{}", status: "ok" },
				{ name: "read", args: "{}", status: "ok" },
				{ name: "ls", args: "{}", status: "ok" },
				{ name: "bash", args: "{}", status: "ok" },
			],
		},
		durationMs: 140,
	};
	row.markExecutionStarted();
	row.updateResult({ content: [], details: { calls: [{ name: "read", args: "{}", status: "running" }] } }, true);
	assert.deepEqual(plain(row.render(80)), ["· codemode  read  · 1 次 · 正在执行 read"]);

	row.updateResult({ content: [], details: { calls: [{ name: "read", args: '{"path":"src/app.ts"}', status: "running" }] } }, true);
	assert.deepEqual(plain(row.render(80)), ["· codemode  read  · 1 次 · 正在执行 read", "└─ read  src/app.ts"]);

	row.updateResult(cleanOutcome);
	assert.deepEqual(plain(row.render(80)), ["● codemode  read×2, ls, bash  · 4 次 · 140ms"]);

	const errorOutcome = {
		content: [
			{ type: "text", text: "Script completed\nWall time 0.2 seconds\nOutput:\n" },
			{ type: "text", text: "SCRIPT-OUTPUT\n".repeat(20) },
		],
		details: { calls: [{ name: "read", args: '{"path":"missing.txt"}', status: "error", error: "ENOENT: missing.txt" }] },
		durationMs: 200,
	};
	row.setExpanded(true);
	row.setExpanded(false);
	row.updateResult(errorOutcome);
	const compactErr = ["● codemode  read  · 1 次 · 1 失败 · 200ms", "└─ read ENOENT: missing.txt"];
	assert.deepEqual(plain(row.render(80)), compactErr);
	assert.ok(row.render(80)[1].includes(theme.fg("error", "●")), "nested codemode error should show red dot");
	assert.equal(plain(row.render(14)).length, 2);
	assert.ok(row.render(14).every((line) => tui.visibleWidth(line) <= 14));

	row.setExpanded(true);
	const reference = toolRow("codemode", args, { definition: native("codemode") });
	reference.updateResult(errorOutcome);
	reference.setExpanded(true);
	assert.deepEqual(row.render(80), reference.render(80));
	assert.match(plain(row.render(80)).join("\n"), /SCRIPT-19[\s\S]*missing.txt[\s\S]*SCRIPT-OUTPUT/);
	row.setExpanded(false);
	assert.deepEqual(plain(row.render(80)), compactErr);

	row.updateResult({ ...errorOutcome, isError: true, details: { calls: [] }, content: [{ type: "text", text: "Earlier output" },
		{ type: "text", text: "Script error:\nTypeError: missing value\nstack trace" }] });
	assert.deepEqual(plain(row.render(80)), ["● codemode  脚本  · 脚本失败 · 200ms", "└─ TypeError: missing value"]);
	assert.ok(row.render(80)[1].includes(theme.fg("error", "●")), "script failure should show red dot");
});

test("Pi keeps the image renderer and model-compatibility notice", () => {
	const caps = tui.getCapabilities();
	tui.setCapabilities({ ...caps, images: "kitty" });
	try {
		const row = toolRow("read", { path: "probe.png" }, { showImages: true });
		const outcome = result("Read image file [image/png]", {
			content: [{ type: "image", mimeType: "image/png", data: png }],
			details: { imageUnsupportedByModel: "fixture text-only model" },
		});
		row.updateResult(outcome);
		assert.match(plain(row.render(100))[0], /图片 image\/png/);
		assert.match(plain(row.render(100))[1], /模型不支持图片/);
		assert.ok(row.render(100).some((line) => line.includes("\x1b_G")));
		row.setExpanded(true);
		assert.ok(row.render(100).some((line) => line.includes("\x1b_G")));
		assert.match(plain(row.render(100)).join("\n"), /fixture text-only model does not support images/);
	} finally { tui.setCapabilities(caps); }
});

test("native fullscreen hit testing opens adjacent calls independently and follows later updates per Pi", (t) => {
	const terminal = { columns: 90, rows: 24, isTTY: true, write() {}, onData: () => () => {}, setRawMode() {},
		getColorMode: () => "truecolor", start() {}, stop() {}, showCursor() {}, hideCursor() {} };
	const renderer = createInteractiveTui({ tuiMode: "fullscreen", showHardwareCursor: false, terminal, logDirectory: paths.cwd });
	renderer.altScreenActive = true;
	renderer.requestRender = () => { renderer.contentChanged = true; };
	t.after(() => renderer.stop());
	const doc = new tui.Container();
	doc.addChild(new tui.Text(Array.from({ length: 40 }, (_, i) => "earlier transcript " + i).join("\n"), 0, 0));
	const a = toolRow("read", { path: "相邻-一.txt" }, { ui: renderer, id: "a" });
	const b = toolRow("read", { path: "相邻-二.txt" }, { ui: renderer, id: "b" });
	const c = toolRow("bash", { command: "fixture live command" }, { ui: renderer, id: "c" });
	a.updateResult(result("first A\nfull-result-A"));
	b.updateResult(result("first B\nfull-result-B"));
	c.markExecutionStarted();
	c.updateResult(result("流式第一行"), true);
	for (const row of [a, b, c]) doc.addChild(row);
	const view = createChatViewport({ document: doc, pendingMessages: new tui.Container(), status: new tui.Container(),
		editor: new tui.Text("editor", 0, 0), footer: new tui.Container(), scrollbar: "always" });
	renderer.setLayoutRoot(view.root);
	const frame = () => {
		renderer.contentChanged = true;
		renderer.doRender();
		return renderer.getScreenLines().map(tui.stripTerminalSequences);
	};
	const click = (label) => {
		const lines = frame();
		const y = lines.findIndex((line) => line.includes(label)) + 1;
		assert.ok(y, label + " missing\n" + lines.join("\n"));
		renderer.handleViewportInput("\x1b[<0;3;" + y + "M");
		renderer.handleViewportInput("\x1b[<0;3;" + y + "m");
		return frame().join("\n");
	};
	assert.match(click("相邻-一.txt"), /full-result-A/);
	assert.equal(a.expanded, true);
	assert.equal(b.expanded, false);
	assert.match(click("相邻-二.txt"), /full-result-B/);
	assert.equal(b.expanded, true);
	click("相邻-二.txt");
	assert.equal(b.expanded, false);
	assert.match(click("fixture live command"), /流式第一行/);
	assert.equal(c.expanded, true);
	c.updateResult(result("流式第一行\n流式第二行"), true);
	assert.match(frame().join("\n"), /流式第二行/);
	click("fixture live command");
	assert.equal(c.expanded, false);
	c.updateResult(result("流式第一行\n流式最终输出", { durationMs: 320 }));
	assert.match(frame().join("\n"), /● bash      fixture live command  · 2 行 · 320ms/);
	assert.equal(c.expanded, false);

	renderer.handleViewportInput("\x1b[1;5H");
	frame();
	assert.equal(view.transcript.isFollowingEnd, false);
	for (let i = 0; i < 24; i++) doc.addChild(new tui.Text("later output " + i, 0, 0));
	assert.match(frame().join("\n"), /earlier transcript 0/);
	renderer.handleViewportInput("\x1b[1;5F");
	assert.match(frame().join("\n"), /later output 23/);
	assert.equal(view.transcript.isFollowingEnd, true);
});

test("priority-based metric trimming preserves critical errors, truncation, and diff stats on narrow widths", async () => {
	const editRow = toolRow("edit", {
		path: "src/components/editor-panel.ts",
		edits: [{ oldText: "a", newText: "b" }, { oldText: "c", newText: "d" }, { oldText: "e", newText: "f" }],
	});
	editRow.updateResult(result("ok", {
		details: { diff: "+ 1 a\n+ 2 b\n+ 3 c\n- 1 x\n- 2 y" },
		durationMs: 18,
	}));
	assert.deepEqual(plain(editRow.render(100)), ["● edit      src/components/editor-panel.ts  · +3 · −2 · 3 处 · 18ms"]);
	const narrowEdit = editRow.render(38);
	const narrowEditPlain = plain(narrowEdit)[0];
	assert.match(narrowEditPlain, /\+3 · −2/);
	assert.ok(!narrowEditPlain.includes("18ms"), "duration should drop before diff counts on narrow width");
	assert.ok(narrowEdit.every((line) => tui.visibleWidth(line) <= 38));

	const bashRow = toolRow("bash", { command: "npm --prefix pi-tool-ui test" });
	bashRow.updateResult(result("boom\n\nCommand exited with code 7", { isError: true, durationMs: 12400 }));
	const narrowBash = bashRow.render(32);
	assert.match(plain(narrowBash)[0], /exit 7/);
	assert.ok(!plain(narrowBash)[0].includes("12.4s"), "duration should drop before exit code on narrow width");
	assert.ok(narrowBash.every((line) => tui.visibleWidth(line) <= 32));

	const { createExtensionRuntime, loadExtensions } = await importPi("core/extensions/loader.js");
	const runtime = createExtensionRuntime();
	runtime.getAllTools = () => [{ name: "ffgrep", sourceInfo: { source: "npm:@ff-labs/pi-fff@0.11.0" } }];
	const loaded = await loadExtensions([join(packageDir, "index.ts")], paths.cwd, undefined, runtime);
	const [renderer] = loaded.extensions[0].toolRenderers;
	const base = {
		renderCall: () => new tui.Text("FFF", 0, 0),
		renderResult: (value) => new tui.Text(value.content[0].text, 0, 0),
	};
	const fffRow = toolRow("ffgrep", { pattern: "needle", path: "src/components", cursor: "c2" }, { definition: renderer("ffgrep", () => base) });
	fffRow.updateResult(result('[0 exact matches. Maybe you meant this?]\nsrc/a.ts:1:needl\n\n[Continue with cursor="c3"]', {
		details: { totalMatched: 12, truncated: true },
		durationMs: 125,
	}));
	assert.match(plain(fffRow.render(120))[0], /12 处匹配 · 续页 · 近似匹配 · 可翻页 · 截断 · 125ms/);
	const narrowFff = fffRow.render(50);
	const narrowFffPlain = plain(narrowFff)[0];
	assert.match(narrowFffPlain, /近似匹配/);
	assert.match(narrowFffPlain, /截断/);
	assert.ok(!narrowFffPlain.includes("125ms"), "duration should drop before warning badges");
	assert.ok(narrowFff.every((line) => tui.visibleWidth(line) <= 50));
});

test("HTML export expanded rendering retains write file content and codemode script source", async () => {
	const { createToolHtmlRenderer } = await importPi("core/export-html/tool-renderer.js");
	const htmlRenderer = createToolHtmlRenderer({
		getToolRenderers: (name) => decorate(name),
		theme,
		cwd: paths.cwd,
		width: 100,
	});

	const writeArgs = {
		path: "exported.txt",
		content: Array.from({ length: 20 }, (_, i) => `EXPORTED-LINE-${i}`).join("\n"),
	};
	htmlRenderer.renderCall("write-export", "write", writeArgs);
	const writeHtml = htmlRenderer.renderResult("write-export", "write", [{ type: "text", text: "Successfully wrote" }], undefined, false);
	assert.ok(writeHtml?.expanded, "write HTML export should produce expanded output");
	assert.match(writeHtml.expanded, /EXPORTED-LINE-19/, "write HTML export expanded view must include full written file content");
	assert.ok(writeHtml.collapsed && writeHtml.collapsed !== writeHtml.expanded, "write HTML export should preserve collapsed summary");

	const codemodeArgs = {
		code: Array.from({ length: 16 }, (_, i) => `text("EXPORT-SCRIPT-${i}");`).join("\n"),
	};
	htmlRenderer.renderCall("cm-export", "codemode", codemodeArgs);
	const cmHtml = htmlRenderer.renderResult(
		"cm-export",
		"codemode",
		[
			{ type: "text", text: "Script completed\nWall time 0.1 seconds\nOutput:\n" },
			{ type: "text", text: "EXPORT-OUTPUT" },
		],
		{ calls: [{ name: "read", args: '{"path":"a.txt"}', status: "ok" }] },
		false,
	);
	assert.ok(cmHtml?.expanded, "codemode HTML export should produce expanded output");
	assert.match(cmHtml.expanded, /EXPORT-SCRIPT-15/, "codemode HTML export expanded view must include full script source");
	assert.match(cmHtml.expanded, /EXPORT-OUTPUT/);
});

test("surfaces partial failures, curator-fallback details, codemode cost/images/cancelled, and fallback error color", async () => {
	const { createExtensionRuntime, loadExtensions } = await importPi("core/extensions/loader.js");
	const runtime = createExtensionRuntime();
	runtime.getAllTools = () => [
		{ name: "web_search", sourceInfo: { source: "npm:pi-web-access@0.48.0" } },
		{ name: "fetch_content", sourceInfo: { source: "npm:pi-web-access@0.48.0" } },
		{ name: "get_search_content", sourceInfo: { source: "npm:pi-web-access@0.48.0" } },
		{ name: "tool_search", sourceInfo: { path: "builtin:tool-search" } },
	];
	const loaded = await loadExtensions([join(packageDir, "index.ts")], paths.cwd, undefined, runtime);
	const [renderer] = loaded.extensions[0].toolRenderers;
	const base = {
		renderCall: () => new tui.Text("WEB", 0, 0),
		renderResult: (value) => new tui.Text(value.content[0].text, 0, 0),
	};

	// fetch_content all-failed (0/3) -> red dot, partial (1/3) -> warning dot
	const fetchAllFail = toolRow("fetch_content", { urls: ["https://a.test", "https://b.test", "https://c.test"] }, { definition: renderer("fetch_content", () => base) });
	fetchAllFail.updateResult(result("failed", { details: { urlCount: 3, successful: 0 } }));
	const fetchAllFailRaw = fetchAllFail.render(100).join("\n");
	assert.match(plain(fetchAllFail.render(100))[0], /^● fetch     .* 0\/3 页$/);
	assert.ok(fetchAllFailRaw.includes(theme.fg("error", "●")));
	assert.ok(fetchAllFailRaw.includes(theme.fg("error", "0/3 页")));

	const fetchPartial = toolRow("fetch_content", { urls: ["https://a.test", "https://b.test", "https://c.test"] }, { definition: renderer("fetch_content", () => base) });
	fetchPartial.updateResult(result("partial", { details: { urlCount: 3, successful: 1 } }));
	const fetchPartialRaw = fetchPartial.render(100).join("\n");
	assert.match(plain(fetchPartial.render(100))[0], /^● fetch     .* 1\/3 页$/);
	assert.ok(fetchPartialRaw.includes(theme.fg("warning", "●")));
	assert.ok(fetchPartialRaw.includes(theme.fg("warning", "1/3 页")));

	// web_search partial failure + curator-fallback details
	const wsPartial = toolRow("web_search", { queries: ["q1", "q2", "q3"] }, { definition: renderer("web_search", () => base) });
	wsPartial.markExecutionStarted();
	wsPartial.updateResult(result("fallback", {
		details: {
			phase: "curator-fallback",
			curatorUrl: "http://127.0.0.1:4321",
			browserOpenError: "xdg-open failed",
			timeoutSeconds: 30,
		},
	}), true);
	const fallbackLines = plain(wsPartial.render(110));
	assert.match(fallbackLines[0], /等待确认/);
	assert.match(fallbackLines[1], /http:\/\/127\.0\.0\.1:4321 \(xdg-open failed\).*30s 后自动提交/);

	wsPartial.updateResult(result("done", { details: { queryCount: 3, successfulQueries: 1, totalResults: 4 } }));
	const wsPartialRaw = wsPartial.render(100).join("\n");
	assert.match(plain(wsPartial.render(100))[0], /^● web       .* 1\/3 组 · 4 来源$/);
	assert.ok(wsPartialRaw.includes(theme.fg("warning", "●")));
	assert.ok(wsPartialRaw.includes(theme.fg("warning", "1/3 组")));

	// codemode: error + cancelled coexist, cost & image count, leading blank line in script error
	const cm = toolRow("codemode", { code: "tools.read({});" });
	cm.updateResult({
		content: [
			{ type: "text", text: "Script completed\nWall time 0.4 seconds\nOutput:\n" },
			{ type: "image", mimeType: "image/png", data: png },
		],
		details: {
			calls: [
				{ name: "models.call", args: "{}", status: "ok", cost: 0.025 },
				{ name: "read", args: "{}", status: "error", error: "ENOENT" },
				{ name: "bash", args: "{}", status: "cancelled" },
				{ name: "ls", args: "{}", status: "cancelled" },
			],
		},
		durationMs: 400,
	});
	const cmLine = plain(cm.render(120))[0];
	assert.match(cmLine, /4 次 · 1 失败 · 2 取消 · 1 图 · \$0\.03 · 400ms/);

	cm.updateResult({
		isError: true,
		content: [{ type: "text", text: "\n\nReferenceError: boom\nstack" }],
		details: { calls: [] },
	});
	assert.match(plain(cm.render(100))[1], /ReferenceError: boom/);

	// fallbackResultComponent uses error color and strips foreign ANSI
	const tsErr = toolRow("tool_search", { query: "bad" }, { definition: renderer("tool_search", () => ({ name: "tool_search" })) });
	tsErr.updateResult(result("\x1b[32mTool search failed\x1b[0m", { isError: true }));
	tsErr.setExpanded(true);
	const tsErrRaw = tsErr.render(100).join("\n");
	assert.ok(tsErrRaw.includes(theme.fg("error", "Tool search failed")));
	assert.ok(!tsErrRaw.includes("\x1b[32m"));
});

test("preserves critical call arguments, bash error command fallback, SKILL.md badges, and explicit limit counts", async () => {
	// bash switches from displaySummary to raw command when execution fails
	const bashFail = toolRow("bash", { command: "npm --prefix pi-tool-ui test", displaySummary: "运行测试套件" });
	bashFail.updateResult(result("AssertionError\n\nCommand exited with code 1", { isError: true }));
	assert.match(plain(bashFail.render(100))[0], /^● bash      npm --prefix pi-tool-ui test  · exit 1$/);
	assert.ok(bashFail.render(100)[1].includes(theme.fg("error", "●")));

	// read SKILL.md renders [skill] badge with clickable file link
	const caps = tui.getCapabilities();
	tui.setCapabilities({ ...caps, hyperlinks: true });
	try {
		const skillPath = join(paths.cwd, "skills", "orca-cli", "SKILL.md");
		const skillRow = toolRow("read", { path: skillPath, offset: 1, limit: 40 });
		skillRow.updateResult(result("a\nb"));
		const skillRaw = skillRow.render(100)[1];
		assert.deepEqual(plain([skillRaw]), ["● read      [skill] orca-cli:1-40  · 2 行"]);
		assert.ok(skillRaw.includes(pathToFileURL(skillPath).href), "SKILL.md badge must link to the original file");
	} finally {
		tui.setCapabilities(caps);
	}

	// grep glob + explicit matchLimitReached / resultLimitReached / entryLimitReached
	const grepRow = toolRow("grep", { pattern: "foo", path: "src", glob: "*.ts" });
	grepRow.updateResult(result("src/a.ts:1:foo", { details: { matchLimitReached: 100 } }));
	assert.deepEqual(plain(grepRow.render(100)), ['● grep      "foo"  src (*.ts)  · 1 处匹配 · 上限 100']);

	const findRow = toolRow("find", { pattern: "*.ts", path: "." });
	findRow.updateResult(result("a.ts", { details: { resultLimitReached: 200 } }));
	assert.deepEqual(plain(findRow.render(100)), ['● find      "*.ts"  · 1 个文件 · 上限 200']);

	const lsRow = toolRow("ls", { path: "." });
	lsRow.updateResult(result("a.ts", { details: { entryLimitReached: 500 } }));
	assert.deepEqual(plain(lsRow.render(100)), ["● ls        .  · 1 项 · 上限 500"]);

	// get_search_content offset
	const { createExtensionRuntime, loadExtensions } = await importPi("core/extensions/loader.js");
	const runtime = createExtensionRuntime();
	runtime.getAllTools = () => [{ name: "get_search_content", sourceInfo: { source: "npm:pi-web-access@0.48.0" } }];
	const loaded = await loadExtensions([join(packageDir, "index.ts")], paths.cwd, undefined, runtime);
	const [renderer] = loaded.extensions[0].toolRenderers;
	const gscRow = toolRow("get_search_content", { url: "https://example.com/guide", offset: 4000 }, {
		definition: renderer("get_search_content", () => ({ name: "get_search_content" })),
	});
	gscRow.updateResult(result("chunk", { details: { contentLength: 2000 } }));
	assert.deepEqual(plain(gscRow.render(100)), ["● web_read  example.com/guide @4000  · 2.0k 字"]);

	// Invalid non-string arguments show [无效参数] in error color
	const badRead = toolRow("read", { path: 12345 });
	badRead.updateResult(result("invalid path", { isError: true }));
	assert.ok(badRead.render(100).join("\n").includes(theme.fg("error", "[无效参数]")));

	const badBash = toolRow("bash", { command: { bad: true } });
	badBash.updateResult(result("invalid command", { isError: true }));
	assert.ok(badBash.render(100).join("\n").includes(theme.fg("error", "[无效参数]")));
});

test("shows streaming argument progress, multi-line shell formatting, and Pi 1.7.0 codemode models.* recognition", () => {
	// write streaming args: live line count grows while !argsComplete, then switches to 等待结果 once complete
	const writeRow = toolRow("write", { path: "src/gen.ts", content: "line1\nline2" });
	assert.deepEqual(plain(writeRow.render(90)), ["· write     src/gen.ts  · 生成中 · 2 行"]);
	writeRow.updateArgs({ path: "src/gen.ts", content: "line1\nline2\nline3\nline4" });
	assert.deepEqual(plain(writeRow.render(90)), ["· write     src/gen.ts  · 生成中 · 4 行"]);
	writeRow.setArgsComplete();
	assert.deepEqual(plain(writeRow.render(90)), ["· write     src/gen.ts  · 等待结果"]);

	// edit streaming args: live block count while !argsComplete
	const editRow = toolRow("edit", { path: "src/app.ts", edits: [{ oldText: "a", newText: "b" }, { oldText: "c", newText: "d" }] });
	assert.deepEqual(plain(editRow.render(90)), ["· edit      src/app.ts  · 生成中 · 2 处"]);

	// codemode streaming args + Pi 1.7.0 models.generateImages() recognition
	const cmRow = toolRow("codemode", { code: "const imgs = await models.generateImages({ prompt: 'cat' });\nconsole.log(imgs.length);\nreturn imgs;" });
	assert.deepEqual(plain(cmRow.render(100)), ["· codemode  models.generateImages  · 生成中 · 3 行"]);

	// Multi-line shell command shows first line + (+N 行) instead of smearing commands together
	const multiBash = toolRow("bash", { command: "git status\nnpm test\ngit diff --stat" });
	multiBash.updateResult(result("clean", { durationMs: 40 }));
	assert.deepEqual(plain(multiBash.render(90)), ["● bash      git status (+2 行)  · 1 行 · 40ms"]);

	// Multi-line shell with displaySummary keeps summary on success, shows first line + (+N 行) on error
	const multiSummary = toolRow("bash", { command: "git status\nnpm test", displaySummary: "检查并测试" });
	multiSummary.updateResult(result("ok"));
	assert.deepEqual(plain(multiSummary.render(90)), ["● bash      检查并测试  · 1 行"]);
	multiSummary.updateResult(result("failed\n\nCommand exited with code 2", { isError: true }));
	assert.deepEqual(plain(multiSummary.render(90)), ["● bash      git status (+1 行)  · exit 2", "└─ Command exited with code 2 · failed"]);
});
