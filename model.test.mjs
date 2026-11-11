import assert from "node:assert/strict";
import { test } from "node:test";
import { handoffControl, issueGroups, octoIssueNumber, taskIndicators, taskStatus, timelineFor } from "./model.mjs";

test("returning from App distinguishes waiting, CLI execution and readiness for handoff", () => {
  const run = { state: "queued", events: [{ type: "app.returned" }] };
  assert.equal(handoffControl({ disposition: { appHandoff: {} }, runs: [run] }).label, "App 正在接手中");
  assert.deepEqual(handoffControl({ runs: [run] }), { label: "已交回 CLI · 排队中", disabled: true });
  assert.deepEqual(handoffControl({ runs: [{ ...run, state: "claimed" }] }), { label: "CLI 正在续办", disabled: true });
  assert.deepEqual(handoffControl({ runs: [{ ...run, state: "done" }] }), { label: "转 App 接手", disabled: false });
});

test("groups by rule and subject and retains pending cards on older runs", () => {
  const issues = issueGroups({
    runs: [
      { id: 5, rule: "A", subject: "x", state: "queued", events: [{ type: "reply", link: "javascript:alert(1)" }] },
      { id: 4, rule: "A", subject: "x", state: "done", events: [{ type: "created", source: "octo-issue", link: "https://example.invalid/issues/x" }] },
      { id: 3, rule: "B", subject: "x", state: "claimed" },
    ],
    cards: [{ id: 1, runId: 1, rule: "A", subject: "x", kind: "ask", state: "open" }],
  });
  assert.equal(issues.length, 2);
  assert.deepEqual(issues[0].runs.map((run) => run.id), [5, 4]);
  assert.equal(issues[0].cards[0].runId, 1);
  assert.equal(issues[1].cards.length, 0);
  assert.deepEqual(issues[0].links, [{ source: "octo-issue", url: "https://example.invalid/issues/x" }]);
});

test("an independent card remains selectable after archive and close", () => {
  const card = { id: 2, kind: "ask", state: "open", title: "审批演练" };
  const [open] = issueGroups({ runs: [], cards: [card] });
  const disposition = { target: open.target, rule: open.rule, title: card.title, archived: true, closed: true };
  const [closed] = issueGroups({ runs: [], cards: [], issueDispositions: [disposition] });
  assert.deepEqual(open.target, { kind: "card", id: 2 });
  assert.equal(closed.key, open.key);
  assert.equal(closed.title, card.title);
  assert.equal(closed.disposition, disposition);
});

test("notification controls require an unambiguous Octo Issue link", () => {
  const url = "https://example.invalid/fleet/demo-workspace/issues/DEMO-256";
  const octo = { source: "octo-issue", url };
  assert.equal(octoIssueNumber({ links: [octo] }), "DEMO-256");
  assert.equal(octoIssueNumber({ links: [{ source: "other", url }] }), undefined);
  assert.equal(octoIssueNumber({ links: [octo, { ...octo, url: url.replace("256", "257") }] }), undefined);
});

test("finished rounds do not imply task completion or testing", () => {
  const run = { id: 4, rule: "A", subject: "issue-1", state: "done" };
  const card = { id: 9, runId: 4, state: "closed", result: "分支已推送，等待人工测试" };
  const [issue] = issueGroups({ runs: [run], cards: [], recentCards: [card] });
  assert.equal(taskStatus(issue), "followup");
  assert.equal(issue.lastResolution, card);
  const testing = { ...issue, disposition: { stage: "testing" } };
  assert.equal(taskStatus(testing), "testing");
  assert.equal(taskStatus({ ...testing, runs: [{ ...run, state: "claimed" }] }), "running");
  assert.equal(taskStatus({ ...issue, disposition: { closed: true } }), "closed");
});

test("timeline keeps unrelated facts out of the selected run", () => {
  const changes = [
    { table: "run_events", key: "1:2", row: { run_id: 1, event_id: 2 } },
    { table: "events", key: "2", row: { id: 2, type: "task.report.created", detail: "相关正文" } },
    { table: "events", key: "9", row: { id: 9, type: "other", detail: "无关" } },
    { table: "runs", key: "1", row: { id: 1, state: "queued" } },
    { table: "cards", key: "4", row: { id: 4, run_id: 1, title: "确认方案", kind: "ask" } },
  ];
  const details = timelineFor([{ at: 1, type: "ingest", changes }], 1);
  assert.deepEqual(details.events.map((event) => event.id), [2]);
  assert.deepEqual(details.cards.map((card) => card.id), [4]);
  assert.equal(details.entries.length, 3);
});

test("business stage, concurrent round states and pending cards remain independently visible", () => {
  const issue = {
    disposition: { stage: "coding", stageLabel: "编码中" },
    runs: [
      { state: "claimed" }, { state: "claimed", stopping: true }, { state: "queued", attempts: 1 },
      { state: "queued" }, { state: "unknown" }, { state: "done" },
    ],
    cards: [{}],
  };
  assert.deepEqual(taskIndicators(issue).map(({ key }) => key), [
    "coding", "running", "stopping", "queued", "retrying", "unknown", "waiting",
  ]);
  const closed = {
    disposition: { closed: true, archived: true, history: [{ label: "已上线" }] },
    runs: [{ state: "done" }], cards: [],
  };
  assert.deepEqual(taskIndicators(closed).map(({ label }) => label), ["已上线", "已结案", "已归档", "暂无活动轮次"]);
});
