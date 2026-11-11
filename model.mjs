export const states = {
  queued: "排队", claimed: "运行中", done: "已完成轮次", nothing: "无事可做",
  cancelled: "已取消", unknown: "状态不确定",
};

export function handoffControl(issue) {
  if (issue.disposition?.localDebug) return { label: "本地调试中，请先交回 worktree 工作区", disabled: true };
  if (issue.disposition?.appHandoff) return { label: "App 正在接手中", disabled: true };
  if (issue.runs.some(({ sessionBlocked }) => sessionBlocked))
    return { label: "原会话待重试", disabled: true };
  if (issue.runs.some(({ state }) => state === "unknown"))
    return { label: "执行状态待核对", disabled: true };
  const returned = ({ events = [] }) => events.some(({ type }) => type === "app.returned");
  const running = issue.runs.find(({ state }) => state === "claimed");
  if (running) return { label: returned(running) ? "CLI 正在续办" : "CLI 执行中", disabled: true };
  if (issue.runs.some((run) => run.state === "queued" && returned(run)))
    return { label: "已交回 CLI · 排队中", disabled: true };
  return { label: "转 App 接手", disabled: false };
}

export function taskStatus(issue) {
  if (issue.progress) return issue.progress.status;
  if (issue.disposition?.closed) return "closed";
  if (issue.disposition?.stageLabel) return issue.disposition.stage;
  if (issue.runs.some(({ state }) => state === "unknown")) return "unknown";
  if (issue.runs.some(({ state }) => state === "claimed")) return "running";
  if (issue.runs.some(({ state }) => state === "queued")) return "queued";
  if (issue.cards.length) return "waiting";
  if (issue.disposition?.stage === "testing") return "testing";
  if (issue.answeredCard) return "answered";
  return "followup";
}

export function taskIndicators(issue) {
  const indicators = [];
  const { disposition, runs, cards } = issue;
  const add = (dimension, key, label, style) => indicators.push({ dimension, key, label, style });
  const manual = !disposition?.closed && disposition?.manualStatus;
  if (manual) {
    add("手动状态", manual.status, manual.label, "waiting");
  } else if (disposition?.stageLabel) {
    const { stage, stageLabel } = disposition;
    const style = ["coded", "testing", "test_branch_pushed", "delivered", "released"].includes(stage) ? "done" : "waiting";
    add("开发", stage === "test_approved" ? "deployed" : stage, stageLabel, style);
  } else if (disposition?.closed && disposition.history?.length) {
    add("结案前阶段", "", disposition.history.at(-1).label, "done");
  } else if (disposition?.stage === "testing") {
    add("开发", "testing", "提测中", "claimed");
  }
  if (disposition?.closed) add("任务", "closed", "已结案", "done");
  if (disposition?.archived) add("归档", "archived", "已归档", "");
  if (disposition?.appHandoff) add("执行", "app-handoff", "App 接手中", "waiting");
  if (disposition?.localDebug) add("执行", "local-debug", "本地调试中", "waiting");
  for (const [key, label, style, match] of [
    ["running", "运行中", "claimed", (run) => run.state === "claimed" && !run.stopping],
    ["stopping", "停止中", "claimed", (run) => run.state === "claimed" && run.stopping],
    ["session-blocked", "原会话待重试", "waiting", (run) => run.sessionBlocked],
    ["queued", "排队中", "queued", (run) => run.state === "queued" && !run.sessionBlocked && !run.attempts],
    ["retrying", "待重试", "queued", (run) => run.state === "queued" && !run.sessionBlocked && run.attempts],
    ["unknown", "待核对", "unknown", (run) => run.state === "unknown"],
  ]) {
    const count = runs.filter(match).length;
    if (count) add("执行", key, `${label} ${count} 轮`, style);
  }
  if (cards.length) add("卡片", "waiting", `${cards.length} 张待确认或回复`, "waiting");
  else if (issue.answeredCard) add("卡片", "answered", "已回复", "done");
  if (!manual && taskStatus(issue) === "followup") add("任务", "followup", issue.progress?.label ?? "待跟进", "waiting");
  if (runs.length && !indicators.some(({ dimension }) => dimension === "执行"))
    add("执行", "idle", "暂无活动轮次", "");
  return indicators;
}

export function sourceUrl(value) {
  if (typeof value !== "string" || !value) return;
  try {
    const url = new URL(value);
    if (["https:", "http:"].includes(url.protocol) && !url.username && !url.password) return url.href;
  } catch {}
}

export function octoIssueNumber(issue) {
  const numbers = new Set();
  for (const { source, url } of issue.links) {
    if (source !== "octo-issue") continue;
    const number = /^\/fleet\/[^/]+\/issues\/([A-Z][A-Z0-9_-]{0,69}-\d{1,9})\/?$/i.exec(new URL(url).pathname)?.[1];
    if (number) numbers.add(number.toUpperCase());
  }
  return numbers.size === 1 ? [...numbers][0] : undefined;
}

export function issueGroups(snapshot) {
  const groups = new Map();
  const byRun = new Map();
  function group(rule, subject, target) {
    const key = target ? JSON.stringify([target.kind, target.id]) : JSON.stringify([rule, subject]);
    if (!groups.has(key)) groups.set(key, { key, rule, subject, target, runs: [], cards: [] });
    return groups.get(key);
  }
  for (const run of snapshot.runs) {
    const issue = group(run.rule, run.subject || "", run.subject ? undefined : { kind: "run", id: run.id });
    issue.runs.push(run);
    byRun.set(run.id, issue);
  }
  for (const card of snapshot.cards) {
    if (card.state !== "open" || card.kind !== "ask") continue;
    const issue = byRun.get(card.runId) ?? (card.runId && card.subject
      ? group(card.rule || "未归属", card.subject)
      : group(card.rule || "未归属", "", card.runId
        ? { kind: "run", id: card.runId }
        : { kind: "card", id: card.id }));
    issue.cards.push(card);
  }
  for (const card of snapshot.recentCards ?? []) {
    if (card.state === "closed" && card.result) {
      const issue = byRun.get(card.runId) ?? (card.subject && groups.get(JSON.stringify([card.rule, card.subject])));
      if (issue && (!issue.lastResolution || (card.closedAt ?? "") > (issue.lastResolution.closedAt ?? "")))
        issue.lastResolution = card;
    }
    if (card.kind !== "ask" || card.runId || card.state !== "decided") continue;
    group(card.rule || "未归属", "", { kind: "card", id: card.id }).answeredCard = card;
  }
  for (const disposition of snapshot.issueDispositions ?? []) {
    if (disposition.target) {
      group(disposition.rule, "", disposition.target).disposition = disposition;
    } else {
      const issue = groups.get(JSON.stringify([disposition.rule, disposition.subject]));
      if (issue) issue.disposition = disposition;
    }
  }
  for (const issue of groups.values()) {
    issue.progress = snapshot.issueStatuses?.[issue.key];
    issue.runs.sort((a, b) => b.id - a.id);
    issue.taskId = issue.runs.find(({ taskId }) => taskId)?.taskId
      ?? issue.cards.find(({ taskId }) => taskId)?.taskId ?? issue.answeredCard?.taskId
      ?? (issue.target ? `${issue.target.kind === "card" ? "C" : "T"}-${issue.target.id}` : undefined);
    const events = issue.runs.flatMap((run) => run.events ?? []);
    issue.sources = [...new Set(events.map((event) => event.source).filter(Boolean))];
    const links = new Map();
    for (const event of events) {
      const url = sourceUrl(event.link);
      if (url && !links.has(url)) links.set(url, { source: event.source, url });
    }
    issue.links = [...links.values()];
    issue.title = events.find(
      (event) => event.summary && (event.type.endsWith(".created") || event.type.endsWith(".comment")),
    )?.summary || issue.subject || issue.cards[0]?.title || issue.answeredCard?.title || issue.disposition?.title || `第 ${issue.runs[0]?.id} 轮`;
    issue.latest = Math.max(0, ...issue.runs.map((run) => run.id), ...issue.cards.map((card) => card.runId ?? 0));
  }
  return [...groups.values()].sort((a, b) => b.latest - a.latest);
}

export function timelineFor(facts, runId) {
  const changes = facts.flatMap((fact) => fact.changes);
  const related = new Set(changes.filter(({ table, row }) => table === "run_events" && row?.run_id === runId)
    .map(({ row }) => row.event_id));
  const versions = new Set(changes.filter(({ table, row }) => table === "runs" && row?.id === runId)
    .map(({ row }) => row.rules_version));
  const entries = [];
  const previous = new Map();
  const starts = new Set();
  let run;
  const events = new Map();
  const cards = new Map();
  for (const fact of facts) {
    const add = (title, detail = "", at = fact.at) => entries.push({ at, title, detail });
    if (fact.type === "rules" && versions.has(fact.seq)) add(`规则版本 #${fact.seq}`);
    for (const { table, key, row } of fact.changes) {
      const before = previous.get(`${table}:${key}`);
      if (row && table === "runs" && row.id === runId) {
        run = row;
        if (!before) add("进入队列", "", row.created_at || fact.at);
        if (row.claimed_at && row.claimed_at !== before?.claimed_at) add("Worker 领取", row.agent, row.claimed_at);
        if (fact.type === "started" && !starts.has(row.issued)) {
          add("开始执行", row.session);
          starts.add(row.issued);
        }
        if (row.session_blocked && !before?.session_blocked) add("原会话待重试", row.error);
        if (!row.session_blocked && before?.session_blocked && fact.type === "retrySession") add("已重试原会话");
        else if (row.attempts > (before?.attempts ?? 0)) add("执行失败，等待重试", row.error);
        if (row.finished_at && row.finished_at !== before?.finished_at)
          add(states[row.state] ?? row.state, row.summary || row.error, row.finished_at);
        if (row.state === "unknown" && before?.state !== "unknown") add("运行状态不确定");
      }
      if (row && table === "events" && related.has(row.id)) {
        events.set(row.id, row);
        if (!before) add(`收到事件 · ${row.type}`, row.summary || row.subject, row.received_at || fact.at);
      }
      if (row && table === "cards" && (row.run_id === runId || related.has(row.answer_event))) {
        cards.set(row.id, row);
        if (!before && row.run_id === runId) add(row.kind === "ask" ? "发出确认卡" : "发出通知", row.title, row.created_at || fact.at);
        if (row.decided_at && row.decided_at !== before?.decided_at) {
          const options = Array.isArray(row.options) ? row.options : JSON.parse(row.options || "[]");
          add("收到回答", row.answer || options[row.choice] || row.title, row.decided_at);
        }
        if (row.closed_at && row.closed_at !== before?.closed_at)
          add("卡片已处理", row.result || row.title, row.closed_at);
      }
      previous.set(`${table}:${key}`, row);
    }
  }
  return { entries: entries.sort((a, b) => new Date(a.at) - new Date(b.at)), run, events: [...events.values()], cards: [...cards.values()] };
}
