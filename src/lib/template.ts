import { spawn } from "node:child_process";
import { cp, mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureDirectory, ensureFileExecutable, exists } from "./utils.js";

export const DEFAULT_TEMPLATE_REPOSITORY_URL = new URL("../../template/", import.meta.url).toString();
export const DEFAULT_TEMPLATE_REF = "bundled";

export interface TemplateSource {
  repositoryUrl: string;
  ref: string;
}

interface TemplateEntry {
  destination: string;
  source: string;
  bundledSource?: string;
}

const TEMPLATE_ENTRIES: TemplateEntry[] = [
  {
    destination: ".gitignore",
    source: ".gitignore",
    bundledSource: "gitignore",
  },
  {
    destination: "app",
    source: "app",
  },
  {
    destination: "build.gradle.kts",
    source: "build.gradle.kts",
  },
  // Keep this list explicit so internal docs, scratch notes, and planning files
  // never leak into generated projects by default.
  {
    destination: "gradle",
    source: "gradle",
  },
  {
    destination: "gradle.properties",
    source: "gradle.properties",
  },
  {
    destination: "gradlew",
    source: "gradlew",
  },
  {
    destination: "gradlew.bat",
    source: "gradlew.bat",
  },
  {
    destination: "settings.gradle.kts",
    source: "settings.gradle.kts",
  },
];

export async function copyTemplateProject(
  targetDirectory: string,
  overwrite: boolean,
  templateSource: TemplateSource,
): Promise<void> {
  const localTemplateDirectory = await resolveLocalTemplateDirectory(templateSource.repositoryUrl);
  if (localTemplateDirectory) {
    await copyTemplateEntries(localTemplateDirectory, targetDirectory, overwrite);
    return;
  }

  const cloneDirectory = await mkdtemp(path.join(os.tmpdir(), "mwa-webshell-template-"));
  await ensureDirectory(targetDirectory);

  try {
    await cloneTemplateRepository(cloneDirectory, templateSource);
    await copyTemplateEntries(cloneDirectory, targetDirectory, overwrite);
  } finally {
    await rm(cloneDirectory, { recursive: true, force: true });
  }
}

async function cloneTemplateRepository(
  targetDirectory: string,
  templateSource: TemplateSource,
): Promise<void> {
  const args = [
    "clone",
    "--depth",
    "1",
    "--single-branch",
    "--branch",
    templateSource.ref,
    templateSource.repositoryUrl,
    targetDirectory,
  ];

  await new Promise<void>((resolve, reject) => {
    let cloneOutput = "";
    const child = spawn("git", args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    child.stdout.on("data", (chunk) => {
      cloneOutput += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      cloneOutput += chunk.toString();
    });

    child.on("error", () => {
      reject(
        new Error(
          "Git is required for template generation. Install git and try again.",
        ),
      );
    });
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `Failed to clone template repository ${templateSource.repositoryUrl}#${templateSource.ref}.${formatCloneFailure(cloneOutput)}`,
        ),
      );
    });
  });
}

async function copyTemplateEntries(
  sourceDirectory: string,
  targetDirectory: string,
  overwrite: boolean,
): Promise<void> {
  await ensureDirectory(targetDirectory);
  const isBundledTemplate =
    sourceDirectory === fileURLToPath(new URL("../../template/", import.meta.url));

  for (const entry of TEMPLATE_ENTRIES) {
    const sourceName = isBundledTemplate ? entry.bundledSource ?? entry.source : entry.source;
    const sourcePath = path.join(sourceDirectory, sourceName);
    const destinationPath = path.join(targetDirectory, entry.destination);
    await ensureDirectory(path.dirname(destinationPath));
    if (overwrite && (await exists(destinationPath))) {
      await rm(destinationPath, { recursive: true, force: true });
    }
    await cp(sourcePath, destinationPath, {
      recursive: true,
      force: overwrite,
      errorOnExist: !overwrite,
    });
  }

  await ensureFileExecutable(path.join(targetDirectory, "gradlew"));
}

async function resolveLocalTemplateDirectory(
  repositoryUrl: string,
): Promise<string | undefined> {
  const trimmed = repositoryUrl.trim();

  const fileUrl = parseFileUrl(trimmed);
  if (fileUrl) {
    const candidate = fileURLToPath(fileUrl);
    return (await isDirectory(candidate)) ? candidate : undefined;
  }

  if (looksLikeRemoteRepository(trimmed)) {
    return undefined;
  }

  const candidate = path.resolve(trimmed);
  return (await isDirectory(candidate)) ? candidate : undefined;
}

function parseFileUrl(value: string): URL | undefined {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "file:" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function looksLikeRemoteRepository(value: string): boolean {
  return (
    value.startsWith("http://") ||
    value.startsWith("https://") ||
    value.startsWith("ssh://") ||
    value.startsWith("git@")
  );
}

async function isDirectory(candidate: string): Promise<boolean> {
  try {
    return (await stat(candidate)).isDirectory();
  } catch {
    return false;
  }
}

function formatCloneFailure(output: string): string {
  const message = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !line.startsWith("Cloning into "))
    .at(-1);

  return message ? ` ${message}` : "";
}
