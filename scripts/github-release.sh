#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  scripts/github-release.sh <version> [--repo owner/repo] [--upload]

Examples:
  scripts/github-release.sh v3.3.0-vasl.2
  scripts/github-release.sh v3.3.0-vasl.2 --upload
  scripts/github-release.sh v3.3.0-vasl.2 --repo shahramgit/gridman --upload

The script stages final release assets in releases/<version>/.
With --upload, it creates the GitHub release if needed and uploads assets with --clobber.
EOF
}

if [[ $# -lt 1 ]]; then
  usage
  exit 1
fi

version="$1"
shift

repo="shahramgit/gridman"
upload="false"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo)
      if [[ $# -lt 2 ]]; then
        echo "Missing value for --repo" >&2
        exit 1
      fi
      repo="$2"
      shift 2
      ;;
    --upload)
      upload="true"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage
      exit 1
      ;;
  esac
done

root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
out_dir="$root_dir/packages/bruno-electron/out"
release_dir="$root_dir/releases/$version"
asset_prefix="gridman_${version#v}_"

mkdir -p "$release_dir"

copy_assets_from() {
  local source_dir="$1"
  [[ -d "$source_dir" ]] || return 0

  find "$source_dir" -maxdepth 1 -type f \( \
    -name "${asset_prefix}*.dmg" -o \
    -name "${asset_prefix}*.exe" -o \
    -name "${asset_prefix}*.AppImage" \
  \) -print0 | while IFS= read -r -d '' asset; do
    cp -f "$asset" "$release_dir/"
  done
}

copy_assets_from "$out_dir"

echo "Release assets staged in: $release_dir"
if ! find "$release_dir" -maxdepth 1 -type f \( -name '*.dmg' -o -name '*.exe' -o -name '*.AppImage' \) | grep -q .; then
  echo "No final release assets found." >&2
  echo "Build artifacts first, then rerun this script." >&2
  exit 1
fi

find "$release_dir" -maxdepth 1 -type f \( -name '*.dmg' -o -name '*.exe' -o -name '*.AppImage' \) -print | sort | while read -r asset; do
  ls -lh "$asset"
done

linux_x64="$release_dir/${asset_prefix}x86_64_linux.AppImage"
if [[ ! -f "$linux_x64" ]]; then
  cat <<EOF

Note: Linux x64 AppImage was not found.
Electron Builder names Linux x64 as x86_64. To build it:

  npm run build:web
  cd packages/bruno-electron
  npx electron-builder --linux AppImage --x64 --config electron-builder-config.js
  cd ../..
  scripts/github-release.sh $version

EOF
fi

if [[ "$upload" != "true" ]]; then
  cat <<EOF

Dry run only. To upload:

  scripts/github-release.sh $version --repo $repo --upload

EOF
  exit 0
fi

if ! command -v gh >/dev/null 2>&1; then
  echo "GitHub CLI 'gh' is required for --upload." >&2
  exit 1
fi

if ! gh release view "$version" --repo "$repo" >/dev/null 2>&1; then
  gh release create "$version" \
    --repo "$repo" \
    --title "Gridman $version" \
    --notes "Gridman $version release."
fi

gh release upload "$version" "$release_dir"/* --repo "$repo" --clobber

echo "Uploaded release assets to $repo@$version"

