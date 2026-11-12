# Container Build

Build a container image with supply chain protection, generate an SBOM, scan it for vulnerabilities with
[Trivy](https://trivy.dev) and push it to a registry.
The same code runs as a **GitHub Action** and as an **Azure DevOps** extension.

```
build (package installs protected by Aikido Safe Chain) → SBOM → vulnerability scan → push
```

- **Zero configuration**: the image name is derived from the source (`<registry>/<owner|project>/<repository>`),
  and the registry and its credentials can be configured once for the whole organization or project.
- **Secure by default**: the image is scanned *before* it is pushed; vulnerable images never reach the registry.
- **Malware protection during the build**: `npm`, `yarn`, `pnpm`, `bun`, `pip`, `uv`, `poetry`, ... in your Dockerfile's
  `RUN` instructions run through [Aikido Safe Chain](https://github.com/AikidoSec/safe-chain), without changing your Dockerfile.
- **SBOM** (CycloneDX or SPDX) for every image.
- **Sensible tags**: short commit SHA, plus `latest` on `main`/`master`, the git tag (`v1.2.3` and `1.2.3`) on tag builds, `pr-<n>` for pull requests or the branch name.
- **No push for pull requests** by default (`push: auto`).
- **Zero runtime dependencies**: each platform gets a single bundled JavaScript file.

## Image naming

When `image` is not set, the image name is derived from the source repository:

| Platform | Image name |
|---|---|
| GitHub | `<registry>/<owner>/<repository>`, e.g. `ghcr.io/onek8s/container-build-extension` |
| Azure DevOps | `<registry>/<project>/<repository>`, e.g. `myacr.azurecr.io/web-shop/frontend` |
| Docker Hub | `docker.io/<namespace>/<repository>` (Docker Hub allows only one level) |

Names are lower-cased and characters that are not allowed are replaced with `-`. `image` can also be a name below the
registry (`image: tools/api` → `myacr.azurecr.io/tools/api`) or a full reference (`image: other.io/team/app`).

The registry is the first of: the `registry` input, the `CONTAINER_REGISTRY` variable, the service connection's registry
(Azure DevOps), or `ghcr.io` (GitHub). It may include a namespace, e.g. `myacr.azurecr.io/team`.

## Configure the registry once

Neither GitHub nor Azure DevOps can store secrets for an action or extension at install time. Instead, put the registry and
its credentials in organization or project level settings under these names, and the extension picks them up:

| Name | Kind | Example |
|---|---|---|
| `CONTAINER_REGISTRY` | variable | `myacr.azurecr.io` |
| `CONTAINER_REGISTRY_USERNAME` | variable or secret | service principal / token name |
| `CONTAINER_REGISTRY_PASSWORD` | secret | password / token |

The credentials are only used for the registry named in `CONTAINER_REGISTRY`. If a pipeline pushes to another registry,
they are not sent.

### GitHub Actions

Create the variables and secrets in *Organization settings → Secrets and variables → Actions* (or per repository).
Then every repository needs only this workflow:

```yaml
on:
  push:
    branches: [main]
    tags: ["v*"]
  pull_request:

jobs:
  build:
    permissions:
      contents: read
      packages: write   # only needed for ghcr.io
      id-token: write   # only needed for Azure (OIDC)
    uses: onek8s/container-build-extension/.github/workflows/container-build.yml@v0
    secrets: inherit
```

The reusable workflow checks out the repository, builds, protects package installs, generates and uploads the SBOM, scans
and pushes. Optional inputs: `image`, `context`, `dockerfile`, `build-args`, `target`, `tags`, `push`, `runs-on`. Outputs:
`image`, `image-ref`, `digest`, `tags`.

Without any configuration it pushes to `ghcr.io/<owner>/<repository>` using the workflow token.

To use the action directly in your own jobs:

```yaml
permissions:
  contents: read
  packages: write

steps:
  - uses: actions/checkout@v4
  - uses: onek8s/container-build-extension@v0
```

To use another registry, pass `username`/`password` inputs, or set the `CONTAINER_REGISTRY*` variables as `env:`.
If you already log in with another step (for example `azure/login` + `az acr login`, or `docker/login-action`), just set
`registry` or `image`.

### Azure Pipelines

Install the extension, then do one of the following:

**Variable group.** Create a variable group (*Pipelines → Library*), for example `container-registry`, with
`CONTAINER_REGISTRY`, `CONTAINER_REGISTRY_USERNAME` and `CONTAINER_REGISTRY_PASSWORD` (mark it secret):

```yaml
variables:
  - group: container-registry

steps:
  - task: ContainerBuild@0
```

**Service connection.** Use a *Docker Registry* service connection: username/password, or Azure Container Registry with a
service principal. It can be shared with several projects. The image name is derived from its registry:

```yaml
steps:
  - task: ContainerBuild@0
    inputs:
      containerRegistry: my-acr-connection
```

To apply this to every pipeline centrally, put the step (and the variable group) in a shared template and use
`extends:` or `template:` from your pipelines.

For Azure Container Registry with workload identity federation or managed identity, see
[Azure Container Registry without passwords](#azure-container-registry-without-passwords).

Output variables are available as `$(<stepName>.digest)` etc. when the step has a `name:`.
The SBOM is published automatically as the `sbom` pipeline artifact.

On GitHub (when using the action directly), upload the SBOM with:

```yaml
  - uses: onek8s/container-build-extension@v0
    id: build
  - uses: actions/upload-artifact@v4
    with:
      name: sbom
      path: ${{ steps.build.outputs.sbom }}
```

## Azure Container Registry without passwords

For Azure Container Registry (`*.azurecr.io`) the extension logs in with a Microsoft Entra identity, the same way as
`az acr login` (Entra token → ACR refresh token → `docker login`), without needing the Azure CLI. The identity needs the
**AcrPush** role on the registry. When no username/password is configured, the first available identity is used:

| # | Identity | Azure DevOps | GitHub |
|---|---|---|---|
| 1 | Service connection / OIDC | Docker Registry (Azure Container Registry) or Azure Resource Manager service connection with **workload identity federation**, managed identity or service principal | **GitHub OIDC** with `AZURE_CLIENT_ID` + `AZURE_TENANT_ID` and `permissions: id-token: write` |
| 2 | Existing `docker login` | kept as is (e.g. `az acr login` in a previous step) | kept as is |
| 3 | AKS workload identity | agents running in AKS pods with workload identity (`AZURE_FEDERATED_TOKEN_FILE`) | runners in AKS pods (e.g. Actions Runner Controller) |
| 4 | Managed identity | self-hosted agents on Azure VMs / VM scale sets (`AZURE_CLIENT_ID` selects a user-assigned identity) | self-hosted runners on Azure VMs / VM scale sets |

### Self-hosted agents and runners

With a managed identity or AKS workload identity on the agent pool, configure only the registry, for example in the
agent's or runner's `.env` file (or as a pipeline / organization variable):

```
CONTAINER_REGISTRY=myacr.azurecr.io
```

and the pipelines need nothing else:

```yaml
# Azure Pipelines
pool: my-self-hosted-pool
steps:
  - task: ContainerBuild@0
```

```yaml
# GitHub Actions
jobs:
  build:
    runs-on: [self-hosted, linux]
    steps:
      - uses: actions/checkout@v4
      - uses: onek8s/container-build-extension@v0
```

The agents need outbound access to `login.microsoftonline.com` (not for managed identity) and the registry; the
instance metadata endpoint `169.254.169.254` is always called without proxy.

Ready-to-deploy autoscaling setups are in [examples](examples): a Managed DevOps Pool (Bicep) for Azure DevOps
and Actions Runner Controller on AKS (Helm) for GitHub.

### Azure DevOps with workload identity federation

Create a *Docker Registry → Azure Container Registry* service connection with *Workload Identity federation*, then:

```yaml
steps:
  - task: ContainerBuild@0
    inputs:
      containerRegistry: my-acr-connection
```

An *Azure Resource Manager* service connection works too: set `azureSubscription: my-arm-connection` and
`registry: myacr.azurecr.io`.

### GitHub OIDC

Add a federated credential for your repositories to an Entra app registration or user-assigned managed identity (subject e.g.
`repo:my-org/my-repo:ref:refs/heads/main`), grant it AcrPush, and set the organization variables
`CONTAINER_REGISTRY`, `AZURE_CLIENT_ID` and `AZURE_TENANT_ID`. With the reusable workflow:

```yaml
jobs:
  build:
    permissions:
      contents: read
      id-token: write
      packages: write
    uses: onek8s/container-build-extension/.github/workflows/container-build.yml@v0
    secrets: inherit
```

Or with the action directly: `permissions: id-token: write` and `azure-client-id` / `azure-tenant-id` inputs (or the
`AZURE_CLIENT_ID` / `AZURE_TENANT_ID` environment variables).

## Supply chain protection with Aikido Safe Chain

Package managers running inside `docker build` download code from public registries, and a single compromised package
is enough to ship malware in your image. With `safe-chain` enabled (the default), every shell-form `RUN` instruction of the
Dockerfile runs with [Aikido Safe Chain](https://github.com/AikidoSec/safe-chain) in front of the package managers. It
blocks known malware and, by default, package versions published less than 48 hours ago. A blocked package fails the build.

How it works, without touching your Dockerfile or image:

1. The pinned, static safe-chain Linux binary is downloaded on the agent and its SHA-256 checksum verified.
2. A temporary copy of the Dockerfile is built in which `RUN npm ci` becomes
   `RUN --mount=<safe-chain> export PATH="<safe-chain shims>:$PATH"; npm ci`.
3. safe-chain is only *mounted* into the build steps (BuildKit bind/cache mounts), so nothing ends up in the image layers.

Exec-form (`RUN ["npm", "ci"]`) and heredoc `RUN` instructions, stages with a custom `SHELL` and Windows Dockerfiles are
left as they are. safe-chain settings such as `SAFE_CHAIN_MINIMUM_PACKAGE_AGE_HOURS` can be passed with `build-args`
(declare them with `ARG` in the Dockerfile). Requires a Linux x64/arm64 agent and BuildKit (the default since Docker 23).

## Inputs

GitHub uses `kebab-case` names, Azure DevOps uses `camelCase` names.

| GitHub | Azure DevOps | Default | Description |
|---|---|---|---|
| `image` | `image` | automatic | Image name, a name below the registry, or empty for [automatic naming](#image-naming). |
| `registry` | `registry` | see [Image naming](#image-naming) | Registry (and namespace) for automatic image names. |
| `azure-client-id` / `azure-tenant-id` | `azureSubscription` | | Entra identity for [Azure Container Registry](#azure-container-registry-without-passwords). |
| `username` / `password` | `containerRegistry` | | Registry credentials. Defaults to the [`CONTAINER_REGISTRY*` variables](#configure-the-registry-once); on GitHub, `ghcr.io` uses `github-token`. Otherwise an existing `docker login` is used. |
| `tags` | `tags` | automatic | Comma or newline separated tags. |
| `context` | `context` | `.` | Build context. |
| `dockerfile` | `dockerfile` | `<context>/Dockerfile` | Dockerfile path. |
| `build-args` | `buildArgs` | | Newline separated `KEY=VALUE` build arguments. |
| `target` | `target` | | Target build stage. |
| `push` | `push` | `auto` | `auto` (push unless pull request), `true` or `false`. |
| `safe-chain` | `safeChain` | `true` | Protect package installs in `RUN` instructions with Aikido Safe Chain. |
| `sbom` | `sbom` | `true` | Generate an SBOM of the image. |
| `sbom-format` | `sbomFormat` | `cyclonedx` | `cyclonedx` or `spdx-json`. |
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
| `sbom` | `sbom` | Path to the SBOM file |
| `scan-report` | `scanReport` | Path to the Trivy JSON report |

## Requirements

A Linux agent/runner with Docker (GitHub-hosted `ubuntu-*` runners and Microsoft-hosted `ubuntu-*` agents work out of the box).
Trivy runs as a container (`ghcr.io/aquasecurity/trivy`) and safe-chain is downloaded from its GitHub release
(the agent needs access to `github.com` and `malware-list.aikido.dev`), so nothing else has to be installed. Proxy settings
(`HTTPS_PROXY`, ...) and a custom CA bundle (`SSL_CERT_FILE` or `NODE_EXTRA_CA_CERTS`) are passed on to the scanner.

## How it works

```
src/core/      shared logic: inputs, tagging, safe-chain, docker build/login/push, SBOM, Trivy scan, summary
src/github/    GitHub Actions adapter (inputs, outputs, masking, step summary)
src/azure/     Azure Pipelines adapter (inputs, service connections, output variables, build summary)
```

Both adapters implement the small `Platform` interface in `src/core/platform.ts`; everything else is shared.
The adapters speak the platforms' workflow/logging command protocols directly, so no SDKs are bundled.

## Development

```bash
npm ci                   # CI runs this through Aikido Safe Chain too
npm run check            # typecheck + unit tests + build
npm run package:azure    # build the .vsix into dist-azure/
```

`dist/index.js` (used by the GitHub Action) is committed and CI checks it is up to date, so run `npm run build` before committing.

### Releasing

1. Bump `version` in `package.json` and run `npm run build` (syncs the Azure task and extension versions). Merge to `main`.
2. Run the **Release** workflow on `main` (*Actions → Release → Run workflow*), or push a tag `vX.Y.Z`.
   The workflow creates the tag and a GitHub release with the `.vsix`, moves the `vX` major tag for the action, and
   publishes to the Visual Studio Marketplace if the `AZURE_DEVOPS_MARKETPLACE_TOKEN` secret is configured.
