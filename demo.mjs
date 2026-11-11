const now = "2026-11-09T09:12:00+08:00";
const issue = (id, rule, subject, summary, state, createdAt) => ({
  id, rule, subject, state, createdAt, agent: "codex", attempts: 0,
  taskId: subject.endsWith("123") ? "T-102" : `T-${id}`, number: id === 104 ? 2 : 1,
  claimedAt: state === "queued" ? null : createdAt,
  session: state === "queued" ? null : "00000000-0000-4000-8000-000000000102",
  finishedAt: state === "done" ? now : null,
  summary: state === "done" ? "已核实影响范围，提交方案待确认。" : "",
  events: [{
    source: "octo-issue",
    type: rule.startsWith("同步") ? "task.sync.created" : "task.reporting.created",
    subject, summary, link: `https://octo.example.invalid/fleet/demo-workspace/issues/${summary.split(" ")[0]}`,
  }],
});
const runs = [
  issue(104, "报表项目", "loop:demo:issue-123", "DEMO-123 修复导出失败", "queued", now),
  issue(103, "同步项目", "loop:demo:issue-456", "DEMO-456 排查数据同步延迟", "claimed", "2026-11-09T09:09:00+08:00"),
  issue(102, "报表项目", "loop:demo:issue-123", "DEMO-123 修复导出失败", "done", "2026-11-09T09:02:00+08:00"),
  { ...issue(101, "报表项目", "loop:demo:issue-087", "DEMO-87 核对报表口径", "done", "2026-11-09T08:40:00+08:00"), summary: "已核对查询范围并记录结论。" },
];
const card = {
  id: 19, kind: "ask", state: "open", runId: 102, rule: "报表项目", subject: "loop:demo:issue-123",
  title: "确认导出修复方案", text: "修改范围：报表导出接口与相关测试。\n验收：导出正常，空结果返回清晰提示。",
  options: ["确认方案和范围", "退回修改"], createdAt: now,
};
export const snapshot = {
  demo: true, now, runs, cards: [card], nextBefore: null,
  canCollect: true, canNotify: true, supportsBusinessStages: true, supportsAppHandoff: true,
  supportsLocalRecords: true, supportsLatestSessionRetry: true,
  agents: [{ id: "codex", use: "codex", name: "Codex" }],
  lines: [
    { name: "报表项目", types: ["task.reporting.created", "task.reporting.comment"] },
    { name: "同步项目", types: ["task.sync.created", "task.sync.comment"] },
  ],
  issueDispositions: [
    { rule: "报表项目", subject: "loop:demo:issue-087", closed: true, closedAt: now, reason: "已完成报表口径核对" },
    { rule: "报表项目", subject: "loop:demo:issue-123", stageLabel: "方案确认", stage: "review",
      appHandoff: { id: 12, run: 102, link: "codex://threads/00000000-0000-4000-8000-000000000102", at: now },
      history: [{ at: "2026-11-09T09:02:00+08:00", label: "已接收" }, { at: now, label: "等待方案确认" }],
      localRecords: [{ id: "demo-record", at: now, source: "app", text: "已复现空结果导出问题，并补充了验收步骤。" }],
      progressNotes: [
      { at: now, text: "已定位空结果导出失败的原因，修复方案等待确认。" },
    ] },
  ],
};
export function why(id) {
  const run = runs.find((r) => r.id === id);
  if (!run) return [];
  const change = (table, key, row) => ({ table, key: String(key), row });
  const row = { ...run, created_at: run.createdAt, claimed_at: null, finished_at: null, state: "queued" };
  const facts = [{ seq: 1, at: Date.parse(run.createdAt), type: "ingest", changes: [
    change("events", id, { ...run.events[0], id, detail: "演示事件。此内容不来自真实 Issue。", received_at: run.createdAt }),
    change("runs", id, row),
    change("run_events", `${id}:${id}`, { run_id: id, event_id: id }),
  ] }];
  if (run.claimedAt) facts.push({ seq: 2, at: Date.parse(run.claimedAt), type: "claim", changes: [
    change("runs", id, { ...row, state: "claimed", claimed_at: run.claimedAt }),
  ] });
  if (run.finishedAt) facts.push({ seq: 3, at: Date.parse(run.finishedAt), type: "finish", changes: [
    change("runs", id, { ...row, claimed_at: run.claimedAt, state: run.state, finished_at: run.finishedAt }),
    ...(id === card.runId ? [change("cards", card.id, { ...card, run_id: id, created_at: card.createdAt })] : []),
  ] });
  return facts;
}

const event = {
  rule: "报表项目", subject: "loop:demo:issue-123", type: "task.reporting.created",
  title: "DEMO-123 修复导出失败", hubEvent: 205, outcome: "Hub 已接收",
};
const scheduled = { startedAt: now, finishedAt: now, ok: true, eligible: 3, created: 1, comments: 0, events: [event] };
export const collector = {
  running: true, enabled: true, collecting: false, intervalSeconds: 600,
  nextAt: "2026-11-09T09:22:00+08:00", last: scheduled, logs: [scheduled, {
    mode: "manual", issue: "DEMO-456", rule: "同步项目", startedAt: "2026-11-09T09:08:00+08:00",
    finishedAt: "2026-11-09T09:08:01+08:00", ok: true, eligible: 1, created: 1, comments: 0,
    events: [{ ...event, rule: "同步项目", subject: "loop:demo:issue-456", title: "DEMO-456 排查数据同步延迟",
      type: "task.sync.created", hubEvent: 204 }],
  }],
};
export const repositories = [{
  name: "reporting-api", branch: "fea_DEMO123", workspace: true,
  repositoryUrl: "https://code.example.invalid/demo/reporting-api",
  remoteBranches: [{ name: "fea_DEMO123", url: "https://code.example.invalid/demo/reporting-api/tree/fea_DEMO123" }],
  localSwitch: { command: "git checkout fea_DEMO123" },
}];
export const cardHistory = [{
  id: 17, title: "确认验收范围", text: "覆盖正常导出和空结果两种场景。", state: "done",
  options: ["确认方案和范围", "退回修改"], choice: 0, decidedAt: now, by: "示例负责人",
  answer: "已确认验收范围。", result: "已记录并继续处理。",
}];
export const log = {
  turn: 1, truncated: false, files: [{ path: "src/export.ts", kinds: ["修改"] }],
  entries: [
    { kind: "message", text: "已定位到空结果导出的分支，先核对现有用例。" },
    { kind: "command", id: "test", command: "node --test tests/export.test.mjs",
      exitCode: 0, output: "✔ exports rows\n✔ handles empty results\nℹ tests 2\nℹ pass 2\nℹ fail 0" },
    { kind: "file", text: "文件变更\n修改 · src/export.ts" },
    { kind: "status", text: "Codex 执行完成" },
  ],
};
