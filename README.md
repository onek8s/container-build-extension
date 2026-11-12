# Container Build

Build a container image, scan it for vulnerabilities with [Trivy](https://trivy.dev) and push it to a registry.
The same code runs as a **GitHub Action** and as an **Azure DevOps** extension.

- **Minimal configuration**: the image name is the only required input.
- **Secure by default**: the image is scanned *before* it is pushed; vulnerable images never reach the registry.
- **Sensible tags**: short commit SHA, plus `latest` on `main`/`master`, the git tag (`v1.2.3` and `1.2.3`) on tag builds, `pr-<n>` for pull requests or the branch name.
- **No push for pull requests** by default (`push: auto`).
- **Zero runtime dependencies**: each platform gets a single bundled JavaScript file.

## GitHub Actions

Push to GitHub Container Registry needs no credentials at all:

```yaml
permissions:
  contents: read
  packages: write

steps:
  - uses: actions/checkout@v4
  - uses: onek8s/container-build-extension@v0
    with:
      image: ghcr.io/${{ github.repository }}
```

Any other registry:

```yaml
  - uses: onek8s/container-build-extension@v0
    with:
      image: myacr.azurecr.io/my-app
      username: ${{ secrets.REGISTRY_USERNAME }}
      password: ${{ secrets.REGISTRY_PASSWORD }}
```

If you already log in with another step (for example `azure/login` + `az acr login`, or `docker/login-action`), just omit `username`/`password`.

## Azure Pipelines

Install the extension, then:

```yaml
steps:
  - task: ContainerBuild@0
    inputs:
      image: myacr.azurecr.io/my-app
      containerRegistry: my-acr-connection
```

`containerRegistry` is a *Docker Registry* service connection (username/password, or Azure Container Registry with a
service principal). For workload identity federation / managed identity, log in with `AzureCLI@2` (`az acr login -n myacr`)
in a previous step and omit `containerRegistry`.

Output variables are available as `$(<stepName>.digest)` etc. when the step has a `name:`.

## Inputs

GitHub uses `kebab-case` names, Azure DevOps uses `camelCase` names.

| GitHub | Azure DevOps | Default | Description |
|---|---|---|---|
| `image` | `image` | **required** | Image name including registry, e.g. `ghcr.io/owner/app`. Lower-cased automatically. |
| `username` / `password` | `containerRegistry` | | Registry credentials. On GitHub, `ghcr.io` uses `github-token` automatically. If not set, an existing `docker login` is used. |
| `tags` | `tags` | automatic | Comma or newline separated tags. |
| `context` | `context` | `.` | Build context. |
| `dockerfile` | `dockerfile` | `<context>/Dockerfile` | Dockerfile path. |
| `build-args` | `buildArgs` | | Newline separated `KEY=VALUE` build arguments. |
| `target` | `target` | | Target build stage. |
| `push` | `push` | `auto` | `auto` (push unless pull request), `true` or `false`. |
| `scan` | `scan` | `true` | Scan with Trivy before pushing. |
| `severity` | `severity` | `CRITICAL,HIGH` | Severities to report. |
| `fail-on-vulnerabilities` | `failOnVulnerabilities` | `true` | Fail and skip the push when vulnerabilities are found. |
| `ignore-unfixed` | `ignoreUnfixed` | `true` | Ignore vulnerabilities without an available fix. |
| `trivy-version` | `trivyVersion` | pinned | Trivy version, or a full scanner image reference (e.g. an internal mirror). |

To accept specific vulnerabilities, list their IDs in a `.trivyignore` file in the build context or repository root.

## Outputs

| GitHub | Azure DevOps | Description |
|---|---|---|
| `image` | `image` | Image repository |
| `tags` | `tags` | Comma separated full image references |
| `digest` | `digest` | Digest of the pushed image |
| `image-ref` | `imageRef` | Immutable reference `image@sha256:...` (use this for deployments) |
| `vulnerabilities` | `vulnerabilities` | Number of vulnerabilities found |
| `scan-report` | `scanReport` | Path to the Trivy JSON report |

## Requirements

A Linux agent/runner with Docker (GitHub-hosted `ubuntu-*` runners and Microsoft-hosted `ubuntu-*` agents work out of the box).
Trivy runs as a container (`ghcr.io/aquasecurity/trivy`), so nothing else has to be installed. Proxy settings
(`HTTPS_PROXY`, ...) and a custom CA bundle (`SSL_CERT_FILE` or `NODE_EXTRA_CA_CERTS`) are passed on to the scanner.

## How it works

```
src/core/      shared logic: inputs, tagging, docker build/login/push, Trivy scan, summary
src/github/    GitHub Actions adapter (inputs, outputs, masking, step summary)
src/azure/     Azure Pipelines adapter (inputs, service connections, output variables, build summary)
```

Both adapters implement the small `Platform` interface in `src/core/platform.ts`; everything else is shared.
The adapters speak the platforms' workflow/logging command protocols directly, so no SDKs are bundled.

## Development

```bash
npm ci
npm run check            # typecheck + unit tests + build
npm run package:azure    # build the .vsix into dist-azure/
```

`dist/index.js` (used by the GitHub Action) is committed and CI checks it is up to date, so run `npm run build` before committing.

### Releasing

1. Bump `version` in `package.json` and run `npm run build` (syncs the Azure task and extension versions).
2. Merge to `main`, then push a tag `vX.Y.Z`. The release workflow creates a GitHub release with the `.vsix`,
   moves the `vX` major tag for the action, and publishes to the Visual Studio Marketplace if the
   `AZURE_DEVOPS_MARKETPLACE_TOKEN` secret is configured.
