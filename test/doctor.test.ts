import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parseJavaMajorVersion, runDoctor } from "../src/lib/toolchain.ts";

test("parseJavaMajorVersion handles common java -version outputs", () => {
  assert.equal(parseJavaMajorVersion('openjdk version "17.0.15" 2025-04-15'), 17);
  assert.equal(parseJavaMajorVersion("openjdk 24 2026-03-18"), 24);
  assert.equal(parseJavaMajorVersion("not java"), undefined);
});

test("doctor fails without fix when JDK is missing", async () => {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "webshell-doctor-"));
  const gradleWrapper = path.join(
    tempDirectory,
    process.platform === "win32" ? "gradlew.bat" : "gradlew",
  );

  try {
    await writeFile(gradleWrapper, "");

    await assert.rejects(
      runDoctor(
        {
          projectDirectory: tempDirectory,
          fix: false,
        },
        {
          logger: { log: () => undefined },
          resolveJavaInstallation: async () => undefined,
        },
      ),
      /JDK 17 or newer is required before building/,
    );
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
});

test("doctor auto-installs missing tools and writes local.properties", async () => {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "webshell-doctor-"));
  const gradleWrapper = path.join(
    tempDirectory,
    process.platform === "win32" ? "gradlew.bat" : "gradlew",
  );
  const sdkDir = path.join(tempDirectory, "android-sdk");
  const sdkManagerPath = path.join(sdkDir, "cmdline-tools", "latest", "bin", "sdkmanager");

  try {
    await writeFile(gradleWrapper, "");

    const logs: string[] = [];
    let checkedPackages = 0;
    let installPackagesCalled = false;

    const result = await runDoctor(
      {
        projectDirectory: tempDirectory,
        fix: true,
      },
      {
        logger: {
          log: (message: string) => {
            logs.push(message);
          },
        },
        resolveJavaInstallation: async () => undefined,
        installManagedJdk: async () => ({
          javaBinary: "/tmp/jdk/bin/java",
          javaHome: "/tmp/jdk",
          source: "managed",
          version: 17,
        }),
        resolveAndroidSdkDir: async () => sdkDir,
        resolveSdkManagerPath: async () => undefined,
        installAndroidCommandLineTools: async () => sdkManagerPath,
        findMissingAndroidPackages: async () => {
          checkedPackages += 1;
          if (checkedPackages === 1) {
            return [
              {
                id: "platform-tools",
                label: "Android SDK Platform-Tools",
              },
              {
                id: "platforms;android-36",
                label: "Android Platform 36",
              },
            ];
          }
          return [];
        },
        installAndroidPackages: async (actualSdkManagerPath, actualSdkDir, java, requirements) => {
          installPackagesCalled = true;
          assert.equal(actualSdkManagerPath, sdkManagerPath);
          assert.equal(actualSdkDir, sdkDir);
          assert.equal(java.javaHome, "/tmp/jdk");
          assert.deepEqual(
            requirements.map((item) => item.id),
            ["platform-tools", "platforms;android-36"],
          );
        },
      },
    );

    assert.equal(result.sdkDir, sdkDir);
    assert.equal(result.sdkManagerPath, sdkManagerPath);
    assert.equal(result.java.javaHome, "/tmp/jdk");
    assert.equal(installPackagesCalled, true);
    assert.ok(logs.includes("Android command-line tools: missing"));
    assert.ok(logs.includes("Installing JDK 17..."));
    assert.ok(logs.includes("Installing required Android SDK packages..."));

    const localProperties = await readFile(path.join(tempDirectory, "local.properties"), "utf8");
    assert.match(localProperties, /sdk\.dir=/);
    assert.match(localProperties, new RegExp(sdkDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
});
