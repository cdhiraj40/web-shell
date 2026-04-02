import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ManifestIcon, ManifestSeed, SigningConfig } from "./types.js";
import { normalizeHttpUrl, readUtf8 } from "./utils.js";

interface LoadedJsonSource {
  location: string;
  baseUrl?: string;
  data: unknown;
}

type JsonObject = Record<string, unknown>;
const BUBBLEWRAP_LAUNCHER_NAME_MAX_SIZE = 12;

export async function loadManifest(
  source: string,
  cwd: string,
): Promise<ManifestSeed> {
  const loaded = await loadJsonSource(source, cwd);
  const manifest = asObject(loaded.data, "Manifest");

  if (isBubblewrapManifest(manifest)) {
    return parseBubblewrapManifest(loaded, manifest);
  }

  return parseWebManifest(loaded, manifest);
}

export async function loadWebManifest(
  source: string,
  cwd: string,
): Promise<ManifestSeed> {
  const loaded = await loadJsonSource(source, cwd);
  const manifest = asObject(loaded.data, "Web manifest");
  return parseWebManifest(loaded, manifest);
}

export async function loadBubblewrapManifest(
  source: string,
  cwd: string,
): Promise<ManifestSeed> {
  const loaded = await loadJsonSource(source, cwd);
  const manifest = asObject(loaded.data, "Bubblewrap manifest");
  return parseBubblewrapManifest(loaded, manifest);
}

function parseWebManifest(
  loaded: LoadedJsonSource,
  manifest: JsonObject,
): ManifestSeed {
  return {
    kind: "web",
    source: loaded.location,
    webManifestUrl: loaded.location,
    appName: resolveLauncherName(manifest),
    webUrl: resolveWebManifestUrl(manifest, loaded.baseUrl),
    themeColor: asString(manifest.theme_color),
    backgroundColor: asString(manifest.background_color),
    icons: parseManifestIcons(manifest.icons, loaded.baseUrl),
  };
}

function parseBubblewrapManifest(
  loaded: LoadedJsonSource,
  manifest: JsonObject,
): ManifestSeed {
  return {
    kind: "bubblewrap",
    source: loaded.location,
    appName:
      asString(manifest.launcherName) ??
      asString(manifest.shortName) ??
      asString(manifest.short_name) ??
      asString(manifest.name),
    applicationId:
      asString(manifest.packageId) ?? asString(manifest.applicationId),
    versionCode: asPositiveInteger(
      manifest.versionCode ??
        manifest.appVersionCode ??
        manifest.androidVersionCode,
    ),
    versionName:
      asString(manifest.versionName) ??
      asString(manifest.appVersionName) ??
      asString(manifest.androidVersionName),
    webManifestUrl: resolveAssetUrl(asString(manifest.webManifestUrl), loaded.baseUrl),
    webUrl: resolveBubblewrapUrl(manifest, loaded.baseUrl),
    signing: normalizeSigning(asObjectOrUndefined(manifest.signingKey)),
  };
}

function isBubblewrapManifest(manifest: JsonObject): boolean {
  return Boolean(
    asString(manifest.packageId) ??
      asString(manifest.applicationId) ??
      asString(manifest.launcherName) ??
      asString(manifest.host) ??
      asString(manifest.webManifestUrl) ??
      asString(manifest.generatorApp) ??
      asString(manifest.fallbackType) ??
      (asObjectOrUndefined(manifest.signingKey) ? "signingKey" : undefined),
  );
}

async function loadJsonSource(
  source: string,
  cwd: string,
): Promise<LoadedJsonSource> {
  const trimmed = source.trim();
  const parsedUrl = parseUrl(trimmed);

  if (parsedUrl?.protocol === "http:" || parsedUrl?.protocol === "https:") {
    const response = await fetch(parsedUrl);
    if (!response.ok) {
      throw new Error(`Failed to fetch ${parsedUrl}: ${response.status} ${response.statusText}`);
    }
    return {
      location: parsedUrl.toString(),
      baseUrl: parsedUrl.toString(),
      data: (await response.json()) as unknown,
    };
  }

  if (parsedUrl?.protocol === "file:") {
    const absolutePath = fileURLToPath(parsedUrl);
    const rawContents = await readUtf8(absolutePath);
    return {
      location: parsedUrl.toString(),
      baseUrl: parsedUrl.toString(),
      data: JSON.parse(rawContents) as unknown,
    };
  }

  const absolutePath = path.resolve(cwd, trimmed);
  const rawContents = await readUtf8(absolutePath);
  return {
    location: absolutePath,
    baseUrl: pathToFileURL(absolutePath).toString(),
    data: JSON.parse(rawContents) as unknown,
  };
}

function parseUrl(value: string): URL | undefined {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

function resolveStartUrl(
  startUrl: string | undefined,
  baseUrl?: string,
): string | undefined {
  if (!startUrl) {
    return undefined;
  }

  if (startUrl.startsWith("http://") || startUrl.startsWith("https://")) {
    return normalizeHttpUrl(startUrl);
  }

  if (!baseUrl?.startsWith("http://") && !baseUrl?.startsWith("https://")) {
    return undefined;
  }

  return normalizeHttpUrl(new URL(startUrl, baseUrl).toString());
}

function resolveWebManifestUrl(
  manifest: JsonObject,
  baseUrl?: string,
): string | undefined {
  const explicitStartUrl =
    asString(manifest.start_url) ??
    asString(manifest.startUrl);

  const resolvedStartUrl = resolveStartUrl(explicitStartUrl, baseUrl);
  if (resolvedStartUrl) {
    return resolvedStartUrl;
  }

  if (!baseUrl?.startsWith("http://") && !baseUrl?.startsWith("https://")) {
    return undefined;
  }

  return normalizeHttpUrl(new URL("/", baseUrl).toString());
}

function resolveBubblewrapUrl(
  manifest: JsonObject,
  baseUrl?: string,
): string | undefined {
  const explicitStartUrl =
    asString(manifest.startUrl) ?? asString(manifest.start_url);

  if (explicitStartUrl?.startsWith("http://") || explicitStartUrl?.startsWith("https://")) {
    return normalizeHttpUrl(explicitStartUrl);
  }

  const host = asString(manifest.host);
  if (host) {
    const hostUrl = host.startsWith("http://") || host.startsWith("https://")
      ? host
      : `https://${host}`;
    return normalizeHttpUrl(
      new URL(explicitStartUrl ?? "/", hostUrl).toString(),
    );
  }

  return resolveStartUrl(explicitStartUrl, baseUrl);
}

function parseManifestIcons(
  value: unknown,
  baseUrl?: string,
): ManifestIcon[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const icons: ManifestIcon[] = [];
  for (const entry of value) {
    const icon = asObjectOrUndefined(entry);
    const src = resolveAssetUrl(asString(icon?.src), baseUrl);
    if (!src) {
      continue;
    }

    icons.push({
      src,
      type: asString(icon?.type),
      purpose: parsePurpose(asString(icon?.purpose)),
      sizes: parseSizes(asString(icon?.sizes)),
    });
  }

  return icons.length > 0 ? icons : undefined;
}

function resolveAssetUrl(
  value: string | undefined,
  baseUrl?: string,
): string | undefined {
  if (!value) {
    return undefined;
  }

  if (
    value.startsWith("http://") ||
    value.startsWith("https://") ||
    value.startsWith("file://")
  ) {
    return value;
  }

  if (!baseUrl) {
    return undefined;
  }

  return new URL(value, baseUrl).toString();
}

function normalizeSigning(signingKey: JsonObject | undefined): SigningConfig | undefined {
  if (!signingKey) {
    return undefined;
  }

  const keystorePath = asString(signingKey.path) ?? asString(signingKey.file);
  const keyAlias = asString(signingKey.alias);

  if (!keystorePath && !keyAlias) {
    return undefined;
  }

  return {
    keystorePath,
    keyAlias,
    storePasswordEnv: "WEB_SHELL_KEYSTORE_PASSWORD",
    keyPasswordEnv: "WEB_SHELL_KEY_PASSWORD",
  };
}

function resolveLauncherName(manifest: JsonObject): string | undefined {
  const shortName = asString(manifest.short_name) ?? asString(manifest.shortName);
  if (shortName) {
    return shortName;
  }

  const name = asString(manifest.name);
  if (!name) {
    return undefined;
  }

  return name.slice(0, BUBBLEWRAP_LAUNCHER_NAME_MAX_SIZE);
}

function asObject(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object.`);
  }
  return value as JsonObject;
}

function asObjectOrUndefined(value: unknown): JsonObject | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as JsonObject;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asPositiveInteger(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return value;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return undefined;
    }
    const parsed = Number.parseInt(trimmed, 10);
    if (Number.isInteger(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return undefined;
}

function parsePurpose(value: string | undefined): string[] {
  if (!value) {
    return [];
  }
  return value
    .split(/\s+/)
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
}

function parseSizes(value: string | undefined): number[] {
  if (!value || value === "any") {
    return [];
  }

  return value
    .split(/\s+/)
    .map((part) => {
      const [width, height] = part.toLowerCase().split("x");
      const widthValue = Number.parseInt(width ?? "", 10);
      const heightValue = Number.parseInt(height ?? "", 10);
      if (!Number.isFinite(widthValue) || !Number.isFinite(heightValue)) {
        return undefined;
      }
      return Math.max(widthValue, heightValue);
    })
    .filter((size): size is number => size !== undefined);
}
