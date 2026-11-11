import { execFile, execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const script = fileURLToPath(import.meta.url);
const runtime = (home) => join(home, "collector-control");
const iso = () => new Date().toISOString();

function read(home, name) {
  try {
    return JSON.parse(readFileSync(join(runtime(home), name), "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

function save(home, name, data) {
  const path = join(runtime(home), name);
  const temp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temp, JSON.stringify(data), { mode: 0o600, flag: "wx" });
  renameSync(temp, path);
}

function interval(config) {
  const seconds = JSON.parse(readFileSync(config, "utf8")).intervalSeconds ?? 600;
  if (!Number.isSafeInteger(seconds) || seconds < 10 || seconds > 86400) throw new Error("采集间隔配置无效");
  return seconds;
}

function alive(control) {
  if (!Number.isSafeInteger(control?.pid) || control.pid < 1 || !/^[a-f0-9-]{36}$/.test(control.id ?? "")) return false;
  try {
    const command = execFileSync("/bin/ps", ["-p", String(control.pid), "-o", "command="], {
      encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 1000,
    }).trim();
    return command.includes(` ${script} `) && command.endsWith(` ${control.id}`);
  } catch {
    return false;
  }
}

function recentHubEvents(home) {
  const file = join(home, "hub.db");
  if (!existsSync(file)) return [];
  using db = new DatabaseSync(file, { readOnly: true, timeout: 100 });
  const events = db.prepare(`
    SELECT id, type, subject, summary, received_at, routed FROM events
    WHERE subject LIKE 'loop:%' AND key LIKE 'loop:%'
      AND (type LIKE 'task%.created' OR type LIKE 'task%.comment')
    ORDER BY id DESC LIMIT 50
  `).all();
  return events.flatMap(({ id, type, subject, summary, received_at, routed }) =>
    JSON.parse(routed).map(rule => ({
      hubEvent: id, type, subject, title: summary, at: received_at, rule, outcome: "Hub 已接收",
    })));
}

export function collectorStatus(home, config) {
  const control = read(home, "control.json");
  const state = read(home, "status.json");
  const running = alive(control);
  const current = state?.id === control?.id ? state : undefined;
  const logs = [...(state?.logs ?? []), ...(read(home, "manual-logs.json") ?? [])]
    .sort((a, b) => b.finishedAt.localeCompare(a.finishedAt)).slice(0, 50);
  return {
    running,
    enabled: running && control.enabled,
    intervalSeconds: interval(config),
    collecting: running && Boolean(current?.collecting),
    nextAt: running && control.enabled ? current?.nextAt ?? null : null,
    last: state?.logs?.[0] ?? null,
    logs,
    hubEvents: recentHubEvents(home),
  };
}

export function collectionDetails(stdout) {
  const output = JSON.parse(stdout.trim().split("\n").at(-1));
  return {
    eligible: output.eligible, created: output.created, comments: output.comments, baseline: output.baseline,
    pending: output.pending?.length ?? 0, noticeFailures: output.noticeFailures?.length ?? 0,
    events: output.events, omittedEvents: output.omittedEvents,
    pendingItems: output.pending, noticeFailureItems: output.noticeFailures,
  };
}

export async function collectManually(home, issue, rule, execute) {
  return withCollectorLock(home, async () => {
    const entry = { mode: "manual", issue, rule, startedAt: iso() };
    try {
      const result = await execute();
      Object.assign(entry, collectionDetails(result.stdout), { ok: true });
      return result;
    } catch (error) {
      if (error.stdout?.trim()) {
        try { Object.assign(entry, collectionDetails(error.stdout)); } catch {}
      }
      Object.assign(entry, { ok: false, message: "手动采集未完成，请核对 Octo 登录、采集配置和 Hub 连接。" });
      throw error;
    } finally {
      entry.finishedAt = iso();
      const logs = read(home, "manual-logs.json") ?? [];
      save(home, "manual-logs.json", [entry, ...logs].slice(0, 50));
    }
  });
}

export function setCollector(home, config, cli, enabled) {
  const current = read(home, "control.json");
  const running = alive(current);
  if (running) {
    if (enabled && !current.enabled) throw new Error("采集器正在停止，请稍后再试");
    if (!enabled && current.enabled) save(home, "control.json", { ...current, enabled: false });
  } else if (enabled) {
    interval(config);
    mkdirSync(runtime(home), { recursive: true, mode: 0o700 });
    const id = randomUUID();
    const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", script, home, config, cli, id], {
      detached: true, stdio: "ignore",
    });
    child.on("error", () => {});
    if (!child.pid) throw new Error("无法启动定时采集");
    save(home, "control.json", { id, pid: child.pid, enabled: true });
    child.unref();
  }
  return collectorStatus(home, config);
}

export async function withCollectorLock(home, action) {
  mkdirSync(runtime(home), { recursive: true, mode: 0o700 });
  using lock = new DatabaseSync(join(runtime(home), "lock.sqlite"), { timeout: 0 });
  try {
    lock.exec("BEGIN IMMEDIATE");
  } catch (error) {
    if (error.errcode === 5) throw new Error("已有采集正在执行，请稍后再试");
    throw error;
  }
  try {
    return await action();
  } finally {
    lock.exec("ROLLBACK");
  }
}

async function watch(home, config, cli, id) {
  const envFile = config.endsWith(".json") ? config.replace(/\.json$/, ".env") : "";
  const enabled = () => {
    const control = read(home, "control.json");
    return control?.enabled === true && control.id === id;
  };
  const state = { id, collecting: false, nextAt: null, logs: read(home, "status.json")?.logs ?? [] };
  while (enabled()) {
    const startedAt = iso();
    state.collecting = true;
    state.nextAt = null;
    save(home, "status.json", state);
    let result;
    try {
      const { stdout } = await withCollectorLock(home, () => run(process.execPath, [
        "--disable-warning=ExperimentalWarning", cli, "octo", "collect", "--config", config, "--log-events",
        ...(envFile && existsSync(envFile) ? ["--env-file", envFile] : []),
      ], { env: { ...process.env, AGENT_AUTOLOOP_HOME: home }, timeout: 120000, maxBuffer: 1024 * 1024 }));
      result = { ok: true, ...collectionDetails(stdout) };
    } catch (error) {
      result = { ok: false, message: error.message === "已有采集正在执行，请稍后再试"
        ? "已有手动采集在运行，本轮跳过。" : "采集未完成，请核对 Octo 登录、采集配置和 Hub 连接。" };
      try {
        const output = JSON.parse(error.stdout?.trim().split("\n").at(-1));
        result.events = output.events;
        result.omittedEvents = output.omittedEvents;
      } catch {
        // A failure before collection starts has no event records.
      }
    }
    const finishedAt = iso();
    const seconds = interval(config);
    const next = Date.now() + seconds * 1000;
    state.collecting = false;
    state.nextAt = enabled() ? new Date(next).toISOString() : null;
    state.logs = [{ startedAt, finishedAt, ...result }, ...state.logs].slice(0, 50);
    save(home, "status.json", state);
    while (enabled() && Date.now() < next) await delay(Math.min(1000, next - Date.now()));
  }
}

if (import.meta.main) await watch(...process.argv.slice(2));
