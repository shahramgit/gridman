# Local Installation And Build Guide

This guide explains how to install dependencies, run Gridman locally, and build desktop packages.

## Prerequisites

- Node.js `v22.12.0`, as defined in `.nvmrc`
- npm
- Git
- macOS, Windows, or Linux for development

Use the repository root for all commands.

## First-Time Setup

```sh
npm run setup
```

This installs dependencies, builds shared workspace packages, and prepares runtime bundles required by the Electron app.

## Run Locally

```sh
npm run dev
```

This starts the Rsbuild renderer and the Electron desktop app.

Browser-only renderer mode is available with:

```sh
npm run dev:web
```

The full app requires Electron because workspace, filesystem, and Git features use IPC.

## Build

Build the renderer:

```sh
npm run build:web
```

Build the desktop app for the current platform:

```sh
npm run build:electron
```

Build specific targets:

```sh
npm run build:electron:mac
npm run build:electron:win
npm run build:electron:linux
```

Electron Builder configuration lives in `packages/bruno-electron/electron-builder-config.js`.

## Signing

Local development builds can be unsigned. For macOS builds without a signing certificate, use:

```sh
CSC_IDENTITY_AUTO_DISCOVERY=false npm run build:electron:mac
```

Release signing and notarization should be configured separately for the Gridman project.
