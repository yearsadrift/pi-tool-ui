import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const packageDir = fileURLToPath(new URL("../", import.meta.url));
export const fixture = fileURLToPath(new URL("fixtures/provider.ts", import.meta.url));
export const builtIns = ["read", "bash", "powershell", "edit", "write", "grep", "find", "ls"];
export const png = "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAFElEQVR4nGMMqFjAgA0wYRUdtBIAHTcBeMwxqO4AAAAASUVORK5CYII=";
const install = process.env.PI_MANAGED_INSTALL_ROOT ?? join(homedir(), ".pi", "agent", "install");
export const root = resolve(process.env.PI_TOOL_UI_PI_ROOT ??
	join(install, "releases", "1.6.1", "node_modules", "@earendil-works", "pi-coding-agent"));
export const importPi = (file) => import(pathToFileURL(join(root, "dist", file)).href);

export async function workspace() {
	const cwd = await mkdtemp(join(tmpdir(), "pi-tool-ui-"));
	const agentDir = join(cwd, "agent");
	await mkdir(agentDir);
	await Promise.all([
		writeFile(join(cwd, "probe.png"), Buffer.from(png, "base64")),
		writeFile(join(cwd, "中文-一.txt"), "PTY-ONE-FIRST\nPTY-ONE-DETAIL\n"),
		writeFile(join(cwd, "中文-二.txt"), "PTY-TWO-FIRST\nPTY-TWO-DETAIL\n"),
	]);
	return { cwd, agentDir };
}

export async function loadHost(agentDir) {
	process.env.PI_CODING_AGENT_DIR = agentDir;
	process.env.PI_OFFLINE = "1";
	const [api, tui, { withBuiltInRenderers }] = await Promise.all([
		importPi("index.js"),
		importPi("../../pi-tui/dist/index.js"),
		importPi("core/tools/renderers/index.js"),
	]);
	assert.equal(api.VERSION, "1.6.1");
	return { api, tui, withBuiltInRenderers };
}

export async function createSession(api, paths, { enabled = true, extensionFactories = [], codemode = false } = {}) {
	const settingsManager = api.SettingsManager.inMemory({
		terminalTheme: false,
		defaultProvider: "tool-ui-fixture",
		defaultModel: "local",
	});
	const resourceLoader = new api.DefaultResourceLoader({
		...paths,
		settingsManager,
		noExtensions: true,
		noContextFiles: true,
		additionalExtensionPaths: [...(enabled ? [packageDir] : []), fixture, ...(codemode ? ["builtin:codemode"] : [])],
		extensionFactories: [
			...(codemode ? [{ name: "codemode", builtin: true, factory: api.createCodemodeExtension({ models: false }) }] : []),
			...extensionFactories,
		],
	});
	await resourceLoader.reload();
	const result = await api.createAgentSession({
		...paths,
		resourceLoader,
		settingsManager,
		sessionManager: api.SessionManager.inMemory(paths.cwd),
		tools: codemode ? [...builtIns, "codemode"] : builtIns,
	});
	assert.deepEqual(result.extensionsResult.errors, []);
	const model = result.session.extensionRunner.getModelRegistry().find("tool-ui-fixture", "local");
	assert.ok(model, "fixture provider did not load");
	await result.session.setModel(model);
	return result;
}
