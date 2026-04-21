import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runBuildCommand } from "../src/commands/build.ts";

test("build runs doctor first and passes resolved env into Gradle", async () => {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "webshell-build-"));
  const gradleWrapper = path.join(
    tempDirectory,
    process.platform === "win32" ? "gradlew.bat" : "gradlew",
  );

  try {
    await writeFile(gradleWrapper, "");

    let doctorCalled = false;
    let gradleCalled = false;

    await runBuildCommand(
      tempDirectory,
      { stacktrace: true },
      {
        doctor: async () => {
          doctorCalled = true;
          return {
            gradleWrapper,
            sdkDir: "/tmp/android-sdk",
            sdkManagerPath: "/tmp/android-sdk/cmdline-tools/latest/bin/sdkmanager",
            java: {
              javaBinary: "/tmp/jdk/bin/java",
              javaHome: "/tmp/jdk",
              source: "managed",
              version: 17,
            },
          };
        },
        runGradle: async (command, args, cwd, env) => {
          gradleCalled = true;
          assert.equal(command, gradleWrapper);
          assert.deepEqual(args, ["assembleRelease", "--stacktrace"]);
          assert.equal(cwd, tempDirectory);
          assert.equal(env?.JAVA_HOME, "/tmp/jdk");
          assert.equal(env?.ANDROID_SDK_ROOT, "/tmp/android-sdk");
          assert.equal(env?.ANDROID_HOME, "/tmp/android-sdk");
        },
      },
    );

    assert.equal(doctorCalled, true);
    assert.equal(gradleCalled, true);
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
});

test("build requires signing passwords when signing metadata exists", async () => {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "webshell-build-"));
  const gradleWrapper = path.join(
    tempDirectory,
    process.platform === "win32" ? "gradlew.bat" : "gradlew",
  );
  const configPath = path.join(tempDirectory, "twa-manifest.json");

  try {
    await writeFile(gradleWrapper, "");
    await writeFile(
      configPath,
      JSON.stringify({
        signingKey: {
          path: "release.keystore",
          alias: "webshell",
        },
      }),
    );

    const previousStorePassword = process.env.WEB_SHELL_KEYSTORE_PASSWORD;
    const previousKeyPassword = process.env.WEB_SHELL_KEY_PASSWORD;
    delete process.env.WEB_SHELL_KEYSTORE_PASSWORD;
    delete process.env.WEB_SHELL_KEY_PASSWORD;

    try {
      await assert.rejects(
        runBuildCommand(
          tempDirectory,
          {},
          {
            doctor: async () => ({
              gradleWrapper,
              sdkDir: "/tmp/android-sdk",
              sdkManagerPath: "/tmp/android-sdk/cmdline-tools/latest/bin/sdkmanager",
              java: {
                javaBinary: "/tmp/jdk/bin/java",
                javaHome: "/tmp/jdk",
                source: "managed",
                version: 17,
              },
            }),
          },
        ),
        /Missing signing password environment variable WEB_SHELL_KEYSTORE_PASSWORD/,
      );
    } finally {
      if (previousStorePassword === undefined) {
        delete process.env.WEB_SHELL_KEYSTORE_PASSWORD;
      } else {
        process.env.WEB_SHELL_KEYSTORE_PASSWORD = previousStorePassword;
      }

      if (previousKeyPassword === undefined) {
        delete process.env.WEB_SHELL_KEY_PASSWORD;
      } else {
        process.env.WEB_SHELL_KEY_PASSWORD = previousKeyPassword;
      }
    }
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
});
