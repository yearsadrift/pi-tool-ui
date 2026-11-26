import { spawnSync } from "node:child_process";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { fixture, packageDir, root, workspace } from "./pi-host.mjs";

const mode = process.argv[2] ?? "fullscreen";
if (mode !== "fullscreen" && mode !== "regular") throw new Error("Use fullscreen or regular");
if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("Run the demo from an interactive terminal");

const { cwd, agentDir } = await workspace();
try {
	const env = { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1" };
	delete env.PI_SESSION_ID;
	delete env.PI_SESSION_FILE;
	const child = spawnSync(process.execPath, [
		join(root, "dist", "bundle", "cli.js"), "--tui-mode", mode,
		"--no-session", "--no-extensions", "--no-skills", "--no-prompt-templates",
		"--model", "tool-ui-fixture/local", "--tools", "read",
		"-e", packageDir, "-e", fixture, "demo",
	], { cwd, env, stdio: "inherit" });
	if (child.error) throw child.error;
	process.exitCode = child.status ?? 1;
} finally {
	await rm(cwd, { recursive: true, force: true });
}
