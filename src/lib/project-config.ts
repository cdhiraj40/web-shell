import path from "node:path";
import { GeneratedProjectConfig, SavedProjectConfig } from "./types.js";
import {
  PROJECT_CONFIG_FILENAME,
  exists,
  readUtf8,
  writeUtf8,
} from "./utils.js";

export async function writeProjectConfig(
  projectDirectory: string,
  config: GeneratedProjectConfig,
): Promise<void> {
  const outputPath = path.join(projectDirectory, PROJECT_CONFIG_FILENAME);
  const webUrl = new URL(config.webUrl);
  const signingKey =
    config.signing?.keystorePath || config.signing?.keyAlias
      ? {
          path: config.signing?.keystorePath,
          alias: config.signing?.keyAlias,
        }
      : undefined;
  const bubblewrapStyleConfig = {
    packageId: config.applicationId,
    host: webUrl.host,
    name: config.appName,
    launcherName: config.appName,
    startUrl: `${webUrl.pathname}${webUrl.search}`,
    webManifestUrl: asRemoteUrl(config.source.webManifest),
    fallbackType: "webview",
    generatorApp: "webshell-cli",
    signingKey,
  };

  await writeUtf8(outputPath, `${JSON.stringify(bubblewrapStyleConfig, null, 2)}\n`);
}

export async function readProjectConfig(
  projectDirectory: string,
): Promise<SavedProjectConfig | undefined> {
  const configPath = path.join(projectDirectory, PROJECT_CONFIG_FILENAME);
  if (!(await exists(configPath))) {
    return undefined;
  }
  const parsed = JSON.parse(await readUtf8(configPath)) as {
    signingKey?: {
      path?: string;
      alias?: string;
    };
  };

  const keystorePath = parsed.signingKey?.path;
  const keyAlias = parsed.signingKey?.alias;
  const signing =
    keystorePath || keyAlias
      ? {
          keystorePath,
          keyAlias,
          storePasswordEnv: "WEB_SHELL_KEYSTORE_PASSWORD",
          keyPasswordEnv: "WEB_SHELL_KEY_PASSWORD",
        }
      : undefined;

  return { signing };
}

function asRemoteUrl(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  if (value.startsWith("http://") || value.startsWith("https://")) {
    return value;
  }

  return undefined;
}
