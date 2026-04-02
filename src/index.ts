#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { runBuildCommand } from "./commands/build.js";
import { runDoctorCommand } from "./commands/doctor.js";
import { runInitCommand } from "./commands/init.js";

const CLI_VERSION = readCliVersion();

async function main(): Promise<void> {
  ensureSupportedNodeVersion();

  const argv = process.argv.slice(2);
  const command = argv[0];

  if (!command || command === "help" || command === "--help" || command === "-h") {
    printHelp();
    return;
  }

  if (command === "--version" || command === "-v") {
    console.log(CLI_VERSION);
    return;
  }

  switch (command) {
    case "init": {
      const { values, positionals } = parseArgs({
        args: argv.slice(1),
        allowPositionals: true,
        options: {
          manifest: { type: "string" },
          "application-id": { type: "string" },
          "app-name": { type: "string" },
          url: { type: "string" },
          "version-code": { type: "string" },
          "version-name": { type: "string" },
          "keystore-path": { type: "string" },
          "keystore-alias": { type: "string" },
          force: { type: "boolean" },
          help: { type: "boolean", short: "h" },
        },
      });

      if (values.help) {
        printInitHelp();
        return;
      }

      await runInitCommand(positionals[0], {
        manifest: values.manifest,
        applicationId: values["application-id"],
        appName: values["app-name"],
        url: values.url,
        versionCode: values["version-code"]
          ? Number.parseInt(values["version-code"], 10)
          : undefined,
        versionName: values["version-name"],
        keystorePath: values["keystore-path"],
        keystoreAlias: values["keystore-alias"],
        force: values.force,
      });
      return;
    }

    case "build": {
      const { values, positionals } = parseArgs({
        args: argv.slice(1),
        allowPositionals: true,
        options: {
          release: { type: "boolean" },
          stacktrace: { type: "boolean" },
          "keystore-path": { type: "string" },
          "keystore-alias": { type: "string" },
          help: { type: "boolean", short: "h" },
        },
      });

      if (values.help) {
        printBuildHelp();
        return;
      }

      await runBuildCommand(positionals[0], {
        release: values.release,
        stacktrace: values.stacktrace,
        keystorePath: values["keystore-path"],
        keystoreAlias: values["keystore-alias"],
      });
      return;
    }

    case "doctor": {
      const { values, positionals } = parseArgs({
        args: argv.slice(1),
        allowPositionals: true,
        options: {
          fix: { type: "boolean" },
          help: { type: "boolean", short: "h" },
        },
      });

      if (values.help) {
        printDoctorHelp();
        return;
      }

      await runDoctorCommand(positionals[0], {
        fix: values.fix,
      });
      return;
    }

    default:
      throw new Error(`Unknown command: ${command}`);
  }
}

function readCliVersion(): string {
  const rawPackageJson = readFileSync(new URL("../package.json", import.meta.url), "utf8");
  const parsed = JSON.parse(rawPackageJson) as { version?: string };
  return parsed.version ?? "0.0.0";
}

function ensureSupportedNodeVersion(): void {
  const majorVersion = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
  if (majorVersion < 24) {
    throw new Error(
      `Node 24 or newer is required. Found ${process.versions.node}.`,
    );
  }
}

function printHelp(): void {
  console.log(`Solana Mobile Web Shell CLI ${CLI_VERSION}

Usage:
  mwa-webshell <command> [options]

Commands:
  init [directory]   Generate a new Android WebView shell project
  build [directory]  Build a generated Android project
  doctor [directory] Check and optionally install required Android build tools

Run "mwa-webshell <command> --help" for command-specific options.`);
}

function printInitHelp(): void {
  console.log(`Usage:
  mwa-webshell init [directory] [options]

Options:
  --manifest <path-or-url>                     Load a web manifest.json or Bubblewrap twa-manifest.json
  --application-id <id>                        Android application ID
  --app-name <name>                            Android launcher name
  --url <url>                                  Default web URL to load
  --version-code <number>                      Android version code for updates/releases
  --version-name <name>                        Android version name for updates/releases
  --keystore-path <path>                       Optional release keystore path
  --keystore-alias <alias>                     Optional release key alias
  --force                                      Overwrite template files if needed
  -h, --help                                   Show help`);
}

function printBuildHelp(): void {
  console.log(`Usage:
  mwa-webshell build [directory] [options]

Options:
  --release                    Build a release APK
  --stacktrace                 Pass --stacktrace to Gradle
  --keystore-path <path>       Release keystore path override
  --keystore-alias <alias>     Release key alias override
  -h, --help                   Show help`);
}

function printDoctorHelp(): void {
  console.log(`Usage:
  mwa-webshell doctor [directory] [options]

Options:
  --fix                        Install missing tools and SDK packages automatically
  -h, --help                   Show help`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Error: ${message}`);
  process.exitCode = 1;
});
