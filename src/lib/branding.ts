import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ManifestIcon, ManifestSeed } from "./types.js";

const DEFAULT_SPLASH_BACKGROUND = "#3DDC84";
const DEFAULT_ICON_BACKGROUND = "#3DDC84";
const FOREGROUND_RESOURCE_NAME = "ic_launcher_foreground_inner";
const SUPPORTED_ICON_EXTENSIONS = new Set(["png", "webp", "jpg", "jpeg"]);

export async function applyProjectBranding(
  projectDirectory: string,
  manifestSeed?: ManifestSeed,
): Promise<void> {
  const splashBackground =
    normalizeAndroidColor(manifestSeed?.backgroundColor) ??
    normalizeAndroidColor(manifestSeed?.themeColor) ??
    DEFAULT_SPLASH_BACKGROUND;
  const iconBackground =
    normalizeAndroidColor(manifestSeed?.themeColor) ??
    normalizeAndroidColor(manifestSeed?.backgroundColor) ??
    DEFAULT_ICON_BACKGROUND;

  await writeColors(projectDirectory, splashBackground, iconBackground);
  await writeLauncherBackground(projectDirectory);

  const selectedIcon = selectPreferredManifestIcon(manifestSeed?.icons);
  if (!selectedIcon) {
    return;
  }

  const downloadedIcon = await downloadManifestIconSafely(selectedIcon.src);
  if (!downloadedIcon) {
    console.warn(
      `Warning: Failed to import manifest icon ${selectedIcon.src}. Using the default Android launcher icon instead.`,
    );
    return;
  }

  await writeLauncherForeground(projectDirectory, downloadedIcon.extension);
  await clearPreviousForegroundAssets(projectDirectory, downloadedIcon.extension);

  const drawableNodpiDirectory = path.join(
    projectDirectory,
    "app",
    "src",
    "main",
    "res",
    "drawable-nodpi",
  );
  await mkdir(drawableNodpiDirectory, { recursive: true });
  await writeFile(
    path.join(drawableNodpiDirectory, `${FOREGROUND_RESOURCE_NAME}.${downloadedIcon.extension}`),
    downloadedIcon.buffer,
  );
}

function selectPreferredManifestIcon(
  icons: ManifestIcon[] | undefined,
): ManifestIcon | undefined {
  if (!icons?.length) {
    return undefined;
  }

  const rankedIcons = [...icons]
    .filter((icon) => isSupportedIconSource(icon.src, icon.type))
    .sort((left, right) => {
      const purposeDelta = purposeScore(right.purpose) - purposeScore(left.purpose);
      if (purposeDelta !== 0) {
        return purposeDelta;
      }

      return largestDeclaredSize(right.sizes) - largestDeclaredSize(left.sizes);
    });

  return rankedIcons[0];
}

function purposeScore(purpose: string[]): number {
  // Adaptive icons and the native splash screen both crop the foreground asset,
  // so prefer maskable artwork when it is available.
  if (purpose.includes("maskable")) {
    return 2;
  }
  if (purpose.length === 0 || purpose.includes("any")) {
    return 1;
  }
  return 0;
}

function largestDeclaredSize(sizes: number[]): number {
  return sizes.reduce((largest, size) => Math.max(largest, size), 0);
}

function isSupportedIconSource(source: string, type?: string): boolean {
  if (source.startsWith("data:")) {
    return false;
  }

  const extension = detectImageExtension(source, type);
  return extension !== undefined;
}

async function downloadManifestIcon(
  source: string,
): Promise<{ buffer: Buffer; extension: string } | undefined> {
  if (source.startsWith("file://")) {
    const extension = detectImageExtension(source);
    if (!extension) {
      return undefined;
    }

    return {
      buffer: await readFile(fileURLToPath(source)),
      extension,
    };
  }

  if (source.startsWith("http://") || source.startsWith("https://")) {
    const response = await fetch(source);
    if (!response.ok) {
      throw new Error(`Failed to fetch manifest icon ${source}: ${response.status} ${response.statusText}`);
    }

    const extension = detectImageExtension(source, response.headers.get("content-type") ?? undefined);
    if (!extension) {
      return undefined;
    }

    return {
      buffer: Buffer.from(await response.arrayBuffer()),
      extension,
    };
  }

  return undefined;
}

async function downloadManifestIconSafely(
  source: string,
): Promise<{ buffer: Buffer; extension: string } | undefined> {
  try {
    return await downloadManifestIcon(source);
  } catch (error) {
    if (error instanceof Error) {
      console.warn(`Warning: ${error.message}`);
      return undefined;
    }
    throw error;
  }
}

function detectImageExtension(
  source: string,
  type?: string,
): string | undefined {
  const normalizedType = type?.toLowerCase();
  if (normalizedType) {
    if (normalizedType.includes("png")) {
      return "png";
    }
    if (normalizedType.includes("webp")) {
      return "webp";
    }
    if (normalizedType.includes("jpeg") || normalizedType.includes("jpg")) {
      return "jpg";
    }
  }

  const withoutQuery = source.split("?")[0]?.split("#")[0] ?? source;
  const extension = path.extname(withoutQuery).replace(".", "").toLowerCase();
  if (SUPPORTED_ICON_EXTENSIONS.has(extension)) {
    return extension;
  }

  return undefined;
}

async function writeColors(
  projectDirectory: string,
  splashBackground: string,
  iconBackground: string,
): Promise<void> {
  const colorsPath = path.join(
    projectDirectory,
    "app",
    "src",
    "main",
    "res",
    "values",
    "colors.xml",
  );
  const contents = `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <color name="launcher_icon_background">${iconBackground}</color>
    <color name="splash_background">${splashBackground}</color>
    <color name="black">#FF000000</color>
    <color name="white">#FFFFFFFF</color>
</resources>
`;
  await writeFile(colorsPath, contents, "utf8");
}

async function writeLauncherBackground(projectDirectory: string): Promise<void> {
  const backgroundPath = path.join(
    projectDirectory,
    "app",
    "src",
    "main",
    "res",
    "drawable",
    "ic_launcher_background.xml",
  );
  const contents = `<?xml version="1.0" encoding="utf-8"?>
<shape xmlns:android="http://schemas.android.com/apk/res/android" android:shape="rectangle">
    <solid android:color="@color/launcher_icon_background" />
</shape>
`;
  await writeFile(backgroundPath, contents, "utf8");
}

async function writeLauncherForeground(
  projectDirectory: string,
  extension: string,
): Promise<void> {
  const foregroundXmlPath = path.join(
    projectDirectory,
    "app",
    "src",
    "main",
    "res",
    "drawable",
    "ic_launcher_foreground.xml",
  );
  const contents = `<?xml version="1.0" encoding="utf-8"?>
<inset xmlns:android="http://schemas.android.com/apk/res/android"
    android:drawable="@drawable/${FOREGROUND_RESOURCE_NAME}"
    android:insetBottom="18dp"
    android:insetLeft="18dp"
    android:insetRight="18dp"
    android:insetTop="18dp" />
`;
  await writeFile(foregroundXmlPath, contents, "utf8");

  const foregroundAssetDirectory = path.join(
    projectDirectory,
    "app",
    "src",
    "main",
    "res",
    "drawable-nodpi",
  );
  await mkdir(foregroundAssetDirectory, { recursive: true });

  for (const candidateExtension of SUPPORTED_ICON_EXTENSIONS) {
    if (candidateExtension === extension) {
      continue;
    }
    await rm(
      path.join(foregroundAssetDirectory, `${FOREGROUND_RESOURCE_NAME}.${candidateExtension}`),
      { force: true },
    );
  }
}

async function clearPreviousForegroundAssets(
  projectDirectory: string,
  currentExtension: string,
): Promise<void> {
  const drawableNodpiDirectory = path.join(
    projectDirectory,
    "app",
    "src",
    "main",
    "res",
    "drawable-nodpi",
  );
  await mkdir(drawableNodpiDirectory, { recursive: true });
  const entries = await readdir(drawableNodpiDirectory);
  await Promise.all(
    entries
      .filter(
        (entry) =>
          entry.startsWith(`${FOREGROUND_RESOURCE_NAME}.`) &&
          !entry.endsWith(`.${currentExtension}`),
      )
      .map((entry) => rm(path.join(drawableNodpiDirectory, entry), { force: true })),
  );
}

function normalizeAndroidColor(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  const trimmed = value.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(trimmed) || /^#[0-9a-fA-F]{8}$/.test(trimmed)) {
    return trimmed.toUpperCase();
  }
  if (/^#[0-9a-fA-F]{3}$/.test(trimmed)) {
    const [red, green, blue] = trimmed.slice(1).split("");
    return `#${red}${red}${green}${green}${blue}${blue}`.toUpperCase();
  }
  if (/^#[0-9a-fA-F]{4}$/.test(trimmed)) {
    const [alpha, red, green, blue] = trimmed.slice(1).split("");
    return `#${alpha}${alpha}${red}${red}${green}${green}${blue}${blue}`.toUpperCase();
  }

  return undefined;
}
