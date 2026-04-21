import { spawn } from "node:child_process";
import path from "node:path";
import { PromptSession } from "./prompts.js";
import {
  ensureJavaInstallation,
  JavaRuntime,
  resolveKeytoolBinary,
} from "./toolchain.js";
import { SigningConfig } from "./types.js";
import { ensureDirectory, exists } from "./utils.js";

const DEFAULT_KEYSTORE_FILENAME = "android.keystore";
const DEFAULT_KEY_ALIAS = "android";
const ANSI_BOLD_RED = "\u001b[1;31m";
const ANSI_RESET = "\u001b[0m";
const MIN_KEYSTORE_PASSWORD_LENGTH = 6;

export interface SigningRuntime extends JavaRuntime {
  createKeystore?: (options: CreateKeystoreOptions) => Promise<void>;
  logger?: Pick<Console, "log">;
}

export interface CreateKeystoreOptions {
  keystorePath: string;
  keyAlias: string;
  storePassword: string;
  keyPassword: string;
  appName: string;
}

export async function ensureInitSigning(
  prompter: PromptSession,
  targetDirectory: string,
  appName: string,
  existingSigning: SigningConfig | undefined,
  runtime: SigningRuntime = {},
): Promise<SigningConfig | undefined> {
  if (!prompter.isInteractive()) {
    return existingSigning;
  }

  const logger = runtime.logger ?? console;
  const defaultKeystorePath = path.join(targetDirectory, DEFAULT_KEYSTORE_FILENAME);
  const requestedKeystorePath = await prompter.text("Signing keystore path", {
    defaultValue: existingSigning?.keystorePath ?? defaultKeystorePath,
    validate: requireNonEmpty("Signing keystore path"),
  });
  const keystorePath = path.resolve(requestedKeystorePath);

  const keyAlias = await prompter.text("Signing key alias", {
    defaultValue: existingSigning?.keyAlias ?? DEFAULT_KEY_ALIAS,
    validate: requireNonEmpty("Signing key alias"),
  });

  const signing: SigningConfig = {
    keystorePath,
    keyAlias,
    storePasswordEnv: existingSigning?.storePasswordEnv ?? "WEB_SHELL_KEYSTORE_PASSWORD",
    keyPasswordEnv: existingSigning?.keyPasswordEnv ?? "WEB_SHELL_KEY_PASSWORD",
  };

  if (await exists(keystorePath)) {
    return signing;
  }

  logger.log(`Signing keystore not found at ${keystorePath}. Creating one now...`);
  logger.log(
    `${ANSI_BOLD_RED}Important: keep this keystore file and its passwords secure. You will need them for future release builds and app updates.${ANSI_RESET}`,
  );
  const storePassword = await promptConfirmedPassword(
    prompter,
    "Keystore password",
    "Confirm keystore password",
  );
  const useSameKeyPassword = await prompter.confirm(
    "Use the same password for the signing key?",
    true,
  );
  const keyPassword = useSameKeyPassword
    ? storePassword
    : await promptConfirmedPassword(
        prompter,
        "Signing key password",
        "Confirm signing key password",
      );

  await (runtime.createKeystore ?? createKeystore)({
    keystorePath,
    keyAlias,
    storePassword,
    keyPassword,
    appName,
  });

  logger.log(
    `Created signing keystore at ${keystorePath}. Keep this file and its passwords safe.`,
  );

  return signing;
}

export async function promptBuildSigningPasswords(
  prompter: PromptSession,
  signing: SigningConfig,
): Promise<{ storePassword: string; keyPassword: string }> {
  const storePasswordEnv = signing.storePasswordEnv ?? "WEB_SHELL_KEYSTORE_PASSWORD";
  const keyPasswordEnv = signing.keyPasswordEnv ?? storePasswordEnv;
  const envStorePassword = process.env[storePasswordEnv];
  const envKeyPassword = process.env[keyPasswordEnv];

  const storePassword =
    envStorePassword ??
    (prompter.isInteractive()
      ? await prompter.password(`Keystore password (${storePasswordEnv} not set)`, {
          validate: requireNonEmpty("Keystore password"),
        })
      : undefined);

  if (!storePassword) {
    throw new Error(`Missing signing password environment variable ${storePasswordEnv}.`);
  }

  if (envKeyPassword) {
    return {
      storePassword,
      keyPassword: envKeyPassword,
    };
  }

  if (!prompter.isInteractive()) {
    return {
      storePassword,
      keyPassword: storePassword,
    };
  }

  const useSameKeyPassword = await prompter.confirm(
    `Use the same password for the signing key?`,
    true,
  );
  if (useSameKeyPassword) {
    return {
      storePassword,
      keyPassword: storePassword,
    };
  }

  const keyPassword = await prompter.password(`Signing key password (${keyPasswordEnv} not set)`, {
    validate: requireNonEmpty("Signing key password"),
  });
  return {
    storePassword,
    keyPassword,
  };
}

async function promptConfirmedPassword(
  prompter: PromptSession,
  label: string,
  confirmationLabel: string,
): Promise<string> {
  while (true) {
    const password = await prompter.password(label, {
      validate: validateSigningPassword(label),
    });
    const confirmedPassword = await prompter.password(confirmationLabel, {
      validate: validateSigningPassword(confirmationLabel),
    });
    if (password === confirmedPassword) {
      return password;
    }
    console.error("Error: Passwords do not match.");
  }
}

async function createKeystore(
  options: CreateKeystoreOptions,
  runtime: SigningRuntime = {},
): Promise<void> {
  const java = await ensureJavaInstallation({ fix: true }, runtime);
  const keytoolBinary = resolveKeytoolBinary(java);
  const env = {
    ...process.env,
    ...(java.javaHome ? { JAVA_HOME: java.javaHome } : {}),
  };
  const dname = buildDname(options.appName);

  await ensureDirectory(path.dirname(options.keystorePath));

  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      keytoolBinary,
      [
        "-genkeypair",
        "-v",
        "-keystore",
        options.keystorePath,
        "-alias",
        options.keyAlias,
        "-keyalg",
        "RSA",
        "-keysize",
        "2048",
        "-validity",
        "10000",
        "-storepass",
        options.storePassword,
        "-keypass",
        options.keyPassword,
        "-dname",
        dname,
        "-noprompt",
      ],
      {
        env,
        stdio: "inherit",
        shell: process.platform === "win32",
      },
    );

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`keytool exited with code ${code ?? "unknown"}.`));
    });
  });
}

function buildDname(appName: string): string {
  const commonName = sanitizeDistinguishedNameValue(appName) || "Solana Mobile Web Shell";
  return `CN=${commonName}, OU=Unknown, O=Unknown, L=Unknown, ST=Unknown, C=US`;
}

function sanitizeDistinguishedNameValue(value: string): string {
  return value.replace(/["+,;<>#=]/g, " ").replace(/\s+/g, " ").trim();
}

function requireNonEmpty(label: string): (value: string) => string | undefined {
  return (value) => {
    if (!value.trim()) {
      return `${label} is required.`;
    }
    return undefined;
  };
}

function validateSigningPassword(
  label: string,
): (value: string) => string | undefined {
  return (value) => {
    const trimmed = value.trim();
    if (!trimmed) {
      return `${label} is required.`;
    }
    if (trimmed.length < MIN_KEYSTORE_PASSWORD_LENGTH) {
      return `${label} must be at least ${MIN_KEYSTORE_PASSWORD_LENGTH} characters.`;
    }
    return undefined;
  };
}
