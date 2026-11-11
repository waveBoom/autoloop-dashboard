import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, promisify } from "node:util";
import { adoptableWorkspaces, adoptTaskWorkspace, openTaskWorkspace, removeTaskWorkspace, taskBranchAction, taskRepositories } from "./repositories.mjs";
import { collectManually, collectorStatus, setCollector } from "./collector.mjs";
import { codexLogFile, readCodexLog } from "./live-log.mjs";

const { values } = parseArgs({ options: {
  config: { type: "string" }, port: { type: "string", default: "3351" }, demo: { type: "boolean" },
} });
const port = Number(values.port);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("端口无效");
const address = `127.0.0.1:${port}`;
const configPath = resolve(
  values.config ?? join(process.env.AGENT_AUTOLOOP_HOME ?? join(homedir(), ".agent-autoloop"), "config.json"),
);
const config = values.demo ? null : JSON.parse(readFileSync(configPath, "utf8"));
const hub = config && new URL(config.url);
if (config && (!config.owner || hub.protocol !== "http:" || !["127.0.0.1", "[::1]", "localhost"].includes(hub.hostname)
    || hub.username || hub.password || hub.pathname !== "/" || hub.search || hub.hash))
  throw new Error("需要本机 Hub 地址和本人密钥");
const headers = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
};
const assets = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/styles.css", ["styles.css", "text/css; charset=utf-8"]],
  ["/app.mjs", ["app.mjs", "text/javascript; charset=utf-8"]],
  ["/model.mjs", ["model.mjs", "text/javascript; charset=utf-8"]],
]);
const demo = values.demo ? await import("./demo.mjs") : null;
const { configuredTestAddress } = demo ? {} : await import("../agent-autoloop/plugins/octo/test-delivery-profile.ts");
const { parseRules } = demo ? {} : await import("../agent-autoloop/protocol/rules.ts");
const canNotify = Boolean(config?.hub && config.channels?.octo?.botConfig && basename(configPath) === "config.json");
const collectorConfig = process.env.AGENT_AUTOLOOP_OCTO_COLLECTOR_CONFIG ?? join(dirname(configPath), "octo-collector.json");
const canCollect = Boolean(config?.hub && basename(configPath) === "config.json" && existsSync(collectorConfig));
const canReload = !demo && typeof process.execve === "function";
const instance = randomUUID();
let reloading = false;
let reloadFailed = false;
let activeActions = 0;
let branchActionInProgress = false;
const cli = fileURLToPath(new URL("../agent-autoloop/bin/agent-autoloop.ts", import.meta.url));
const run = promisify(execFile);
const notificationErrors = [
  "请输入有效的 HTTPS 测试环境地址",
  "Hub 中找不到唯一的 Issue 和规则归属。",
  "找不到已核验的需求方",
  "需求方已不在目标工作区或通知群",
  "无法核对需求通知群成员",
  "此前发送结果待人工核对",
  "发送结果待人工核对",
];
const send = (res, status, content, type = "application/json; charset=utf-8") => {
  res.writeHead(status, { ...headers, "Content-Type": type });
  res.end(content);
};
const error = (res, status, message) => send(res, status, JSON.stringify({ error: message }));

const server = createServer(async (req, res) => {
  if (req.headers.host !== address || req.headers["sec-fetch-site"] === "cross-site")
    return error(res, 403, "只允许从本机看板访问");
  let url;
  try {
    url = new URL(req.url, `http://${address}`);
  } catch {
    return error(res, 400, "地址无效");
  }
  if (url.origin !== `http://${address}`) return error(res, 403, "地址无效");
  if (req.method === "GET" && url.pathname === "/api/dashboard/status")
    return send(res, 200, JSON.stringify({ instance, canReload, reloadFailed }));
  const liveLog = /^\/api\/runs\/([1-9]\d*)\/live-log$/.exec(url.pathname);
  if (req.method === "GET" && liveLog) {
    const attempt = url.searchParams.get("attempt") ?? "";
    const runId = Number(liveLog[1]);
    if (!/^[1-9]\d*$/.test(attempt) || !Number.isSafeInteger(Number(attempt)) || !Number.isSafeInteger(runId))
      return error(res, 400, "轮次或尝试编号无效");
    try {
      if (url.searchParams.get("raw") === "1") {
        const log = !demo && await codexLogFile(dirname(configPath), runId, Number(attempt));
        if (!log) return error(res, 404, "本机没有保留这轮的 Codex stdout");
        const file = await open(log.path, "r");
        const stream = file.createReadStream();
        stream.on("error", () => res.destroy());
        res.on("close", () => stream.destroy());
        res.writeHead(200, { ...headers, "Content-Type": "text/plain; charset=utf-8" });
        stream.pipe(res);
        return;
      }
      const log = demo ? { ...demo.log } : await readCodexLog(dirname(configPath), runId, Number(attempt));
      if (url.searchParams.get("format") !== "events") {
        log.entries = log.entries.map((entry) => entry.kind === "command"
          ? [entry.running ? "Running" : "Ran", entry.command, entry.output].filter(Boolean).join("\n")
          : entry.text);
      }
      return send(res, 200, JSON.stringify(log));
    } catch (cause) {
      if (cause.code === "ENOENT") return error(res, 404, "本机没有保留这轮的 Codex stdout");
      return error(res, 500, "无法读取本机 Worker 日志");
    }
  }
  const collector = url.pathname === "/api/collector";
  if (req.method === "GET" && collector) {
    try {
      return send(res, 200, JSON.stringify(demo ? demo.collector : canCollect ? collectorStatus(dirname(configPath), collectorConfig) : null));
    } catch {
      return error(res, 500, "无法读取定时采集状态");
    }
  }
  if (req.method === "GET" && url.pathname === "/api/issues/test-address") {
    const rule = url.searchParams.get("rule");
    if (!canNotify || !rule || rule.length > 500) return error(res, 400, "无法核对项目测试地址");
    try {
      const rulesFile = resolve(process.env.AGENT_AUTOLOOP_RULES ?? join(dirname(configPath), "rules.json"));
      const { rules } = parseRules(readFileSync(rulesFile, "utf8"), Date.now(), "Asia/Shanghai");
      const cwd = rules.find(({ name }) => name === rule)?.cwd;
      return send(res, 200, JSON.stringify({ testAddress: configuredTestAddress(cwd) ?? "" }));
    } catch {
      return error(res, 500, "无法读取项目测试配置");
    }
  }
  if (req.method === "POST" && url.pathname === "/api/dashboard/reload") {
    if (req.headers.origin !== `http://${address}` || req.headers["content-type"] !== "application/json")
      return error(res, 403, "只接受本机看板发起的操作");
    if (!canReload) return error(res, 409, "当前看板不支持重载");
    if (reloading || activeActions) return error(res, 409, "看板还有操作正在处理，请稍后重试");
    reloading = true;
    reloadFailed = false;
    res.once("finish", () => {
      try {
        process.execve(process.execPath, [process.execPath, ...process.execArgv, ...process.argv.slice(1)]);
      } catch {
        reloadFailed = true;
        reloading = false;
      }
    });
    return send(res, 202, JSON.stringify({ instance }));
  }
  const ownerAction = /^\/api\/(issues\/disposition|cards\/[1-9]\d*\/(?:answer|resolve)|runs\/[1-9]\d*\/(?:cancel|retry))$/.exec(url.pathname)?.[1];
  const octoAction = /^\/api\/issues\/(notify|collect)$/.exec(url.pathname)?.[1];
  const worktrees = url.pathname === "/api/worktrees";
  const configuredRepositories = (rule) => {
    const file = resolve(process.env.AGENT_AUTOLOOP_RULES ?? join(dirname(configPath), "rules.json"));
    return parseRules(readFileSync(file, "utf8"), Date.now(), "Asia/Shanghai")
      .rules.find(({ name }) => name === rule)?.repositories;
  };
  if (req.method === "GET" && worktrees) {
    const { rule, subject, issue, adoptable } = Object.fromEntries(url.searchParams);
    if (adoptable === "1") {
      try {
        return send(res, 200, JSON.stringify(demo ? [] : await adoptableWorkspaces(issue, configuredRepositories(rule))));
      } catch {
        return error(res, 409, "无法读取任务的仓库配置");
      }
    }
    return send(res, 200, JSON.stringify(demo ? subject === "loop:demo:issue-123" ? demo.repositories : [] : await taskRepositories(dirname(configPath), rule, subject, issue)));
  }
  if (req.method === "POST" && (ownerAction || octoAction || worktrees || collector)) {
    if (demo || req.headers.origin !== `http://${address}` || req.headers["content-type"] !== "application/json")
      return error(res, 403, "只接受本机看板发起的操作");
    if (reloading) return error(res, 409, "看板正在重载，请稍后重试");
    activeActions++;
    let body = "";
    try {
      for await (const chunk of req) {
        body += chunk;
        if (body.length > (ownerAction === "issues/disposition" ? 65536 : 4096))
          return error(res, 413, "请求过长");
      }
      if (collector) {
        if (!canCollect) return error(res, 409, "看板未配置 Octo 采集");
        let input;
        try { input = JSON.parse(body); } catch { return error(res, 400, "采集开关参数无效"); }
        if (typeof input?.enabled !== "boolean") return error(res, 400, "采集开关参数无效");
        try {
          return send(res, 200, JSON.stringify(setCollector(dirname(configPath), collectorConfig, cli, input.enabled)));
        } catch {
          return error(res, 409, "无法切换定时采集，请稍后重试");
        }
      }
      if (worktrees) {
        let input;
        try { input = JSON.parse(body); } catch { return error(res, 400, "工作区参数无效"); }
        if (["local-debug-start", "local-debug-return", "push", "adopt"].includes(input?.action)) {
          if (input.confirmed !== true) return error(res, 400, "请先确认分支操作");
          if (branchActionInProgress) return error(res, 409, "有分支操作正在处理，请稍后重试");
          branchActionInProgress = true;
          try {
            const request = (route, payload) => fetch(new URL(route, hub), {
              headers: { authorization: `Bearer ${config.owner}`, "content-type": "application/json" },
              redirect: "error", signal: AbortSignal.timeout(5000),
              ...(payload && { method: "POST", body: JSON.stringify(payload) }),
            });
            const state = await request("/v1/state");
            if (!state.ok) return error(res, 502, "无法核实任务状态");
            const data = await state.json();
            const matches = (item) => item.rule === input.rule && item.subject === input.subject;
            if (input.action === "adopt") {
              const handoff = data.issueDispositions?.find(matches)?.appHandoff;
              const runs = data.runs.filter(matches);
              const issue = typeof input.issue === "string" && /^[A-Z]+-\d{1,9}$/.test(input.issue) ? input.issue : "";
              if (!handoff || !issue || !runs.some(run => run.events.some(event =>
                event.link?.split(/[?#]/)[0].endsWith(`/${issue}`) || event.summary?.startsWith(`${issue} `))))
                return error(res, 409, "请在对应 Issue 的 App 接手期间登记工作区");
              const candidates = await adoptableWorkspaces(issue, configuredRepositories(input.rule));
              const candidate = candidates.find(item => item.name === input.name && item.path === input.path &&
                item.branch === input.branch && item.commit === input.commit);
              if (!candidate) return error(res, 409, "工作区或提交已变化，请刷新后重试");
              await adoptTaskWorkspace(dirname(configPath), input.rule, input.subject, candidate);
              return send(res, 200, JSON.stringify({ ok: true }));
            }
            if (input.action === "push" && data.runs.some(run => matches(run) && ["claimed", "unknown"].includes(run.state)))
              return error(res, 409, "请等 Worker 结束当前轮次再推送");
            await taskBranchAction(dirname(configPath), input, data.issueDispositions ?? [], async (params) => {
              const response = await request("/v1/issues/disposition", { rule: input.rule, subject: input.subject, ...params });
              const result = await response.json();
              if (!response.ok) throw new Error(result.error ?? "Hub 无法交接任务");
              return result;
            });
            return send(res, 200, JSON.stringify({ ok: true }));
          } catch (cause) {
            return error(res, 409, cause.code ? "无法核实 Git 分支或工作区状态" : cause.message);
          } finally {
            branchActionInProgress = false;
          }
        }
        if (input?.action === "remove") {
          if (input.confirmation !== "yes,delete it")
            return error(res, 400, "请准确输入确认文字");
          const state = await fetch(new URL("/v1/state", hub), {
            headers: { authorization: `Bearer ${config.owner}` },
            redirect: "error", signal: AbortSignal.timeout(5000),
          });
          if (!state.ok) return error(res, 502, "无法核实任务状态");
          const { issueDispositions, runs } = await state.json();
          const matches = (item) => item.rule === input.rule && item.subject === input.subject;
          if (!issueDispositions?.some((item) => matches(item) && item.closed && !item.appHandoff) ||
              runs?.some((run) => matches(run) && ["queued", "claimed", "unknown"].includes(run.state)))
            return error(res, 409, "只能删除已结案且没有活动轮次的任务工作区");
          try {
            if (!(await removeTaskWorkspace(dirname(configPath), input)))
              return error(res, 404, "找不到已登记的任务工作区");
          } catch {
            return error(res, 409, "Git 拒绝移除工作区。请核对是否有未提交的改动、锁定或分支不符");
          }
          return send(res, 200, JSON.stringify({ ok: true }));
        }
        if (!input || !(await openTaskWorkspace(dirname(configPath), input)))
          return error(res, 404, "找不到已登记的任务工作区");
        return send(res, 200, JSON.stringify({ ok: true }));
      }
      if (octoAction) {
        if (!(octoAction === "notify" ? canNotify : canCollect))
          return error(res, 409, "看板未配置此 Octo 操作");
        let input;
        try { input = JSON.parse(body); } catch { return error(res, 400, "Octo 操作参数无效"); }
        const { issue, stage, dryRun, testAddress, rule } = input ?? {};
        const validIssue = typeof issue === "string" && /^[A-Z][A-Z0-9_-]{0,69}-\d{1,9}$/.test(issue);
        if (!validIssue || (octoAction === "notify" ? !["test", "release"].includes(stage) : typeof dryRun !== "boolean"))
          return error(res, 400, "Issue 编号或操作参数无效");
        if (octoAction === "notify" && stage === "test" &&
            (typeof testAddress !== "string" || !testAddress.trim() || testAddress.length > 500))
          return error(res, 400, "请输入有效的 HTTPS 测试环境地址");
        if (octoAction === "notify" && (typeof rule !== "string" || !rule.trim() || rule.length > 500))
          return error(res, 400, "请选择要通知的项目");
        if (octoAction === "collect" && rule !== undefined &&
            (typeof rule !== "string" || !rule.trim() || rule.length > 500))
          return error(res, 400, "指定规则名称无效");
        const args = octoAction === "notify"
          ? ["--rule", rule, issue, stage, ...(stage === "test" ? [testAddress.trim()] : [])]
          : ["--issue", issue, ...(rule ? [`--rule=${rule}`] : []), dryRun ? "--dry-run" : "--log-events"];
        try {
          const execute = () => run(process.execPath, ["--disable-warning=ExperimentalWarning", cli, "octo", octoAction, ...args], {
            env: { ...process.env, AGENT_AUTOLOOP_HOME: dirname(configPath) },
            timeout: 120_000,
            maxBuffer: octoAction === "collect" ? 1024 * 1024 : 64 * 1024,
          });
          const { stdout } = await (octoAction === "collect" && !dryRun
            ? collectManually(dirname(configPath), issue, rule, execute) : execute());
          return send(res, 200, JSON.stringify({ message: stdout.trim() }));
        } catch (failure) {
          if (octoAction === "collect") {
            if (failure.message === "已有采集正在执行，请稍后再试") return error(res, 409, failure.message);
            if (failure.stdout?.trim()) return send(res, 409, JSON.stringify({ error: failure.stdout.trim() }));
            return error(res, 502, "采集未完成，请核对 Octo CLI 登录和采集配置");
          }
          const detail = notificationErrors.find((message) => failure.stderr?.split("\n").some((line) => line.trim() === message));
          return error(res, 502, detail || "无法确认通知结果，请先核对 Octo 需求通知子区");
        }
      }
      const response = await fetch(new URL(`/v1/${ownerAction}`, hub), {
        method: "POST", body, redirect: "error", signal: AbortSignal.timeout(5000),
        headers: { authorization: `Bearer ${config.owner}`, "content-type": "application/json" },
      });
      return send(res, response.status, JSON.stringify(await response.json()));
    } catch {
      return error(res, 502, "无法确认 Hub 是否已处理，请刷新查看");
    } finally {
      activeActions--;
    }
  }
  if (req.method !== "GET") return error(res, 405, "不支持此操作");
  const asset = assets.get(url.pathname);
  if (asset) {
    try {
      return send(res, 200, readFileSync(new URL(asset[0], import.meta.url)), asset[1]);
    } catch {
      return error(res, 500, "页面文件无法读取");
    }
  }
  const id = /^\/api\/runs\/([1-9]\d*)\/why$/.exec(url.pathname)?.[1];
  if (id && !Number.isSafeInteger(Number(id))) return error(res, 400, "轮次编号无效");
  const cardHistory = url.pathname === "/api/cards/history";
  if (url.pathname !== "/api/state" && !id && !cardHistory) return error(res, 404, "没有这个地址");
  const before = url.searchParams.get("before");
  if (before !== null && !/^[1-9]\d*$/.test(before)) return error(res, 400, "分页编号无效");
  if (demo) return send(res, 200, JSON.stringify(cardHistory ? url.searchParams.get("subject") === "loop:demo:issue-123" ? demo.cardHistory : [] : id ? demo.why(Number(id)) : demo.snapshot));
  const route = cardHistory ? `/v1/cards/history${url.search}` : id ? `/v1/runs/${id}/why` : `/v1/state${before ? `?before=${before}` : ""}`;
  try {
    const response = await fetch(new URL(route, hub), {
      headers: { authorization: `Bearer ${config.owner}` },
      redirect: "error",
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return error(res, response.status, response.status === 404 ? "没有这一轮" : `Hub 返回 ${response.status}`);
    const data = await response.json();
    return send(res, 200, JSON.stringify(id || before || cardHistory ? data : { ...data, canNotify, canCollect }));
  } catch {
    return error(res, 502, "连接不到 Hub，请确认本机 Hub 已启动");
  }
});
server.listen(port, "127.0.0.1", () => console.log(`本机看板 http://${address}${demo ? "（演示数据）" : ""}`));
