# GitHub release workflow

This document describes how to prepare and upload Gridman release assets to GitHub.

## User download instructions

Add this section, or a version-specific variant of it, to the GitHub release notes.

Download Gridman from the release assets:

- macOS Apple Silicon: `gridman_<version>_arm64_mac.dmg`
- macOS Intel: `gridman_<version>_x64_mac.dmg`
- Windows ARM64: `gridman_<version>_arm64_win.exe`
- Windows x64: `gridman_<version>_x64_win.exe`
- Linux ARM64: `gridman_<version>_arm64_linux.AppImage`
- Linux x64: `gridman_<version>_x86_64_linux.AppImage`

For macOS, open the `.dmg`, drag `Gridman.app` to `/Applications`, then run Gridman from Applications.

Current macOS builds are unsigned. If macOS blocks the app after installation, run:

```sh
sudo xattr -dr com.apple.quarantine "/Applications/Gridman.app"
```

For Linux, make the AppImage executable before running it:

```sh
chmod +x gridman_<version>_x86_64_linux.AppImage
./gridman_<version>_x86_64_linux.AppImage
```

## Release assets

Upload only the final installer/runtime files:

- macOS: `*.dmg`
- Windows: `*_x64_win.exe`, `*_arm64_win.exe`
- Linux: `*.AppImage`

Do not upload unpacked folders, `.blockmap`, `.yml`, `.7z`, the generic `*_win.exe` combined installer, or generated intermediate files unless you intentionally add auto-update support later.

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

To stage existing build output, run:

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

To build all supported platform assets first and then stage them:

```sh
scripts/github-release.sh <version> --build
```

The `--build` mode prepares the Electron web bundle once, builds macOS `.dmg`, Windows `.exe`, Linux ARM64 `.AppImage`, and Linux x64 `.AppImage`. It copies final release assets into `releases/<version>/` after each platform build so later builds cannot remove earlier artifacts from the release folder.

## Create tag

Create and push an annotated tag:

```sh
git tag -a v3.3.0-vasl.2 -m "Gridman v3.3.0-vasl.2"
git push origin v3.3.0-vasl.2
git push vasl v3.3.0-vasl.2
```

Or let the release helper create and push the tag:

```sh
scripts/github-release.sh v3.3.0-vasl.2 --tag
```

The helper creates the annotated tag only if it does not already exist. If the tag already exists at another commit, the script stops instead of moving the tag.

## Create or upload the GitHub release

To create or update the GitHub release and upload the staged files:

```sh
scripts/github-release.sh v3.3.0-vasl.2 --upload
```

To continue a release upload after a network failure:

```sh
scripts/github-release.sh v3.3.0-vasl.2 --upload --resume
```

`--resume` is release-level resume, not byte-range resume. GitHub Releases does not support continuing a partially uploaded file from the failed byte offset. Gridman checks existing uploaded assets by GitHub `sha256` digest when available, otherwise by file size. Matching assets are skipped; missing, incomplete, or mismatched assets are uploaded again.

To build, stage, create/push the tag, create/update the GitHub release, and upload in one command:

```sh
scripts/github-release.sh v3.3.0-vasl.2 --build --tag --upload
```

By default, upload uses Gridman's progress uploader. It shows real byte progress for each final asset and replaces any existing release asset with the same filename.

To upload with limited parallelism:

```sh
scripts/github-release.sh v3.3.0-vasl.2 --upload --upload-jobs 2
```

Parallel upload is optional. Keep the default sequential upload on weak or unstable networks.

To use the simpler GitHub CLI upload path instead:

```sh
scripts/github-release.sh v3.3.0-vasl.2 --upload --simple
```

The `--simple` option uses `gh release upload --clobber` and does not show byte-level progress.
It cannot be combined with `--resume`.

The default GitHub repository is:

```text
shahramgit/gridman
```

To use another repository:

```sh
scripts/github-release.sh v3.3.0-vasl.2 --repo owner/repo --upload
```

Rerunning upload replaces existing assets with the same names. Only `.dmg`, arch-specific Windows `.exe`, and `.AppImage` files are uploaded.

## Manual upload command

If you prefer manual upload:

```sh
find releases/v3.3.0-vasl.2 -maxdepth 1 -type f \( -name '*.dmg' -o -name '*.exe' -o -name '*.AppImage' \) -print0 \
  | grep -z -Ev '_win\.exe$' \
  | xargs -0 gh release upload v3.3.0-vasl.2 --repo shahramgit/gridman
```

Use this only after checking the staged directory:

```sh
ls -lh releases/v3.3.0-vasl.2/
```
