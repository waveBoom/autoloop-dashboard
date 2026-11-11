import { handoffControl, issueGroups, octoIssueNumber, sourceUrl, states, taskIndicators, taskStatus, timelineFor } from "./model.mjs";

const byId = (id) => document.getElementById(id);
const date = new Intl.DateTimeFormat("zh-CN", { dateStyle: "short", timeStyle: "medium", timeZone: "Asia/Shanghai" });
const time = (value) => value && Number.isFinite(new Date(value).valueOf()) ? date.format(new Date(value)) : "—";
function el(tag, text = "", className = "") {
  const node = document.createElement(tag);
  node.textContent = text;
  node.className = className;
  return node;
}

function actionDialog(title, message, { value, confirmText = "确认", required = false, alternateText } = {}) {
  return new Promise((resolve) => {
    const previousFocus = document.activeElement;
    const dialog = el("dialog", "", "action-dialog");
    const form = el("form");
    const heading = el("h2", title);
    heading.id = "action-dialog-title";
    const description = el("p", message);
    description.id = "action-dialog-description";
    dialog.setAttribute("aria-labelledby", heading.id);
    dialog.setAttribute("aria-describedby", description.id);
    form.append(heading, description);
    let input;
    if (value !== undefined) {
      input = el("textarea");
      input.value = value;
      input.rows = 3;
      input.required = required;
      input.setAttribute("aria-label", title);
      form.append(input);
    }
    const actions = el("div", "", "action-dialog-actions");
    const cancel = el("button", "取消");
    cancel.type = "button";
    cancel.onclick = () => dialog.close();
    const confirm = el("button", confirmText, "action-dialog-confirm");
    actions.append(cancel);
    if (alternateText) {
      const alternate = el("button", alternateText);
      alternate.type = "button";
      alternate.onclick = () => {
        result = false;
        dialog.close();
      };
      actions.append(alternate);
    }
    actions.append(confirm);
    form.append(actions);
    let result = null;
    form.onsubmit = (event) => {
      event.preventDefault();
      if (required && !input.value.trim()) return;
      result = input ? input.value : true;
      dialog.close();
    };
    dialog.append(form);
    dialog.onclose = () => {
      dialog.remove();
      if (previousFocus?.isConnected) previousFocus.focus();
      resolve(result);
    };
    document.body.append(dialog);
    dialog.showModal();
    (input ?? cancel).focus();
  });
}

const collapsedButtons = new WeakMap();
const collapsedTextObserver = new ResizeObserver((entries) => {
  for (const { target } of entries) {
    if (!target.clientWidth || !target.classList.contains("result-text-clamped")) continue;
    collapsedButtons.get(target).hidden = target.scrollHeight <= target.clientHeight + 1;
  }
});

function collapsibleResult(text) {
  const block = el("div", "", "result-text-block");
  const body = el("p", text, "result-text result-text-clamped");
  const button = el("button", "展开", "result-text-toggle");
  button.type = "button";
  button.hidden = true;
  button.setAttribute("aria-expanded", "false");
  button.onclick = () => {
    const collapsed = body.classList.toggle("result-text-clamped");
    button.textContent = collapsed ? "展开" : "收起";
    button.setAttribute("aria-expanded", String(!collapsed));
  };
  body.dataset.collapsibleText = "";
  collapsedButtons.set(body, button);
  collapsedTextObserver.observe(body);
  block.append(body, button);
  return block;
}
const badge = (label, kind) => el("span", label, `badge ${kind}`);
const indicatorBadge = ({ dimension, label, style }) => badge(`${dimension} · ${label}`, style);
const runLabel = (run) => run.sessionBlocked ? "原会话待重试" :
  run.state === "queued" && run.attempts ? "待重试" : states[run.state] ?? run.state;
const roundLabel = (run, id = run?.id) => run?.number ? `第 ${run.number} 轮` : `轮次 #${id}`;
const sourceName = (name) => name === "octo-issue" ? "Octo Issue" : name || "原始来源";

function sourceAnchor(url, label) {
  const anchor = el("a", label, "source-link");
  anchor.href = url;
  anchor.target = "_blank";
  anchor.rel = "noopener noreferrer";
  anchor.title = url;
  return anchor;
}

let snapshot;
let groups = [];
let selected;
let selectedRun;
let detailTab = "overview";
let nextBefore;
let older = new Map();
const olderIssueStatuses = {};
let refreshing = false;
let refreshQueued = false;
let reloading = false;
let paging = false;
let traceVersion = 0;
let renderedIssue;
const notificationStates = new Map();
const dispositionErrors = new Map();
const taskMessages = new Map();
const appRecordSelections = new Map();
const localRecordsExpanded = new Map();
const replyDrafts = new Map();

async function get(path) {
  const response = await fetch(path, { cache: "no-store" });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? "读取失败");
  return data;
}

async function post(path, body) {
  const response = await fetch(path, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? "操作失败");
  return data;
}

async function taskAction(issue, path, body, message) {
  try {
    const result = await post(path, body);
    let outcome = result.changed === false ? "卡片已经处理，请查看最新状态。" : message;
    if (result.notificationQueued) outcome = "已确认提测，Hub 正在处理通知。";
    taskMessages.set(issue.key, outcome);
    await refresh(true);
    return true;
  } catch (error) {
    taskMessages.set(issue.key, error.message);
    return false;
  } finally {
    renderIssue();
  }
}

function progressControls(issue) {
  const toolbar = el("div", "", "progress-toolbar");
  const forms = el("div");
  const controls = [];
  for (const [title, action, field] of [
    ["改状态", "set-display-status", "status"],
    ["加进展", "add-progress", "reason"],
  ]) {
    if (field === "status" && issue.disposition?.closed) continue;
    const trigger = el("button", field === "reason" ? "＋ 加进展" : title, field === "reason" ? "progress-add" : "");
    trigger.setAttribute("aria-expanded", "false");
    trigger.setAttribute("aria-controls", `progress-form-${field}`);
    const editor = el("div", "", "progress-inline-form");
    editor.id = `progress-form-${field}`;
    editor.hidden = true;
    controls.push({ trigger, editor });
    const form = el("form", "", "reply-form");
    const fields = el("fieldset");
    const input = el(field === "status" ? "select" : "textarea");
    input.setAttribute("aria-label", field === "status" ? "展示状态" : "进展内容");
    input.required = true;
    if (field === "status") {
      for (const [key, label] of Object.entries({ auto: "使用自动状态", ...snapshot.manualStatusLabels })) {
        const option = el("option", label);
        option.value = key;
        input.append(option);
      }
      input.value = issue.disposition?.manualStatus?.status ?? "auto";
    } else {
      input.placeholder = "例如：正在生产环境重跑报告";
      input.maxLength = 500;
      input.rows = 2;
    }
    const button = el("button", field === "status" ? "保存状态" : "记录进展");
    form.onsubmit = async (event) => {
      event.preventDefault();
      const value = input.value.trim();
      if (!value) return;
      fields.disabled = true;
      const saved = await taskAction(issue, "/api/issues/disposition", {
        rule: issue.rule, subject: issue.subject, action, [field]: value,
      }, field === "status" ? "展示状态已保存。" : "已记录进展。");
      if (saved && field === "reason") input.value = "";
      fields.disabled = false;
    };
    fields.append(input, button);
    form.append(fields);
    editor.append(el("p", field === "status"
      ? "下次自动推进时会采用新的业务状态。"
      : "进展会显示在看板和 Octo 的查进度结果中。", "meta"), form);
    trigger.onclick = () => {
      const opening = editor.hidden;
      for (const control of controls) {
        const visible = opening && control.editor === editor;
        control.editor.hidden = !visible;
        control.trigger.setAttribute("aria-expanded", String(visible));
      }
      if (opening) input.focus();
    };
    toolbar.append(trigger);
    forms.append(editor);
  }
  return { toolbar, forms };
}

function sessionAction(button) {
  const wrapper = el("div", "", "app-handoff-action");
  const hint = el("span", "", "app-handoff-hint");
  wrapper.append(button, hint);
  return { wrapper, setReason(reason) {
    button.disabled = Boolean(reason);
    hint.textContent = reason;
    hint.hidden = !reason;
  } };
}

function appHandoffButton(issue, run) {
  const { label, disabled } = handoffControl(issue);
  const button = el("button", "转 App 接手", "app-handoff-button");
  const { wrapper, setReason } = sessionAction(button);
  setReason(issue.disposition?.closed ? "任务已结案" : disabled ? label : run ? "" : "暂无可用的 Codex 会话");
  if (!button.disabled) button.title = `使用${roundLabel(run)}的 Codex 会话`;
  if (!button.disabled) button.onclick = async () => {
    if (!await actionDialog("转 App 接手", `Hub 会暂停派发，并打开${roundLabel(run)}的 Codex 会话。`)) return;
    button.disabled = true;
    const done = await taskAction(issue, "/api/issues/disposition", {
      rule: issue.rule, subject: issue.subject, action: "app-handoff", run: run.id,
    }, "已暂停派发，可以在 Codex App 中继续。");
    if (done) window.location.href = run.link;
    else button.disabled = false;
  };
  return wrapper;
}

function localRecordsPanel(issue, handoffTools) {
  const section = el("details", "", "overview-card overview-local-records");
  const handoff = issue.disposition?.appHandoff;
  const records = issue.disposition?.localRecords ?? [];
  const defaultExpanded = Boolean(handoff);
  section.open = localRecordsExpanded.get(issue.key) ?? defaultExpanded;
  section.ontoggle = () => {
    if (!section.isConnected) return;
    if (section.open === defaultExpanded) localRecordsExpanded.delete(issue.key);
    else localRecordsExpanded.set(issue.key, section.open);
  };
  const recordIds = new Set(records.map(({ id }) => id));
  const chosen = new Set([...(appRecordSelections.get(handoff?.id) ?? [records.at(-1)?.id])]
    .filter((id) => recordIds.has(id)));
  const request = { rule: issue.rule, subject: issue.subject };
  const heading = el("summary", `本地处理记录 · ${records.length} 条`);
  heading.append(el("span", "仅看板可见", "local-record-badge"));
  section.append(heading);
  const recordForm = (record) => {
    const editor = el("details", "", "local-record-editor");
    const form = el("form", "", "reply-form");
    const fields = el("fieldset");
    const input = el("textarea");
    input.setAttribute("aria-label", record ? "编辑处理记录" : "处理结果");
    input.placeholder = "写下你做了什么、验证结果和下一步";
    input.value = record?.text ?? "";
    input.required = true;
    input.maxLength = 4000;
    input.rows = 3;
    const source = el("select");
    source.setAttribute("aria-label", "记录来源");
    for (const [value, label] of [["manual", "手动处理"], ["app", "Codex App"]]) {
      const option = el("option", label);
      option.value = value;
      source.append(option);
    }
    source.value = handoff ? "app" : "manual";
    if (!record) fields.append(source);
    fields.append(input, el("button", record ? "保存修改" : "保存记录"));
    form.append(fields);
    form.onsubmit = async (event) => {
      event.preventDefault();
      if (!input.value.trim()) return;
      fields.disabled = true;
      await taskAction(issue, "/api/issues/disposition", {
        ...request, action: record ? "edit-local-record" : "add-local-record", reason: input.value.trim(),
        ...(record ? { record: record.id, expectedText: record.text, expectedEditedAt: record.editedAt ?? null }
          : { source: source.value }),
      }, record ? "处理记录已更新。" : "已保存本地处理记录。");
      fields.disabled = false;
    };
    editor.append(el("summary", record ? "编辑" : "＋ 记录处理结果"), form);
    return editor;
  };
  section.append(recordForm());
  const resume = el("button", "交回 CLI 续办", "app-handoff-button");
  const resumeAction = sessionAction(resume);
  resumeAction.setReason(issue.disposition?.closed ? "任务已结案" : "App 未接手");
  handoffTools?.append(resumeAction.wrapper);
  const selection = el("p", "", "meta");
  const updateSelection = () => {
    selection.textContent = chosen.size
      ? `下一轮会优先续接原会话，读取选中的 ${chosen.size} 条记录并核对待处理卡。`
      : "下一轮会直接续接原会话。可选勾处理记录一并交回。";
    resumeAction.setReason(issue.disposition?.closed ? "任务已结案"
      : issue.disposition?.localDebug ? "请先交回本地调试分支" : "");
  };
  if (!records.length) section.append(el("p", "暂无本地处理记录。", "meta"));
  for (const record of records.toReversed()) {
    const row = el("article", "", "local-record");
    const meta = el("div", "", "local-record-meta");
    const description = el("span", `${time(record.at)} · ${record.source === "app" ? "Codex App" : "手动处理"}${record.editedAt ? " · 已编辑" : ""}`, "meta");
    if (handoff) {
      const label = el("label");
      const checkbox = el("input");
      checkbox.type = "checkbox";
      checkbox.checked = chosen.has(record.id);
      checkbox.setAttribute("aria-label", `随交回附上 ${record.text.slice(0, 40)}`);
      checkbox.onchange = () => {
        if (checkbox.checked) chosen.add(record.id);
        else chosen.delete(record.id);
        appRecordSelections.set(handoff.id, chosen);
        updateSelection();
      };
      label.append(checkbox, description);
      meta.append(label);
    } else meta.append(description);
    row.append(meta, collapsibleResult(record.text), recordForm(record));
    section.append(row);
  }
  if (!handoff) return section;
  updateSelection();
  section.append(selection);
  resume.onclick = async () => {
    const records = [...chosen];
    const message = records.length
      ? `CLI 会续接原会话。已选中 ${records.length} 条处理记录。`
      : "CLI 会直接续接原会话，本次不附加处理记录。";
    const confirmed = await actionDialog("交回 CLI 续办", message, {
      confirmText: records.length ? "附带记录并交回" : "确认交回",
      alternateText: records.length ? "直接交回" : undefined,
    });
    if (confirmed === null) return;
    resume.disabled = true;
    const saved = await taskAction(issue, "/api/issues/disposition", {
      ...request, action: "app-return", handoff: handoff.id, records: confirmed ? records : [],
    }, "已交回 CLI，等待下一轮续办。");
    if (saved) appRecordSelections.delete(handoff.id);
    else updateSelection();
  };
  return section;
}

function replyForm(issue, card) {
  const form = el("form", "", "reply-form");
  const draft = replyDrafts.get(card.id) ?? { choice: "", text: "" };
  const choice = el("select");
  choice.setAttribute("aria-label", "回复选项");
  choice.required = true;
  const placeholder = el("option", "请选择回复选项");
  placeholder.value = "";
  choice.append(placeholder);
  for (const [index, label] of card.options.entries()) {
    const option = el("option", `${index + 1}. ${label}`);
    option.value = String(index);
    choice.append(option);
  }
  choice.value = draft.choice;
  const text = el("textarea");
  text.setAttribute("aria-label", "补充说明");
  text.placeholder = "补充说明（选填）";
  text.maxLength = 1000;
  text.rows = 2;
  text.value = draft.text;
  const submit = el("button", "提交回复");
  const fieldset = el("fieldset");
  fieldset.disabled = Boolean(draft.pending);
  const save = () => replyDrafts.set(card.id, { choice: choice.value, text: text.value });
  choice.onchange = text.oninput = save;
  form.onsubmit = async (event) => {
    event.preventDefault();
    if (!await actionDialog("提交卡片回复", `卡片 #${card.id} · ${card.title}\n\n提交「${card.options[Number(choice.value)]}」？`)) return;
    save();
    replyDrafts.get(card.id).pending = fieldset.disabled = true;
    const sent = await taskAction(issue, `/api/cards/${card.id}/answer`, {
      choice: Number(choice.value), text: text.value.trim(),
    }, `已提交卡片 #${card.id} 的回复。`);
    if (sent) replyDrafts.delete(card.id);
    else replyDrafts.get(card.id).pending = false;
    const current = document.getElementById(`reply-fields-${card.id}`);
    if (current) current.disabled = sent;
  };
  fieldset.id = `reply-fields-${card.id}`;
  fieldset.append(choice, text, submit);
  form.append(fieldset);
  return form;
}
function counts(issue) {
  const result = { waiting: issue.cards.length };
  for (const run of issue.runs) result[run.state] = (result[run.state] ?? 0) + 1;
  return result;
}

function renderList() {
  const search = byId("search").value.trim().toLowerCase();
  const filter = byId("filter").value;
  const list = byId("issues");
  list.replaceChildren();
  const labels = { queued: "排队", claimed: "运行中", waiting: "待确认", done: "已完成轮次" };
  const total = { queued: 0, claimed: 0, waiting: 0, done: 0 };
  for (const issue of groups) {
    const values = counts(issue);
    for (const key of Object.keys(total)) total[key] += values[key] ?? 0;
    if (Boolean(issue.disposition?.archived) !== (filter === "archived")) continue;
    const cardNumbers = [...issue.cards, ...(issue.answeredCard ? [issue.answeredCard] : [])].map(({ id }) => `#${id}`);
    const indicators = taskIndicators(issue);
    const matchesSearch = /^[tc]-\d+$/.test(search)
      ? issue.taskId?.toLowerCase() === search
      : `${issue.title} ${issue.subject} ${issue.rule} ${issue.taskId ?? ""} ${cardNumbers.join(" ")}`.toLowerCase().includes(search);
    if ((filter && !indicators.some(({ key }) => key === filter)) || !matchesSearch) continue;
    const closed = Boolean(issue.disposition?.closed);
    const button = el("button", "", `issue ${closed ? "issue-closed" : "issue-open"}`);
    button.setAttribute("aria-pressed", String(issue.key === selected));
    const badges = el("span", "", "badges");
    badges.append(...indicators.map(indicatorBadge));
    const rounds = issue.runs.length ? ` · 执行 ${issue.runs.length} 轮，已完成 ${values.done ?? 0} 轮` : "";
    const reference = issue.taskId ? `${issue.taskId} · ` : "";
    const title = el("span", "", "issue-heading");
    const light = el("span", "", `issue-light ${closed ? "closed" : "open"}`);
    light.title = closed ? "已结案" : "未结案";
    light.setAttribute("role", "img");
    light.setAttribute("aria-label", light.title);
    title.append(light, el("span", issue.title, "issue-name"));
    button.append(title, el("span", `${reference}${issue.rule}${rounds}`, "meta"), badges);
    button.onclick = () => {
      if (selected !== issue.key) detailTab = "overview";
      selected = issue.key;
      selectedRun = issue.cards.find((card) => card.runId)?.runId ?? issue.runs[0]?.id;
      renderList();
      renderIssue();
    };
    list.append(button);
  }
  byId("metrics").replaceChildren(...Object.entries(total).map(([key, count]) => {
    const metric = el("div", "", `metric ${key}`);
    metric.append(el("span", labels[key]), el("strong", snapshot ? String(count) : "—"));
    return metric;
  }));
  if (!list.childElementCount) list.append(el("p", snapshot ? "没有符合条件的任务。" : "等待 Hub 返回任务。", "empty"));
  byId("older").hidden = !nextBefore;
}

async function showRepositories(panel, issue) {
  const section = el("section");
  const status = el("p", "正在读取任务仓库…", "meta");
  section.append(el("h3", "任务仓库与分支"), status);
  panel.append(section);
  const params = new URLSearchParams({ rule: issue.rule, subject: issue.subject, issue: octoIssueNumber(issue) ?? "" });
  try {
    const repos = await get(`/api/worktrees?${params}`);
    if (!section.isConnected) return;
    if (!repos.length) {
      status.textContent = "暂无已登记的任务工作区。";
      if (issue.disposition?.appHandoff && params.get("issue")) {
        const candidates = await get(`/api/worktrees?${params}&adoptable=1`);
        if (!section.isConnected) return;
        for (const candidate of candidates) {
          const row = el("article", "", "repository-card");
          const adopt = el("button", "接管已有工作区");
          adopt.onclick = async () => {
            const detail = `${candidate.name} · ${candidate.branch}\n提交 ${candidate.commit.slice(0, 12)}\n${candidate.path}`;
            if (!await actionDialog("接管已有工作区", detail, { confirmText: "确认接管" })) return;
            adopt.disabled = true;
            try {
              const { name, path, branch, commit } = candidate;
              await post("/api/worktrees", {
                rule: issue.rule, subject: issue.subject, issue: params.get("issue"),
                action: "adopt", confirmed: true, name, path, branch, commit,
              });
              section.remove();
              await showRepositories(panel, issue);
            } catch (error) {
              status.textContent = error.message;
              adopt.disabled = false;
            }
          };
          row.append(el("h4", candidate.name), el("p", `${candidate.branch} · ${candidate.commit.slice(0, 12)}`, "meta"), adopt);
          section.append(row);
        }
      }
      return;
    }
    status.remove();
    for (const repo of repos) {
      const row = el("article", "", "repository-card");
      const header = el("div", "", "repository-card-header");
      header.append(el("h4", repo.name));
      if (repo.repositoryUrl) header.append(sourceAnchor(repo.repositoryUrl, "打开代码仓库 ↗"));
      const branches = el("dl", "", "repository-branches");
      if (repo.branch) {
        const local = el("dd");
        local.append(el("code", repo.branch));
        branches.append(el("dt", "本地任务分支"), local);
      }
      const remote = el("dd", "", "repository-remote-branches");
      for (const branch of repo.remoteBranches) {
        const name = `origin/${branch.name}`;
        remote.append(branch.url ? sourceAnchor(branch.url, `${name} ↗`) : el("code", name));
      }
      if (!remote.childElementCount) remote.append(el("span", "暂无已知远端分支", "meta"));
      branches.append(el("dt", "已知远端分支"), remote);
      if (repo.localSwitch) branches.append(el("dt", "推送目标"), el("dd", `origin/${repo.branch}`));
      row.append(header, branches);
      const links = el("div", "", "repository-actions");
      const feedback = el("p", "", "meta");
      feedback.setAttribute("role", "status");
      if (repo.localSwitch) {
        const { command } = repo.localSwitch;
        const copy = el("button", "复制 checkout 命令");
        copy.title = command;
        copy.onclick = async () => {
          try {
            await navigator.clipboard.writeText(command);
            feedback.textContent = "已复制。请在原项目目录运行。";
          } catch {
            await actionDialog("复制 checkout 命令", "复制以下命令，在终端运行。", { value: command, confirmText: "完成" });
          }
        };
        links.append(copy);
        const active = issue.runs.some(({ state }) => state === "claimed" || state === "unknown");
        const debug = issue.disposition?.localDebug;
        const branchActions = [
          ["交给本地调试", "local-debug-start", issue.disposition?.appHandoff
            ? `请先结束 App 正在进行的编辑。确认后将在原项目目录检出 ${repo.branch}。`
            : `暂停此任务的 Worker，并在原项目目录检出 ${repo.branch}？`,
            !repo.workspace || active || issue.disposition?.closed || (debug && debug.name !== repo.name)],
          ["交回 worktree 工作区", "local-debug-return", `把 ${repo.branch} 交回 worktree 工作区，并恢复原项目之前的分支？`,
            !repo.workspace || debug?.name !== repo.name],
          ["推送远程", "push", `把需求分支的已提交内容推送到 origin/${repo.branch}？`, active],
        ];
        if (debug?.name === repo.name) row.append(el("p", "本地调试交接中，Worker 已暂停派发。", "meta"));
        for (const [label, action, confirmation, disabled] of branchActions) {
          const button = el("button", label);
          button.disabled = snapshot.demo || Boolean(disabled);
          button.onclick = async () => {
            if (!await actionDialog(label, confirmation)) return;
            button.disabled = true;
            try {
              await post("/api/worktrees", { rule: issue.rule, subject: issue.subject, name: repo.name, action, confirmed: true });
              feedback.textContent = action === "push" ? `已推送到 origin/${repo.branch}。` : "分支交接完成。";
            } catch (error) {
              feedback.textContent = error.message;
            } finally {
              button.disabled = false;
              await refresh(true);
            }
          };
          links.append(button);
        }
      }
      if (repo.workspace) {
        const open = el("button", "打开本地工作区");
        open.onclick = async () => {
          open.disabled = true;
          try {
            await post("/api/worktrees", { rule: issue.rule, subject: issue.subject, name: repo.name });
            feedback.textContent = "已在 Finder 打开。";
          } catch (error) {
            feedback.textContent = error.message;
          } finally {
            open.disabled = false;
          }
        };
        const remove = el("button", "删除工作区", "danger-worktree");
        remove.disabled = repo.adopted || !issue.disposition?.closed;
        if (remove.disabled) remove.title = repo.adopted ? "接管的 App 工作区请在原位置管理" : "任务结案后可删除";
        remove.onclick = async () => {
          if (!await actionDialog("删除本地工作区", `确认删除「${repo.name}」的本地工作区？`)) return;
          const phrase = "yes,delete it";
          const dialog = el("dialog", "", "action-dialog");
          const form = el("form");
          const input = el("input");
          input.setAttribute("aria-label", "输入删除确认文字");
          const copy = el("button", "复制确认文字");
          const cancel = el("button", "取消");
          copy.type = cancel.type = "button";
          copy.onclick = async () => {
            try { await navigator.clipboard.writeText(phrase); copy.textContent = "已复制"; }
            catch { await actionDialog("复制删除确认文字", "复制以下确认文字。", { value: phrase, confirmText: "完成" }); }
          };
          cancel.onclick = () => dialog.close();
          const confirm = el("button", "确认删除", "danger-worktree");
          confirm.disabled = true;
          input.oninput = () => { confirm.disabled = input.value !== phrase; };
          const heading = el("h2", "删除本地工作区");
          heading.id = "remove-worktree-title";
          dialog.setAttribute("aria-labelledby", heading.id);
          form.append(heading, el("p", "请输入以下文字确认删除"), el("code", phrase), copy, input, cancel, confirm);
          form.onsubmit = async (event) => {
            event.preventDefault();
            if (input.value !== phrase || confirm.disabled) return;
            dialog.close();
            open.disabled = remove.disabled = true;
            try {
              await post("/api/worktrees", { rule: issue.rule, subject: issue.subject, name: repo.name,
                action: "remove", confirmation: input.value });
              open.remove();
              remove.remove();
              feedback.textContent = "本地工作区已删除，任务分支已保留。";
            } catch (error) {
              feedback.textContent = error.message;
              open.disabled = remove.disabled = false;
            }
          };
          dialog.append(form);
          dialog.onclose = () => dialog.remove();
          document.body.append(dialog);
          dialog.showModal();
          input.focus();
        };
        links.append(open, remove);
      }
      if (links.childElementCount) row.append(links, feedback);
      section.append(row);
    }
  } catch (error) {
    status.textContent = error.message;
  }
}

function progressEditor(issue, note, inline = false) {
  const editor = el(inline ? "div" : "details", "", inline ? "progress-inline-form" : "");
  const icon = inline ? el("button", "✎", "progress-edit-icon") : null;
  if (icon) {
    icon.title = "编辑最新进展";
    icon.setAttribute("aria-label", icon.title);
    icon.setAttribute("aria-expanded", "false");
    editor.id = "latest-progress-editor";
    icon.setAttribute("aria-controls", editor.id);
    editor.hidden = true;
  }
  const form = el("form", "", "reply-form");
  const input = el("textarea");
  input.setAttribute("aria-label", "编辑进展");
  input.value = note.text;
  input.required = true;
  input.maxLength = 500;
  input.rows = 2;
  if (icon) icon.onclick = () => {
    editor.hidden = !editor.hidden;
    icon.setAttribute("aria-expanded", String(!editor.hidden));
    if (!editor.hidden) input.focus();
  };
  const save = el("button", "保存修改");
  form.append(input, save);
  form.onsubmit = async (event) => {
    event.preventDefault();
    const reason = input.value.trim();
    if (!reason) return;
    save.disabled = true;
    try {
      await post("/api/issues/disposition", {
        rule: issue.rule, subject: issue.subject, action: "edit-progress",
        index: note.index, expectedText: note.text, expectedEditedAt: note.editedAt ?? null, reason,
      });
      if (icon) {
        editor.hidden = true;
        icon.setAttribute("aria-expanded", "false");
      } else editor.open = false;
      await refresh(true);
    } catch (error) {
      feedback.textContent = error.message;
    } finally {
      save.disabled = false;
    }
  };
  const feedback = el("p", "", "meta");
  feedback.setAttribute("role", "status");
  if (!icon) editor.append(el("summary", "编辑"));
  editor.append(form, feedback);
  return icon ? { icon, editor } : editor;
}

function routingDetails(issue) {
  const created = issue.runs.find((run) => run.events?.some(({ type }) => type.endsWith(".created")));
  const run = created ?? issue.runs.find((entry) => entry.events?.some(({ source }) => source === "octo-issue"));
  if (!run) return;
  const event = run.events.find(({ type }) => type.endsWith(".created")) ??
    run.events.find(({ source }) => source === "octo-issue");
  const details = el("details", "", "overview-routing");
  details.append(el("summary", `已匹配规则 · ${issue.rule}`));
  const fields = el("dl");
  const agent = snapshot.agents?.find(({ id }) => id === run.agent);
  for (const [label, value] of [
    ["事件来源", sourceName(event.source)],
    ["事件类型", event.type],
    ["关联轮次", `#${run.id}`],
    ["执行 Agent", agent?.name ?? run.agent],
  ]) {
    if (value) fields.append(el("dt", label), el("dd", value));
  }
  details.append(fields);
  return details;
}

function renderIssue() {
  const panel = byId("detail");
  const issue = groups.find((group) => group.key === selected);
  const notification = notificationStates.get(selected);
  const dispositionError = dispositionErrors.get(selected);
  const taskMessage = taskMessages.get(selected);
  const signature = JSON.stringify([
    issue, selectedRun, snapshot?.canNotify, snapshot?.supportsStandaloneTasks, snapshot?.supportsBusinessStages,
    snapshot?.supportsLatestSessionRetry, notification, dispositionError, taskMessage,
  ]);
  if (renderedIssue === signature) return;
  renderedIssue = signature;
  for (const text of panel.querySelectorAll("[data-collapsible-text]")) collapsedTextObserver.unobserve(text);
  panel.replaceChildren();
  ++traceVersion;
  if (!issue) {
    panel.append(el("h2", "任务详情"), el("p", "选择任务后可查看确认卡、运行详情与时间线。"));
    return;
  }
  const header = el("header", "", "detail-header");
  const titleRow = el("div", "", "detail-title-row");
  const title = el("div");
  const octoNumber = octoIssueNumber(issue);
  title.className = "detail-title";
  const identity = el("div", "", "task-identity");
  identity.append(el("span", octoNumber ?? issue.rule, "meta"));
  if (issue.taskId) {
    const copy = el("button", issue.taskId, "task-id-copy");
    copy.title = "复制任务 ID";
    copy.setAttribute("aria-label", `复制任务 ID ${issue.taskId}`);
    copy.onclick = async () => {
      try {
        await navigator.clipboard.writeText(issue.taskId);
        copy.textContent = `${issue.taskId} · 已复制`;
      } catch {
        await actionDialog("复制任务 ID", "用这个 ID 可以搜索或引用当前任务。", { value: issue.taskId, confirmText: "完成" });
      }
    };
    identity.append(copy);
  }
  title.append(identity, el("h2", issue.title));
  const headerTools = el("div", "", "detail-header-tools");
  const more = el("details", "", "detail-more");
  const moreBody = el("div", "", "detail-more-body");
  more.append(el("summary", "更多"), moreBody);
  titleRow.append(title, headerTools);
  header.append(titleRow);
  const tabs = el("div", "", "detail-tabs");
  tabs.setAttribute("role", "tablist");
  tabs.setAttribute("aria-label", "任务详情");
  const sections = new Map();
  const loaders = new Map();
  for (const [key, label] of [
    ["overview", "概览"], ["execution", "执行与会话"], ["repositories", "仓库与分支"], ["history", "状态时间线"],
  ]) {
    const button = el("button", label, "detail-tab");
    button.id = `task-tab-${key}`;
    button.setAttribute("role", "tab");
    button.setAttribute("aria-controls", `task-pane-${key}`);
    const content = el("section", "", "detail-tab-content");
    content.id = `task-pane-${key}`;
    content.setAttribute("role", "tabpanel");
    content.setAttribute("aria-labelledby", button.id);
    button.onclick = () => showTab(key);
    tabs.append(button);
    sections.set(key, { button, content });
  }
  function showTab(key) {
    detailTab = key;
    for (const [name, { button, content }] of sections) {
      button.setAttribute("aria-selected", String(name === key));
      content.hidden = name !== key;
    }
    const load = loaders.get(key);
    if (load) {
      loaders.delete(key);
      load();
    }
  }
  const overview = sections.get("overview").content;
  const execution = sections.get("execution").content;
  const repositoryPane = sections.get("repositories").content;
  const historyPane = sections.get("history").content;
  panel.append(header, tabs, ...[...sections.values()].map(({ content }) => content));
  const blocked = issue.runs.find(({ sessionBlocked }) => sessionBlocked);
  if (!snapshot.demo && blocked && !issue.disposition?.closed) {
    const retryBox = el("section", "", "overview-card overview-pending");
    retryBox.append(el("h3", "原会话待重试"), el("p", blocked.error || "原会话暂不可用。"));
    overview.append(retryBox);
  }
  const status = taskStatus(issue);
  const indicators = el("div", "", "badges");
  indicators.append(...taskIndicators(issue).map(indicatorBadge));
  title.append(indicators);
  if (taskMessage) {
    const message = el("p", taskMessage, "meta");
    message.setAttribute("role", "status");
    header.append(message);
  }
  if (snapshot.supportsAppHandoff && issue.subject && !issue.disposition?.closed) {
    if (issue.disposition?.appHandoff) {
      const note = el("div", "", "overview-card overview-pending");
      const show = el("button", "到概览查看处理记录");
      show.onclick = () => showTab("overview");
      note.append(el("h3", "App 接手中"), el("p", "在概览中勾选处理记录，再交回 CLI 续办。", "meta"), show);
      execution.append(note);
    }
  }
  if (issue.disposition?.appResult) {
    const { appResult } = issue.disposition;
    execution.append(el("h3", "最近一次 App 交回结果"), collapsibleResult(appResult.text));
  }
  if (issue.answeredCard) {
    const card = issue.answeredCard;
    overview.append(el("p", `卡片 #${card.id} 已回复 · ${card.options[card.choice] ?? ""}`, "meta"));
    if (card.answer) overview.append(el("p", card.answer));
  }
  if (issue.disposition?.closed) {
    historyPane.append(el("p", `人工结案 · ${time(issue.disposition.closedAt)} · ${issue.disposition.reason}`));
  } else if (status === "testing") {
    historyPane.append(el("p", `提测记录时间 · ${time(issue.disposition.stageAt)}`, "meta"));
  } else if (status === "followup") {
    execution.append(el("p", "当前没有活动轮次，Hub 未记录提测或结案。", "meta"));
  }
  if (issue.subject) loaders.set("repositories", () => { void showRepositories(repositoryPane, issue); });
  else repositoryPane.append(el("p", "暂无已登记的任务工作区。", "meta"));
  if (!snapshot.demo && octoNumber && !snapshot.supportsBusinessStages)
    overview.append(el("p", "本机 Hub 还未加载开发阶段功能，重载 Hub 后可查看和记录。", "meta"));
  const progressNotes = issue.disposition?.progressNotes ?? [];
  const latestProgress = progressNotes.at(-1);
  const progress = el("section", "", "overview-card");
  const progressHeader = el("div", "", "progress-header");
  progressHeader.append(el("h3", "最新进展"));
  const controls = !snapshot.demo && snapshot.manualStatusLabels && issue.subject && issue.runs.length
    ? progressControls(issue) : null;
  if (controls) progressHeader.append(controls.toolbar);
  progress.append(progressHeader);
  if (latestProgress) {
    const row = el("div", "", "latest-progress-row");
    row.append(el("p", latestProgress.text));
    if (!snapshot.demo) {
      const { icon, editor } = progressEditor(issue, { ...latestProgress, index: progressNotes.length - 1 }, true);
      row.append(icon);
      progress.append(row, el("p", `${time(latestProgress.at)} · 手动记录`, "meta"), editor);
    } else {
      progress.append(row, el("p", `${time(latestProgress.at)} · 手动记录`, "meta"));
    }
  } else {
    progress.append(el("p", "暂无手动进展。", "meta"));
  }
  if (controls) progress.append(controls.forms);
  overview.append(progress);
  const routing = routingDetails(issue);
  if (routing) overview.append(routing);
  const manualHistory = [...(issue.disposition?.manualStatusHistory ?? [])];
  const manual = issue.disposition?.manualStatus;
  if (manual && !manualHistory.some(({ at, status }) => at === manual.at && status === manual.status))
    manualHistory.push(manual);
  const historyItems = [
    ...(issue.disposition?.history ?? []),
    ...manualHistory.map(({ label, at }) => ({ label: `手动状态 · ${label}`, at })),
    ...(issue.disposition?.progressNotes ?? []).map((note, index) => ({ ...note, label: "手动进展", index })),
  ].sort((a, b) => a.at.localeCompare(b.at)).reverse();
  if (historyItems.length) {
    const history = el("section");
    const entries = el("ol", "", "timeline");
    for (const note of historyItems) {
      const { label, text, at, index, editedAt } = note;
      const item = el("li");
      item.append(el("time", time(at)), el("strong", label));
      if (text) item.append(el("p", text));
      if (editedAt) item.append(el("small", `已编辑 · ${time(editedAt)}`, "meta"));
      if (!snapshot.demo && index !== undefined) item.append(progressEditor(issue, note));
      entries.append(item);
    }
    history.append(el("h3", "任务状态与进展时间线"), entries);
    historyPane.append(history);
  } else {
    historyPane.append(el("p", "暂无状态和进展记录。", "meta"));
  }
  if (issue.target || issue.subject) historyPane.append(approvalHistory(issue));
  if (Array.isArray(snapshot.issueDispositions) && (issue.target || issue.subject)) {
    const actions = el("div", "", "source-links");
    const needsHubReload = issue.target && !snapshot.supportsStandaloneTasks;
    const archived = issue.disposition?.archived;
    const closed = issue.disposition?.closed;
    const closeForm = el("form", "", "reply-form");
    closeForm.hidden = true;
    const fields = el("fieldset");
    const reasonInput = el("textarea");
    reasonInput.setAttribute("aria-label", "结案原因");
    reasonInput.value = "负责人手动结案";
    reasonInput.required = true;
    reasonInput.maxLength = 500;
    reasonInput.rows = 2;
    const closeStatus = el("p", "", "meta");
    closeStatus.setAttribute("role", "status");
    const confirmClose = el("button", "确认结案");
    const cancelClose = el("button", "取消");
    cancelClose.type = "button";
    cancelClose.onclick = () => { closeForm.hidden = true; };
    const closeActions = el("div", "", "source-links");
    closeActions.append(confirmClose, cancelClose);
    fields.append(el("p", issue.target
      ? "结案会关闭此任务的待确认卡。"
      : "结案会关闭待确认卡，之后的新评论不会派发。"), reasonInput, closeActions, closeStatus);
    closeForm.append(fields);
    const changeDisposition = (action, reason) => post("/api/issues/disposition", {
      ...(issue.target ? { target: issue.target } : { rule: issue.rule, subject: issue.subject }), action, reason,
    });
    closeForm.onsubmit = async (event) => {
      event.preventDefault();
      const reason = reasonInput.value.trim();
      if (!reason) {
        closeStatus.textContent = "请填写结案原因。";
        reasonInput.focus();
        return;
      }
      fields.disabled = true;
      closeStatus.textContent = "正在结案…";
      try {
        await changeDisposition("close", reason);
        dispositionErrors.delete(issue.key);
        taskMessages.set(issue.key, "Hub 已记录结案。");
        closeStatus.textContent = "Hub 已记录结案。";
        await refresh(true);
      } catch (error) {
        closeStatus.textContent = error.message;
        fields.disabled = false;
      }
    };
    for (const [label, action] of [
      [archived ? "恢复归档" : "手动归档", archived ? "restore" : "archive"],
      [closed ? "手动重开" : "手动结案", closed ? "reopen" : "close"],
    ]) {
      if (action === "reopen" && issue.target?.kind === "card") continue;
      const button = el("button", label);
      button.disabled = Boolean(snapshot.demo || needsHubReload);
      button.onclick = async () => {
        if (action === "close") {
          closeForm.hidden = false;
          reasonInput.focus();
          reasonInput.select();
          return;
        }
        if (action === "archive" && !await actionDialog("归档任务", "从默认列表隐藏此任务？归档后可在「已归档」查看。")) return;
        button.disabled = true;
        try {
          await changeDisposition(action);
          dispositionErrors.delete(issue.key);
          await refresh(true);
        } catch (error) {
          dispositionErrors.set(issue.key, error.message);
          renderIssue();
        } finally {
          button.disabled = false;
        }
      };
      actions.append(button);
    }
    moreBody.append(actions, closeForm);
    const message = needsHubReload ? "本机 Hub 需要重载一次，才能归档或结案独立任务。" : dispositionError;
    if (message) {
      const status = el("p", message, "meta");
      status.setAttribute("role", "status");
      moreBody.append(status);
    }
  }
  if (issue.links.length) {
    const [primary, ...others] = issue.links;
    const issueLink = sourceAnchor(primary.url, "打开 Issue ↗");
    issueLink.classList.add("detail-issue-link");
    headerTools.append(issueLink);
    for (const { source, url } of others) moreBody.append(sourceAnchor(url, `打开 ${sourceName(source)} ↗`));
  } else if (issue.sources.length) {
    moreBody.append(el("p", `来源 · ${issue.sources.map(sourceName).join("、")} · 暂无原链接`, "meta"));
  }
  const issueNumber = snapshot.canNotify && octoNumber;
  if (issueNumber) {
    const actions = el("div", "", "source-links");
    const status = el("p", notification?.message ?? "", "meta");
    status.setAttribute("role", "status");
    for (const [stage, label, prerequisite] of [
      ["test", "发送提测通知", "请确认测试环境已就绪，可以邀请需求方测试。"],
      ["release", "发送需求上线通知", "请确认需求已经上线。"],
    ]) {
      const button = el("button", label);
      const releaseBlocked = stage === "release" && issue.disposition?.closed;
      button.disabled = Boolean(snapshot.demo || notification?.pending || releaseBlocked);
      if (releaseBlocked) button.title = "任务已结案，请先重新打开任务";
      button.onclick = async () => {
        const show = (message, pending = false) => {
          notificationStates.set(issue.key, { message, pending });
          renderIssue();
        };
        let testAddress;
        if (stage === "test") {
          button.disabled = true;
          const config = await get(`/api/issues/test-address?${new URLSearchParams({ rule: issue.rule })}`)
            .catch(() => null);
          button.disabled = false;
          if (!button.isConnected) return;
          const hint = config?.testAddress ? "已预填项目配置，可以按本次实际环境修改。" :
            config ? "项目未配置测试地址，请手动填写。" : "无法读取项目配置，请手动填写测试地址。";
          const input = await actionDialog("发送提测通知", `${issueNumber} 的测试环境地址\n${hint}\n确认后会通知需求方。`,
            { value: config?.testAddress ?? "", required: true, confirmText: "确认发送" });
          if (input === null) return;
          testAddress = input.trim();
          if (!testAddress || testAddress.length > 500 || !sourceUrl(testAddress.replace(/^POST /, ""))?.startsWith("https://")) {
            show("请输入有效的 HTTPS 测试环境地址。");
            return;
          }
        }
        if (stage === "release" && !await actionDialog("发送需求上线通知", `${prerequisite}\n\n向 Octo 需求通知子区发送 ${issueNumber} 的通知并 @ 需求方？`, { confirmText: "确认发送" })) return;
        show("正在发送通知…", true);
        try {
          const response = await fetch("/api/issues/notify", {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ issue: issueNumber, rule: issue.rule, stage, testAddress }),
          });
          const data = await response.json();
          if (!response.ok) throw new Error(data.error);
          show(data.message);
        } catch (error) {
          show(error.message);
        }
      };
      actions.append(button);
    }
    moreBody.append(el("h3", "需求方通知"), actions);
    if (issue.disposition?.closed)
      moreBody.append(el("p", "任务已结案。重新打开后可发送上线通知。", "meta"));
    moreBody.append(status);
  }
  const codexRuns = issue.runs.filter(({ session, link }) =>
    /^[a-zA-Z0-9-]+$/.test(session ?? "") && link === `codex://threads/${session}`);
  const appRun = codexRuns.find(({ id }) => id === selectedRun) ?? codexRuns[0];
  const appLink = issue.disposition?.appHandoff?.link ?? appRun?.link;
  const codexSession = /^codex:\/\/threads\/([a-zA-Z0-9-]+)$/.exec(appLink ?? "")?.[1];
  if (codexSession) {
    const app = el("a", "在 Codex App 中查看 ↗", "source-link detail-app-link");
    app.href = appLink;
    const copy = el("button", "复制终端命令", "detail-copy-command");
    const command = `codex resume -- ${codexSession}`;
    copy.title = command;
    copy.onclick = async () => {
      try {
        await navigator.clipboard.writeText(command);
        copy.textContent = "已复制";
      } catch {
        await actionDialog("复制终端命令", "复制以下命令，在终端打开同一会话。", { value: command, confirmText: "完成" });
      }
    };
    headerTools.append(app, copy);
  }
  if (moreBody.childElementCount) headerTools.append(more);
  if (issue.cards.length) {
    const pending = el("section", "", "overview-card overview-pending");
    pending.append(el("h3", `待你处理 · ${issue.cards.length}`));
    for (const card of issue.cards) {
      const block = el("details", "", "overview-approval");
      const summary = el("summary", `卡片 #${card.id} · ${card.title}`);
      summary.append(el("span", "查看并回复", "overview-approval-action"));
      block.append(summary, el("p", card.text));
      if (card.options?.length) {
        const reply = replyForm(issue, card);
        if (snapshot.demo) reply.querySelector("fieldset").disabled = true;
        block.append(reply);
      }
      if (!snapshot.demo && !issue.target && !card.testReview) {
        const resolve = el("button", "结束此卡");
        resolve.onclick = async () => {
          const reason = await actionDialog("结束确认卡", "请填写处理结果。", { value: "", required: true, confirmText: "确认结束" });
          if (!reason?.trim()) return;
          resolve.disabled = true;
          await taskAction(issue, `/api/cards/${card.id}/resolve`, { reason }, `已关闭卡片 #${card.id}。`);
          resolve.disabled = false;
        };
        block.append(resolve);
      }
      if (card.runId) {
        const show = el("button", `查看提问 · ${roundLabel(issue.runs.find(({ id }) => id === card.runId), card.runId)}`);
        show.onclick = () => {
          if (selectedRun === card.runId) showTab("execution");
          else { selectedRun = card.runId; detailTab = "execution"; renderIssue(); }
        };
        block.append(show);
      }
      pending.append(block);
    }
    overview.append(pending);
  }
  if (snapshot.supportsLocalRecords && issue.subject && issue.runs.length) {
    const showHandoff = snapshot.supportsAppHandoff && (appRun || issue.disposition?.appHandoff || blocked);
    const handoffTools = showHandoff ? el("div", "", "app-handoff-tools") : null;
    if (handoffTools && (appRun || issue.disposition?.appHandoff)) handoffTools.append(appHandoffButton(issue, appRun));
    overview.append(localRecordsPanel(issue, handoffTools));
    if (handoffTools) {
      const retryRun = blocked ?? codexRuns[0];
      const retry = el("button", "重试原会话", "app-handoff-button");
      const retryAction = sessionAction(retry);
      const active = issue.runs.find(({ state }) => ["claimed", "unknown"].includes(state))
        ?? issue.runs.find(({ state }) => state === "queued");
      retryAction.setReason(issue.disposition?.closed ? "任务已结案"
        : issue.disposition?.appHandoff ? "App 接手中，请先交回 CLI"
        : issue.disposition?.localDebug ? "本地调试中，请先交回 worktree 工作区"
        : snapshot.demo ? "演示模式"
        : !retryRun ? "暂无可重试的 Codex 会话"
        : blocked ? ""
        : active?.state === "unknown" ? "执行状态待核对"
        : active?.state === "claimed" ? "CLI 正在执行"
        : active ? "已有轮次在排队"
        : !snapshot.supportsLatestSessionRetry ? "当前 Hub 仅支持重试受阻会话" : "");
      retry.onclick = () => {
        const dialog = el("dialog", "", "action-dialog");
        const form = el("form", "", "reply-form");
        const heading = el("h2", "续接 Codex 原会话");
        heading.id = "retry-session-title";
        dialog.setAttribute("aria-labelledby", heading.id);
        const note = el("textarea");
        note.rows = 4;
        note.maxLength = 500;
        note.placeholder = "补充说明（可选），例如：先核对测试结果";
        note.setAttribute("aria-label", "补充说明（可选）");
        const feedback = el("p", "", "meta");
        feedback.setAttribute("role", "status");
        const cancel = el("button", "取消");
        cancel.type = "button";
        cancel.onclick = () => dialog.close();
        const submit = el("button", "启动 CLI 续办");
        const fields = el("fieldset");
        const actions = el("div", "", "live-log-actions");
        actions.append(cancel, submit);
        fields.append(note, feedback, actions);
        form.append(heading, fields);
        form.onsubmit = async (event) => {
          event.preventDefault();
          if (fields.disabled) return;
          fields.disabled = true;
          feedback.textContent = "正在提交…";
          const saved = await taskAction(issue, `/api/runs/${retryRun.id}/retry`, { note: note.value.trim() }, "已安排重试原会话。");
          if (saved) dialog.close();
          else {
            feedback.textContent = taskMessages.get(issue.key) ?? "提交失败";
            fields.disabled = false;
          }
        };
        dialog.append(form);
        dialog.onclose = () => dialog.remove();
        document.body.append(dialog);
        dialog.showModal();
        note.focus();
      };
      handoffTools.append(retryAction.wrapper);
      overview.prepend(handoffTools);
    }
  }
  const latestRun = issue.runs[0];
  if (latestRun) {
    const footer = el("div", "", "overview-footer");
    const openRun = el("button", "查看轮次 →");
    openRun.onclick = () => {
      if (selectedRun === latestRun.id) showTab("execution");
      else { selectedRun = latestRun.id; detailTab = "execution"; renderIssue(); }
    };
    footer.append(el("span", `${roundLabel(latestRun)} · ${runLabel(latestRun)}`, "meta"), openRun);
    if (canWatchCodex(latestRun)) footer.append(liveLogButton(latestRun));
    overview.append(footer);
  }
  execution.append(el("h3", "执行轮次"));
  for (const run of issue.runs) {
    const row = el("button", "", "run-row");
    row.setAttribute("aria-pressed", String(run.id === selectedRun));
    row.append(el("span", `${roundLabel(run)} · ${run.agent}`), badge(runLabel(run), run.sessionBlocked ? "waiting" : run.state));
    row.onclick = () => { selectedRun = run.id; renderIssue(); };
    if (canWatchCodex(run)) {
      const actions = el("div", "", "run-live-row");
      actions.append(row, liveLogButton(run));
      execution.append(actions);
    } else execution.append(row);
  }
  if (!issue.runs.length) execution.append(el("p", issue.target?.kind === "card"
    ? "独立卡片没有关联执行轮次。"
    : "提问轮次已不在本页，仍可从待确认卡片查看。", "meta"));
  if (!selectedRun) { showTab(detailTab); return; }
  const run = issue.runs.find((item) => item.id === selectedRun);
  if (!snapshot.demo && run && ["queued", "claimed"].includes(run.state) && !run.stopping) {
    const stop = el("button", "停止本轮");
    stop.onclick = async () => {
      if (!await actionDialog("停止本轮", `停止${roundLabel(run)}的执行？`)) return;
      stop.disabled = true;
      await taskAction(issue, `/api/runs/${run.id}/cancel`, {}, "已提交停止请求。");
      stop.disabled = false;
    };
    execution.append(stop);
  }
  const trace = el("div", "", "trace");
  execution.append(trace);
  const runId = selectedRun;
  const version = traceVersion;
  loaders.set("execution", () => { void showTrace(trace, runId, run, version); });
  showTab(detailTab);
}

function canWatchCodex(run) {
  return (run.state === "claimed" || Boolean(run.finishedAt)) &&
    snapshot.agents?.some(({ id, use }) => id === run.agent && use === "codex");
}

function logRow(entry, turn, expanded) {
  if (typeof entry === "string") return el("li", entry, "live-log-row");
  if (entry.kind !== "command") return el("li", entry.text, `live-log-row log-${entry.kind}`);
  const state = entry.running ? "running" : entry.failed ? "error" : "done";
  const row = el("li", "", `live-log-row log-${state}`);
  const command = el("div", "", "live-log-command");
  const commandText = el("code", entry.command || "命令");
  if (entry.command) commandText.title = entry.command;
  command.append(el("strong", entry.running ? "Running" : "Ran"), commandText);
  if (entry.failed && entry.exitCode !== null) command.append(el("span", `退出码 ${entry.exitCode}`, "live-log-exit"));
  row.append(command);
  if (!entry.output) return row;
  const lines = entry.output.split("\n");
  if (lines.length <= 3 && !entry.outputClipped) {
    row.append(el("pre", entry.output, "live-log-command-output"));
    return row;
  }
  const details = el("details", "", "live-log-command-details");
  details.dataset.logCommand = `${turn}:${entry.id}`;
  details.open = expanded.has(details.dataset.logCommand);
  const hint = lines.length > 3 ? `展开其余 ${lines.length - 3} 行` : "展开输出";
  details.append(el("summary", hint), el("pre",
    entry.outputClipped ? `${entry.output}\n\n… 后续内容见原始 stdout` : entry.output, "live-log-command-output"));
  row.append(el("pre", lines.slice(0, 3).join("\n"), "live-log-command-output live-log-preview"), details);
  return row;
}

function liveLogButton(run) {
  const live = run.state === "claimed";
  const label = live ? "实时日志" : "查看日志";
  const button = el("button", label, "live-log-button");
  button.onclick = () => {
    const dialog = el("dialog", "", "live-log-dialog");
    const heading = el("h3", `${roundLabel(run)} · Codex ${live ? "实时日志" : "执行日志"}`);
    heading.id = "live-log-title";
    dialog.setAttribute("aria-labelledby", heading.id);
    const close = el("button", "关闭");
    close.onclick = () => dialog.close();
    const attempt = (run.attempts ?? 0) + 1;
    const logUrl = `/api/runs/${run.id}/live-log?attempt=${attempt}`;
    const raw = el("a", "打开原始 stdout ↗", "source-link");
    raw.href = `${logUrl}&raw=1`;
    raw.target = "_blank";
    raw.rel = "noopener noreferrer";
    const header = el("div", "", "live-log-header");
    const actions = el("div", "", "live-log-actions");
    if (!snapshot.demo) actions.append(raw);
    actions.append(close);
    header.append(heading, actions);
    const status = el("p", "正在读取 Worker 日志…", "meta");
    const output = el("ol", "", "live-log-output");
    output.setAttribute("aria-label", "Codex 执行事件");
    output.tabIndex = 0;
    const changed = el("details", "", "live-log-files");
    const changedTitle = el("summary", "文件变更");
    const changedList = el("ul");
    changed.hidden = true;
    changed.append(changedTitle, changedList);
    dialog.append(header, status, changed, output);
    document.body.append(dialog);
    dialog.showModal();
    let timer;
    let renderedLog = "";
    dialog.onclose = () => {
      clearTimeout(timer);
      dialog.remove();
      if (button.isConnected) button.focus();
    };
    async function refreshLog() {
      try {
        const { entries, files = [], turn, truncated } = await get(`${logUrl}&format=events`);
        if (!dialog.open) return;
        const next = JSON.stringify([turn, entries]);
        if (entries.length && next !== renderedLog) {
          const atBottom = output.scrollHeight - output.clientHeight - output.scrollTop < 24;
          const scrollTop = output.scrollTop;
          const expanded = new Set([...output.querySelectorAll("details[open]")].map(node => node.dataset.logCommand));
          output.replaceChildren(...entries.map(entry => logRow(entry, turn, expanded)));
          output.scrollTop = atBottom ? output.scrollHeight : scrollTop;
          renderedLog = next;
        }
        changed.hidden = files.length === 0;
        changedTitle.textContent = `文件变更 · ${files.length} 个`;
        changedList.replaceChildren(...files.map(({ path, kinds }) => el("li", `${kinds.join("、")} · ${path}`)));
        if (!live) {
          status.textContent = entries.length
            ? `第 ${attempt} 次尝试 · 第 ${turn} 次启动${truncated ? " · 仅显示近期日志" : ""}`
            : "本机没有保留这轮可查看的 Codex 日志。";
          return;
        }
        const current = groups.flatMap((issue) => issue.runs).find(({ id }) => id === run.id);
        if (current && (current.state !== "claimed" || (current.attempts ?? 0) + 1 !== attempt)) {
          status.textContent = `本次执行已结束 · ${runLabel(current)}`;
          return;
        }
        status.textContent = turn
          ? `实时更新 · 第 ${attempt} 次尝试 · 第 ${turn} 次启动${truncated ? " · 仅显示近期日志" : ""}`
          : "等待本机 Worker 产生日志…";
      } catch (error) {
        status.textContent = error.message;
      }
      if (live && dialog.open) timer = setTimeout(refreshLog, 1000);
    }
    void refreshLog();
  };
  return button;
}

function approvalHistory(issue) {
  const panel = el("details", "", "overview-card overview-routing");
  const heading = el("summary", "历史确认事项");
  const content = el("div");
  panel.append(heading, content);
  let loading = false;
  let loaded = false;
  panel.ontoggle = async () => {
    if (!panel.open || loaded || loading) return;
    loading = true;
    content.textContent = "正在读取确认记录…";
    const params = new URLSearchParams(issue.target
      ? { target: issue.target.kind, id: String(issue.target.id) }
      : { rule: issue.rule, subject: issue.subject });
    try {
      const cards = await get(`/api/cards/history?${params}`);
      heading.textContent = `历史确认事项 · ${cards.length} 张`;
      content.replaceChildren();
      if (!cards.length) content.append(el("p", "暂无历史确认事项。", "meta"));
      else content.append(el("p", "这里展示当时的确认和回复。当前轮次是否可以沿用，以 Hub 校验为准。", "meta"));
      for (const card of cards) {
        const record = el("details");
        const outcome = card.choice == null ? (card.decidedAt ? "已回复" : "已关闭") : card.options[card.choice];
        record.append(el("summary", `#${card.id} · ${card.title} · ${outcome}`));
        record.append(el("p", [time(card.decidedAt ?? card.closedAt ?? card.createdAt), card.by].filter(Boolean).join(" · "), "meta"));
        record.append(el("p", card.text));
        if (card.answer) record.append(el("p", `补充说明 · ${card.answer}`));
        if (card.result) record.append(el("p", `处理结果 · ${card.result}`));
        content.append(record);
      }
      loaded = true;
    } catch (error) {
      content.textContent = error.message;
    } finally {
      loading = false;
    }
  };
  return panel;
}

async function showTrace(panel, id, run, version) {
  panel.append(el("h3", `${roundLabel(run, id)} · 详情与时间线`));
  const pending = el("p", "正在读取时间线…", "meta");
  panel.append(pending);
  try {
    const details = timelineFor(await get(`/api/runs/${id}/why`), id);
    if (traceVersion !== version) return;
    pending.remove();
    const row = details.run ?? {};
    const meta = el("dl");
    for (const [name, value] of [
      ["状态", details.run
        ? runLabel({ state: row.state, attempts: row.attempts, sessionBlocked: row.session_blocked })
        : run ? runLabel(run) : ""],
      ["Agent", run?.agent ?? row.agent],
      ["入队时间", time(run?.createdAt ?? row.created_at)],
      ["领取时间", time(run?.claimedAt ?? row.claimed_at)],
      ["结束时间", time(run?.finishedAt ?? row.finished_at)],
      ["会话", run?.session ?? row.session],
      ["结果", run?.summary || row.summary || run?.error || row.error],
    ]) {
      if (value) meta.append(el("dt", name), el("dd", value));
    }
    panel.append(meta);
    const link = run?.link || row.link;
    if (typeof link === "string" && /^codex:\/\/threads\/[a-zA-Z0-9-]+$/.test(link)) {
      const anchor = el("a", "在 Codex 中查看会话");
      anchor.href = link;
      panel.append(anchor);
    }
    const list = el("ol", "", "timeline");
    for (const entry of details.entries.toReversed()) {
      const item = el("li");
      item.append(el("time", time(entry.at)), el("strong", entry.title));
      if (entry.detail) item.append(el("p", entry.detail));
      list.append(item);
    }
    panel.append(list.childElementCount ? list : el("p", "这轮暂无时间线记录。"));
    for (const event of details.events) {
      const source = el("details");
      source.append(el("summary", `事件资料 · ${event.type}`), el("pre", event.detail || event.summary || "没有正文"));
      const url = sourceUrl(event.link);
      if (url) source.append(sourceAnchor(url, "打开原始事件 ↗"));
      panel.append(source);
    }
  } catch (error) {
    if (traceVersion === version) {
      pending.textContent = error.message;
      renderedIssue = undefined;
    }
  }
}

function rebuild() {
  const runs = new Map(older);
  for (const run of snapshot.runs) runs.set(run.id, run);
  groups = issueGroups({
    runs: [...runs.values()], cards: snapshot.cards, recentCards: snapshot.recentCards,
    issueDispositions: snapshot.issueDispositions,
    issueStatuses: { ...olderIssueStatuses, ...snapshot.issueStatuses },
  });
  if (!groups.some((group) => group.key === selected)) {
    detailTab = "overview";
    selected = groups[0]?.key;
    selectedRun = groups[0]?.cards.find((card) => card.runId)?.runId ?? groups[0]?.runs[0]?.id;
  }
  renderList();
  renderIssue();
}

async function refresh(afterAction = false) {
  if (refreshing || paging || reloading) {
    if (afterAction === true) refreshQueued = true;
    return;
  }
  refreshing = true;
  try {
    const current = await get("/api/state");
    if (!snapshot || older.size === 0) nextBefore = current.nextBefore;
    snapshot = current;
    byId("collect").hidden = !snapshot.canCollect;
    if (snapshot.demo) for (const button of byId("collect").querySelectorAll("button")) button.disabled = true;
    const ruleSelect = byId("collect-rule");
    const ruleNames = (snapshot.lines ?? []).filter(({ types }) =>
      types.some(type => type.endsWith(".created")) && types.some(type => type.endsWith(".comment")))
      .map(({ name }) => name);
    if (ruleNames.join("\n") !== [...ruleSelect.options].slice(1).map(({ value }) => value).join("\n")) {
      const selectedRule = ruleSelect.value;
      ruleSelect.replaceChildren(new Option("自动匹配规则", ""), ...ruleNames.map(name => new Option(name, name)));
      ruleSelect.value = ruleNames.includes(selectedRule) ? selectedRule : "";
    }
    byId("connection").textContent = snapshot.demo ? "演示数据" : "Hub 已连接";
    byId("status").textContent = `已更新 ${time(snapshot.now)} · 统计按已加载轮次和待确认卡片计算`;
    rebuild();
  } catch (error) {
    byId("connection").textContent = "Hub 未连接";
    byId("status").textContent = error.message + (snapshot ? " · 保留上次读取的数据" : "");
  } finally {
    refreshing = false;
    flushRefresh();
  }
}

function flushRefresh() {
  if (!refreshQueued || refreshing || paging || reloading) return;
  refreshQueued = false;
  void refresh();
}

async function collectIssue(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const issue = byId("collect-issue").value.trim().toUpperCase();
  const status = byId("collect-result");
  if (!/^[A-Z][A-Z0-9_-]{0,69}-\d{1,9}$/.test(issue)) {
    status.textContent = "请输入有效的 Issue 编号，例如 DEMO-256。";
    return;
  }
  const dryRun = event.submitter?.value !== "collect";
  const rule = byId("collect-rule").value;
  const destination = rule ? `指定规则「${rule}」` : "自动匹配规则";
  if (!dryRun && !await actionDialog("手动采集 Issue", `将 ${issue} 按${destination}提交到 Hub？入队后可能启动执行或发送通知。`)) return;
  const buttons = [...form.querySelectorAll("button")];
  for (const button of buttons) button.disabled = true;
  status.textContent = dryRun ? "正在核对规则匹配…" : "正在采集…";
  try {
    const { message } = await post("/api/issues/collect", { issue, dryRun, ...(rule && { rule }) });
    status.textContent = collectSummary(message, dryRun);
    if (!dryRun) await Promise.all([refresh(true), refreshCollector()]);
  } catch (error) {
    status.textContent = collectSummary(error.message, dryRun);
  } finally {
    for (const button of buttons) button.disabled = false;
  }
}

let collectorSnapshot;
let changingCollector = false;

function collectorSummary(entry) {
  if (!entry) return "暂无采集记录";
  if (entry.mode === "hub") return "Hub 已接收 · 历史事件";
  if (!entry.ok) return entry.message;
  const result = [`符合条件 ${entry.eligible} 条`, `新建事件 ${entry.created} 条`, `新评论事件 ${entry.comments} 条`];
  if (entry.pending) result.push(`待核对 ${entry.pending} 条`);
  if (entry.noticeFailures) result.push(`通知失败 ${entry.noticeFailures} 条`);
  if (entry.baseline) result.push(`基线 ${entry.baseline} 条`);
  return result.join(" · ");
}

function collectorEntries(logs, events) {
  const entries = logs.map(entry => ({ ...entry, events: [...(entry.events ?? [])] }));
  const eventKey = ({ hubEvent, rule }) => `${hubEvent}:${rule}`;
  const recorded = new Set(entries.flatMap(({ events }) => events.map(eventKey)));
  for (const event of events) {
    const key = eventKey(event);
    if (recorded.has(key)) continue;
    recorded.add(key);
    const entry = entries.find(({ startedAt, finishedAt }) => startedAt && startedAt <= event.at && event.at <= finishedAt);
    if (entry) entry.events.push(event);
    else entries.push({ mode: "hub", finishedAt: event.at, events: [event] });
  }
  return entries.sort((a, b) => b.finishedAt.localeCompare(a.finishedAt)).slice(0, 50);
}

function renderCollector(state) {
  collectorSnapshot = state;
  byId("collector").hidden = !state;
  if (!state) return;
  const toggle = byId("collector-toggle");
  toggle.textContent = state.enabled ? "关闭" : "开启";
  toggle.setAttribute("aria-checked", String(state.enabled));
  toggle.disabled = Boolean(snapshot?.demo || changingCollector || (state.running && !state.enabled));
  const status = state.running
    ? state.enabled ? state.collecting ? "采集中" : "运行中 · 等待下次采集" : "正在停止"
    : "未运行";
  const tone = state.running ? (state.enabled ? "running" : "stopping") : "stopped";
  byId("collector-status").replaceChildren(
    el("span", status, `collector-state ${tone}`), `每 ${state.intervalSeconds / 60} 分钟一次`,
  );
  byId("collector-last").textContent = state.last
    ? `上次 · ${time(state.last.finishedAt)} · ${collectorSummary(state.last)}`
    : "上次 · 暂无采集记录";
  byId("collector-next").textContent = state.nextAt
    ? `下次 · ${time(state.nextAt)}`
    : state.collecting && state.enabled ? "下次 · 本轮结束后安排" : "下次 · —";
  const logs = byId("collector-logs");
  logs.replaceChildren(...collectorEntries(state.logs, state.hubEvents ?? []).map((entry) => {
    const item = el("li");
    const label = entry.mode === "manual" ? `手动采集 · ${entry.issue}${entry.rule ? ` · ${entry.rule}` : ""} · `
      : entry.mode === "hub" ? "" : "定时采集 · ";
    item.append(el("time", time(entry.finishedAt)), el("span", label + collectorSummary(entry)));
    if (entry.events?.length || entry.pendingItems?.length || entry.noticeFailureItems?.length) {
      const details = el("ul", "", "collector-events");
      for (const event of entry.events ?? []) {
        const row = el("li");
        const kind = event.type.endsWith(".created") ? "新建 Issue" : event.type.endsWith(".comment") ? "新增评论" : event.type;
        row.append(el("strong", event.title), el("span", `${kind} · ${event.rule} · ${event.outcome}${event.hubEvent ? ` · Hub #${event.hubEvent}` : ""}`, "meta"));
        if (groups.some(({ rule, subject }) => rule === event.rule && subject === event.subject)) {
          const open = el("button", "查看任务");
          open.onclick = () => {
            const issue = groups.find(({ rule, subject }) => rule === event.rule && subject === event.subject);
            if (!issue) return;
            selected = issue.key;
            selectedRun = issue.runs[0]?.id;
            detailTab = "execution";
            renderList();
            renderIssue();
            byId("detail").scrollIntoView({ block: "start" });
          };
          row.append(open);
        }
        details.append(row);
      }
      for (const pending of entry.pendingItems ?? []) {
        const candidates = pending.candidates?.length ? ` · 候选规则 ${pending.candidates.join("、")}` : "";
        details.append(el("li", `待核对 · ${pending.task} · ${pending.reason}${candidates}`));
      }
      for (const task of entry.noticeFailureItems ?? [])
        details.append(el("li", `需求方通知失败 · ${task}`));
      item.append(details);
    }
    if (entry.omittedEvents) item.append(el("p", `另有 ${entry.omittedEvents} 条事件，详见任务轮次。`, "meta"));
    return item;
  }));
}

async function refreshCollector() {
  if (changingCollector) return;
  try {
    const state = await get("/api/collector");
    if (!changingCollector) renderCollector(state);
  } catch (error) {
    byId("collector").hidden = false;
    byId("collector-status").textContent = error.message;
    byId("collector-toggle").disabled = true;
  }
}

byId("collector-toggle").onclick = async () => {
  if (!collectorSnapshot || changingCollector) return;
  changingCollector = true;
  byId("collector-toggle").disabled = true;
  try {
    renderCollector(await post("/api/collector", { enabled: !collectorSnapshot.enabled }));
  } catch (error) {
    byId("collector-status").textContent = error.message;
  } finally {
    changingCollector = false;
    byId("collector-toggle").disabled = Boolean(collectorSnapshot.running && !collectorSnapshot.enabled);
  }
};

function collectSummary(message, dryRun) {
  try {
    const { eligible, created, comments, pending, rule, rules } = JSON.parse(message.split("\n").at(-1));
    const issues = pending?.map(({ reason, candidates }) =>
      [reason, candidates?.join("、")].filter(Boolean).join(" · "));
    if (issues?.length) return issues.join("；");
    if (eligible === 0) return "没有符合采集条件的记录。";
    const matched = rules?.length ? rules.join("、") : rule;
    const heading = dryRun ? (matched ? `匹配规则「${matched}」` : "预演结果") : "采集完成";
    return `${heading} · 新 Issue ${created} 条 · 新评论 ${comments} 条`;
  } catch {
    return message;
  }
}

async function reloadDashboard() {
  if (reloading || !await actionDialog("重载看板", "重载本机看板服务？页面会在服务恢复后自动刷新。")) return;
  const button = byId("reload");
  const status = byId("status");
  reloading = button.disabled = true;
  status.textContent = "正在重载看板…";
  try {
    const response = await fetch("/api/dashboard/reload", {
      method: "POST", headers: { "content-type": "application/json" },
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error);
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      const current = await get("/api/dashboard/status").catch(() => null);
      if (!current) continue;
      if (current.instance !== result.instance) {
        window.location.reload();
        return;
      }
      if (current.reloadFailed) throw new Error("看板重载失败，原服务仍在运行。");
    }
    throw new Error("暂未确认看板已恢复，请稍后刷新页面。");
  } catch (error) {
    status.textContent = error.message;
    reloading = button.disabled = false;
  }
}

async function loadOlder() {
  if (!nextBefore || paging || refreshing) return;
  paging = true;
  byId("older").disabled = true;
  try {
    const page = await get(`/api/state?before=${nextBefore}`);
    for (const run of page.runs) older.set(run.id, run);
    Object.assign(olderIssueStatuses, page.issueStatuses);
    nextBefore = page.nextBefore;
    rebuild();
  } catch (error) {
    byId("status").textContent = error.message;
  } finally {
    paging = false;
    byId("older").disabled = false;
    flushRefresh();
  }
}

byId("reload").onclick = reloadDashboard;
get("/api/dashboard/status").then(({ canReload }) => { byId("reload").hidden = !canReload; }).catch(() => {});
byId("older").onclick = loadOlder;
byId("collect").onsubmit = collectIssue;
byId("search").oninput = renderList;
byId("filter").onchange = renderList;
renderList();
renderIssue();
await refresh();
void refreshCollector();
if (!snapshot?.demo) {
  setInterval(refresh, 10000);
  setInterval(refreshCollector, 5000);
}
