#!/usr/bin/env tsx
/**
 * smoke-wsl-git-init — Q7 acceptance.
 *
 *   1. `applyPostInitGitConfig` runs the two `git config --local`
 *      commands with the absolute repoRoot.
 *   2. The injected `gitRunner` records argv exactly.
 *   3. `detectWsl` returns true on linux + Microsoft proc-version.
 *   4. `detectWsl` returns false on darwin / win32.
 *   5. `detectWsl` returns false on linux without WSL marker.
 *   6. End-to-end: when detectWsl()=true and applyPostInitGitConfig is
 *      called with an injected runner, both calls fire with safe.directory
 *      pointing at the absolute repoRoot.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  applyPostInitGitConfig,
  detectWsl,
  type GitRunResult,
  type GitRunner,
} from "@isaacriehm/cairn-core";

const cleanups: string[] = [];

function header(msg: string): void {
  console.log(`\n── ${msg}`);
}

function fail(msg: string): never {
  console.error(`\n  ✗ ${msg}`);
  process.exit(1);
}

function pass(msg: string): void {
  console.log(`  ✓ ${msg}`);
}

interface Recorded {
  args: string[];
  cwd: string;
}

function recorder(): { runner: GitRunner; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const runner: GitRunner = (args, cwd): GitRunResult => {
    calls.push({ args, cwd });
    return { ok: true, stdout: "", stderr: "" };
  };
  return { runner, calls };
}

function makeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "cairn-smoke-wsl-"));
  cleanups.push(root);
  return root;
}

async function main(): Promise<void> {
  console.log("smoke-wsl-git-init — start");

  header("Step 1 — applyPostInitGitConfig fires both calls with absolute path");
  {
    const repo = makeRepo();
    const { runner, calls } = recorder();
    const r = applyPostInitGitConfig({ repoRoot: repo, gitRunner: runner });
    if (calls.length !== 2) fail(`expected 2 git calls, got ${calls.length}`);
    if (r.applied.length !== 2) fail(`expected 2 applied entries`);

    const a = calls[0]!;
    if (a.args[0] !== "config" || a.args[1] !== "--local" || a.args[2] !== "safe.directory") {
      fail(`call 1 args wrong: ${JSON.stringify(a.args)}`);
    }
    if (a.args[3] !== resolve(repo)) fail(`safe.directory should be abs repoRoot`);
    if (a.cwd !== resolve(repo)) fail(`cwd should be abs repoRoot`);

    const b = calls[1]!;
    if (
      b.args[0] !== "config" ||
      b.args[1] !== "--local" ||
      b.args[2] !== "core.fileMode" ||
      b.args[3] !== "false"
    ) {
      fail(`call 2 args wrong: ${JSON.stringify(b.args)}`);
    }
    pass("safe.directory + core.fileMode false fired");
  }

  header("Step 2 — runner failure surfaces in result.applied[].ok");
  {
    const repo = makeRepo();
    let n = 0;
    const failingRunner: GitRunner = () => {
      n++;
      return { ok: n === 1, stdout: "", stderr: n === 1 ? "" : "fatal: bad config" };
    };
    const r = applyPostInitGitConfig({ repoRoot: repo, gitRunner: failingRunner });
    if (r.applied[0]?.ok !== true) fail("first call should be ok");
    if (r.applied[1]?.ok !== false) fail("second call should fail");
    if (!r.applied[1]?.stderr.includes("bad config")) fail("stderr should propagate");
    pass("failure threaded back into result");
  }

  header("Step 3 — detectWsl on linux + Microsoft proc-version → true");
  {
    const wsl = detectWsl({
      platform: "linux",
      procVersionReader: () =>
        "Linux version 5.15.146.1-microsoft-standard-WSL2 (x86_64-msft-linux-gnu)\n",
    });
    if (!wsl) fail("expected wsl=true");
    pass("linux + WSL marker → true");
  }

  header("Step 4 — detectWsl on darwin → false");
  {
    if (detectWsl({ platform: "darwin", procVersionReader: () => "Microsoft" })) {
      fail("darwin should never report WSL");
    }
    if (detectWsl({ platform: "win32", procVersionReader: () => "Microsoft" })) {
      fail("win32 should never report WSL");
    }
    pass("non-linux → false");
  }

  header("Step 5 — detectWsl on linux without marker → false");
  {
    if (
      detectWsl({
        platform: "linux",
        procVersionReader: () => "Linux version 6.5.0-generic (gcc 13.2.0)\n",
      })
    ) {
      fail("plain linux should not match");
    }
    if (detectWsl({ platform: "linux", procVersionReader: () => null })) {
      fail("missing /proc/version should not match");
    }
    pass("non-WSL linux → false");
  }

  header("Step 6 — end-to-end: WSL detected ⇒ apply runs unconditionally");
  {
    const repo = makeRepo();
    const wsl = detectWsl({
      platform: "linux",
      procVersionReader: () => "WSL2 microsoft kernel\n",
    });
    if (!wsl) fail("expected wsl=true");
    const { runner, calls } = recorder();
    if (wsl) {
      applyPostInitGitConfig({ repoRoot: repo, gitRunner: runner });
    }
    if (calls.length !== 2) fail("WSL+apply should still fire 2 calls");
    if (calls[0]?.args[3] !== resolve(repo)) fail("safe.directory must be abs repo");
    pass("WSL gate + apply produces both git config calls");
  }

  console.log("smoke-wsl-git-init — pass");
}

main()
  .catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => {
    for (const dir of cleanups) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  });
