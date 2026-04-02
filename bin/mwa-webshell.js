#!/usr/bin/env node

import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const cliDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distEntry = path.join(cliDirectory, "dist", "index.js");
const forwardedArgs = process.argv[2] === "--"
  ? process.argv.slice(3)
  : process.argv.slice(2);

if (!(await hasEntry(distEntry))) {
  console.error(
    "The CLI build output is missing. Run `npm run build` before invoking the local bin.",
  );
  process.exit(1);
}

const child = spawn(
  process.execPath,
  [distEntry, ...forwardedArgs],
  {
    stdio: "inherit",
    env: process.env,
  },
);

child.on("error", (error) => {
  console.error(
    error instanceof Error
      ? error.message
      : "Failed to start the Solana Mobile Web Shell CLI.",
  );
  process.exitCode = 1;
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }

  process.exitCode = code ?? 1;
});

async function hasEntry(filePath) {
  try {
    await access(filePath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}
