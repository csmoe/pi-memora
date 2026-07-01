import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { formatSize, truncateHead, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

type BridgeResult = {
  ok: boolean;
  error?: string;
  detail?: string;
  setup?: string[];
  count?: number;
  user_id?: string;
  home?: string;
  stored?: number;
  entries?: MemoryEntry[];
};

type MemoryEntry = {
  index?: string;
  value?: string;
  primary_abstraction?: string;
  cue_anchors?: string[];
  metadata?: Record<string, unknown>;
  score?: number;
};

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, "..");
const bridgePath = resolve(packageRoot, "bridge", "pi_memora_bridge.py");
const defaultDataHome = process.env.XDG_DATA_HOME || `${process.env.HOME || ""}/.local/share`;
const memoraHome = process.env.PI_MEMORA_HOME || `${defaultDataHome}/pi-memora`;
const memoraRepo = resolve(packageRoot, "vendor", "Memora");
const memoraSrc = `${memoraRepo}/src`;
const defaultMemoraRef = "dec3f8f2444eace7004fc084abe1be9f3d88270e";

const maxRecallChars = 8000;
const maxCaptureChars = 12000;
const minCaptureChars = 120;
const topK = numberEnv("PI_MEMORA_TOP_K", 5);
const bridgeTimeoutMs = 120000;

function boolEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  return !["0", "false", "no", "off"].includes(raw.toLowerCase());
}

function numberEnv(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n\n[truncated ${text.length - max} chars]`;
}

function truncateForTool(text: string): string {
  const truncation = truncateHead(text, {
    maxBytes: maxRecallChars,
    maxLines: 200,
  });
  if (!truncation.truncated) return truncation.content;
  return [
    truncation.content,
    "",
    `[Output truncated: ${truncation.outputLines} of ${truncation.totalLines} lines, ${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}.]`,
  ].join("\n");
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object" && "text" in part) return String((part as { text?: unknown }).text ?? "");
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  if (content == null) return "";
  return JSON.stringify(content);
}

function summarizeMessages(messages: unknown): string {
  if (!Array.isArray(messages)) return "";
  const lines: string[] = [];
  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    const candidate = message as { role?: unknown; content?: unknown; customType?: unknown; toolName?: unknown };
    const role = String(candidate.role || candidate.customType || candidate.toolName || "message");
    const text = truncate(textFromContent(candidate.content), role === "toolResult" ? 1200 : 3000).trim();
    if (text) lines.push(`${role}: ${text}`);
  }
  return truncate(lines.join("\n\n"), maxCaptureChars);
}

function formatEntries(entries: MemoryEntry[] = []): string {
  if (entries.length === 0) return "No matching Memora memories.";
  const rendered = entries.map((entry, index) => {
    const title = entry.primary_abstraction || entry.index || `memory ${index + 1}`;
    const value = entry.value || "";
    const cues = Array.isArray(entry.cue_anchors) && entry.cue_anchors.length > 0
      ? `\nCues: ${entry.cue_anchors.slice(0, 6).join(", ")}`
      : "";
    return `[${index + 1}] ${title}\n${value}${cues}`.trim();
  });
  return truncateForTool(rendered.join("\n\n"));
}

function setupText(result?: BridgeResult): string {
  const detail = result?.detail ? `\nDetail: ${result.detail}` : "";
  const setup = result?.setup?.length
    ? `\n\nSetup:\n${result.setup.map((cmd) => `  ${cmd}`).join("\n")}`
    : "";
  return `${result?.error || "Memora bridge is not ready."}${detail}${setup}`;
}

function toolErrorText(result: BridgeResult): string {
  if (result.setup?.length) {
    return `${result.error || "Memora is not ready."}\n\nRun /memora setup for the copy-paste setup commands, then retry this tool.`;
  }
  return setupText(result);
}

function setupCommands(): string[] {
  return [
    `MEMORA_REPO="${memoraRepo}"`,
    "mkdir -p \"$(dirname \"$MEMORA_REPO\")\"",
    "git init \"$MEMORA_REPO\"",
    "git -C \"$MEMORA_REPO\" remote add origin https://github.com/microsoft/Memora.git",
    `git -C "$MEMORA_REPO" fetch --depth 1 origin ${defaultMemoraRef}`,
    "git -C \"$MEMORA_REPO\" checkout --detach FETCH_HEAD",
    `uv run --project "${packageRoot}" python -c "import sys; print(sys.version)"`,
  ];
}

function bridgeProcess(action: string, payload: Record<string, unknown>, extraEnv: NodeJS.ProcessEnv = {}): { command: string; args: string[]; env: NodeJS.ProcessEnv } {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extraEnv };
  if (existsSync(memoraSrc)) {
    env.PYTHONPATH = env.PYTHONPATH ? `${memoraSrc}:${env.PYTHONPATH}` : memoraSrc;
  }

  if (!existsSync(memoraSrc)) {
    return {
      command: "python3",
      args: [bridgePath, "missing-setup", JSON.stringify(payload)],
      env,
    };
  }

  return { command: "uv", args: ["run", "--project", packageRoot, "python", bridgePath, action, JSON.stringify(payload)], env };
}

function parseBridgeOutput(stdout: string, stderr: string): BridgeResult {
  const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (!line.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(line) as BridgeResult;
      if (!parsed.ok && stderr.trim()) parsed.detail = parsed.detail || stderr.trim();
      return parsed;
    } catch {
      // Continue scanning earlier lines.
    }
  }
  return { ok: false, error: "Memora bridge returned no JSON result.", detail: `${stdout}\n${stderr}`.trim() };
}

function runBridge(action: string, payload: Record<string, unknown>, signal?: AbortSignal, extraEnv?: NodeJS.ProcessEnv): Promise<BridgeResult> {
  return new Promise((resolvePromise) => {
    if (!existsSync(bridgePath)) {
      resolvePromise({ ok: false, error: `Bridge not found at ${bridgePath}` });
      return;
    }

    let settled = false;
    const resolveOnce = (result: BridgeResult) => {
      if (settled) return;
      settled = true;
      resolvePromise(result);
    };

    const runner = bridgeProcess(action, payload, extraEnv);
    const child = spawn(runner.command, runner.args, {
      cwd: packageRoot,
      env: runner.env,
      stdio: ["ignore", "pipe", "pipe"],
      signal,
    });

    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      resolveOnce({ ok: false, error: `Memora bridge timed out after ${bridgeTimeoutMs}ms.` });
    }, bridgeTimeoutMs);

    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => {
      clearTimeout(timeout);
      resolveOnce({ ok: false, error: error.message });
    });
    child.on("close", () => {
      clearTimeout(timeout);
      resolveOnce(parseBridgeOutput(stdout, stderr));
    });
  });
}

function basePayload(ctx: { cwd?: string }): Record<string, unknown> {
  return {
    cwd: ctx.cwd || process.cwd(),
    source: "pi-memora",
  };
}

async function piModelEnv(ctx: any): Promise<NodeJS.ProcessEnv> {
  const model = ctx.model as { id?: string; api?: string; baseUrl?: string } | undefined;
  if (!model?.id || !ctx.modelRegistry?.getApiKeyAndHeaders) return {};

  const api = String(model.api || "");
  if (api && !api.startsWith("openai-")) return {};

  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok || !auth.apiKey) return {};

  return {
    ...(auth.env || {}),
    OPENAI_API_TYPE: "openai",
    OPENAI_API_KEY: auth.apiKey,
    OPENAI_MODEL: model.id,
    ...(model.baseUrl ? { OPENAI_BASE_URL: model.baseUrl } : {}),
  };
}

export default function memoraExtension(pi: ExtensionAPI) {
  pi.registerCommand("memora", {
    description: "Manage Memora-backed persistent memory",
    handler: async (args, ctx) => {
      const [command = "status", ...rest] = String(args || "").trim().split(/\s+/).filter(Boolean);
      const text = rest.join(" ");

      if (command === "help") {
        ctx.ui.notify([
          "/memora status",
          "/memora setup",
          "/memora recall <query>",
          "/memora remember <text>",
          "/memora list [limit]",
          "/memora clear clear",
        ].join("\n"), "info");
        return;
      }

      if (command === "setup") {
        ctx.ui.notify([
          "Memora runtime is not installed automatically by pi install.",
          "Run these commands once, then restart Pi or run /reload:",
          "",
          ...setupCommands(),
        ].join("\n"), "info");
        return;
      }

      if (command === "recall") {
        const result = await runBridge("query", { ...basePayload(ctx), query: text, top_k: topK }, ctx.signal, await piModelEnv(ctx));
        ctx.ui.notify(result.ok ? formatEntries(result.entries) : setupText(result), result.ok ? "info" : "error");
        return;
      }

      if (command === "remember") {
        const result = await runBridge("add", { ...basePayload(ctx), text, type: "doc" }, ctx.signal, await piModelEnv(ctx));
        ctx.ui.notify(result.ok ? `Stored ${result.stored ?? 0} Memora entr${result.stored === 1 ? "y" : "ies"}.` : setupText(result), result.ok ? "info" : "error");
        return;
      }

      if (command === "list") {
        const limit = Number(rest[0]) || 20;
        const result = await runBridge("list", { ...basePayload(ctx), limit }, ctx.signal, await piModelEnv(ctx));
        ctx.ui.notify(result.ok ? formatEntries(result.entries) : setupText(result), result.ok ? "info" : "error");
        return;
      }

      if (command === "clear") {
        const result = await runBridge("clear", { ...basePayload(ctx), confirm: rest[0] }, ctx.signal, await piModelEnv(ctx));
        ctx.ui.notify(result.ok ? "Cleared Memora memory for this scope." : setupText(result), result.ok ? "info" : "error");
        return;
      }

      const result = await runBridge("doctor", basePayload(ctx), ctx.signal, await piModelEnv(ctx));
      ctx.ui.notify(
        result.ok
          ? `Memora ready. Scope ${result.user_id}; ${result.count ?? 0} memories; home ${result.home}.`
          : setupText(result),
        result.ok ? "info" : "error",
      );
    },
  });

  pi.registerTool({
    name: "memora_remember",
    label: "Memora Remember",
    description: "Store durable project or user context in Microsoft Memora.",
    promptSnippet: "Store durable project or user context in Microsoft Memora.",
    promptGuidelines: [
      "Use memora_remember for durable facts, decisions, preferences, procedures, and task outcomes that should survive future Pi sessions.",
      "Do not use memora_remember for secrets, credentials, raw private data, or short-lived scratch notes.",
    ],
    parameters: Type.Object({
      text: Type.String({ description: "Memory content to store." }),
      type: Type.Optional(Type.String({ description: "Memora memory type, defaults to doc." })),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const result = await runBridge("add", { ...basePayload(ctx), text: params.text, type: params.type || "doc" }, signal, await piModelEnv(ctx));
      return {
        isError: !result.ok,
        content: [{ type: "text", text: result.ok ? `Stored ${result.stored ?? 0} Memora entries.` : toolErrorText(result) }],
        details: result,
      };
    },
  });

  pi.registerTool({
    name: "memora_recall",
    label: "Memora Recall",
    description: "Retrieve relevant durable memories from Microsoft Memora. Output is truncated to 8000 bytes and 200 lines.",
    promptSnippet: "Retrieve relevant durable memories from Microsoft Memora.",
    promptGuidelines: [
      "Use memora_recall when past decisions, preferences, architecture, procedures, or previous task context would materially improve the answer.",
    ],
    parameters: Type.Object({
      query: Type.String({ description: "Search query for memory retrieval." }),
      top_k: Type.Optional(Type.Number({ description: "Maximum memories to return." })),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const result = await runBridge("query", { ...basePayload(ctx), query: params.query, top_k: params.top_k || topK }, signal, await piModelEnv(ctx));
      return {
        isError: !result.ok,
        content: [{ type: "text", text: result.ok ? formatEntries(result.entries) : toolErrorText(result) }],
        details: result,
      };
    },
  });

  pi.registerTool({
    name: "memora_list",
    label: "Memora List",
    description: "List recent memories from Microsoft Memora. Output is truncated to 8000 bytes and 200 lines.",
    parameters: Type.Object({
      limit: Type.Optional(Type.Number({ description: "Maximum memories to list." })),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const result = await runBridge("list", { ...basePayload(ctx), limit: params.limit || 20 }, signal, await piModelEnv(ctx));
      return {
        isError: !result.ok,
        content: [{ type: "text", text: result.ok ? formatEntries(result.entries) : toolErrorText(result) }],
        details: result,
      };
    },
  });

  pi.on("before_agent_start", async (event, ctx) => {
    if (!boolEnv("PI_MEMORA_AUTORECALL", true)) return;
    const prompt = String(event.prompt || "").trim();
    if (!prompt) return;
    const result = await runBridge("query", { ...basePayload(ctx), query: prompt, top_k: topK }, ctx.signal, await piModelEnv(ctx));
    if (!result.ok || !result.entries?.length) return;
    const memories = formatEntries(result.entries);
    return {
      systemPrompt: `${event.systemPrompt}\n\nRelevant durable memories from Memora for this turn:\n\n${memories}`,
    };
  });

  pi.on("agent_end", async (event, ctx) => {
    if (!boolEnv("PI_MEMORA_AUTOCAPTURE", true)) return;
    const transcript = summarizeMessages((event as { messages?: unknown }).messages);
    if (transcript.length < minCaptureChars) return;
    await runBridge("add", {
      ...basePayload(ctx),
      text: transcript,
      type: "doc",
      metadata: { captured_at: new Date().toISOString(), capture: "agent_end" },
    }, ctx.signal, await piModelEnv(ctx));
  });
}
