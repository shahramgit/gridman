# Gridman

Gridman is a workspace-first API client derived from [Bruno](https://github.com/usebruno/bruno).

Gridman keeps API work in ordinary folders on your filesystem. Each workspace is a visible folder, each collection lives under that workspace's `collections/` directory, and Git operations run at the workspace root.

## Why Gridman

- Workspace-owned collections: no hidden default workspace and no external collection links.
- Git-first collaboration: initialize, commit, pull, push, and sync at the workspace level.
- File-based API data: requests, collections, docs, and workspace metadata remain plain files.
- Offline-first desktop app: your API data stays on your machine unless you push it to your Git remote.

## Project Status

Gridman is a new fork and rebrand of Bruno. The codebase is actively diverging around a stricter workspace model and workspace-level Git workflows.

Use development builds carefully and keep backups of important workspaces while the project stabilizes.

## Development

Install dependencies:

```sh
npm run setup
```

Run the desktop development app:

```sh
npm run dev
```

Build the renderer:

```sh
npm run build:web
```

Build desktop packages:

```sh
npm run build:electron:mac
npm run build:electron:win
npm run build:electron:linux
```

Platform builds use Electron Builder. Cross-platform packaging can require platform-specific tools such as signing certificates, Wine, or native Git.

## Workspace Model

Gridman intentionally uses a strict workspace model:

- Workspaces are normal folders, usually under `~/Documents/gridman`.
- Collections must be stored below `<workspace>/collections/`.
- Imported collections are copied into the active workspace instead of linked from their original location.
- Deleting a collection removes the collection folder from disk.
- `workspace.yml` stores relative collection paths.

This model keeps Git behavior predictable because one repository owns one workspace.

## Git Workflow

Git is workspace-level only. Initialize Git in a workspace, connect an origin, commit workspace files, then pull or push through the Git tab.

Gridman excludes local environment files from normal Git commits by default because they may contain secrets or machine-specific values.

## Attribution

Gridman includes code derived from [Bruno](https://github.com/usebruno/bruno), originally created by Anoop M D, Anusree P S, and contributors. Bruno is distributed under the MIT License.

The Bruno name is a trademark of its owner. Gridman is an independent fork and is not affiliated with or endorsed by the Bruno project.

See [NOTICE.md](NOTICE.md) and [license.md](license.md) for attribution and license details.

## License

Gridman is distributed under the MIT License. See [license.md](license.md).
