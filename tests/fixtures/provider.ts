// Deterministic model for the tests. It only exercises Pi with local files and commands.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, type AssistantMessage, type ToolCall } from "@earendil-works/pi-ai";

const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const contract = [
	"const shell = await tools.bash({command: " + JSON.stringify("printf '%s' \"$PI_SESSION_ID\"") + "});",
	"const failed = await tools.bash({command: " + JSON.stringify("printf 'fixture stderr\n' >&2; exit 7") + "});",
	'const png = await tools.read({path: "probe.png"});',
	"image(png);",
	"return JSON.stringify({ kind: typeof shell, output: shell.output, exit_code: shell.exit_code, failed: failed.exit_code, image: png.type, mimeType: png.mimeType });",
].join("\n");

const compactScript = [
	'const files = ["中文-一.txt", "测试-不存在.txt"];',
	'for (const path of files) {',
	'  try {',
	'    const value = await tools.read({path});',
	'    text(value);',
	'  } catch (error) {',
	'    text(String(error));',
	'  }',
	'}',
	'for (let i = 1; i <= 8; i++) text("CODEMODE-FULL-OUTPUT-" + i);',
].join("\n");

const streamCommand = [
	"printf 'PTY-LIVE-ONE\\n'",
	"for step in two end; do",
	'  n=0; while [ ! -f "tool-ui-$step.ready" ] && [ "$n" -lt 480 ]; do sleep 0.25; n=$((n+1)); done',
	'  if [ "$step" = two ]; then',
	"    for i in {1..24}; do printf 'PTY-LINE-%02d\\n' \"$i\"; done",
	"    printf 'PTY-LIVE-TWO\\n'",
	"  fi",
	"done",
	"printf 'PTY-SHELL-DONE\\n'",
].join("\n");

export default function (pi: ExtensionAPI): void {
	let nextId = 0;
	const call = (name: string, args: Record<string, unknown>): ToolCall => ({
		type: "toolCall", name, arguments: args, id: "tool-ui-test-" + ++nextId,
	});

	pi.registerProvider("tool-ui-fixture", {
		baseUrl: "http://localhost",
		apiKey: "test-only",
		api: "tool-ui-fixture",
		models: [{ id: "local", name: "Tool UI fixture", input: ["text", "image"], reasoning: false,
			cost, contextWindow: 8000, maxTokens: 2000 }],
		streamSimple(model, context) {
			const stream = createAssistantMessageEventStream();
			const last = context.messages.findLast((message) => message.role !== "system");
			const prompt = context.messages.findLast((message) => message.role === "user")?.content ?? "";
			const text = typeof prompt === "string" ? prompt : prompt.filter((block) => block.type === "text").map((block) => block.text).join("");
			const calls: ToolCall[] = [];
			if (last?.role === "user") {
				if (text === "contract") calls.push(call("codemode", { code: contract }));
				if (text === "compact") calls.push(call("codemode", { code: compactScript }));
				if (text === "screen" || text === "demo") {
					calls.push(call("read", { path: "中文-一.txt" }), call("read", { path: "中文-二.txt" }));
					if (text === "screen") calls.push(call("bash", { command: streamCommand }));
					if (text === "demo") calls.push(call("read", { path: "测试-不存在.txt" }));
				}
			}
			const response = text === "demo" || text === "compact" ? (calls.length ? "读取本地示例文件。" : "本地试用已完成。") :
				calls.length ? "PTY-ASSISTANT-BOUNDARY" : Array.from({ length: 30 }, (_, index) => "PTY-AFTER-" + (index + 1)).join("\n\n");
			const message: AssistantMessage = {
				role: "assistant", api: model.api, provider: model.provider, model: model.id,
				content: [], timestamp: Date.now(), stopReason: "pending",
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { ...cost, total: 0 } },
			};
			queueMicrotask(() => {
				stream.push({ type: "start", partial: message });
				const body = { type: "text", text: "" } as const;
				message.content.push(body);
				stream.push({ type: "text_start", contentIndex: 0, partial: message });
				message.content[0] = { type: "text", text: response };
				stream.push({ type: "text_delta", contentIndex: 0, delta: response, partial: message });
				stream.push({ type: "text_end", contentIndex: 0, content: response, partial: message });
				for (const toolCall of calls) {
					const contentIndex = message.content.length;
					message.content.push({ ...toolCall, arguments: {} });
					stream.push({ type: "toolcall_start", contentIndex, partial: message });
					message.content[contentIndex] = toolCall;
					stream.push({ type: "toolcall_end", contentIndex, toolCall, partial: message });
				}
				message.stopReason = calls.length ? "toolUse" : "stop";
				stream.push({ type: "done", reason: message.stopReason, message });
				stream.end();
			});
			return stream;
		},
	});
}
