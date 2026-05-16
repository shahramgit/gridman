# Playwright Testing Guide For Gridman

Gridman uses Playwright for end-to-end tests of the Electron desktop app.

## Run Tests

```sh
npm run test:e2e
npm run test:e2e:auth
npm run test:e2e:ssl
```

## Generate Tests

```sh
npm run test:codegen my-new-test
```

Use generated tests as a starting point, then add stable selectors and assertions.

## Notes

- Prefer testing the Electron app, not only the browser renderer.
- Workspace tests should use temporary folders.
- Collection tests should assert files are created under `<workspace>/collections/`.
- Git tests should use disposable local repositories or dedicated test remotes.
