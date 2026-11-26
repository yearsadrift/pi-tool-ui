import assert from "node:assert/strict";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { after, test } from "node:test";
import { builtIns, createSession, importPi, loadHost, png, workspace } from "./pi-host.mjs";

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
	for (const name of builtIns) {
		const shell = name === "bash" || name === "powershell";
		const subject = shell ? "echo Chinese-output" : "中文-文件.txt";
		const args = shell ? { command: subject } : name === "write" ? { path: subject, content: "a\nb\nc" } : { path: subject };
		const row = toolRow(name, args);

		// Pending & running before result: 1 clean line (plus Pi's single leading blank separator)
		const pendingRaw = row.render(90);
		assert.equal(pendingRaw.length, 2, name + " pending total rows");
		assert.deepEqual(plain(pendingRaw), [`▏ ◐ ${name}  ${subject}  · 等待结果`]);

		row.markExecutionStarted();
		assert.deepEqual(plain(row.render(90)), [`▏ ◐ ${name}  ${subject}  · 运行中`]);

		// Streaming shell shows live output on 2nd branch line; other tools stay compact
		row.updateResult(result("测试实时输出"), true);
		if (shell) {
			assert.deepEqual(plain(row.render(90)), [`▏ ◐ ${name}  ${subject}  · 运行中`, "▏   └─ 测试实时输出"]);
		} else {
			assert.equal(plain(row.render(90)).length, 1, name + " partial");
		}

		// Finalized normal call: 1 compact transparent line (no toolSuccessBg slab, no top/bottom box padding)
		row.updateResult(result("测试最终输出", { durationMs: 42 }));
		const settledRaw = row.render(90);
		assert.equal(settledRaw.length, 2, name + " settled total rows (1 blank + 1 line)");
		assert.equal(plain(settledRaw).length, 1, name + " settled content lines");
		assert.match(plain(settledRaw)[0], new RegExp(`^▏ ✓ ${name}  `));
		assert.match(plain(settledRaw)[0], /42ms$/);
		if (bgToken) {
			assert.ok(!settledRaw.join("\n").includes(bgToken), name + " should not paint toolSuccessBg when collapsed");
		}
	}
});

test("per-tool smart metrics, colored diff stats, relative paths and tail-preserving path truncation", () => {
	// read with relative cwd shortening + line count + duration
	const readRow = toolRow("read", { path: join(paths.cwd, "sub", "中文.ts"), offset: 10, limit: 25 });
	readRow.updateResult(result("l1\nl2\nl3", { durationMs: 12 }));
	assert.deepEqual(plain(readRow.render(90)), ["▏ ✓ read  sub/中文.ts:10-34  · 3 行 · 12ms"]);

	// edit with colored +added / -removed diff counts
	const editRow = toolRow("edit", { path: join(paths.cwd, "src", "app.ts"), edits: [{ oldText: "a", newText: "b" }] });
	editRow.updateResult(result("ok", { details: { diff: "- 1 old1\n- 2 old2\n+ 1 new1\n+ 2 new2\n+ 3 new3" }, durationMs: 18 }));
	const editRaw = editRow.render(90).join("\n");
	assert.deepEqual(plain(editRow.render(90)), ["▏ ✓ edit  src/app.ts  · +3 · −2 · 18ms"]);
	assert.ok(editRaw.includes(theme.fg("toolDiffAdded", "+3")));
	assert.ok(editRaw.includes(theme.fg("toolDiffRemoved", "−2")));

	// write with line count and KB size
	const writeRow = toolRow("write", { path: "notes.md", content: "x".repeat(2048) + "\nsecond" });
	writeRow.updateResult(result("ok", { durationMs: 5 }));
	assert.deepEqual(plain(writeRow.render(90)), ["▏ ✓ write  notes.md  · 2 行 · 2.0 KB · 5ms"]);

	// grep / find / ls counts
	const grepRow = toolRow("grep", { path: "src", pattern: "renderShell" });
	grepRow.updateResult(result("a.ts:1:renderShell\nb.ts:4:renderShell"));
	assert.deepEqual(plain(grepRow.render(90)), ['▏ ✓ grep  "renderShell"  src  · 2 处匹配']);

	const findRow = toolRow("find", { path: ".", pattern: "*.ts" });
	findRow.updateResult(result("a.ts\nb.ts\nc.ts"));
	assert.deepEqual(plain(findRow.render(90)), ['▏ ✓ find  "*.ts"  · 3 个文件']);

	const lsRow = toolRow("ls", { path: "." });
	lsRow.updateResult(result("a.ts\nb.ts"));
	assert.deepEqual(plain(lsRow.render(90)), ["▏ ✓ ls  .  · 2 项"]);

	// Deep path preserves basename when truncated
	const deepPath = "very/deeply/nested/workspace/directory/structure/components/tool-execution.js";
	const deepRow = toolRow("read", { path: deepPath });
	deepRow.updateResult(result("line 1"));
	const narrow = plain(deepRow.render(48))[0];
	assert.match(narrow, /…\/.*tool-execution\.js/);
	assert.ok(tui.visibleWidth(deepRow.render(48)[1]) <= 48);
});

test("keeps the tool name, error color and real failure at narrow Unicode widths", () => {
	const row = toolRow("powershell", { command: "Write-Output " + "宽路径 👩‍💻 é ".repeat(500) });
	row.updateResult(result("\x1b[32m缺失文件或权限失败\x1b[0m\nstack trace", { isError: true }));
	const full = row.render(120).join("\n");
	assert.ok(full.includes(theme.fg("error", "缺失文件或权限失败 …")));
	assert.ok(!full.includes("\x1b[32m"), "foreign ANSI formatting reached the compact view");
	for (const width of [14, 21, 38, 70]) {
		const lines = row.render(width);
		assert.equal(plain(lines).length, 2);
		assert.match(plain(lines)[0], /× powershell/);
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
	assert.deepEqual(plain(row.render(80)), ["▏ ◐ codemode  read  · 1 次 · 正在执行 read"]);

	row.updateResult(cleanOutcome);
	assert.deepEqual(plain(row.render(80)), ["▏ ✓ codemode  read×2, ls, bash  · 4 次 · 140ms"]);

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
	const compactErr = ["▏ ! codemode  read  · 1 次 · 1 失败 · 200ms", "▏   └─ read ENOENT: missing.txt"];
	assert.deepEqual(plain(row.render(80)), compactErr);
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
	assert.deepEqual(plain(row.render(80)), ["▏ × codemode  脚本  · 脚本失败 · 200ms", "▏   └─ TypeError: missing value"]);
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
	assert.match(frame().join("\n"), /▏ ✓ bash  fixture live command  · 2 行 · 320ms/);
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
