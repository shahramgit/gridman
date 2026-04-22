# Local Installation and Build Guide

This guide explains how to install dependencies, run Bruno locally, test the renderer in a browser, and create a macOS DMG build from this repository.

## Prerequisites

- macOS, Linux, or Windows for development.
- macOS is required for reliable macOS DMG signing/notarization.
- Node.js `v22.12.0`, as defined in `.nvmrc`.
- npm.

Use the repository root for all commands:

```sh
cd /Users/shahramra/Documents/Projects/vasl/bruno
```

If you use `nvm`:

```sh
nvm install
nvm use
```

## First-Time Setup

Run setup once after cloning the repository, or after deleting `node_modules`:

```sh
npm run setup
```

This command:

- installs dependencies with `npm install --legacy-peer-deps`
- builds shared workspace packages
- builds GraphQL docs
- builds the request/runtime packages
- bundles the Bruno JavaScript sandbox libraries

The sandbox bundle is required by the Electron dev app. If it is missing, `npm run dev` can fail.

## Run Bruno Locally

After setup has completed, start the local development app:

```sh
npm run dev
```

This starts:

- the React/Rsbuild renderer dev server from `packages/bruno-app`
- the Electron app from `packages/bruno-electron`

The root dev script detects the renderer dev-server port and passes it to Electron with `BRUNO_DEV_PORT`.

For normal day-to-day development, `npm run dev` is usually enough after the first successful `npm run setup`.

## Browser-Only Renderer Test

To start only the renderer:

```sh
npm run dev:web
```

Open:

```text
http://localhost:3000
```

Important: Bruno is designed to run inside Electron. In a normal browser, the app does not have `window.ipcRenderer`, so it will show an error screen. Browser-only mode is useful for checking that the web bundle starts, but it is not a full app test.

## Automated E2E Tests

Run the default Playwright tests:

```sh
npm run test:e2e
```

This starts:

- the renderer dev server
- the test API server from `packages/bruno-tests`
- Playwright tests from `tests/`

Other test projects:

```sh
npm run test:e2e:auth
npm run test:e2e:ssl
```

## Build the Renderer

Before packaging Electron, build the renderer:

```sh
npm run build:web
```

This creates:

```text
packages/bruno-app/dist
```

The Electron build scripts copy this folder into:

```text
packages/bruno-electron/web
```

## Build for the Current OS

To build for the OS you are currently running:

```sh
npm run build:electron
```

This command auto-detects the platform:

- macOS builds the mac target
- Windows builds the Windows target
- Linux builds the Linux target

It does not build all operating systems.

## Build a macOS DMG

From macOS, run:

```sh
npm run build:web
CSC_IDENTITY_AUTO_DISCOVERY=false npm run build:electron:mac
```

The unsigned local build output appears in:

```text
packages/bruno-electron/out
```

The macOS Electron Builder config can create:

- `.dmg`
- `.pkg`
- `.zip`

for:

- `x64`
- `arm64`

The `CSC_IDENTITY_AUTO_DISCOVERY=false` setting disables automatic certificate discovery. Use it when you do not have the upstream Bruno Apple Developer signing certificate.

## Build Specific Targets

Use these root scripts:

```sh
npm run build:electron:mac
npm run build:electron:win
npm run build:electron:linux
npm run build:electron:deb
npm run build:electron:rpm
npm run build:electron:snap
```

The target package formats are configured in:

```text
packages/bruno-electron/electron-builder-config.js
```

## Build a Windows Installer from macOS

The default Windows target builds both `x64` and `arm64`:

```sh
CSC_IDENTITY_AUTO_DISCOVERY=false npm run build:electron:win
```

On Apple Silicon macOS, this can fail during the combined NSIS installer step:

```text
makensis process failed ERR_ELECTRON_BUILDER_CANNOT_EXECUTE
```

For a reliable local Windows build from macOS, build `x64` only:

```sh
NSISDIR=/Users/shahramra/Library/Caches/electron-builder/nsis/nsis-3.0.4.1 \
CSC_IDENTITY_AUTO_DISCOVERY=false \
npx electron-builder --win nsis --x64 --config electron-builder-config.js
```

If Electron Builder has not downloaded NSIS yet, run the normal Windows build once first so the cache exists.

The successful output is:

```text
packages/bruno-electron/out/bruno_2.0.0_x64_win.exe
```

This file should identify as:

```text
PE32 executable (GUI) Intel 80386, for MS Windows, Nullsoft Installer self-extracting archive
```

For full `x64` plus `arm64` Windows packaging, prefer a Windows machine or Windows CI runner.

### Exclude Local Scratch Folders

Electron Builder packages files from `packages/bruno-electron` using a broad include rule:

```js
files: ['**/*']
```

Any untracked local folder inside `packages/bruno-electron` can be included in the final installer. For example, a local `packages/bruno-electron/all/` folder can make `app.asar` and the Windows installer much larger than expected.

To exclude that folder without deleting it:

```sh
NSISDIR=/Users/shahramra/Library/Caches/electron-builder/nsis/nsis-3.0.4.1 \
CSC_IDENTITY_AUTO_DISCOVERY=false \
npx electron-builder --win nsis --x64 --config electron-builder-config.js --config.files='**/*' --config.files='!all{,/**/*}'
```

Expected local result from this repository state:

```text
packages/bruno-electron/out/bruno_2.0.0_x64_win.exe
```

Approximate size after excluding `all/`:

```text
110M
```

## Build Version in Artifact Names

Electron Builder gets the app version from:

```text
packages/bruno-electron/package.json
```

The artifact name uses:

```text
${name}_${version}_${arch}_${os}.${ext}
```

If `packages/bruno-electron/package.json` contains:

```json
"version": "2.0.0"
```

then the local DMG name will include `2.0.0`, even if the Git tag or public release is newer.

To create local artifacts named `3.2.2`, update the package versions before building:

```sh
npm pkg set version=3.2.2 --workspace=packages/bruno-electron
npm pkg set version=3.2.2 --workspace=packages/bruno-app
npm run build:web
CSC_IDENTITY_AUTO_DISCOVERY=false npm run build:electron:mac
```

Only change versions intentionally, because this modifies tracked files.

## Output Locations

Renderer build:

```text
packages/bruno-app/dist
```

Prepared Electron renderer copy:

```text
packages/bruno-electron/web
```

Packaged desktop artifacts:

```text
packages/bruno-electron/out
```

## Common Commands

Fresh setup and run:

```sh
npm run setup
npm run dev
```

Run after setup already succeeded:

```sh
npm run dev
```

Browser-only renderer smoke test:

```sh
npm run dev:web
```

Build unsigned macOS DMG:

```sh
npm run build:web
CSC_IDENTITY_AUTO_DISCOVERY=false npm run build:electron:mac
```
