import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { ensureInitSigning, promptBuildSigningPasswords } from "../src/lib/signing.ts";
import { PromptSession } from "../src/lib/prompts.ts";
import { SigningConfig } from "../src/lib/types.ts";

class FakePromptSession implements PromptSession {
  private readonly answers: string[];
  private readonly confirmations: boolean[];
  private readonly interactiveValue: boolean;

  constructor(options: {
    answers?: string[];
    confirmations?: boolean[];
    interactive?: boolean;
  } = {}) {
    this.answers = [...(options.answers ?? [])];
    this.confirmations = [...(options.confirmations ?? [])];
    this.interactiveValue = options.interactive ?? true;
  }

  async text(): Promise<string> {
    const value = this.answers.shift();
    if (value === undefined) {
      throw new Error("No more fake text answers.");
    }
    return value;
  }

  async confirm(): Promise<boolean> {
    return this.confirmations.shift() ?? true;
  }

  async password(): Promise<string> {
    const value = this.answers.shift();
    if (value === undefined) {
      throw new Error("No more fake password answers.");
    }
    return value;
  }

  isInteractive(): boolean {
    return this.interactiveValue;
  }

  close(): void {}
}

test("ensureInitSigning creates a keystore when one is not present", async () => {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "webshell-signing-"));

  try {
    let created: {
      keystorePath: string;
      keyAlias: string;
      storePassword: string;
      keyPassword: string;
      appName: string;
    } | undefined;

    const signing = await ensureInitSigning(
      new FakePromptSession({
        answers: [
          path.join(tempDirectory, "android.keystore"),
          "android",
          "store-secret",
          "store-secret",
        ],
        confirmations: [true],
      }),
      tempDirectory,
      "Wallet Shell",
      undefined,
      {
        logger: { log: () => undefined },
        createKeystore: async (options) => {
          created = options;
        },
      },
    );

    assert.deepEqual(signing, {
      keystorePath: path.join(tempDirectory, "android.keystore"),
      keyAlias: "android",
      storePasswordEnv: "WEB_SHELL_KEYSTORE_PASSWORD",
      keyPasswordEnv: "WEB_SHELL_KEY_PASSWORD",
    });
    assert.deepEqual(created, {
      keystorePath: path.join(tempDirectory, "android.keystore"),
      keyAlias: "android",
      storePassword: "store-secret",
      keyPassword: "store-secret",
      appName: "Wallet Shell",
    });
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
});

test("ensureInitSigning reuses an existing keystore without creating a new one", async () => {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "webshell-signing-"));
  const keystorePath = path.join(tempDirectory, "android.keystore");

  try {
    await writeFile(keystorePath, "existing");
    let createCalled = false;

    const signing = await ensureInitSigning(
      new FakePromptSession({
        answers: [keystorePath, "android"],
      }),
      tempDirectory,
      "Wallet Shell",
      undefined,
      {
        logger: { log: () => undefined },
        createKeystore: async () => {
          createCalled = true;
        },
      },
    );

    assert.equal(createCalled, false);
    assert.equal(signing?.keystorePath, keystorePath);
    assert.equal(signing?.keyAlias, "android");
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
});

test("promptBuildSigningPasswords falls back to hidden prompts when env vars are missing", async () => {
  const signing: SigningConfig = {
    keystorePath: "/tmp/release.keystore",
    keyAlias: "release",
    storePasswordEnv: "WEB_SHELL_KEYSTORE_PASSWORD",
    keyPasswordEnv: "WEB_SHELL_KEY_PASSWORD",
  };

  const previousStorePassword = process.env.WEB_SHELL_KEYSTORE_PASSWORD;
  const previousKeyPassword = process.env.WEB_SHELL_KEY_PASSWORD;
  delete process.env.WEB_SHELL_KEYSTORE_PASSWORD;
  delete process.env.WEB_SHELL_KEY_PASSWORD;

  try {
    const credentials = await promptBuildSigningPasswords(
      new FakePromptSession({
        answers: ["store-secret", "key-secret"],
        confirmations: [false],
      }),
      signing,
    );

    assert.deepEqual(credentials, {
      storePassword: "store-secret",
      keyPassword: "key-secret",
    });
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
});
