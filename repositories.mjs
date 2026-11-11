import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
const git = async (repo, args) =>
  (await execute("git", ["--no-optional-locks", "-C", repo, ...args], { env, timeout: 3000 })).stdout.trim();

const shellQuote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";

function webRepository(remote) {
  try {
    const scp = /^[^@\s]+@([a-z0-9.-]+):([^\s]+)$/i.exec(remote);
    const url = new URL(scp ? `https://${scp[1]}/${scp[2]}` : remote);
    if (!["https:", "ssh:"].includes(url.protocol)) return;
    const path = url.pathname.replace(/\.git\/?$/, "").replace(/\/$/, "");
    if (path.split("/").filter(Boolean).length < 2) return;
    return { hostname: url.hostname, url: `https://${url.protocol === "ssh:" ? url.hostname : url.host}${path}` };
  } catch {
    return undefined;
  }
}

async function registration(home, rule, subject) {
  if (typeof rule !== "string" || !rule || rule.length > 500 ||
      typeof subject !== "string" || !subject || subject.length > 500) return;
  const key = createHash("sha256").update(JSON.stringify([rule, subject])).digest("hex");
  try {
    const root = await realpath(join(home, "worker", "worktrees"));
    const folder = join(root, key);
    if (await realpath(folder) !== folder) return;
    const file = join(folder, "registration.json");
    if (await realpath(file) !== file) return;
    return { folder, ...JSON.parse(await readFile(file, "utf8")) };
  } catch {
    return undefined;
  }
}

export async function adoptableWorkspaces(issue, repositories = {}) {
  const match = /^([A-Z]+)-(\d{1,9})$/.exec(issue ?? "");
  if (!match) return [];
  const [, project, number] = match;
  const branchPattern = new RegExp(`^fea_(?:${project}${number}|issue${number}_\\d{8})$`);
  const candidates = await Promise.all(Object.entries(repositories).map(async ([name, config]) => {
    try {
      const repo = await realpath(config.path.replace(/^~(?=\/)/, homedir()));
      const baseRef = `refs/heads/${config.baseBranch}`;
      const records = (await git(repo, ["worktree", "list", "--porcelain", "-z"])).split("\0\0");
      return records.flatMap(record => {
        const fields = record.split("\0");
        const path = fields[0]?.slice("worktree ".length);
        const branch = fields.find(field => field.startsWith("branch refs/heads/"))?.slice("branch refs/heads/".length);
        const commit = fields.find(field => field.startsWith("HEAD "))?.slice(5);
        if (!path || path === repo || !branchPattern.test(branch ?? "") || !/^[a-f0-9]{40,64}$/.test(commit ?? "")) return [];
        return [{ name, repo, path, branch, commit, baseRef }];
      });
    } catch {
      return [];
    }
  }));
  return candidates.flat();
}

export async function adoptTaskWorkspace(home, rule, subject, candidate) {
  const saved = await registration(home, rule, subject);
  const { name, repo, path, branch, commit, baseRef } = candidate;
  if (!/^[a-z][a-z0-9-]{0,99}$/.test(name)) throw new Error("仓库名称无效");
  if (saved?.repositories?.[name] || (saved && saved.branch !== branch))
    throw new Error("当前任务已有不同的仓库或分支登记");
  if (await realpath(path) !== path ||
      await git(path, ["symbolic-ref", "HEAD"]) !== `refs/heads/${branch}` ||
      await git(path, ["rev-parse", "HEAD"]) !== commit)
    throw new Error("工作区或提交已变化，请刷新后重试");
  const baseCommit = await git(repo, ["merge-base", baseRef, commit]);
  const key = createHash("sha256").update(JSON.stringify([rule, subject])).digest("hex");
  const root = join(home, "worker", "worktrees");
  await mkdir(root, { recursive: true, mode: 0o700 });
  const folder = join(await realpath(root), key);
  await mkdir(folder, { recursive: true, mode: 0o700 });
  if (await realpath(folder) !== folder) throw new Error("任务登记目录不正确");
  const file = join(folder, "registration.json");
  const temp = `${file}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify({
    branch, repositories: { ...saved?.repositories, [name]: { repo, path, branch, baseRef, baseCommit, adopted: true } },
  }), { mode: 0o600, flag: "wx" });
  await rename(temp, file);
}

export async function taskRepositories(home, rule, subject, issue) {
  const saved = await registration(home, rule, subject);
  const short = typeof issue === "string" && /^[A-Z]+-\d{1,9}$/.test(issue) ? `fea_${issue.replace("-", "")}` : "";
  return Promise.all(Object.entries(saved?.repositories ?? {}).map(async ([name, binding]) => {
    const info = { name, branch: binding?.branch, workspace: false, remoteBranches: [], adopted: binding?.adopted === true };
    if (!binding || typeof binding.repo !== "string" || !isAbsolute(binding.repo) ||
        typeof binding.branch !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(binding.branch)) return info;
    info.workspace = Boolean(await workspacePath(saved, name));
    info.localSwitch = { command: `git checkout ${shellQuote(binding.branch)}` };
    try {
      const web = webRepository(await git(binding.repo, ["config", "--get", "remote.origin.url"]));
      if (!web) return info;
      info.repositoryUrl = web.url;
      const tree = web.hostname === "github.com" ? "/tree/" :
        web.hostname === "gitlab.com" ? "/-/tree/" : "";
      const names = [...new Set([binding.branch, short].filter(Boolean))];
      const refs = await git(binding.repo, ["for-each-ref", "--format=%(refname)", ...names.map((name) => `refs/remotes/origin/${name}`)]);
      info.remoteBranches = names.filter((name) => refs.split("\n").includes(`refs/remotes/origin/${name}`))
        .map((name) => ({ name, ...(tree && { url: web.url + tree + encodeURIComponent(name) }) }));
    } catch {
      // The registered task branch is still useful if origin cannot be read.
    }
    return info;
  }));
}

async function workspacePath(saved, name) {
  if (!saved || typeof name !== "string" || !/^[a-z][a-z0-9-]{0,99}$/.test(name)) return;
  if (!Object.hasOwn(saved.repositories ?? {}, name)) return;
  const binding = saved.repositories[name];
  const expected = binding.adopted ? binding.path : join(saved.folder, name);
  if (!isAbsolute(expected ?? "") || binding.path !== expected) return;
  if (binding.adopted) {
    const records = await git(binding.repo, ["worktree", "list", "--porcelain", "-z"]).catch(() => "");
    if (!records.split("\0").includes(`worktree ${expected}`)) return;
  }
  if (await realpath(expected).catch(() => undefined) === expected &&
      (await stat(expected).catch(() => undefined))?.isDirectory()) return expected;
}

export async function openTaskWorkspace(home, { rule, subject, name }) {
  const path = await workspacePath(await registration(home, rule, subject), name);
  if (!path) return false;
  await execute("/usr/bin/open", [path], { timeout: 5000 });
  return true;
}

export async function taskBranchAction(home, { rule, subject, name, action }, dispositions, debugAction) {
  const saved = await registration(home, rule, subject);
  const binding = saved && Object.hasOwn(saved.repositories ?? {}, name) && saved.repositories[name];
  if (!binding || !isAbsolute(binding.repo ?? "") ||
      !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(binding.branch ?? ""))
    throw new Error("找不到已登记的需求分支");
  const repo = await realpath(binding.repo);
  const { branch } = binding;
  const ref = `refs/heads/${branch}`;
  const commit = await git(repo, ["rev-parse", "--verify", `${ref}^{commit}`]);
  if (action === "push") {
    try {
      await execute("git", ["-C", repo, "push", "origin", `${commit}:${ref}`], { env, timeout: 60000 });
    } catch {
      throw new Error("推送失败，请核对 origin 的连接、权限及远端分支是否有新提交");
    }
    return;
  }
  const path = await workspacePath(saved, name);
  if (!path) throw new Error("找不到已登记的任务工作区");
  const records = (await git(repo, ["worktree", "list", "--porcelain", "-z"])).split("\0\0").map(row => row.split("\0"));
  if (!records.some(row => row[0] === `worktree ${path}`))
    throw new Error("任务工作区与原项目仓库不匹配");
  const head = (cwd) => git(cwd, ["rev-parse", "--symbolic-full-name", "HEAD"]);
  const clean = async () => {
    const changes = await Promise.all([
      git(repo, ["status", "--porcelain", "--untracked-files=all"]),
      git(path, ["status", "--porcelain", "--untracked-files=all"]),
    ]);
    if (changes.some(Boolean)) throw new Error("原项目或任务工作区有未提交的改动，请先提交或暂存");
  };
  let debug = dispositions.find(item => item.rule === rule && item.subject === subject)?.localDebug;
  if (debug && debug.name !== name) throw new Error("请先交回此任务正在调试的仓库");
  if (dispositions.some(item => item.localDebug?.repo === repo && item.localDebug !== debug))
    throw new Error("原项目目录正在调试另一个任务，请先交回");
  const [originalHead, workerHead] = await Promise.all([head(repo), head(path)]);
  await clean();
  const checkout = async (cwd, args) => {
    try {
      await git(cwd, ["checkout", "--no-overwrite-ignore", ...args]);
    } catch {
      throw new Error("Git 拒绝切换分支，请核对工作区状态后重试交接或交回");
    }
  };
  if (action === "local-debug-start") {
    if (!debug) {
      if (!/^refs\/heads\/[^-]/.test(originalHead) || workerHead !== ref)
        throw new Error("请先让原项目处于本地分支、任务工作区处于需求分支");
      ({ localDebug: debug } = await debugAction({ action, name, original: originalHead, repo }));
      await clean();
      if (await head(repo) !== originalHead || await head(path) !== workerHead)
        throw new Error("交接期间分支发生变化，请核对后重试");
    }
    if (originalHead === ref && workerHead === "HEAD") return;
    if (originalHead !== debug.original || (workerHead !== ref && workerHead !== "HEAD"))
      throw new Error("当前分支与交接记录不符");
    if (workerHead === ref) await checkout(path, ["--detach"]);
    await checkout(repo, [branch, "--"]);
  } else {
    if (!debug || !/^refs\/heads\/[^-]/.test(debug.original)) throw new Error("没有有效的本地调试交接记录");
    if (originalHead !== ref && originalHead !== debug.original)
      throw new Error("请先切回需求分支或交接前的原项目分支");
    if (workerHead !== "HEAD" && workerHead !== ref) throw new Error("任务工作区当前分支与交接记录不符");
    if (originalHead === ref) await checkout(repo, [debug.original.slice("refs/heads/".length), "--"]);
    if (workerHead !== ref) await checkout(path, [branch, "--"]);
    await debugAction({ action, name, handoff: debug.id });
  }
}

export async function removeTaskWorkspace(home, { rule, subject, name }) {
  const saved = await registration(home, rule, subject);
  const path = await workspacePath(saved, name);
  if (!path) return false;
  const binding = saved.repositories[name];
  if (binding.adopted) throw new Error("接管的 App 工作区请在原位置管理");
  if (typeof binding.repo !== "string" || !isAbsolute(binding.repo) ||
      typeof binding.branch !== "string" ||
      await git(path, ["symbolic-ref", "HEAD"]) !== `refs/heads/${binding.branch}`)
    throw new Error("工作区分支与登记不符");
  await git(binding.repo, ["worktree", "remove", "--", path]);
  return true;
}
