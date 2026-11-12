# GitHub: Actions Runner Controller on AKS + Azure Container Registry

Autoscaling self-hosted GitHub runners on AKS with
[Actions Runner Controller](https://docs.github.com/actions/hosting-your-own-runners/managing-self-hosted-runners-with-actions-runner-controller)
(runner scale sets). Runners scale from zero with the job queue, build with Docker-in-Docker and push to Azure
Container Registry with **AKS workload identity**: no secrets in GitHub.

| File | Purpose |
|---|---|
| [setup.sh](setup.sh) | One-time setup with `az`, `kubectl` and `helm` (see below) |
| [values.yaml](values.yaml) | Helm values of the runner scale set: dind, workload identity, `CONTAINER_REGISTRY` |
| [build.yml](build.yml) | Complete workflow for a repository |

`setup.sh` does the following:

1. Enables the OIDC issuer and workload identity on the AKS cluster.
2. Creates a user-assigned managed identity with **AcrPush** on the registry, and a federated credential for the
   runner service account `arc-runners/container-build-runner`.
3. Installs the ARC controller and a runner scale set named `container-build` with [values.yaml](values.yaml).

```bash
export RESOURCE_GROUP=my-rg AKS_NAME=my-aks ACR_NAME=myacr
export GITHUB_CONFIG_URL=https://github.com/my-org
export GITHUB_APP_ID=123456 GITHUB_APP_INSTALLATION_ID=7890123 GITHUB_APP_PRIVATE_KEY_FILE=./app.pem
./setup.sh
```

The GitHub App needs the organization permission *Self-hosted runners: read & write*
([how to create it](https://docs.github.com/actions/hosting-your-own-runners/managing-self-hosted-runners-with-actions-runner-controller/authenticating-to-the-github-api)).

Workflows then need no registry settings at all ([build.yml](build.yml)):

```yaml
jobs:
  build:
    runs-on: container-build
    steps:
      - uses: actions/checkout@v4
      - uses: onek8s/container-build-extension@v0
```

The image is named `myacr.azurecr.io/<owner>/<repository>`. The action uses the workload identity token that AKS
injects into the runner pod (`AZURE_FEDERATED_TOKEN_FILE`), exchanges it for an ACR token and pushes.

## Notes

- Docker-in-Docker runs privileged. Use a dedicated node pool for runners if you need to isolate them.
- The dind sidecar shares `/home/runner/_work` with the runner, which the action uses for its scan and SBOM files.
- To restrict which repositories can use the runners, create a runner group in the organization settings and set
  `runnerGroup` in `values.yaml`.
