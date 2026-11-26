import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { after, test } from "node:test";
import { builtIns, createSession, loadHost, workspace } from "./pi-host.mjs";

const paths = await workspace();
after(() => rm(paths.cwd, { recursive: true, force: true }));
const { api, tui, withBuiltInRenderers } = await loadHost(paths.agentDir);
const resolve = (session, name) =>
	session.extensionRunner.resolveToolRenderers(name, () => withBuiltInRenderers(name, session.getToolDefinition(name)));

async function checkContract(session) {
	await session.bindExtensions({ mode: "print" });
	await session.prompt("contract");
	const result = session.messages.find((message) => message.role === "toolResult" && message.toolName === "codemode");
	assert.ok(result, JSON.stringify(session.messages.at(-1)));
	const output = result.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
	assert.equal(result.isError, false, output);
	const json = output.split("\n").find((line) => line.startsWith('{"kind":'));
	assert.ok(json, output);
	assert.deepEqual(JSON.parse(json), {
		kind: "object",
		output: session.sessionManager.getSessionId(),
		exit_code: 0,
		failed: 7,
		image: "image",
		mimeType: "image/png",
	});
	const image = result.content.find((block) => block.type === "image");
	assert.equal(image?.mimeType, "image/png");
	assert.ok(image.data.length > 0);
	return image.data;
}

test("manifests load without registering tools and real codemode keeps shell and image objects", async (t) => {
	const { session: native } = await createSession(api, paths, { enabled: false, codemode: true });
	const { session, extensionsResult } = await createSession(api, paths, { codemode: true });
	t.after(() => { native.dispose(); session.dispose(); });
	const plugin = extensionsResult.extensions.find((extension) => /pi-tool-ui[\\/]index\.ts$/.test(extension.path));
	assert.equal(plugin?.toolRenderers?.length, 1);
	assert.equal(plugin.tools.size, 0);
	assert.equal(plugin.handlers.size, 0);
	assert.equal(plugin.commands.size, 0);
	assert.equal(plugin.shortcuts.size, 0);
	assert.equal(JSON.stringify(session.getAllTools()), JSON.stringify(native.getAllTools()));
	assert.equal(session.systemPrompt, native.systemPrompt);
	assert.deepEqual(session.getActiveToolNames(), native.getActiveToolNames());

	for (const name of [...builtIns, "codemode"]) {
		const definition = session.getToolDefinition(name);
		const presentation = resolve(session, name);
		assert.notEqual(presentation.renderCall, definition.renderCall, name);
		assert.notEqual(presentation.renderResult, definition.renderResult, name);
		assert.equal(presentation.renderShell, "self", name + ".renderShell");
		for (const [key, value] of Object.entries(definition)) {
			if (key !== "renderCall" && key !== "renderResult" && key !== "renderShell") {
				assert.equal(presentation[key], value, name + "." + key);
			}
		}
	}
	assert.ok(session.getToolDefinition("bash").outputSchema);
	assert.ok(session.getToolDefinition("read").outputSchema);
	const nativeImage = await checkContract(native);
	assert.equal(await checkContract(session), nativeImage);
});

test("same-name overrides and downstream specialized renderers pass through by reference", async (t) => {
	const names = ["codemode", "ask_user_question", "subagent", "mcp__fixture__list", "custom"];
	const renderer = { renderShell: "self", renderCall: () => new tui.Text("SPECIAL CALL"),
		renderResult: () => new tui.Text("SPECIAL RESULT") };
	const { session } = await createSession(api, paths, {
		extensionFactories: [(pi) => {
			pi.registerTool({ name: "read", label: "Replacement read", description: "Test override",
				parameters: { type: "object", properties: {} }, async execute() { throw new Error("fixture"); }, ...renderer });
			pi.registerToolRenderer((name, next) => names.includes(name) ? renderer : next());
		}],
	});
	t.after(() => session.dispose());
	const extension = session.extensionRunner;
	for (const name of names) assert.equal(resolve(session, name), renderer, name);
	assert.equal(resolve(session, "unresolved-tool"), undefined);
	assert.equal(resolve(session, "read").renderCall, renderer.renderCall);
	assert.equal(resolve(session, "read").renderResult, renderer.renderResult);
	assert.equal(resolve(session, "read").renderShell, "self");
	assert.equal(extension.resolveToolRenderers("bash", () => undefined), undefined);
});
