# Container Build

Build a container image with supply chain protection, generate an SBOM, scan it for vulnerabilities with [Trivy](https://trivy.dev) and push it to a registry, all in one task with minimal configuration.

```yaml
steps:
  - task: ContainerBuild@0
```

On **self-hosted agents** (Managed DevOps Pools, VM scale sets, your own VMs or AKS) that is the whole pipeline. The agent
provides everything:

- **login**: its managed identity or AKS workload identity, with the AcrPush role on your Azure Container Registry
- **registry**: the `container-registry` tag of the agent VM (Managed DevOps Pools pass pool tags to the agents), or
  `CONTAINER_REGISTRY=myacr.azurecr.io` in the agent's environment
- **image name**: `<registry>/<project>/<repository>`

On **Microsoft-hosted agents**, or to choose per pipeline, use a Docker Registry service connection. This can be Azure
Container Registry with workload identity federation, or username/password:

```yaml
steps:
  - task: ContainerBuild@0
    inputs:
      containerRegistry: my-acr-connection
```

You can also set `CONTAINER_REGISTRY`, `CONTAINER_REGISTRY_USERNAME` and `CONTAINER_REGISTRY_PASSWORD` in a variable group.

The task:

1. **Builds** `./Dockerfile` and tags it automatically (short commit SHA, plus `latest` on main/master, the git tag on tag builds, `pr-<n>` for pull requests or the branch name).
   Package installs (`npm`, `yarn`, `pnpm`, `pip`, `uv`, `poetry`, ...) in the Dockerfile run through
   [Aikido Safe Chain](https://github.com/AikidoSec/safe-chain), which blocks malware, without changing your Dockerfile or image.
2. **Generates an SBOM** (CycloneDX or SPDX) and publishes it as the `sbom` pipeline artifact.
3. **Scans** the image with Trivy for `CRITICAL` and `HIGH` vulnerabilities that have a fix available. If any are found the task fails and **nothing is pushed**.
4. **Pushes** all tags (skipped automatically for pull request builds) and sets the `digest` and `imageRef` output variables.

A summary of the scan is attached to the build results page.

When you **re-run a failed job**, vulnerabilities and safe-chain's minimum package age are reported as warnings
instead of failing, because there is usually a good reason for the re-run. Known malware is always blocked. Set
`bypassOnRerun: false` to enforce the checks on every attempt.

See the [documentation](https://github.com/onek8s/container-build-extension#readme) for all options.
