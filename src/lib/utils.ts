import { constants } from "node:fs";
import {
  access,
  chmod,
  mkdir,
  readFile,
  readdir,
  rename,
  rmdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const TEMPLATE_PACKAGE_NAME = "com.solanamobile.webshell";
export const PROJECT_CONFIG_FILENAME = "twa-manifest.json";
const RESERVED_PACKAGE_SEGMENTS = new Set([
  "abstract",
  "annotation",
  "as",
  "assert",
  "boolean",
  "break",
  "byte",
  "case",
  "catch",
  "char",
  "class",
  "companion",
  "const",
  "constructor",
  "continue",
  "data",
  "default",
  "do",
  "double",
  "dynamic",
  "else",
  "enum",
  "exports",
  "extends",
  "external",
  "false",
  "field",
  "final",
  "finally",
  "float",
  "for",
  "fun",
  "get",
  "goto",
  "if",
  "implements",
  "import",
  "in",
  "infix",
  "init",
  "instanceof",
  "int",
  "interface",
  "internal",
  "is",
  "java",
  "long",
  "module",
  "native",
  "new",
  "null",
  "object",
  "open",
  "operator",
  "out",
  "override",
  "package",
  "private",
  "protected",
  "public",
  "record",
  "reified",
  "requires",
  "return",
  "sealed",
  "set",
  "short",
  "static",
  "strictfp",
  "super",
  "suspend",
  "switch",
  "synchronized",
  "this",
  "throw",
  "throws",
  "transient",
  "transitive",
  "true",
  "try",
  "typealias",
  "typeof",
  "val",
  "var",
  "void",
  "volatile",
  "when",
  "while",
  "yield",
]);

export function resolveRepositoryRoot(importMetaUrl: string): string {
  return path.resolve(path.dirname(fileURLToPath(importMetaUrl)), "../../..");
}

export async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function isDirectoryEmpty(directory: string): Promise<boolean> {
  if (!(await exists(directory))) {
    return true;
  }
  const entries = await readdir(directory);
  return entries.length === 0;
}

export async function ensureDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true });
}

export async function readUtf8(filePath: string): Promise<string> {
  return readFile(filePath, "utf8");
}

export async function writeUtf8(filePath: string, value: string): Promise<void> {
  await ensureDirectory(path.dirname(filePath));
  await writeFile(filePath, value, "utf8");
}

export function normalizeHttpUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`Invalid URL: ${value}`);
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`URL must use http or https: ${value}`);
  }

  return parsed.toString();
}

export function validateApplicationId(value: string): string | undefined {
  if (!/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/.test(value)) {
    return "Application ID must look like com.example.app. Use lowercase package segments with letters, numbers, or underscores only; dashes (-) are not allowed.";
  }

  return undefined;
}

export function deriveApplicationIdFromUrl(value: string): string | undefined {
  return deriveApplicationIdSuggestionFromUrl(value).applicationId;
}

export interface DerivedApplicationIdSuggestion {
  applicationId?: string;
  note?: string;
}

export function deriveApplicationIdSuggestionFromUrl(
  value: string,
): DerivedApplicationIdSuggestion {
  let parsed: URL;
  try {
    parsed = new URL(normalizeHttpUrl(value));
  } catch {
    return {};
  }

  const host = parsed.hostname.trim().toLowerCase();
  if (!host || host === "localhost" || /^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    return {};
  }

  const segmentResults = host
    .split(".")
    .reverse()
    .map((segment) =>
      normalizeApplicationIdSegment(segment, { rewriteReservedKeywords: false })
    );
  const segments = segmentResults
    .map((result) => result.normalized)
    .filter((segment): segment is string => Boolean(segment));

  if (segments.length < 2) {
    return {};
  }

  const candidate = segments.join(".");
  if (validateApplicationId(candidate)) {
    return {};
  }

  const normalizedRewrite = segmentResults.some((result) => result.adjusted);
  if (normalizedRewrite) {
    return {
      applicationId: candidate,
      note: `Adjusted the default application ID to ${candidate} to keep it Android-safe.`,
    };
  }

  return {
    applicationId: candidate,
  };
}

export interface DerivedPackageNameSuggestion {
  packageName: string;
  note?: string;
}

export function derivePackageNameSuggestionFromApplicationId(
  value: string,
): DerivedPackageNameSuggestion {
  const segmentResults = value
    .trim()
    .split(".")
    .map((segment) =>
      normalizeApplicationIdSegment(segment, { rewriteReservedKeywords: true })
    );
  const segments = segmentResults
    .map((result) => result.normalized)
    .filter((segment): segment is string => Boolean(segment));

  const packageName = segments.join(".");
  const reservedRewrite = segmentResults.find((result) => result.reason === "reserved");
  if (reservedRewrite?.original) {
    return {
      packageName,
      note:
        `The Kotlin package/namespace will use ${packageName} because ` +
        `"${reservedRewrite.original}" is a reserved word in Kotlin/Java.`,
    };
  }

  const normalizedRewrite = segmentResults.some((result) => result.adjusted);
  if (normalizedRewrite) {
    return {
      packageName,
      note: `The Kotlin package/namespace will use ${packageName} to keep it code-safe.`,
    };
  }

  return { packageName };
}

export function packageNameToPath(packageName: string): string {
  return packageName.split(".").join(path.sep);
}

export function escapeXmlText(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function updateGradleProperty(
  contents: string,
  key: string,
  value: string,
): string {
  const escapedValue = value.replaceAll("\\", "\\\\");
  const pattern = new RegExp(`^${escapeRegExp(key)}=.*$`, "m");
  const line = `${key}=${escapedValue}`;
  if (pattern.test(contents)) {
    return contents.replace(pattern, line);
  }
  return `${contents.trimEnd()}\n${line}\n`;
}

export function updateRootProjectName(
  contents: string,
  projectName: string,
): string {
  const escapedName = projectName.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
  return contents.replace(
    /rootProject\.name\s*=\s*"[^"]*"/,
    `rootProject.name = "${escapedName}"`,
  );
}

export async function walkFiles(directory: string): Promise<string[]> {
  const output: string[] = [];
  const entries = await readdir(directory, { withFileTypes: true });

  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      output.push(...(await walkFiles(entryPath)));
    } else {
      output.push(entryPath);
    }
  }

  return output;
}

export async function removeEmptyParents(
  startDirectory: string,
  stopDirectory: string,
): Promise<void> {
  let current = startDirectory;
  const normalizedStop = path.resolve(stopDirectory);

  while (path.resolve(current).startsWith(normalizedStop)) {
    if (path.resolve(current) === normalizedStop) {
      return;
    }

    const entries = await readdir(current);
    if (entries.length > 0) {
      return;
    }

    await rmdir(current);
    current = path.dirname(current);
  }
}

export async function moveDirectory(
  source: string,
  destination: string,
): Promise<void> {
  await ensureDirectory(path.dirname(destination));
  await rename(source, destination);
}

export function createLocalPropertiesSdkLine(sdkDir: string): string {
  return `sdk.dir=${sdkDir.replaceAll("\\", "\\\\")}\n`;
}

export async function readLocalPropertiesValue(
  projectDirectory: string,
  key: string,
): Promise<string | undefined> {
  const localPropertiesPath = path.join(projectDirectory, "local.properties");
  if (!(await exists(localPropertiesPath))) {
    return undefined;
  }

  const contents = await readUtf8(localPropertiesPath);
  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    if (trimmed.startsWith(`${key}=`)) {
      return trimmed.slice(key.length + 1).replaceAll("\\\\", "\\");
    }
  }

  return undefined;
}

export async function findDefaultAndroidSdkDir(): Promise<string | undefined> {
  const home = os.homedir();
  const candidates =
    process.platform === "darwin"
      ? [path.join(home, "Library", "Android", "sdk")]
      : process.platform === "win32"
        ? [
            path.join(process.env.LOCALAPPDATA ?? "", "Android", "Sdk"),
            path.join(home, "AppData", "Local", "Android", "Sdk"),
          ]
        : [path.join(home, "Android", "Sdk")];

  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }
    if (await exists(candidate)) {
      return candidate;
    }
  }

  return undefined;
}

export async function ensureFileExecutable(filePath: string): Promise<void> {
  if (process.platform === "win32") {
    return;
  }
  const fileStats = await stat(filePath);
  const executableMode = fileStats.mode | 0o111;
  if (fileStats.mode !== executableMode) {
    await chmod(filePath, executableMode);
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

interface NormalizedApplicationIdSegment {
  normalized?: string;
  original: string;
  adjusted: boolean;
  reason?: "normalized" | "reserved";
}

function normalizeApplicationIdSegment(
  value: string,
  options: { rewriteReservedKeywords: boolean },
): NormalizedApplicationIdSegment {
  let normalized = value
    .replace(/[^a-z0-9_]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");

  if (!normalized) {
    return {
      original: value,
      adjusted: true,
    };
  }

  let adjusted = normalized !== value;

  if (!/^[a-z]/.test(normalized)) {
    normalized = `app${normalized}`;
    adjusted = true;
  }

  if (options.rewriteReservedKeywords && RESERVED_PACKAGE_SEGMENTS.has(normalized)) {
    return {
      normalized: `_${normalized}`,
      original: value,
      adjusted: true,
      reason: "reserved",
    };
  }

  return {
    normalized,
    original: value,
    adjusted,
    reason: adjusted ? "normalized" : undefined,
  };
}
