import path from "node:path";
import { rm } from "node:fs/promises";
import { applyProjectBranding } from "./branding.js";
import { GeneratedProjectConfig } from "./types.js";
import {
  TEMPLATE_PACKAGE_NAME,
  escapeXmlText,
  exists,
  moveDirectory,
  packageNameToPath,
  readUtf8,
  removeEmptyParents,
  updateGradleProperty,
  updateRootProjectName,
  walkFiles,
  writeUtf8,
} from "./utils.js";

export async function applyProjectConfiguration(
  projectDirectory: string,
  config: GeneratedProjectConfig,
  manifestSeed?: GeneratedProjectConfig["source"] extends never ? never : import("./types.js").ManifestSeed,
): Promise<void> {
  await rewriteGradleProperties(projectDirectory, config);
  await rewriteSettings(projectDirectory, config);
  await rewriteAppBuildScript(projectDirectory, config);
  await rewriteStrings(projectDirectory, config);
  await rewritePackageDeclarations(projectDirectory, config.packageName);
  await relocatePackageDirectories(projectDirectory, config.packageName);
  await applyProjectBranding(projectDirectory, manifestSeed);
  await writeProjectReadme(projectDirectory, config);
}

async function rewriteGradleProperties(
  projectDirectory: string,
  config: GeneratedProjectConfig,
): Promise<void> {
  const gradlePropertiesPath = path.join(projectDirectory, "gradle.properties");
  let contents = await readUtf8(gradlePropertiesPath);
  contents = updateGradleProperty(contents, "WEB_SHELL_URL", config.webUrl);
  contents = updateGradleProperty(
    contents,
    "WEB_SHELL_APPLICATION_ID",
    config.applicationId,
  );
  contents = updateGradleProperty(
    contents,
    "WEB_SHELL_VERSION_CODE",
    String(config.versionCode),
  );
  contents = updateGradleProperty(
    contents,
    "WEB_SHELL_VERSION_NAME",
    config.versionName,
  );
  await writeUtf8(gradlePropertiesPath, contents);
}

async function rewriteSettings(
  projectDirectory: string,
  config: GeneratedProjectConfig,
): Promise<void> {
  const settingsPath = path.join(projectDirectory, "settings.gradle.kts");
  const contents = await readUtf8(settingsPath);
  await writeUtf8(settingsPath, updateRootProjectName(contents, config.projectName));
}

async function rewriteAppBuildScript(
  projectDirectory: string,
  config: GeneratedProjectConfig,
): Promise<void> {
  const buildScriptPath = path.join(projectDirectory, "app", "build.gradle.kts");
  const contents = await readUtf8(buildScriptPath);
  const nextContents = contents.replace(
    /namespace\s*=\s*"[^"]+"/,
    `namespace = "${config.packageName}"`,
  );
  await writeUtf8(buildScriptPath, nextContents);
}

async function rewriteStrings(
  projectDirectory: string,
  config: GeneratedProjectConfig,
): Promise<void> {
  const stringsPath = path.join(
    projectDirectory,
    "app",
    "src",
    "main",
    "res",
    "values",
    "strings.xml",
  );
  const contents = await readUtf8(stringsPath);
  const nextContents = contents.replace(
    /<string name="app_name">.*?<\/string>/,
    `<string name="app_name">${escapeXmlText(config.appName)}</string>`,
  );
  await writeUtf8(stringsPath, nextContents);
}

async function rewritePackageDeclarations(
  projectDirectory: string,
  packageName: string,
): Promise<void> {
  const sourceRoots = [
    path.join(projectDirectory, "app", "src", "main", "java"),
    path.join(projectDirectory, "app", "src", "test", "java"),
    path.join(projectDirectory, "app", "src", "androidTest", "java"),
  ];

  for (const sourceRoot of sourceRoots) {
    if (!(await exists(sourceRoot))) {
      continue;
    }

    const files = await walkFiles(sourceRoot);
    for (const filePath of files) {
      if (!filePath.endsWith(".kt")) {
        continue;
      }
      const contents = await readUtf8(filePath);
      await writeUtf8(
        filePath,
        contents.replaceAll(TEMPLATE_PACKAGE_NAME, packageName),
      );
    }
  }
}

async function relocatePackageDirectories(
  projectDirectory: string,
  packageName: string,
): Promise<void> {
  if (packageName === TEMPLATE_PACKAGE_NAME) {
    return;
  }

  const sourceSets = [
    path.join(projectDirectory, "app", "src", "main", "java"),
    path.join(projectDirectory, "app", "src", "test", "java"),
    path.join(projectDirectory, "app", "src", "androidTest", "java"),
  ];

  for (const sourceSet of sourceSets) {
    const sourceDirectory = path.join(
      sourceSet,
      packageNameToPath(TEMPLATE_PACKAGE_NAME),
    );
    if (!(await exists(sourceDirectory))) {
      continue;
    }

    const destinationDirectory = path.join(
      sourceSet,
      packageNameToPath(packageName),
    );
    if (await exists(destinationDirectory)) {
      await rm(destinationDirectory, { recursive: true, force: true });
    }
    await moveDirectory(sourceDirectory, destinationDirectory);
    await removeEmptyParents(path.dirname(sourceDirectory), sourceSet);
  }
}

async function writeProjectReadme(
  projectDirectory: string,
  config: GeneratedProjectConfig,
): Promise<void> {
  const signingSection =
    config.signing?.keystorePath && config.signing.keyAlias
      ? `## Release Signing

Saved from CLI configuration:

- Keystore path: \`${config.signing.keystorePath}\`
- Key alias: \`${config.signing.keyAlias}\`
- Store password env: \`${config.signing.storePasswordEnv ?? "WEB_SHELL_KEYSTORE_PASSWORD"}\`
- Key password env: \`${config.signing.keyPasswordEnv ?? "WEB_SHELL_KEY_PASSWORD"}\`

Export the password environment variables before running the CLI release build.

`
      : "";

  const contents = `# ${config.appName}

Generated by the Solana Mobile Web Shell CLI.

## Configuration

- Web URL: \`${config.webUrl}\`
- Application ID: \`${config.applicationId}\`
- Version code: \`${config.versionCode}\`
- Version name: \`${config.versionName}\`
- Kotlin package / namespace: \`${config.packageName}\`

## Build

\`\`\`bash
webshell build .
adb install -r app/build/outputs/apk/release/app-release.apk
\`\`\`

${signingSection}## Notes

- This project is a WebView-based Android shell, not a Trusted Web Activity.
- External links outside the configured host open in the system browser.
- Solana wallet intents are handled natively by the app shell.
`;

  await writeUtf8(path.join(projectDirectory, "README.md"), contents);
}
