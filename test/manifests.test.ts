import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import {
  loadManifest,
  loadBubblewrapManifest,
  loadWebManifest,
} from "../src/lib/manifests.ts";

test("loadBubblewrapManifest reads Bubblewrap-style metadata", async () => {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "webshell-manifest-"));

  try {
    const manifestPath = path.join(tempDirectory, "twa-manifest.json");
    await writeFile(
      manifestPath,
      JSON.stringify({
        packageId: "com.example.walletshell",
        launcherName: "Wallet Shell",
        host: "app.example.com",
        startUrl: "/launch?mode=prod",
        webManifestUrl: "./manifest.json",
        signingKey: {
          path: "./release.keystore",
          alias: "release",
        },
      }),
      "utf8",
    );

    const seed = await loadBubblewrapManifest(manifestPath, tempDirectory);

    assert.equal(seed.kind, "bubblewrap");
    assert.equal(seed.appName, "Wallet Shell");
    assert.equal(seed.applicationId, "com.example.walletshell");
    assert.equal(seed.webManifestUrl, pathToFileURL(path.join(tempDirectory, "manifest.json")).toString());
    assert.equal(seed.webUrl, "https://app.example.com/launch?mode=prod");
    assert.deepEqual(seed.signing, {
      keystorePath: "./release.keystore",
      keyAlias: "release",
      storePasswordEnv: "WEB_SHELL_KEYSTORE_PASSWORD",
      keyPasswordEnv: "WEB_SHELL_KEY_PASSWORD",
    });
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
});

test("loadWebManifest resolves a remote relative start_url", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) =>
    ({
      ok: true,
      headers: new Headers({
        "content-type": input.toString().endsWith(".png") ? "image/png" : "application/json",
      }),
      json: async () => ({
        name: "Trepa",
        start_url: "/app/start",
        theme_color: "#123456",
        background_color: "#ABCDEF",
        icons: [
          {
            src: "/icons/launcher.png",
            sizes: "512x512",
            type: "image/png",
          },
        ],
      }),
    }) as Response;

  try {
    const manifestUrl = "https://trepa.app/manifest.json";
    const seed = await loadWebManifest(manifestUrl, process.cwd());

    assert.equal(seed.kind, "web");
    assert.equal(seed.appName, "Trepa");
    assert.equal(seed.webUrl, "https://trepa.app/app/start");
    assert.equal(seed.themeColor, "#123456");
    assert.equal(seed.backgroundColor, "#ABCDEF");
    assert.deepEqual(seed.icons, [
      {
        src: "https://trepa.app/icons/launcher.png",
        sizes: [512],
        type: "image/png",
        purpose: [],
      },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("loadWebManifest falls back to the manifest site origin when start_url is missing", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    ({
      ok: true,
      headers: new Headers({
        "content-type": "application/json",
      }),
      json: async () => ({
        name: "Jupiter",
        short_name: "Jupiter",
      }),
    }) as Response;

  try {
    const manifestUrl = "https://jup.ag/manifest.json";
    const seed = await loadWebManifest(manifestUrl, process.cwd());

    assert.equal(seed.kind, "web");
    assert.equal(seed.appName, "Jupiter");
    assert.equal(seed.webUrl, "https://jup.ag/");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("loadManifest autodetects Bubblewrap-style manifests", async () => {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "webshell-manifest-"));

  try {
    const manifestPath = path.join(tempDirectory, "twa-manifest.json");
    await writeFile(
      manifestPath,
      JSON.stringify({
        packageId: "com.example.detected",
        launcherName: "Detected Shell",
        host: "wallet.example.com",
        startUrl: "/",
      }),
      "utf8",
    );

    const seed = await loadManifest(manifestPath, tempDirectory);

    assert.equal(seed.kind, "bubblewrap");
    assert.equal(seed.applicationId, "com.example.detected");
    assert.equal(seed.appName, "Detected Shell");
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
});
