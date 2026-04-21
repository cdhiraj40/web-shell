import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const cliDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

test("npm pack dry-run includes only packaged runtime assets", async () => {
  const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
  await runCommand(npmCommand, ["run", "build"], cliDirectory);
  const output = await runCommand(npmCommand, ["pack", "--dry-run", "--json"], cliDirectory);
  const parsed = JSON.parse(output) as Array<{
    files: Array<{ path: string }>;
  }>;

  assert.equal(parsed.length, 1);
  const filePaths = parsed[0]?.files.map((entry) => entry.path) ?? [];

  assert.ok(filePaths.includes("README.md"), formatMissingFileMessage("README.md", filePaths));
  assert.ok(filePaths.includes("bin/webshell.js"), formatMissingFileMessage("bin/webshell.js", filePaths));
  assert.ok(filePaths.includes("dist/index.js"), formatMissingFileMessage("dist/index.js", filePaths));
  assert.ok(filePaths.includes("template/build.gradle.kts"), formatMissingFileMessage("template/build.gradle.kts", filePaths));

  assert.equal(filePaths.some((filePath) => filePath.startsWith("src/")), false);
  assert.equal(filePaths.some((filePath) => filePath.startsWith("test/")), false);
  assert.equal(filePaths.some((filePath) => filePath.startsWith("scripts/")), false);
  assert.equal(filePaths.includes("test-release.keystore"), false);
});

async function runCommand(
  command: string,
  args: string[],
  cwd: string,
): Promise<string> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve(stdout);
        return;
      }

      reject(
        new Error(
          stderr.trim() || `Command failed with code ${code ?? "unknown"}.`,
        ),
      );
    });
  });
}

function formatMissingFileMessage(
  expectedPath: string,
  filePaths: string[],
): string {
  return `Expected npm pack output to include ${expectedPath}. Actual files: ${filePaths.join(", ")}`;
}
