import path from "node:path";
import { fileURLToPath } from "node:url";
import { applyProjectConfiguration } from "../lib/android-project.js";
import {
  loadManifest,
  loadWebManifest,
} from "../lib/manifests.js";
import { ensureInitSigning } from "../lib/signing.js";
import { writeProjectConfig } from "../lib/project-config.js";
import { Prompter } from "../lib/prompts.js";
import {
  DEFAULT_TEMPLATE_REF,
  DEFAULT_TEMPLATE_REPOSITORY_URL,
  copyTemplateProject,
} from "../lib/template.js";
import {
  deriveApplicationIdFromUrl,
  deriveApplicationIdSuggestionFromUrl,
  derivePackageNameSuggestionFromApplicationId,
  isDirectoryEmpty,
  normalizeHttpUrl,
  resolveRepositoryRoot,
  validateApplicationId,
} from "../lib/utils.js";
import { createStepFeedback, runStep } from "../lib/ui.js";
import { GeneratedProjectConfig, ManifestSeed, SigningConfig } from "../lib/types.js";

const MAX_ANDROID_VERSION_CODE = 2_100_000_000;

export interface InitCommandOptions {
  manifest?: string;
  applicationId?: string;
  appName?: string;
  url?: string;
  versionCode?: number;
  versionName?: string;
  projectName?: string;
  keystorePath?: string;
  keystoreAlias?: string;
  keystoreStorePasswordEnv?: string;
  keystoreKeyPasswordEnv?: string;
  templateRepo?: string;
  templateRef?: string;
  nonInteractive?: boolean;
  force?: boolean;
}

export async function runInitCommand(
  directory: string | undefined,
  options: InitCommandOptions,
): Promise<void> {
  const cwd = process.cwd();
  const targetDirectory = path.resolve(cwd, directory ?? ".");
  const repositoryRoot = resolveRepositoryRoot(import.meta.url);
  const feedback = createStepFeedback();

  if (targetDirectory === repositoryRoot) {
    throw new Error("Refusing to generate into the template repository root.");
  }

  const inputManifestSeed = options.manifest
    ? await runStep(
        feedback,
        "Loading manifest...",
        () => loadManifest(options.manifest!, cwd),
        "Loaded manifest.",
      )
    : undefined;
  const bubblewrapSeed = inputManifestSeed?.kind === "bubblewrap"
    ? inputManifestSeed
    : undefined;
  const linkedWebManifestUrl = bubblewrapSeed?.webManifestUrl;
  const webManifestSeed = inputManifestSeed?.kind === "web"
    ? inputManifestSeed
    : linkedWebManifestUrl
      ? await runStep(
          feedback,
          "Loading linked web manifest...",
          () => loadWebManifest(linkedWebManifestUrl, cwd),
          "Loaded linked web manifest.",
        )
      : undefined;

  const prompter = new Prompter(options.nonInteractive ? false : undefined);
  try {
    const overwrite =
      options.force ||
      (await isDirectoryEmpty(targetDirectory)) ||
      (await prompter.confirm(
        `Target directory ${targetDirectory} is not empty. Overwrite template files if needed?`,
        false,
      ));

    if (!overwrite && !(await isDirectoryEmpty(targetDirectory))) {
      throw new Error("Target directory is not empty. Re-run with --force to overwrite.");
    }

    const initialWebUrl = resolveInitialWebUrl(
      options.url,
      bubblewrapSeed,
      webManifestSeed,
    );
    const applicationId = await resolveApplicationId(
      prompter,
      options.applicationId,
      initialWebUrl,
      bubblewrapSeed,
    );
    const packageNameSuggestion = derivePackageNameSuggestionFromApplicationId(applicationId);
    if (packageNameSuggestion.note && prompter.isInteractive()) {
      console.log(`Note: ${packageNameSuggestion.note}`);
    }
    const initialAppName = resolveInitialAppName(
      options.appName,
      bubblewrapSeed,
      webManifestSeed,
    );
    const appName = await resolveAppName(
      prompter,
      initialAppName,
    );
    const versionCode = await resolveVersionCode(
      prompter,
      options.versionCode,
      bubblewrapSeed,
    );
    const versionName = await resolveVersionName(
      prompter,
      options.versionName,
      bubblewrapSeed,
    );
    const webUrl = await resolveWebUrl(
      prompter,
      options.url,
      bubblewrapSeed,
      webManifestSeed,
    );
    const projectName = resolveProjectName(
      targetDirectory,
      options.projectName,
      appName,
    );
    const usingBundledTemplate = options.templateRepo === undefined;
    const templateRepo = options.templateRepo ?? DEFAULT_TEMPLATE_REPOSITORY_URL;
    const templateRef = options.templateRef ?? DEFAULT_TEMPLATE_REF;

    const initialSigning = resolveSigning(options, bubblewrapSeed);

    await runStep(
      feedback,
      "Preparing Android shell project...",
      () =>
        copyTemplateProject(targetDirectory, overwrite, {
          repositoryUrl: templateRepo,
          ref: templateRef,
        }),
      "Prepared Android shell project.",
    );

    const signing = await ensureInitSigning(
      prompter,
      targetDirectory,
      appName,
      initialSigning,
    );

    const projectConfig: GeneratedProjectConfig = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      projectName,
      appName,
      applicationId,
      versionCode,
      versionName,
      packageName: packageNameSuggestion.packageName,
      webUrl,
      source: {
        templateRepo: usingBundledTemplate ? "bundled" : templateRepo,
        templateRef,
        webManifest: webManifestSeed?.source,
        bubblewrapManifest: bubblewrapSeed?.source,
      },
      signing,
    };

    await runStep(
      feedback,
      "Applying Android project configuration...",
      async () => {
        await applyProjectConfiguration(targetDirectory, projectConfig, webManifestSeed);
        await writeProjectConfig(targetDirectory, projectConfig);
      },
      "Applied Android project configuration.",
    );

    console.log(`Generated project at ${targetDirectory}`);
    console.log(`Application ID: ${applicationId}`);
    console.log(`Web URL: ${webUrl}`);
    console.log("Next steps:");
    if (signing?.keystorePath && signing.keyAlias) {
      console.log("  # Optional: set these to skip password prompts during builds");
      console.log("  export WEB_SHELL_KEYSTORE_PASSWORD='<keystore-password>'");
      console.log("  export WEB_SHELL_KEY_PASSWORD='<key-password>'");
    }
    console.log(`  webshell build ${quoteShellValue(targetDirectory)}`);
  } finally {
    prompter.close();
  }
}

async function resolveApplicationId(
  prompter: Prompter,
  explicitValue: string | undefined,
  webUrl: string | undefined,
  bubblewrapSeed?: ManifestSeed,
): Promise<string> {
  const derivedSuggestion =
    !explicitValue && !bubblewrapSeed?.applicationId && webUrl
      ? deriveApplicationIdSuggestionFromUrl(webUrl)
      : undefined;

  if (derivedSuggestion?.note && prompter.isInteractive()) {
    console.log(`Note: ${derivedSuggestion.note}`);
  }

  const candidate =
    explicitValue ??
    bubblewrapSeed?.applicationId ??
    derivedSuggestion?.applicationId ??
    (webUrl ? deriveApplicationIdFromUrl(webUrl) : undefined);
  return prompter.text("Android application ID", {
    defaultValue: candidate,
    validate: validateApplicationId,
  });
}

async function resolveAppName(
  prompter: Prompter,
  defaultValue: string | undefined,
): Promise<string> {
  return prompter.text("App name", {
    defaultValue,
    validate: requireNonEmpty("App name"),
  });
}

async function resolveWebUrl(
  prompter: Prompter,
  explicitValue: string | undefined,
  bubblewrapSeed?: ManifestSeed,
  webManifestSeed?: ManifestSeed,
): Promise<string> {
  const defaultValue = explicitValue ?? bubblewrapSeed?.webUrl ?? webManifestSeed?.webUrl;
  return prompter.text(defaultValue ? "Website URL" : "Website URL (https://example.com)", {
    defaultValue,
    validate: (value) => {
      if (!value.trim()) {
        return "Website URL is required.";
      }
      try {
        normalizeHttpUrl(value);
        return undefined;
      } catch (error) {
        return error instanceof Error ? error.message : "Invalid URL.";
      }
    },
  }).then(normalizeHttpUrl);
}

async function resolveVersionCode(
  prompter: Prompter,
  explicitValue: number | undefined,
  bubblewrapSeed?: ManifestSeed,
): Promise<number> {
  const rawValue = await prompter.text("Android version code", {
    defaultValue: String(explicitValue ?? bubblewrapSeed?.versionCode ?? 1),
    validate: validateVersionCode,
  });
  return Number.parseInt(rawValue, 10);
}

async function resolveVersionName(
  prompter: Prompter,
  explicitValue: string | undefined,
  bubblewrapSeed?: ManifestSeed,
): Promise<string> {
  return prompter.text("Android version name", {
    defaultValue: explicitValue ?? bubblewrapSeed?.versionName ?? "1.0",
    validate: requireNonEmpty("Android version name"),
  });
}

function resolveSigning(
  options: InitCommandOptions,
  bubblewrapSeed?: ManifestSeed,
): SigningConfig | undefined {
  const candidate: SigningConfig = {
    keystorePath:
      options.keystorePath ??
      resolveSeedRelativePath(bubblewrapSeed?.signing?.keystorePath, bubblewrapSeed?.source),
    keyAlias: options.keystoreAlias ?? bubblewrapSeed?.signing?.keyAlias,
    storePasswordEnv:
      options.keystoreStorePasswordEnv ??
      bubblewrapSeed?.signing?.storePasswordEnv,
    keyPasswordEnv:
      options.keystoreKeyPasswordEnv ??
      bubblewrapSeed?.signing?.keyPasswordEnv,
  };

  if (
    !candidate.keystorePath &&
    !candidate.keyAlias &&
    !candidate.storePasswordEnv &&
    !candidate.keyPasswordEnv
  ) {
    return undefined;
  }

  return candidate;
}

function resolveSeedRelativePath(
  candidate: string | undefined,
  manifestSource: string | undefined,
): string | undefined {
  if (!candidate?.trim()) {
    return undefined;
  }

  if (path.isAbsolute(candidate)) {
    return candidate;
  }

  if (!manifestSource) {
    return candidate;
  }

  if (manifestSource.startsWith("http://") || manifestSource.startsWith("https://")) {
    return candidate;
  }

  if (manifestSource.startsWith("file://")) {
    return path.resolve(path.dirname(fileURLToPath(manifestSource)), candidate);
  }

  return path.resolve(path.dirname(manifestSource), candidate);
}

function requireNonEmpty(label: string): (value: string) => string | undefined {
  return (value) => {
    if (!value.trim()) {
      return `${label} is required.`;
    }
    return undefined;
  };
}

function validateVersionCode(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) {
    return "Android version code is required.";
  }
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return "Android version code must be a positive integer.";
  }
  if (parsed > MAX_ANDROID_VERSION_CODE) {
    return `Android version code must be ${MAX_ANDROID_VERSION_CODE} or lower.`;
  }
  return undefined;
}

function resolveProjectName(
  targetDirectory: string,
  explicitValue: string | undefined,
  fallbackName: string,
): string {
  const trimmedExplicitValue = explicitValue?.trim();
  if (trimmedExplicitValue) {
    return trimmedExplicitValue;
  }

  const inferredName = path.basename(targetDirectory).trim();
  return inferredName || fallbackName;
}

function resolveInitialWebUrl(
  explicitValue: string | undefined,
  bubblewrapSeed?: ManifestSeed,
  webManifestSeed?: ManifestSeed,
): string | undefined {
  const candidate = explicitValue ?? bubblewrapSeed?.webUrl ?? webManifestSeed?.webUrl;
  if (!candidate) {
    return undefined;
  }

  try {
    return normalizeHttpUrl(candidate);
  } catch {
    return undefined;
  }
}

function quoteShellValue(value: string): string {
  return JSON.stringify(value);
}

function resolveInitialAppName(
  explicitValue: string | undefined,
  bubblewrapSeed: ManifestSeed | undefined,
  webManifestSeed: ManifestSeed | undefined,
): string | undefined {
  if (explicitValue?.trim()) {
    return explicitValue.trim();
  }

  if (bubblewrapSeed?.appName) {
    return bubblewrapSeed.appName;
  }

  return webManifestSeed?.appName;
}
