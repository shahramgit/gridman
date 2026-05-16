# Gridman CLI

Gridman keeps the Bruno `bru` CLI for running API collections from the command line.

The CLI remains compatible with Bruno collection files and is useful for CI, local smoke tests, and scripted API checks.

## Installation

From this monorepo:

```bash
npm install
npm run build --workspace=packages/bruno-cli
```

Published package naming is still inherited from Bruno for now. Internal package renaming is intentionally deferred.

## Usage

Run all requests in a collection:

```bash
bru run
```

Run one request:

```bash
bru run request.bru
```

Run a folder:

```bash
bru run folder
```

Run with an environment:

```bash
bru run folder --env Local
```

Write results to a file:

```bash
bru run folder --output results.json
```

Use a custom CA certificate:

```bash
bru run request.bru --cacert myCustomCA.pem
```

## Import

Import OpenAPI into a collection directory:

```bash
bru import openapi --source api.yml --output ~/Desktop/my-collection --collection-name "My API"
```

Import from a URL:

```bash
bru import openapi --source https://example.com/api-spec.json --output ~/Desktop --collection-name "Remote API"
```

## Support

Report Gridman CLI issues at:

https://github.com/shahramgit/gridman/issues

## License

MIT. See the repository license and notice files for Bruno attribution.
