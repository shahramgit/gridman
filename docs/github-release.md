# GitHub release workflow

This document describes how to prepare and upload Gridman release assets to GitHub.

## Release assets

Upload only the final installer/runtime files:

- macOS: `*.dmg`
- Windows: `*.exe`
- Linux: `*.AppImage`

Do not upload unpacked folders, `.blockmap`, `.yml`, `.7z`, or generated intermediate files unless you intentionally add auto-update support later.

## macOS unsigned app note

Current macOS builds are not signed with an Apple Developer ID. After dragging `Gridman.app` into `/Applications`, macOS may block launch because the app is quarantined.

Users can remove the quarantine flag with:

```sh
sudo xattr -dr com.apple.quarantine "/Applications/Gridman.app"
```

This should be included in the GitHub release notes until Gridman has a valid signed and notarized macOS build.

## Output directories

Electron Builder writes platform builds to:

```sh
packages/bruno-electron/out
```

That folder can be cleaned or overwritten by the next platform build. After each platform build, copy the final artifacts into:

```sh
releases/<version>/
```

The `releases/` directory is ignored by Git and is only a local staging area.

## Build commands

Start from a clean `main` branch:

```sh
git checkout main
git pull origin main
git status
```

Build the web app before each Electron build:

```sh
npm run build:web
```

macOS:

```sh
CSC_IDENTITY_AUTO_DISCOVERY=false npm run build:electron:mac
```

Windows:

```sh
CSC_IDENTITY_AUTO_DISCOVERY=false npm run build:electron:win
```

Linux ARM64 AppImage:

```sh
npm run build:electron:linux
```

Linux x64 AppImage:

```sh
cd packages/bruno-electron
npx electron-builder --linux AppImage --x64 --config electron-builder-config.js
cd ../..
```

Important: Electron Builder names Linux x64 as `x86_64`, not `x64`. The expected Linux x64 file name is:

```text
gridman_<version>_x86_64_linux.AppImage
```

not:

```text
gridman_<version>_x64_linux.AppImage
```

## Stage final artifacts

After each build, run:

```sh
scripts/github-release.sh <version>
```

Example:

```sh
scripts/github-release.sh v3.3.0-vasl.2
```

The script copies matching final artifacts from `packages/bruno-electron/out` into:

```sh
releases/v3.3.0-vasl.2/
```

It also keeps any final artifacts already present in that directory.

## Create tag

Create and push an annotated tag:

```sh
git tag -a v3.3.0-vasl.2 -m "Gridman v3.3.0-vasl.2"
git push origin v3.3.0-vasl.2
git push vasl v3.3.0-vasl.2
```

## Create or upload the GitHub release

To create or update the GitHub release and upload the staged files:

```sh
scripts/github-release.sh v3.3.0-vasl.2 --upload
```

The default GitHub repository is:

```text
shahramgit/gridman
```

To use another repository:

```sh
scripts/github-release.sh v3.3.0-vasl.2 --repo owner/repo --upload
```

The script uses `gh release upload --clobber`, so rerunning it replaces existing assets with the same names.

## Manual upload command

If you prefer manual upload:

```sh
gh release upload v3.3.0-vasl.2 releases/v3.3.0-vasl.2/* --repo shahramgit/gridman
```

Use this only after checking the staged directory:

```sh
ls -lh releases/v3.3.0-vasl.2/
```
