# Solana Mobile Web Shell

Solana Mobile Web Shell is a Command Line Interface (CLI) that helps developers generate an Android app project that wraps an existing web app or website inside an Android WebView.

## Why

Browsers are rolling out Local Network Access restrictions that can break wallet association flows on Android web, especially flows that rely on local network or loopback communication.

Android web apps and native app wrappers that use Custom Chrome Tabs, including Bubblewrap-style APKs, can be affected by this change.

Solana Mobile Web Shell exists to work around those browser-side restrictions by moving the app into an Android WebView shell while preserving Solana Mobile wallet flows.

References:
- https://developer.chrome.com/blog/local-network-access
- https://github.com/WICG/local-network-access

## What It Does

- generates an Android project for wrapping an existing web app, website, or PWA
- keeps in-scope navigation inside the app and opens out-of-scope links in the system browser
- intercepts `solana-wallet://` and related wallet handoff flows natively
- supports app name, application ID, icons, splash branding, signing metadata, and Android version configuration
- accepts both standard web `manifest.json` files and Bubblewrap-style `twa-manifest.json` files

## Install

```bash
npm install -g @solana-mobile/webshell-cli
```

## Commands

```bash
webshell init ./my-app --manifest https://example.com/manifest.json
webshell init ./my-app --manifest ./twa-manifest.json
webshell init ./my-app --version-code 12 --version-name 1.2.0
webshell build ./my-app
webshell doctor ./my-app --fix
```

## Supported Input

- standard web `manifest.json`
- Bubblewrap-style `twa-manifest.json`
- direct website URL overrides through `--url`

The CLI reuses compatible metadata such as app name, start URL, package ID, signing key path, icons, and theme colors. It always generates an Android WebView shell project, not a Trusted Web Activity.

## Toolchain Setup

- `build` always runs the same preflight as `doctor --fix`
- the CLI checks for:
  - Gradle wrapper in the generated project
  - JDK 17+
  - Android SDK directory
  - Android command-line tools / `sdkmanager`
  - required SDK packages:
    - `platform-tools`
    - `platforms;android-36`
    - `build-tools;36.0.0`
- if the Android command-line tools or SDK packages are missing, the CLI installs them automatically before building
- if no usable JDK is found, the CLI attempts to install a managed JDK 17 locally under `~/.webshell`

## Signing Flow

- `init` prompts for a signing keystore path and key alias
- `init` also captures Android version code and version name
- if the keystore file does not exist yet, `init` creates it and persists only the keystore path and alias into `twa-manifest.json`
- `build` uses that saved signing metadata
- passwords are never persisted
- password resolution order is:
  - `WEB_SHELL_KEYSTORE_PASSWORD` / `WEB_SHELL_KEY_PASSWORD`
  - hidden interactive prompts during `build`

## Temporary Compatibility Note

This CLI does not install or update the JavaScript wallet adapter packages used by the website loaded inside the shell.

For Web Shell support, teams should use a Web Shell-capable Solana Mobile wallet adapter canary or a later compatible release. The current minimum known-good baseline for this repo is:

- https://www.npmjs.com/package/@solana-mobile/wallet-adapter-mobile/v/0.0.0-canary-20260331201049

Older releases may ignore Web Shell behavior in WebView. Replace this note once the same support is available in a stable upstream release.

## Development

```bash
npm install
npm run build
npm run check
npm test
```
