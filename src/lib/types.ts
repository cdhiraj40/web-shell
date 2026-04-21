export interface SigningConfig {
  keystorePath?: string;
  keyAlias?: string;
  storePasswordEnv?: string;
  keyPasswordEnv?: string;
}

export interface ManifestIcon {
  src: string;
  type?: string;
  purpose: string[];
  sizes: number[];
}

export interface ManifestSeed {
  kind: "web" | "bubblewrap";
  source: string;
  webManifestUrl?: string;
  appName?: string;
  applicationId?: string;
  versionCode?: number;
  versionName?: string;
  webUrl?: string;
  themeColor?: string;
  backgroundColor?: string;
  icons?: ManifestIcon[];
  signing?: SigningConfig;
}

export interface GeneratedProjectConfig {
  schemaVersion: 1;
  generatedAt: string;
  projectName: string;
  appName: string;
  applicationId: string;
  versionCode: number;
  versionName: string;
  packageName: string;
  webUrl: string;
  source: {
    templateRepo: string;
    templateRef: string;
    webManifest?: string;
    bubblewrapManifest?: string;
  };
  signing?: SigningConfig;
}

export interface SavedProjectConfig {
  signing?: SigningConfig;
}
