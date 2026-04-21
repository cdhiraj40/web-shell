import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import {
  readProjectConfig,
  writeProjectConfig,
} from "../src/lib/project-config.ts";
import { PROJECT_CONFIG_FILENAME } from "../src/lib/utils.ts";

test("writeProjectConfig persists a Bubblewrap-style twa-manifest subset", async () => {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "webshell-config-"));

  try {
    await writeProjectConfig(tempDirectory, {
      schemaVersion: 1,
      generatedAt: "2026-03-12T00:00:00.000Z",
      projectName: "WalletShell",
      appName: "Wallet Shell",
      applicationId: "com.example.walletshell",
      versionCode: 12,
      versionName: "1.2.0",
      packageName: "com.example.walletshell",
      webUrl: "https://app.example.com/launch?mode=prod",
      source: {
        templateRepo: "bundled",
        templateRef: "bundled",
        webManifest: "https://app.example.com/manifest.json",
      },
      signing: {
        keystorePath: "/tmp/release.keystore",
        keyAlias: "release",
      },
    });

    const configPath = path.join(tempDirectory, PROJECT_CONFIG_FILENAME);
    const contents = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;

    assert.equal(contents.packageId, "com.example.walletshell");
    assert.equal(contents.host, "app.example.com");
    assert.equal(contents.name, "Wallet Shell");
    assert.equal(contents.launcherName, "Wallet Shell");
    assert.equal(contents.startUrl, "/launch?mode=prod");
    assert.equal(contents.webManifestUrl, "https://app.example.com/manifest.json");
    assert.equal(contents.fallbackType, "webview");
    assert.equal(contents.generatorApp, "webshell-cli");
    assert.deepEqual(contents.signingKey, {
      path: "/tmp/release.keystore",
      alias: "release",
    });
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
});

test("readProjectConfig loads signing metadata from twa-manifest.json", async () => {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "webshell-config-"));

  try {
    await writeProjectConfig(tempDirectory, {
      schemaVersion: 1,
      generatedAt: "2026-03-12T00:00:00.000Z",
      projectName: "WalletShell",
      appName: "Wallet Shell",
      applicationId: "com.example.walletshell",
      versionCode: 1,
      versionName: "1.0.0",
      packageName: "com.example.walletshell",
      webUrl: "https://app.example.com/",
      source: {
        templateRepo: "bundled",
        templateRef: "bundled",
      },
      signing: {
        keystorePath: "/tmp/release.keystore",
        keyAlias: "release",
      },
    });

    const config = await readProjectConfig(tempDirectory);
    assert.deepEqual(config, {
      signing: {
        keystorePath: "/tmp/release.keystore",
        keyAlias: "release",
        storePasswordEnv: "WEB_SHELL_KEYSTORE_PASSWORD",
        keyPasswordEnv: "WEB_SHELL_KEY_PASSWORD",
      },
    });
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
});
