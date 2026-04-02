import { spawn } from "node:child_process";
import path from "node:path";
import { Prompter } from "../lib/prompts.js";
import { readProjectConfig } from "../lib/project-config.js";
import { promptBuildSigningPasswords } from "../lib/signing.js";
import { doctorEnvironment, DoctorResult, runDoctor } from "../lib/toolchain.js";
import { SigningConfig } from "../lib/types.js";
import { createStepFeedback, runStep } from "../lib/ui.js";

export interface BuildCommandOptions {
  projectDir?: string;
  release?: boolean;
  stacktrace?: boolean;
  sdkDir?: string;
  keystorePath?: string;
  keystoreAlias?: string;
  storePasswordEnv?: string;
  keyPasswordEnv?: string;
}

export interface BuildCommandRuntime {
  doctor?: typeof runDoctor;
  resolveSigningPasswords?: (
    signing: SigningConfig,
  ) => Promise<{ storePassword: string; keyPassword: string }>;
  runGradle?: (
    command: string,
    args: string[],
    cwd: string,
    extraEnv?: NodeJS.ProcessEnv,
  ) => Promise<void>;
}

export async function runBuildCommand(
  directory: string | undefined,
  options: BuildCommandOptions,
  runtime: BuildCommandRuntime = {},
): Promise<void> {
  const projectDirectory = path.resolve(process.cwd(), directory ?? options.projectDir ?? ".");
  const doctor = runtime.doctor ?? runDoctor;
  const feedback = createStepFeedback();
  const toolchain = await runStep(
    feedback,
    "Checking Android toolchain...",
    () =>
      doctor(
        {
          projectDirectory,
          sdkDir: options.sdkDir,
          fix: true,
        },
        { logger: feedback.logger },
      ),
    "Android toolchain ready.",
  );

  const projectConfig = await readProjectConfig(projectDirectory);
  const signing = resolveSigning(options, projectConfig?.signing);
  const task = options.release ? "assembleRelease" : "assembleDebug";

  const gradleArgs = [task];
  if (options.stacktrace) {
    gradleArgs.push("--stacktrace");
  }

  const gradleEnv = doctorEnvironment(toolchain.java, toolchain.sdkDir);
  const prompter = new Prompter();

  try {
    if (options.release && signing.keystorePath && signing.keyAlias) {
      const credentials = await (
        runtime.resolveSigningPasswords ??
        ((candidate) => promptBuildSigningPasswords(prompter, candidate))
      )(signing);

      gradleArgs.push(
        `-PWEB_SHELL_SIGNING_STORE_FILE=${signing.keystorePath}`,
        `-PWEB_SHELL_SIGNING_KEY_ALIAS=${signing.keyAlias}`,
      );

      await runStep(
        feedback,
        describeGradleTask(task),
        () =>
          (runtime.runGradle ?? runGradleCommand)(
            toolchain.gradleWrapper,
            gradleArgs,
            projectDirectory,
            {
              ...gradleEnv,
              WEB_SHELL_SIGNING_STORE_PASSWORD: credentials.storePassword,
              WEB_SHELL_SIGNING_KEY_PASSWORD: credentials.keyPassword,
            },
          ),
        describeGradleTaskSuccess(task),
      );
    } else {
      if (options.release && (!signing.keystorePath || !signing.keyAlias)) {
        feedback.info("No signing metadata configured. Gradle will produce an unsigned release artifact.");
      }

      await runStep(
        feedback,
        describeGradleTask(task),
        () =>
          (runtime.runGradle ?? runGradleCommand)(
            toolchain.gradleWrapper,
            gradleArgs,
            projectDirectory,
            gradleEnv,
          ),
        describeGradleTaskSuccess(task),
      );
    }

    printBuildOutput(projectDirectory, options, toolchain);
  } finally {
    prompter.close();
  }
}

function describeGradleTask(task: string): string {
  switch (task) {
    case "assembleRelease":
      return "Building release APK...";
    default:
      return "Building debug APK...";
  }
}

function describeGradleTaskSuccess(task: string): string {
  switch (task) {
    case "assembleRelease":
      return "Built release APK.";
    default:
      return "Built debug APK.";
  }
}

function resolveSigning(
  options: BuildCommandOptions,
  savedConfig?: SigningConfig,
): SigningConfig {
  return {
    keystorePath: options.keystorePath ?? savedConfig?.keystorePath,
    keyAlias: options.keystoreAlias ?? savedConfig?.keyAlias,
    storePasswordEnv: options.storePasswordEnv ?? savedConfig?.storePasswordEnv,
    keyPasswordEnv: options.keyPasswordEnv ?? savedConfig?.keyPasswordEnv,
  };
}

async function runGradleCommand(
  command: string,
  args: string[],
  cwd: string,
  extraEnv?: NodeJS.ProcessEnv,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let output = "";
    const child = spawn(command, args, {
      cwd,
      env: {
        ...process.env,
        ...extraEnv,
      },
      stdio: ["ignore", "pipe", "pipe"],
      shell: process.platform === "win32",
    });

    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      const details = output.trim();
      reject(
        new Error(
          details
            ? `Gradle exited with code ${code ?? "unknown"}.\n${details}`
            : `Gradle exited with code ${code ?? "unknown"}.`,
        ),
      );
    });
  });
}

function printBuildOutput(
  projectDirectory: string,
  options: BuildCommandOptions,
  _toolchain: DoctorResult,
): void {
  const variant = options.release ? "release" : "debug";
  const apkName = options.release ? "app-release.apk" : "app-debug.apk";
  console.log(
    `Build finished. Check ${path.join(projectDirectory, "app", "build", "outputs", "apk", variant, apkName)}`,
  );
}
