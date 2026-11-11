import { open, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";

const tailBytes = 128 * 1024;

export async function codexLogFile(home, run, attempt) {
  const folder = join(home, "worker", "runs", `${run}-${attempt}`);
  let turn;
  let finished = false;
  try {
    const entry = JSON.parse(await readFile(join(folder, "entry.json"), "utf8"));
    if (entry.run !== run || entry.attempt !== attempt || entry.job.agent.use !== "codex"
        || !Number.isSafeInteger(entry.turn) || entry.turn < 1) return;
    turn = entry.turn;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    try {
      const files = await readdir(folder);
      turn = Math.max(0, ...files.map((name) => Number(/^exit-([1-9]\d*)$/.exec(name)?.[1] ?? 0)));
      if (!Number.isSafeInteger(turn) || !turn) return;
      const command = await readFile(join(folder, `command-${turn}.sh`), "utf8");
      if (!/^exec '[^'\n]*\bcodex' 'exec' (?:'resume' )?'--json'(?: |$)/im.test(command)) return;
      finished = true;
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
  }
  return { turn, finished, path: join(folder, `stdout-${turn}.log`) };
}

const changeLabels = { add: "新增", update: "修改", delete: "删除" };

function logEntry(line, files, commands) {
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    return;
  }
  if (!event) return;
  const { type, item } = event;
  if (type === "turn.started") return { kind: "status", text: "Codex 开始执行" };
  if (type === "turn.completed") return { kind: "status", text: "Codex 执行完成" };
  if (type === "turn.failed" || type === "error")
    return { kind: "error", text: "Codex 报告执行错误，详情见轮次结果" };
  if (type === "item.completed" && item?.type === "agent_message" && typeof item.text === "string")
    return { kind: "message", text: item.text.split("\n```agent-autoloop")[0] };
  if (item?.type === "command_execution" && ["item.started", "item.updated", "item.completed"].includes(type)) {
    const previous = commands.get(item.id);
    const entry = previous ?? { kind: "command", id: item.id };
    if (typeof item.command === "string") entry.command = item.command;
    if (typeof item.aggregated_output === "string") {
      const output = item.aggregated_output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").trimEnd();
      entry.output = output.slice(0, 16000);
      entry.outputClipped = output.length > entry.output.length;
    }
    entry.running = type !== "item.completed";
    entry.failed = item.status === "failed" || (Number.isInteger(item.exit_code) && item.exit_code !== 0);
    entry.exitCode = Number.isInteger(item.exit_code) ? item.exit_code : null;
    if (typeof item.id === "string") commands.set(item.id, entry);
    if (!previous) return entry;
    return;
  }
  if (item?.type === "mcp_tool_call" && ["item.started", "item.completed"].includes(type)) {
    const name = [item.server, item.tool].filter(Boolean).join(" / ");
    return { kind: "tool", text: `${type === "item.started" ? "调用工具" : "工具调用结束"} · ${name}${item.status === "failed" ? " · 失败" : ""}` };
  }
  if (item?.type === "web_search" && type === "item.completed")
    return { kind: "tool", text: `网页搜索 · ${item.query ?? ""}` };
  if (item?.type === "file_change" && type === "item.completed" && Array.isArray(item.changes)) {
    const changes = item.changes.filter(({ path }) => typeof path === "string");
    if (item.status === "completed") {
      for (const { path, kind } of changes) {
        if (!files.has(path)) files.set(path, new Set());
        files.get(path).add(changeLabels[kind] ?? "变更");
      }
    }
    return { kind: "file", text: [item.status === "failed" ? "文件变更失败" : "文件变更",
      ...changes.map(({ path, kind }) => `${changeLabels[kind] ?? "变更"} · ${path}`)].join("\n") };
  }
}

export async function readCodexLog(home, run, attempt) {
  const log = await codexLogFile(home, run, attempt);
  if (!log) return { entries: [] };
  const { turn } = log;
  let file;
  try {
    file = await open(log.path, "r");
  } catch (error) {
    if (error.code === "ENOENT") return { entries: [] };
    throw error;
  }
  try {
    const entries = [];
    const files = new Map();
    const commands = new Map();
    const collect = (line) => {
      const entry = logEntry(line, files, commands);
      if (entry && (entry.kind === "command" || entry.text)) entries.push(entry);
    };
    if (log.finished) {
      const lines = createInterface({ input: file.createReadStream({ autoClose: false }), crlfDelay: Infinity });
      for await (const line of lines) collect(line);
      return { turn, entries, files: [...files].map(([path, kinds]) => ({ path, kinds: [...kinds] })), truncated: false };
    }
    const { size } = await file.stat();
    const offset = Math.max(0, size - tailBytes);
    const buffer = Buffer.alloc(size - offset);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, offset);
    const lines = buffer.toString("utf8", 0, bytesRead).split("\n");
    lines.pop();
    if (offset) lines.shift();
    lines.forEach(collect);
    return { turn, entries, files: [...files].map(([path, kinds]) => ({ path, kinds: [...kinds] })), truncated: offset > 0 };
  } finally {
    await file.close();
  }
}
