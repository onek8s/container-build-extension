# Container Build

Build a container image with supply chain protection, generate an SBOM, scan it for vulnerabilities with [Trivy](https://trivy.dev) and push it to a registry, all in one task with minimal configuration.

```yaml
steps:
  - task: ContainerBuild@0
    inputs:
      image: myacr.azurecr.io/my-app
      containerRegistry: my-acr-connection   # Docker Registry service connection
```

That's it. The task:

1. **Builds** `./Dockerfile` and tags it automatically (short commit SHA, plus `latest` on main/master, the git tag on tag builds, `pr-<n>` for pull requests or the branch name).
   Package installs (`npm`, `yarn`, `pnpm`, `pip`, `uv`, `poetry`, ...) in the Dockerfile run through
   [Aikido Safe Chain](https://github.com/AikidoSec/safe-chain), which blocks malware, without changing your Dockerfile or image.
2. **Generates an SBOM** (CycloneDX or SPDX) and publishes it as the `sbom` pipeline artifact.
3. **Scans** the image with Trivy for `CRITICAL` and `HIGH` vulnerabilities that have a fix available. If any are found the task fails and **nothing is pushed**.
4. **Pushes** all tags (skipped automatically for pull request builds) and sets the `digest` and `imageRef` output variables.

A summary of the scan is attached to the build results page.

See the [documentation](https://github.com/onek8s/container-build-extension#readme) for all options.
