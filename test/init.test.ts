import assert from "node:assert/strict";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { runInitCommand } from "../src/commands/init.ts";
const tinyPngBuffer = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aM6kAAAAASUVORK5CYII=",
  "base64",
);

test("init infers the Gradle project name from the target directory", async () => {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "mwa-webshell-init-"));
  const generatedProject = path.join(tempDirectory, "generated");

  try {
    await runInitCommand(generatedProject, {
      applicationId: "com.example.walletshell",
      appName: "Wallet Shell",
      url: "https://app.example.com/launch",
      nonInteractive: true,
    });

    const gradleProperties = await readFile(
      path.join(generatedProject, "gradle.properties"),
      "utf8",
    );
    const settingsGradle = await readFile(
      path.join(generatedProject, "settings.gradle.kts"),
      "utf8",
    );
    const appBuildGradle = await readFile(
      path.join(generatedProject, "app", "build.gradle.kts"),
      "utf8",
    );
    const stringsXml = await readFile(
      path.join(generatedProject, "app", "src", "main", "res", "values", "strings.xml"),
      "utf8",
    );
    const mainActivityPath = path.join(
      generatedProject,
      "app",
      "src",
      "main",
      "java",
      "com",
      "example",
      "walletshell",
      "MainActivity.kt",
    );
    const mainActivity = await readFile(mainActivityPath, "utf8");
    const twaManifest = JSON.parse(
      await readFile(path.join(generatedProject, "twa-manifest.json"), "utf8"),
    ) as Record<string, unknown>;

    assert.match(gradleProperties, /WEB_SHELL_URL=https:\/\/app\.example\.com\/launch/);
    assert.match(gradleProperties, /WEB_SHELL_APPLICATION_ID=com\.example\.walletshell/);
    assert.doesNotMatch(gradleProperties, /WEB_SHELL_USER_AGENT_SUFFIX=/);
    assert.match(settingsGradle, /rootProject\.name = "generated"/);
    assert.match(appBuildGradle, /namespace = "com\.example\.walletshell"/);
    assert.match(stringsXml, /<string name="app_name">Wallet Shell<\/string>/);
    assert.match(mainActivity, /^package com\.example\.walletshell/m);
    assert.equal(twaManifest.packageId, "com.example.walletshell");
    assert.equal(twaManifest.host, "app.example.com");
    assert.equal(twaManifest.startUrl, "/launch");
    assert.equal(twaManifest.fallbackType, "webview");
    assert.equal(twaManifest.generatorApp, "mwa-webshell-cli");
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
});

test("init reuses Bubblewrap metadata for a migration-style flow", async () => {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "mwa-webshell-init-"));

  try {
    const iconPath = path.join(tempDirectory, "launcher.png");
    await writeFile(iconPath, tinyPngBuffer);
    const webManifestPath = path.join(tempDirectory, "manifest.json");
    await writeFile(
      webManifestPath,
      JSON.stringify({
        name: "Existing Shell",
        icons: [
          {
            src: "./launcher.png",
            sizes: "512x512",
            type: "image/png",
          },
        ],
        theme_color: "#223344",
        background_color: "#F5F5F5",
      }),
      "utf8",
    );
    const bubblewrapManifestPath = path.join(tempDirectory, "twa-manifest.json");
    await writeFile(
      bubblewrapManifestPath,
      JSON.stringify({
        packageId: "com.example.existing",
        launcherName: "Existing Shell",
        host: "wallet.example.com",
        startUrl: "/app?mode=prod",
        webManifestUrl: pathToFileURL(webManifestPath).toString(),
        signingKey: {
          path: "./existing.keystore",
          alias: "release",
        },
      }),
      "utf8",
    );

    const generatedProject = path.join(tempDirectory, "generated");
    await runInitCommand(generatedProject, {
      manifest: bubblewrapManifestPath,
      nonInteractive: true,
    });

    const gradleProperties = await readFile(
      path.join(generatedProject, "gradle.properties"),
      "utf8",
    );
    const colorsXml = await readFile(
      path.join(generatedProject, "app", "src", "main", "res", "values", "colors.xml"),
      "utf8",
    );
    const foregroundXml = await readFile(
      path.join(generatedProject, "app", "src", "main", "res", "drawable", "ic_launcher_foreground.xml"),
      "utf8",
    );
    const iconBytes = await readFile(
      path.join(generatedProject, "app", "src", "main", "res", "drawable-nodpi", "ic_launcher_foreground_inner.png"),
    );
    const twaManifest = JSON.parse(
      await readFile(path.join(generatedProject, "twa-manifest.json"), "utf8"),
    ) as Record<string, unknown>;

    assert.match(gradleProperties, /WEB_SHELL_APPLICATION_ID=com\.example\.existing/);
    assert.match(gradleProperties, /WEB_SHELL_URL=https:\/\/wallet\.example\.com\/app\?mode=prod/);
    assert.match(colorsXml, /<color name="launcher_icon_background">#223344<\/color>/);
    assert.match(colorsXml, /<color name="splash_background">#F5F5F5<\/color>/);
    assert.match(foregroundXml, /@drawable\/ic_launcher_foreground_inner/);
    assert.equal(iconBytes.length > 0, true);
    assert.equal(twaManifest.packageId, "com.example.existing");
    assert.equal(twaManifest.host, "wallet.example.com");
    assert.equal(twaManifest.startUrl, "/app?mode=prod");
    assert.deepEqual(twaManifest.signingKey, {
      path: path.join(tempDirectory, "existing.keystore"),
      alias: "release",
    });
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
});

test("init imports launcher branding from a standard web manifest", async () => {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "mwa-webshell-init-"));

  try {
    const iconPath = path.join(tempDirectory, "maskable.png");
    await writeFile(iconPath, tinyPngBuffer);
    const webManifestPath = path.join(tempDirectory, "manifest.json");
    await writeFile(
      webManifestPath,
      JSON.stringify({
        name: "Trepa",
        start_url: "https://trepa.app/app/start",
        icons: [
          {
            src: "./maskable.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable",
          },
        ],
        theme_color: "#123456",
        background_color: "#F5F5F5",
      }),
      "utf8",
    );

    const generatedProject = path.join(tempDirectory, "generated");
    await runInitCommand(generatedProject, {
      manifest: webManifestPath,
      applicationId: "app.trepa.webshell",
      nonInteractive: true,
    });

    const colorsXml = await readFile(
      path.join(generatedProject, "app", "src", "main", "res", "values", "colors.xml"),
      "utf8",
    );
    const foregroundXml = await readFile(
      path.join(generatedProject, "app", "src", "main", "res", "drawable", "ic_launcher_foreground.xml"),
      "utf8",
    );
    const importedIcon = await readFile(
      path.join(generatedProject, "app", "src", "main", "res", "drawable-nodpi", "ic_launcher_foreground_inner.png"),
    );

    assert.match(colorsXml, /<color name="launcher_icon_background">#123456<\/color>/);
    assert.match(colorsXml, /<color name="splash_background">#F5F5F5<\/color>/);
    assert.match(foregroundXml, /android:drawable="@drawable\/ic_launcher_foreground_inner"/);
    assert.equal(importedIcon.length > 0, true);
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
});

test("init derives the application ID from the web app host by default", async () => {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "mwa-webshell-init-"));

  try {
    const webManifestPath = path.join(tempDirectory, "manifest.json");
    await writeFile(
      webManifestPath,
      JSON.stringify({
        name: "Solana Mobile Staking",
        start_url: "https://stake.solanamobile.com/",
      }),
      "utf8",
    );

    const generatedProject = path.join(tempDirectory, "generated");
    await runInitCommand(generatedProject, {
      manifest: webManifestPath,
      nonInteractive: true,
    });

    const gradleProperties = await readFile(
      path.join(generatedProject, "gradle.properties"),
      "utf8",
    );

    assert.match(gradleProperties, /WEB_SHELL_APPLICATION_ID=com\.solanamobile\.stake/);
    await access(
      path.join(
        generatedProject,
        "app",
        "src",
        "main",
        "java",
        "com",
        "solanamobile",
        "stake",
        "MainActivity.kt",
      ),
    );
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
});

test("init keeps the Android application ID and sanitizes only the Kotlin package", async () => {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "mwa-webshell-init-"));

  try {
    const webManifestPath = path.join(tempDirectory, "manifest.json");
    await writeFile(
      webManifestPath,
      JSON.stringify({
        name: "CFL",
        start_url: "https://www.cfl.fun/",
      }),
      "utf8",
    );

    const generatedProject = path.join(tempDirectory, "generated");
    await runInitCommand(generatedProject, {
      manifest: webManifestPath,
      nonInteractive: true,
    });

    const gradleProperties = await readFile(
      path.join(generatedProject, "gradle.properties"),
      "utf8",
    );
    const appBuildGradle = await readFile(
      path.join(generatedProject, "app", "build.gradle.kts"),
      "utf8",
    );
    const twaManifest = JSON.parse(
      await readFile(path.join(generatedProject, "twa-manifest.json"), "utf8"),
    ) as Record<string, unknown>;

    assert.match(gradleProperties, /WEB_SHELL_APPLICATION_ID=fun\.cfl\.www/);
    assert.match(appBuildGradle, /namespace = "_fun\.cfl\.www"/);
    await access(
      path.join(
        generatedProject,
        "app",
        "src",
        "main",
        "java",
        "_fun",
        "cfl",
        "www",
        "MainActivity.kt",
      ),
    );
    assert.equal(twaManifest.packageId, "fun.cfl.www");
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
});

test("init uses the manifest short_name as the default launcher app name", async () => {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "mwa-webshell-init-"));

  try {
    const webManifestPath = path.join(tempDirectory, "manifest.json");
    await writeFile(
      webManifestPath,
      JSON.stringify({
        name: "Create TanStack App Sample",
        short_name: "Trepa",
        start_url: "https://app.example.com/",
      }),
      "utf8",
    );

    const generatedProject = path.join(tempDirectory, "generated");
    await runInitCommand(generatedProject, {
      manifest: webManifestPath,
      nonInteractive: true,
    });

    const stringsXml = await readFile(
      path.join(generatedProject, "app", "src", "main", "res", "values", "strings.xml"),
      "utf8",
    );

    assert.match(stringsXml, /<string name="app_name">Trepa<\/string>/);
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
});

test("init keeps the default launcher artwork when manifest icons are unsupported", async () => {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "mwa-webshell-init-"));

  try {
    const webManifestPath = path.join(tempDirectory, "manifest.json");
    await writeFile(
      webManifestPath,
      JSON.stringify({
        name: "Trepa",
        start_url: "https://trepa.app/app/start",
        icons: [
          {
            src: "./maskable.svg",
            sizes: "512x512",
            type: "image/svg+xml",
            purpose: "maskable",
          },
        ],
        theme_color: "#445566",
        background_color: "#FAFAFA",
      }),
      "utf8",
    );

    const generatedProject = path.join(tempDirectory, "generated");
    await runInitCommand(generatedProject, {
      manifest: webManifestPath,
      applicationId: "app.trepa.defaulticon",
      nonInteractive: true,
    });

    const colorsXml = await readFile(
      path.join(generatedProject, "app", "src", "main", "res", "values", "colors.xml"),
      "utf8",
    );
    const foregroundXml = await readFile(
      path.join(generatedProject, "app", "src", "main", "res", "drawable", "ic_launcher_foreground.xml"),
      "utf8",
    );

    await assert.rejects(
      access(
        path.join(
          generatedProject,
          "app",
          "src",
          "main",
          "res",
          "drawable-nodpi",
          "ic_launcher_foreground_inner.png",
        ),
      ),
    );

    assert.match(colorsXml, /<color name="launcher_icon_background">#445566<\/color>/);
    assert.match(colorsXml, /<color name="splash_background">#FAFAFA<\/color>/);
    assert.match(foregroundXml, /<vector xmlns:android=/);
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
});

test("init keeps the default launcher artwork when a manifest icon URL returns 404", async () => {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "mwa-webshell-init-"));
  const server = http.createServer((request, response) => {
    if (request.url === "/manifest.json") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        name: "Loopscale",
        start_url: "https://app.loopscale.com/",
        icons: [
          {
            src: "/android-chrome-512x512.png",
            sizes: "512x512",
            type: "image/png",
          },
        ],
        theme_color: "#101820",
        background_color: "#FAFAFA",
      }));
      return;
    }

    response.writeHead(404, { "content-type": "text/plain" });
    response.end("missing");
  });

  try {
    await new Promise<void>((resolve, reject) => {
      server.listen(0, "127.0.0.1", (error?: Error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });

    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Test server did not expose a usable port.");
    }

    const generatedProject = path.join(tempDirectory, "generated");
    await runInitCommand(generatedProject, {
      manifest: `http://127.0.0.1:${address.port}/manifest.json`,
      applicationId: "com.example.loopscale",
      nonInteractive: true,
    });

    const colorsXml = await readFile(
      path.join(generatedProject, "app", "src", "main", "res", "values", "colors.xml"),
      "utf8",
    );
    const foregroundXml = await readFile(
      path.join(generatedProject, "app", "src", "main", "res", "drawable", "ic_launcher_foreground.xml"),
      "utf8",
    );

    await assert.rejects(
      access(
        path.join(
          generatedProject,
          "app",
          "src",
          "main",
          "res",
          "drawable-nodpi",
          "ic_launcher_foreground_inner.png",
        ),
      ),
    );

    assert.match(colorsXml, /<color name="launcher_icon_background">#101820<\/color>/);
    assert.match(colorsXml, /<color name="splash_background">#FAFAFA<\/color>/);
    assert.match(foregroundXml, /<vector xmlns:android=/);
  } finally {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    await rm(tempDirectory, { recursive: true, force: true });
  }
});
