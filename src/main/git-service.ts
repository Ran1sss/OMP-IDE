import type { IpcMain } from "electron";
import { execFile } from "node:child_process";
import type {
  GitStatus,
  GitFileStatus,
  GitFileCode,
  GitLineRange,
  GitCommitInfo,
} from "../shared/types";

function git(root: string, args: string[], input?: string): Promise<string> {
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  const proc = execFile(
    "git",
    args,
    { cwd: root, maxBuffer: 32 * 1024 * 1024, windowsHide: true, encoding: "utf-8" },
    (err, stdout, stderr) => {
      if (err) reject(new Error(stderr.trim() || err.message));
      else resolve(stdout);
    },
  );
  if (input !== undefined && proc.stdin) {
    proc.stdin.write(input);
    proc.stdin.end();
  }
  return promise;
}

function parsePorcelain(out: string): GitFileStatus[] {
  const files: GitFileStatus[] = [];
  // porcelain v1 -z: entries NUL-separated; renames carry a second NUL-separated path
  const parts = out.split("\u0000").filter((p) => p.length > 0);
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    if (entry.length < 4) continue;
    const index = entry[0] as GitFileCode | " ";
    const worktree = entry[1] as GitFileCode | " ";
    const path = entry.slice(3);
    if (index === "R" || index === "C") {
      const origPath = parts[++i];
      files.push({ path, origPath, index, worktree });
    } else {
      files.push({ path, index, worktree });
    }
  }
  return files;
}

export function registerGitHandlers(ipc: IpcMain) {
  ipc.handle("git:status", async (_e, root: string): Promise<GitStatus> => {
    try {
      const out = await git(root, ["status", "--porcelain=v1", "-z", "--branch"]);
      const parts = out.split("\u0000");
      const branchLine = parts[0] ?? "";
      // "## main...origin/main [ahead 1, behind 2]"
      const bm = branchLine.match(/^## ([^.\s]+(?:[^.\s.]*)?)(?:\.\.\.\S+)?(?: \[(?:ahead (\d+))?(?:, )?(?:behind (\d+))?\])?/);
      let branch = "";
      let ahead = 0;
      let behind = 0;
      if (branchLine.startsWith("## ")) {
        const label = branchLine.slice(3);
        branch = label.split("...")[0].trim();
        if (branch.startsWith("No commits yet on ")) branch = label.slice("No commits yet on ".length);
        const a = bm?.[2];
        const b = bm?.[3];
        ahead = a ? parseInt(a, 10) : 0;
        behind = b ? parseInt(b, 10) : 0;
      }
      const rest = out.slice(out.indexOf("\u0000") + 1);
      return { isRepo: true, branch, ahead, behind, files: parsePorcelain(rest) };
    } catch {
      return { isRepo: false, branch: "", ahead: 0, behind: 0, files: [] };
    }
  });

  ipc.handle("git:stage", async (_e, root: string, paths: string[]) => {
    await git(root, ["add", "--", ...paths]);
  });

  ipc.handle("git:unstage", async (_e, root: string, paths: string[]) => {
    try {
      await git(root, ["restore", "--staged", "--", ...paths]);
    } catch {
      // Repos with no commits yet: restore fails; rm --cached handles new files.
      await git(root, ["rm", "--cached", "-r", "--", ...paths]);
    }
  });

  ipc.handle("git:commit", async (_e, root: string, message: string): Promise<string> => {
    const out = await git(root, ["commit", "-m", message]);
    return out.trim();
  });

  // Repo-local identity for the commit-rescue flow (first commit on a fresh
  // machine). Never touches --global config.
  ipc.handle("git:setIdentity", async (_e, root: string, name: string, email: string) => {
    await git(root, ["config", "user.name", name]);
    await git(root, ["config", "user.email", email]);
  });

  ipc.handle("git:branches", async (_e, root: string): Promise<string[]> => {
    const out = await git(root, ["branch", "--format=%(refname:short)"]);
    return out.split("\n").map((s) => s.trim()).filter(Boolean);
  });

  ipc.handle("git:checkout", async (_e, root: string, branch: string): Promise<string> => {
    const out = await git(root, ["checkout", branch]);
    return out.trim();
  });

  ipc.handle("git:discard", async (_e, root: string, paths: string[]) => {
    // Untracked files are removed; tracked files restored.
    const status = parsePorcelain(await git(root, ["status", "--porcelain=v1", "-z"]));
    const wanted = new Set(paths.map((p) => p.replace(/\\/g, "/")));
    const untracked: string[] = [];
    const tracked: string[] = [];
    for (const f of status) {
      if (!wanted.has(f.path)) continue;
      if (f.index === "?" && f.worktree === "?") untracked.push(f.path);
      else tracked.push(f.path);
    }
    if (tracked.length) await git(root, ["checkout", "--", ...tracked]);
    if (untracked.length) await git(root, ["clean", "-f", "--", ...untracked]);
  });

  ipc.handle("git:headContent", async (_e, root: string, path: string): Promise<string | null> => {
    try {
      return await git(root, ["show", `HEAD:${path.replace(/\\/g, "/")}`]);
    } catch {
      return null;
    }
  });

  ipc.handle("git:diffRanges", async (_e, root: string, path: string): Promise<GitLineRange[]> => {
    try {
      const out = await git(root, ["diff", "--unified=0", "--no-color", "--", path]);
      const ranges: GitLineRange[] = [];
      const hunkRe = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm;
      let m: RegExpExecArray | null;
      while ((m = hunkRe.exec(out))) {
        const oldCount = m[2] === undefined ? 1 : parseInt(m[2], 10);
        const newStart = parseInt(m[3], 10);
        const newCount = m[4] === undefined ? 1 : parseInt(m[4], 10);
        if (newCount === 0) {
          ranges.push({ start: newStart, count: 0, kind: "deleted" });
        } else if (oldCount === 0) {
          ranges.push({ start: newStart, count: newCount, kind: "added" });
        } else {
          ranges.push({ start: newStart, count: newCount, kind: "modified" });
        }
      }
      return ranges;
    } catch {
      return [];
    }
  });

  ipc.handle("git:log", async (_e, root: string, limit: number): Promise<GitCommitInfo[]> => {
    try {
      const out = await git(root, [
        "log",
        `-${Math.max(1, Math.min(limit, 200))}`,
        "--pretty=format:%H%x00%h%x00%s%x00%an%x00%at",
      ]);
      return out
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const [hash, shortHash, subject, author, at] = line.split("\u0000");
          return { hash, shortHash, subject, author, at: (parseInt(at, 10) || 0) * 1000 };
        });
    } catch {
      return [];
    }
  });

  ipc.handle("git:init", async (_e, root: string) => {
    await git(root, ["init"]);
  });
}
