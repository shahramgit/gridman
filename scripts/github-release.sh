#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  scripts/github-release.sh <version> [--repo owner/repo] [--build] [--tag] [--upload] [--resume] [--simple] [--upload-jobs 1|2]

Examples:
  scripts/github-release.sh v3.3.0-vasl.2
  scripts/github-release.sh v3.3.0-vasl.2 --build
  scripts/github-release.sh v3.3.0-vasl.2 --tag
  scripts/github-release.sh v3.3.0-vasl.2 --upload
  scripts/github-release.sh v3.3.0-vasl.2 --upload --resume
  scripts/github-release.sh v3.3.0-vasl.2 --upload --simple
  scripts/github-release.sh v3.3.0-vasl.2 --upload --upload-jobs 2
  scripts/github-release.sh v3.3.0-vasl.2 --build --tag --upload
  scripts/github-release.sh v3.3.0-vasl.2 --repo shahramgit/gridman --build --tag --upload

The script stages final release assets in releases/<version>/.
With --build, it builds macOS, Windows, Linux ARM64, and Linux x64 assets first.
With --tag, it creates an annotated Git tag if missing and pushes it to origin and vasl.
With --upload, it creates the GitHub release if needed and uploads assets with progress.
With --resume, upload skips existing matching assets and uploads missing/mismatched assets.
With --simple, upload uses gh release upload --clobber instead of the progress uploader.
EOF
}

if [[ $# -eq 1 && ( "$1" == "-h" || "$1" == "--help" ) ]]; then
  usage
  exit 0
fi

if [[ $# -lt 1 ]]; then
  usage
  exit 1
fi

version="$1"
shift

repo="shahramgit/gridman"
upload="false"
build="false"
tag="false"
simple="false"
resume="false"
upload_jobs="1"
upload_jobs_was_set="false"

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
    --simple)
      simple="true"
      shift
      ;;
    --resume)
      resume="true"
      shift
      ;;
    --upload-jobs)
      if [[ $# -lt 2 ]]; then
        echo "Missing value for --upload-jobs" >&2
        exit 1
      fi
      upload_jobs="$2"
      upload_jobs_was_set="true"
      shift 2
      ;;
    --build)
      build="true"
      shift
      ;;
    --tag)
      tag="true"
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

if [[ "$upload_jobs" != "1" && "$upload_jobs" != "2" ]]; then
  echo "--upload-jobs must be 1 or 2." >&2
  exit 1
fi

if [[ "$simple" == "true" && "$upload" != "true" ]]; then
  echo "--simple can only be used together with --upload." >&2
  exit 1
fi

if [[ "$resume" == "true" && "$upload" != "true" ]]; then
  echo "--resume can only be used together with --upload." >&2
  exit 1
fi

if [[ "$simple" == "true" && "$upload_jobs_was_set" == "true" ]]; then
  echo "--upload-jobs cannot be combined with --simple." >&2
  exit 1
fi

if [[ "$simple" == "true" && "$resume" == "true" ]]; then
  echo "--resume cannot be combined with --simple." >&2
  exit 1
fi

root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
out_dir="$root_dir/packages/bruno-electron/out"
release_dir="$root_dir/releases/$version"
asset_prefix="gridman_${version#v}_"
electron_dir="$root_dir/packages/bruno-electron"
electron_web_dir="$electron_dir/web"
app_dist_dir="$root_dir/packages/bruno-app/dist"
progress_uploader="$root_dir/scripts/github-release-upload.js"

mkdir -p "$release_dir"

run_cmd() {
  echo
  echo "==> $*"
  "$@"
}

list_release_assets() {
  if has_release_assets; then
    find_release_assets | sort | while read -r asset; do
      ls -lh "$asset"
    done
  else
    echo "No release assets currently staged in: $release_dir"
  fi
}

is_final_release_asset() {
  local asset="$1"
  local name
  name="$(basename "$asset")"

  case "$name" in
    "${asset_prefix}x64_win.exe"|\
    "${asset_prefix}arm64_win.exe"|\
    "${asset_prefix}"*".dmg"|\
    "${asset_prefix}"*".AppImage")
      return 0
      ;;
    "${asset_prefix}"*"_win.exe")
      return 1
      ;;
    *)
      return 1
      ;;
  esac
}

find_release_assets() {
  find "$release_dir" -maxdepth 1 -type f \( -name '*.dmg' -o -name '*.exe' -o -name '*.AppImage' \) -print | while read -r asset; do
    if is_final_release_asset "$asset"; then
      printf '%s\n' "$asset"
    fi
  done
}

has_release_assets() {
  [[ -n "$(find_release_assets)" ]]
}

get_release_assets() {
  find_release_assets | sort | while IFS= read -r asset; do
    printf '%s\0' "$asset"
  done
}

ensure_git_tag() {
  local head_sha
  head_sha="$(git -C "$root_dir" rev-parse HEAD)"

  if git -C "$root_dir" rev-parse -q --verify "refs/tags/$version" >/dev/null; then
    local tag_sha
    tag_sha="$(git -C "$root_dir" rev-list -n 1 "$version")"
    if [[ "$tag_sha" != "$head_sha" ]]; then
      echo "Tag $version already exists at $tag_sha, but HEAD is $head_sha." >&2
      echo "Refusing to move an existing release tag." >&2
      exit 1
    fi
    echo "Tag $version already exists at HEAD."
  else
    run_cmd git -C "$root_dir" tag -a "$version" -m "Gridman $version"
  fi

  run_cmd git -C "$root_dir" push origin "$version"
  if git -C "$root_dir" remote get-url vasl >/dev/null 2>&1; then
    run_cmd git -C "$root_dir" push vasl "$version"
  else
    echo "Remote 'vasl' is not configured; skipping internal tag push."
  fi
}

copy_assets_from() {
  local source_dir="$1"
  [[ -d "$source_dir" ]] || return 0

  find "$source_dir" -maxdepth 1 -type f \( \
    -name "${asset_prefix}*.dmg" -o \
    -name "${asset_prefix}*.exe" -o \
    -name "${asset_prefix}*.AppImage" \
  \) -print0 | while IFS= read -r -d '' asset; do
    if is_final_release_asset "$asset"; then
      cp -f "$asset" "$release_dir/"
    fi
  done
}

prepare_electron_web() {
  rm -rf "$electron_web_dir"
  mkdir -p "$electron_web_dir"

  run_cmd npm run build:web

  if [[ ! -f "$app_dist_dir/index.html" ]]; then
    echo "Renderer build did not create $app_dist_dir/index.html" >&2
    exit 1
  fi

  cp -R "$app_dist_dir"/. "$electron_web_dir"/

  if [[ ! -f "$electron_web_dir/index.html" ]]; then
    echo "Electron package is missing $electron_web_dir/index.html" >&2
    exit 1
  fi

  find "$electron_web_dir" -name '*.map' -type f -delete
}

build_release_assets() {
  echo "Existing release assets before build:"
  list_release_assets

  rm -rf "$out_dir"
  prepare_electron_web

  (
    cd "$electron_dir"
    export CSC_IDENTITY_AUTO_DISCOVERY=false
    run_cmd npx electron-builder --mac --x64 --arm64 --config electron-builder-config.js
    copy_assets_from "$out_dir"

    run_cmd npx electron-builder --win --x64 --arm64 --config electron-builder-config.js
    copy_assets_from "$out_dir"

    run_cmd npx electron-builder --linux AppImage --arm64 --config electron-builder-config.js
    copy_assets_from "$out_dir"

    run_cmd npx electron-builder --linux AppImage --x64 --config electron-builder-config.js
    copy_assets_from "$out_dir"
  )
}

if [[ "$build" == "true" ]]; then
  build_release_assets
fi

if [[ "$tag" == "true" ]]; then
  ensure_git_tag
fi

copy_assets_from "$out_dir"

echo "Release assets staged in: $release_dir"
if ! has_release_assets; then
  echo "No final release assets found." >&2
  echo "Build artifacts first, then rerun this script." >&2
  exit 1
fi

list_release_assets

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
  scripts/github-release.sh $version --repo $repo --upload --resume
  scripts/github-release.sh $version --repo $repo --upload --simple
  scripts/github-release.sh $version --repo $repo --upload --upload-jobs 2
  scripts/github-release.sh $version --repo $repo --build --tag --upload

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

release_assets=()
while IFS= read -r -d '' asset; do
  release_assets+=("$asset")
done < <(get_release_assets)

if [[ "$simple" == "true" ]]; then
  gh release upload "$version" "${release_assets[@]}" --repo "$repo" --clobber
else
  uploader_args=(--repo "$repo" --tag "$version" --jobs "$upload_jobs")
  if [[ "$resume" == "true" ]]; then
    uploader_args+=(--resume)
  fi
  uploader_args+=(--assets "${release_assets[@]}")
  node "$progress_uploader" "${uploader_args[@]}"
fi

echo "Uploaded release assets to $repo@$version"
