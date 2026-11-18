import { execFile, spawn } from "node:child_process";
import { resolve } from "node:path";

/** Runs a command to completion; never rejects. */
export function run(cmd, args, { cwd, env, timeout = 120_000 } = {}) {
  return new Promise((done) => {
    execFile(cmd, args, { cwd, env, timeout, windowsHide: true, maxBuffer: 16 << 20 }, (error, stdout, stderr) => {
      done({ code: error ? (typeof error.code === "number" ? error.code : 1) : 0, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

/** Runs a command and hands each output line to `onLine`; resolves with the exit code. */
export function stream(cmd, args, { cwd, env, onLine }) {
  return new Promise((done) => {
    const child = spawn(cmd, args, { cwd, env, windowsHide: true });
    for (const s of [child.stdout, child.stderr]) {
      let rest = "";
      s.setEncoding("utf8");
      s.on("data", (chunk) => {
        const lines = (rest + chunk).split(/\r?\n/);
        rest = lines.pop();
        lines.forEach((l) => onLine(l));
      });
      s.on("end", () => rest && onLine(rest));
    }
    child.on("error", (err) => { onLine(`error: ${err.message}`); done(1); });
    child.on("close", (code) => done(code ?? 1));
  });
}

const norm = (p) => resolve(p).replace(/\\/g, "/").toLowerCase();
export const samePath = (a, b) => norm(a) === norm(b);

/** `git worktree list --porcelain`, main checkout first. */
export async function listWorktrees(repo) {
  const { code, stdout, stderr } = await run("git", ["-C", repo, "worktree", "list", "--porcelain"]);
  if (code !== 0) throw new Error(`git worktree list failed: ${stderr.trim()}`);
  const list = [];
  let cur = null;
  for (const line of stdout.split(/\r?\n/)) {
    if (line.startsWith("worktree ")) list.push((cur = { dir: resolve(line.slice(9)), branch: null, head: null, detached: false, prunable: false }));
    else if (!cur) continue;
    else if (line.startsWith("HEAD ")) cur.head = line.slice(5);
    else if (line.startsWith("branch ")) cur.branch = line.slice(7).replace(/^refs\/heads\//, "");
    else if (line === "detached") cur.detached = true;
    else if (line.startsWith("prunable")) cur.prunable = true;
    else if (line === "bare") cur.bare = true;
  }
  return list.filter((w) => !w.bare);
}

/** Branch, upstream, ahead/behind, uncommitted file count and last commit. */
export async function gitInfo(dir) {
  const g = (...args) => run("git", ["-C", dir, ...args], { timeout: 20_000 });
  const [branch, upstream, status, last] = await Promise.all([
    g("rev-parse", "--abbrev-ref", "HEAD"),
    g("rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"),
    g("status", "--porcelain=v1", "--untracked-files=normal"),
    g("log", "-1", "--format=%h%x09%cr%x09%s"),
  ]);
  const info = {
    branch: branch.code === 0 ? branch.stdout.trim() : null,
    upstream: upstream.code === 0 ? upstream.stdout.trim() : null,
    ahead: 0,
    behind: 0,
    dirty: status.code === 0 ? status.stdout.split(/\r?\n/).filter(Boolean).length : null,
    last: null,
  };
  if (last.code === 0 && last.stdout.trim()) {
    const [hash, when, ...subject] = last.stdout.trim().split("\t");
    info.last = { hash, when, subject: subject.join("\t") };
  }
  if (info.upstream) {
    const counts = await g("rev-list", "--left-right", "--count", "HEAD...@{u}");
    if (counts.code === 0) [info.ahead, info.behind] = counts.stdout.trim().split(/\s+/).map(Number);
  }
  return info;
}

export async function validBranchName(name) {
  if (typeof name !== "string" || !name || name.length > 200 || name.startsWith("-")) return false;
  return (await run("git", ["check-ref-format", "--branch", name])).code === 0;
}
