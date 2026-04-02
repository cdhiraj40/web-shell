import { spawn } from "node:child_process";
import { cp, mkdtemp, readdir, rm } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import {
  createLocalPropertiesSdkLine,
  ensureDirectory,
  exists,
  findDefaultAndroidSdkDir,
  readLocalPropertiesValue,
  readUtf8,
  walkFiles,
  writeUtf8,
} from "./utils.js";

const REQUIRED_JAVA_MAJOR_VERSION = 17;
const REQUIRED_ANDROID_PLATFORM = 36;
const REQUIRED_ANDROID_BUILD_TOOLS_VERSION = "36.0.0";
const MANAGED_TOOLS_DIRECTORY = path.join(os.homedir(), ".mwa-webshell");
const MANAGED_JDK_DIRECTORY = path.join(MANAGED_TOOLS_DIRECTORY, "jdk-17");
const MANAGED_ANDROID_SDK_DIRECTORY = path.join(MANAGED_TOOLS_DIRECTORY, "android-sdk");

// TODO: switch this to dynamic lookup from the official Android SDK download page
// instead of pinning the current command-line tools archive names.
const ANDROID_COMMAND_LINE_TOOLS_DOWNLOADS: Record<NodeJS.Platform, string | undefined> = {
  darwin: "https://dl.google.com/android/repository/commandlinetools-mac-14742923_latest.zip",
  linux: "https://dl.google.com/android/repository/commandlinetools-linux-14742923_latest.zip",
  win32: "https://dl.google.com/android/repository/commandlinetools-win-14742923_latest.zip",
  aix: undefined,
  android: undefined,
  freebsd: undefined,
  haiku: undefined,
  openbsd: undefined,
  sunos: undefined,
  cygwin: undefined,
  netbsd: undefined,
};

export interface ResolvedJavaInstallation {
  javaHome?: string;
  javaBinary: string;
  source: "system" | "java-home" | "android-studio" | "managed";
  version: number;
}

export interface AndroidPackageRequirement {
  id: string;
  label: string;
}

export interface DoctorResult {
  gradleWrapper: string;
  java: ResolvedJavaInstallation;
  sdkDir: string;
  sdkManagerPath: string;
}

export interface DoctorOptions {
  projectDirectory: string;
  sdkDir?: string;
  fix?: boolean;
}

export interface DoctorRuntime {
  logger?: Pick<Console, "log">;
  resolveJavaInstallation?: () => Promise<ResolvedJavaInstallation | undefined>;
  installManagedJdk?: () => Promise<ResolvedJavaInstallation>;
  resolveAndroidSdkDir?: (
    projectDirectory: string,
    explicitSdkDir: string | undefined,
    fix: boolean,
  ) => Promise<string | undefined>;
  resolveSdkManagerPath?: (sdkDir: string) => Promise<string | undefined>;
  installAndroidCommandLineTools?: (
    sdkDir: string,
    java: ResolvedJavaInstallation,
  ) => Promise<string>;
  findMissingAndroidPackages?: (sdkDir: string) => Promise<AndroidPackageRequirement[]>;
  installAndroidPackages?: (
    sdkManagerPath: string,
    sdkDir: string,
    java: ResolvedJavaInstallation,
    requirements: AndroidPackageRequirement[],
  ) => Promise<void>;
}

export interface JavaRuntime {
  logger?: Pick<Console, "log">;
  resolveJavaInstallation?: () => Promise<ResolvedJavaInstallation | undefined>;
  installManagedJdk?: () => Promise<ResolvedJavaInstallation>;
}

export interface JavaOptions {
  fix?: boolean;
}

export async function runDoctor(
  options: DoctorOptions,
  runtime: DoctorRuntime = {},
): Promise<DoctorResult> {
  const logger = runtime.logger ?? console;
  const fix = Boolean(options.fix);

  const gradleWrapper = path.join(
    options.projectDirectory,
    process.platform === "win32" ? "gradlew.bat" : "gradlew",
  );
  if (!(await exists(gradleWrapper))) {
    logStatus(logger, "Gradle wrapper", "missing", gradleWrapper);
    throw new Error(`No Gradle wrapper found at ${gradleWrapper}.`);
  }
  logStatus(logger, "Gradle wrapper", "installed");

  const java = await ensureJavaInstallation({ fix }, runtime);
  logStatus(
    logger,
    `JDK ${REQUIRED_JAVA_MAJOR_VERSION}+`,
    "installed",
    `Java ${java.version}${java.javaHome ? ` at ${java.javaHome}` : ""}`,
  );

  const resolveAndroidSdkDir =
    runtime.resolveAndroidSdkDir ?? defaultResolveAndroidSdkDir;
  const sdkDir = await resolveAndroidSdkDir(
    options.projectDirectory,
    options.sdkDir,
    fix,
  );
  if (!sdkDir) {
    logStatus(logger, "Android SDK", "missing");
    throw new Error(
      "Android SDK was not found. Install Android command-line tools or Android Studio before building.",
    );
  }

  await ensureDirectory(sdkDir);
  logStatus(logger, "Android SDK", "installed", sdkDir);

  const resolveSdkManagerPath = runtime.resolveSdkManagerPath ?? defaultResolveSdkManagerPath;
  let sdkManagerPath = await resolveSdkManagerPath(sdkDir);
  if (!sdkManagerPath) {
    logStatus(logger, "Android command-line tools", "missing");
    if (!fix) {
      throw new Error("Android command-line tools are not installed.");
    }

    logger.log("Installing Android command-line tools...");
    const installAndroidCommandLineTools =
      runtime.installAndroidCommandLineTools ?? defaultInstallAndroidCommandLineTools;
    sdkManagerPath = await installAndroidCommandLineTools(sdkDir, java);
  }
  logStatus(logger, "Android command-line tools", "installed", sdkManagerPath);

  const findMissingAndroidPackages =
    runtime.findMissingAndroidPackages ?? defaultFindMissingAndroidPackages;
  let missingRequirements = await findMissingAndroidPackages(sdkDir);

  for (const requirement of missingRequirements) {
    logStatus(logger, requirement.label, "missing");
  }

  if (missingRequirements.length > 0) {
    if (!fix) {
      throw new Error(
        `Missing required Android SDK packages: ${missingRequirements.map((item) => item.id).join(", ")}.`,
      );
    }

    logger.log("Installing required Android SDK packages...");
    const installAndroidPackages =
      runtime.installAndroidPackages ?? defaultInstallAndroidPackages;
    await installAndroidPackages(sdkManagerPath, sdkDir, java, missingRequirements);
    missingRequirements = await findMissingAndroidPackages(sdkDir);
    if (missingRequirements.length > 0) {
      throw new Error(
        `Android SDK setup is still incomplete after installation: ${missingRequirements.map((item) => item.id).join(", ")}.`,
      );
    }
  }

  for (const requirement of requiredAndroidPackageRequirements()) {
    logStatus(logger, requirement.label, "installed");
  }

  const localPropertiesPath = path.join(options.projectDirectory, "local.properties");
  if (!(await exists(localPropertiesPath))) {
    await writeUtf8(localPropertiesPath, createLocalPropertiesSdkLine(sdkDir));
  } else {
    const currentSdkDir = await readLocalPropertiesValue(options.projectDirectory, "sdk.dir");
    if (!currentSdkDir) {
      const currentContents = await readUtf8(localPropertiesPath);
      await writeUtf8(
        localPropertiesPath,
        `${currentContents.trimEnd()}\n${createLocalPropertiesSdkLine(sdkDir)}`,
      );
    }
  }

  return {
    gradleWrapper,
    java,
    sdkDir,
    sdkManagerPath,
  };
}

export async function ensureJavaInstallation(
  options: JavaOptions = {},
  runtime: JavaRuntime = {},
): Promise<ResolvedJavaInstallation> {
  const logger = runtime.logger ?? console;
  const fix = Boolean(options.fix);
  const resolveJavaInstallation =
    runtime.resolveJavaInstallation ?? defaultResolveJavaInstallation;
  let java = await resolveJavaInstallation();

  if (!java || java.version < REQUIRED_JAVA_MAJOR_VERSION) {
    const detail = java
      ? `found Java ${java.version}, need ${REQUIRED_JAVA_MAJOR_VERSION}+`
      : `need JDK ${REQUIRED_JAVA_MAJOR_VERSION}+`;
    logStatus(logger, `JDK ${REQUIRED_JAVA_MAJOR_VERSION}+`, "missing", detail);

    if (!fix) {
      throw new Error(`JDK ${REQUIRED_JAVA_MAJOR_VERSION} or newer is required before building.`);
    }

    logger.log(`Installing JDK ${REQUIRED_JAVA_MAJOR_VERSION}...`);
    const installManagedJdk = runtime.installManagedJdk ?? defaultInstallManagedJdk;
    java = await installManagedJdk();
  }

  return java;
}

export function resolveKeytoolBinary(java: ResolvedJavaInstallation): string {
  if (java.javaHome) {
    return path.join(
      java.javaHome,
      "bin",
      process.platform === "win32" ? "keytool.exe" : "keytool",
    );
  }

  return process.platform === "win32" ? "keytool.exe" : "keytool";
}

function logStatus(
  logger: Pick<Console, "log">,
  label: string,
  state: "installed" | "missing",
  detail?: string,
): void {
  const suffix = detail ? ` (${detail})` : "";
  logger.log(`${label}: ${state}${suffix}`);
}

async function defaultResolveJavaInstallation(): Promise<ResolvedJavaInstallation | undefined> {
  const javaHomeCandidates: Array<{
    javaHome: string;
    source: "java-home" | "android-studio" | "managed";
  }> = [];

  if (process.env.JAVA_HOME?.trim()) {
    javaHomeCandidates.push({
      javaHome: process.env.JAVA_HOME.trim(),
      source: "java-home",
    });
  }

  const androidStudioJavaHome = await findBundledAndroidStudioJavaHome();
  if (androidStudioJavaHome) {
    javaHomeCandidates.push({
      javaHome: androidStudioJavaHome,
      source: "android-studio",
    });
  }

  const managedJavaHome = await findManagedJavaHome();
  if (managedJavaHome) {
    javaHomeCandidates.push({
      javaHome: managedJavaHome,
      source: "managed",
    });
  }

  for (const candidate of javaHomeCandidates) {
    const installation = await resolveJavaInstallationFromHome(
      candidate.javaHome,
      candidate.source,
    );
    if (installation) {
      return installation;
    }
  }

  const systemVersion = await getJavaMajorVersion("java");
  if (!systemVersion) {
    return undefined;
  }

  return {
    javaBinary: "java",
    source: "system",
    version: systemVersion,
  };
}

async function resolveJavaInstallationFromHome(
  candidateHome: string,
  source: "java-home" | "android-studio" | "managed",
): Promise<ResolvedJavaInstallation | undefined> {
  const resolvedCandidate = path.resolve(candidateHome);
  const candidates = resolvedCandidate.endsWith(path.join("Contents", "Home"))
    ? [resolvedCandidate]
    : [resolvedCandidate, path.join(resolvedCandidate, "Contents", "Home")];

  for (const javaHome of candidates) {
    const javaBinary = path.join(
      javaHome,
      "bin",
      process.platform === "win32" ? "java.exe" : "java",
    );
    if (!(await exists(javaBinary))) {
      continue;
    }

    const version = await getJavaMajorVersion(javaBinary);
    if (!version) {
      continue;
    }

    return {
      javaBinary,
      javaHome,
      source,
      version,
    };
  }

  return undefined;
}

async function getJavaMajorVersion(javaBinary: string): Promise<number | undefined> {
  const result = await captureCommand(javaBinary, ["-version"]);
  if (!result) {
    return undefined;
  }
  return parseJavaMajorVersion(`${result.stdout}\n${result.stderr}`);
}

export function parseJavaMajorVersion(output: string): number | undefined {
  const normalized = output.trim();
  const modernMatch = normalized.match(/version "(?<version>\d+)(?:\.\d+)?/);
  if (modernMatch?.groups?.version) {
    return Number.parseInt(modernMatch.groups.version, 10);
  }

  const openJdkMatch = normalized.match(/openjdk (?<version>\d+)(?:\.\d+)?/);
  if (openJdkMatch?.groups?.version) {
    return Number.parseInt(openJdkMatch.groups.version, 10);
  }

  return undefined;
}

async function defaultResolveAndroidSdkDir(
  projectDirectory: string,
  explicitSdkDir: string | undefined,
  fix: boolean,
): Promise<string | undefined> {
  if (explicitSdkDir) {
    return path.resolve(explicitSdkDir);
  }

  const localPropertiesSdk = await readLocalPropertiesValue(projectDirectory, "sdk.dir");
  if (localPropertiesSdk) {
    return localPropertiesSdk;
  }

  if (process.env.ANDROID_SDK_ROOT?.trim()) {
    return process.env.ANDROID_SDK_ROOT.trim();
  }

  if (process.env.ANDROID_HOME?.trim()) {
    return process.env.ANDROID_HOME.trim();
  }

  const defaultSdkDir = await findDefaultAndroidSdkDir();
  if (defaultSdkDir) {
    return defaultSdkDir;
  }

  if (!fix) {
    return undefined;
  }

  return preferredAndroidSdkDirectory();
}

function preferredAndroidSdkDirectory(): string {
  const home = os.homedir();
  if (process.platform === "darwin") {
    return path.join(home, "Library", "Android", "sdk");
  }
  if (process.platform === "win32") {
    return path.join(process.env.LOCALAPPDATA ?? path.join(home, "AppData", "Local"), "Android", "Sdk");
  }
  if (process.platform === "linux") {
    return path.join(home, "Android", "Sdk");
  }
  return MANAGED_ANDROID_SDK_DIRECTORY;
}

async function defaultResolveSdkManagerPath(sdkDir: string): Promise<string | undefined> {
  const executableName = process.platform === "win32" ? "sdkmanager.bat" : "sdkmanager";
  const preferred = path.join(sdkDir, "cmdline-tools", "latest", "bin", executableName);
  if (await exists(preferred)) {
    return preferred;
  }

  const cmdlineToolsDirectory = path.join(sdkDir, "cmdline-tools");
  if (await exists(cmdlineToolsDirectory)) {
    const versions = await readdir(cmdlineToolsDirectory);
    for (const version of versions) {
      const candidate = path.join(cmdlineToolsDirectory, version, "bin", executableName);
      if (await exists(candidate)) {
        return candidate;
      }
    }
  }

  const legacyCandidate = path.join(sdkDir, "tools", "bin", executableName);
  if (await exists(legacyCandidate)) {
    return legacyCandidate;
  }

  return undefined;
}

async function defaultInstallManagedJdk(): Promise<ResolvedJavaInstallation> {
  const platform = mapAdoptiumPlatform(process.platform);
  const architecture = mapAdoptiumArchitecture(process.arch);
  if (!platform || !architecture) {
    throw new Error(`Automatic JDK installation is not supported on ${process.platform}/${process.arch}.`);
  }

  const downloadUrl =
    `https://api.adoptium.net/v3/binary/latest/${REQUIRED_JAVA_MAJOR_VERSION}/ga/` +
    `${platform}/${architecture}/jdk/hotspot/normal/eclipse?project=jdk`;
  const archiveExtension = process.platform === "win32" ? ".zip" : ".tar.gz";
  const downloadDirectory = await mkdtemp(path.join(os.tmpdir(), "mwa-webshell-jdk-download-"));
  const archivePath = path.join(downloadDirectory, `jdk${archiveExtension}`);
  const extractDirectory = path.join(downloadDirectory, "extract");

  try {
    await downloadFile(downloadUrl, archivePath);
    await ensureDirectory(extractDirectory);
    await extractArchive(archivePath, extractDirectory);

    const extractedJavaHome = await findJavaHomeInDirectory(extractDirectory);
    if (!extractedJavaHome) {
      throw new Error("Downloaded JDK archive did not contain a usable Java installation.");
    }

    await rm(MANAGED_JDK_DIRECTORY, { recursive: true, force: true });
    await ensureDirectory(path.dirname(MANAGED_JDK_DIRECTORY));
    await cp(extractedJavaHome, MANAGED_JDK_DIRECTORY, { recursive: true, force: true });

    const installation = await resolveJavaInstallationFromHome(
      MANAGED_JDK_DIRECTORY,
      "managed",
    );
    if (!installation) {
      throw new Error("Installed managed JDK could not be verified.");
    }

    return {
      ...installation,
      source: "managed",
    };
  } finally {
    await rm(downloadDirectory, { recursive: true, force: true });
  }
}

async function defaultInstallAndroidCommandLineTools(
  sdkDir: string,
  java: ResolvedJavaInstallation,
): Promise<string> {
  const downloadUrl = ANDROID_COMMAND_LINE_TOOLS_DOWNLOADS[process.platform];
  if (!downloadUrl) {
    throw new Error(`Automatic Android command-line tools installation is not supported on ${process.platform}.`);
  }

  const downloadDirectory = await mkdtemp(path.join(os.tmpdir(), "mwa-webshell-android-cli-"));
  const archivePath = path.join(downloadDirectory, "command-line-tools.zip");
  const extractDirectory = path.join(downloadDirectory, "extract");

  try {
    await downloadFile(downloadUrl, archivePath);
    await ensureDirectory(extractDirectory);
    await extractArchive(archivePath, extractDirectory);

    const extractedRoot = await findCommandLineToolsRoot(extractDirectory);
    if (!extractedRoot) {
      throw new Error("Downloaded Android command-line tools archive did not contain sdkmanager.");
    }

    const targetDirectory = path.join(sdkDir, "cmdline-tools", "latest");
    await rm(targetDirectory, { recursive: true, force: true });
    await ensureDirectory(targetDirectory);

    const entries = await readdir(extractedRoot);
    for (const entry of entries) {
      await cp(path.join(extractedRoot, entry), path.join(targetDirectory, entry), {
        recursive: true,
        force: true,
      });
    }

    const sdkManagerPath = await defaultResolveSdkManagerPath(sdkDir);
    if (!sdkManagerPath) {
      throw new Error("Failed to install Android command-line tools.");
    }

    const env = doctorEnvironment(java, sdkDir);
    await runInteractiveCommand(
      sdkManagerPath,
      [`--sdk_root=${sdkDir}`, "--licenses"],
      undefined,
      env,
      true,
    );

    return sdkManagerPath;
  } finally {
    await rm(downloadDirectory, { recursive: true, force: true });
  }
}

function requiredAndroidPackageRequirements(): AndroidPackageRequirement[] {
  return [
    {
      id: "platform-tools",
      label: "Android SDK Platform-Tools",
    },
    {
      id: `platforms;android-${REQUIRED_ANDROID_PLATFORM}`,
      label: `Android Platform ${REQUIRED_ANDROID_PLATFORM}`,
    },
    {
      id: `build-tools;${REQUIRED_ANDROID_BUILD_TOOLS_VERSION}`,
      label: `Android Build Tools ${REQUIRED_ANDROID_BUILD_TOOLS_VERSION}`,
    },
  ];
}

async function defaultFindMissingAndroidPackages(
  sdkDir: string,
): Promise<AndroidPackageRequirement[]> {
  const executableSuffix = process.platform === "win32" ? ".exe" : "";
  const probes: Array<AndroidPackageRequirement & { probePath: string }> = [
    {
      id: "platform-tools",
      label: "Android SDK Platform-Tools",
      probePath: path.join(sdkDir, "platform-tools", `adb${executableSuffix}`),
    },
    {
      id: `platforms;android-${REQUIRED_ANDROID_PLATFORM}`,
      label: `Android Platform ${REQUIRED_ANDROID_PLATFORM}`,
      probePath: path.join(sdkDir, "platforms", `android-${REQUIRED_ANDROID_PLATFORM}`, "android.jar"),
    },
    {
      id: `build-tools;${REQUIRED_ANDROID_BUILD_TOOLS_VERSION}`,
      label: `Android Build Tools ${REQUIRED_ANDROID_BUILD_TOOLS_VERSION}`,
      probePath: path.join(
        sdkDir,
        "build-tools",
        REQUIRED_ANDROID_BUILD_TOOLS_VERSION,
        `aapt2${executableSuffix}`,
      ),
    },
  ];

  const missing: AndroidPackageRequirement[] = [];
  for (const probe of probes) {
    if (!(await exists(probe.probePath))) {
      missing.push({
        id: probe.id,
        label: probe.label,
      });
    }
  }

  return missing;
}

async function defaultInstallAndroidPackages(
  sdkManagerPath: string,
  sdkDir: string,
  java: ResolvedJavaInstallation,
  requirements: AndroidPackageRequirement[],
): Promise<void> {
  const env = doctorEnvironment(java, sdkDir);
  const packageIds = requirements.map((item) => item.id);

  await runInteractiveCommand(
    sdkManagerPath,
    [`--sdk_root=${sdkDir}`, "--licenses"],
    undefined,
    env,
    true,
  );
  await runInteractiveCommand(
    sdkManagerPath,
    [`--sdk_root=${sdkDir}`, "--install", ...packageIds],
    undefined,
    env,
    true,
  );
}

export function doctorEnvironment(
  java: ResolvedJavaInstallation,
  sdkDir: string,
): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...(java.javaHome ? { JAVA_HOME: java.javaHome } : {}),
    ANDROID_SDK_ROOT: sdkDir,
    ANDROID_HOME: sdkDir,
  };
}

async function findBundledAndroidStudioJavaHome(): Promise<string | undefined> {
  const candidates =
    process.platform === "darwin"
      ? [
          "/Applications/Android Studio.app/Contents/jbr/Contents/Home",
          "/Applications/Android Studio Preview.app/Contents/jbr/Contents/Home",
        ]
      : process.platform === "win32"
        ? [
            "C:\\Program Files\\Android\\Android Studio\\jbr",
            "C:\\Program Files\\Android\\Android Studio\\jre",
          ]
        : [
            "/opt/android-studio/jbr",
            "/opt/android-studio/jre",
            path.join(os.homedir(), "android-studio", "jbr"),
          ];

  for (const candidate of candidates) {
    const installation = await resolveJavaInstallationFromHome(candidate, "android-studio");
    if (installation?.javaHome) {
      return installation.javaHome;
    }
  }

  return undefined;
}

async function findManagedJavaHome(): Promise<string | undefined> {
  const installation = await resolveJavaInstallationFromHome(
    MANAGED_JDK_DIRECTORY,
    "managed",
  );
  if (installation?.javaHome) {
    return installation.javaHome;
  }
  return undefined;
}

function mapAdoptiumPlatform(platform: NodeJS.Platform): string | undefined {
  switch (platform) {
    case "darwin":
      return "mac";
    case "linux":
      return "linux";
    case "win32":
      return "windows";
    default:
      return undefined;
  }
}

function mapAdoptiumArchitecture(architecture: string): string | undefined {
  switch (architecture) {
    case "x64":
      return "x64";
    case "arm64":
      return "aarch64";
    default:
      return undefined;
  }
}

async function findJavaHomeInDirectory(directory: string): Promise<string | undefined> {
  const executableName = process.platform === "win32" ? "java.exe" : "java";
  const files = await walkFiles(directory);
  const javaBinary = files.find(
    (filePath) =>
      filePath.endsWith(path.join("bin", executableName)) &&
      !filePath.includes(`${path.sep}jre${path.sep}`),
  );
  if (!javaBinary) {
    return undefined;
  }

  return path.dirname(path.dirname(javaBinary));
}

async function findCommandLineToolsRoot(directory: string): Promise<string | undefined> {
  const executableName = process.platform === "win32" ? "sdkmanager.bat" : "sdkmanager";
  const files = await walkFiles(directory);
  const sdkManagerPath = files.find((filePath) =>
    filePath.endsWith(path.join("bin", executableName)),
  );
  if (!sdkManagerPath) {
    return undefined;
  }

  return path.dirname(path.dirname(sdkManagerPath));
}

async function downloadFile(url: string, destination: string): Promise<void> {
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(`Download failed for ${url}: ${response.status} ${response.statusText}`);
  }

  await ensureDirectory(path.dirname(destination));
  await pipeline(
    Readable.fromWeb(response.body),
    createWriteStream(destination),
  );
}

async function extractArchive(archivePath: string, destination: string): Promise<void> {
  if (archivePath.endsWith(".zip")) {
    if (process.platform === "win32") {
      await runCommand(
        "powershell",
        [
          "-NoProfile",
          "-Command",
          "Expand-Archive",
          "-Path",
          archivePath,
          "-DestinationPath",
          destination,
          "-Force",
        ],
      );
      return;
    }

    try {
      await runCommand("unzip", ["-q", archivePath, "-d", destination]);
      return;
    } catch {
      if (process.platform === "darwin") {
        await runCommand("ditto", ["-x", "-k", archivePath, destination]);
        return;
      }

      await runCommand("python3", ["-m", "zipfile", "-e", archivePath, destination]);
      return;
    }
  }

  if (archivePath.endsWith(".tar.gz") || archivePath.endsWith(".tgz")) {
    await runCommand("tar", ["-xzf", archivePath, "-C", destination]);
    return;
  }

  throw new Error(`Unsupported archive format: ${archivePath}`);
}

async function captureCommand(
  command: string,
  args: string[],
  cwd?: string,
  env?: NodeJS.ProcessEnv,
): Promise<{ stdout: string; stderr: string } | undefined> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      env,
      shell: process.platform === "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", () => resolve(undefined));
    child.on("close", () => resolve({ stdout, stderr }));
  });
}

async function runCommand(
  command: string,
  args: string[],
  cwd?: string,
  env?: NodeJS.ProcessEnv,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      shell: process.platform === "win32",
      stdio: "inherit",
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} exited with code ${code ?? "unknown"}.`));
    });
  });
}

async function runInteractiveCommand(
  command: string,
  args: string[],
  cwd?: string,
  env?: NodeJS.ProcessEnv,
  autoYes = false,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      shell: process.platform === "win32",
      stdio: ["pipe", "inherit", "inherit"],
    });

    child.stdin.on("error", () => {
      // Ignore EPIPE after the child exits.
    });

    let interval: NodeJS.Timeout | undefined;
    if (autoYes) {
      interval = setInterval(() => {
        if (child.stdin.writable) {
          child.stdin.write("y\n");
        }
      }, 100);
    } else {
      child.stdin.end();
    }

    child.on("error", (error) => {
      if (interval) {
        clearInterval(interval);
      }
      reject(error);
    });

    child.on("close", (code) => {
      if (interval) {
        clearInterval(interval);
      }
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} exited with code ${code ?? "unknown"}.`));
    });
  });
}
