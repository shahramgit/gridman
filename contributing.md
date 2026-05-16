# Contributing to Gridman

Gridman is a workspace-first API client derived from Bruno. Contributions should preserve the core Gridman model:

- every workspace is a normal visible folder
- every collection belongs under `<workspace>/collections/`
- Git operations run at the workspace root
- local environment and secret files should not be committed by default

## Development Setup

Use Node.js from `.nvmrc`:

```sh
nvm install
nvm use
npm run setup
```

Run the desktop app:

```sh
npm run dev
```

Build the renderer:

```sh
npm run build:web
```

## Pull Requests

- Keep pull requests focused.
- Include tests or a clear manual verification note for behavior changes.
- Avoid reintroducing hidden default workspace behavior or external collection linking.
- Preserve Bruno attribution and MIT license notices.

## Branch Names

Use short descriptive branch names:

```text
feature/workspace-import
fix/git-pull-conflicts
docs/public-readme
```
