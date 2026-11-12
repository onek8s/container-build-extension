# Azure DevOps: Managed DevOps Pool + Azure Container Registry

Autoscaling Azure Pipelines agents in your subscription with
[Managed DevOps Pools](https://learn.microsoft.com/azure/devops/managed-devops-pools/overview). The agents push to
Azure Container Registry with a **user-assigned managed identity**: no service connection and no secrets.

`main.bicep` (with the pool in `pool.bicep`) creates:

- a user-assigned managed identity with the **AcrPush** role on your registry
- pool tags that tell the agents which registry and identity to use
- the Dev Center and Dev Center project that Managed DevOps Pools require
- a pool of stateless Ubuntu 24.04 agents (Docker preinstalled) that scales with the job queue, up to
  `maximumConcurrency` agents, and starts agents ahead of demand based on your job history
- optionally VNet injection (`subnetId`) to reach a registry behind a private endpoint

## Deploy

```bash
az provider register --namespace Microsoft.DevOpsInfrastructure
az provider register --namespace Microsoft.DevCenter

az deployment group create -g my-rg -f main.bicep \
  -p organizationUrl=https://dev.azure.com/my-org acrName=myacr
```

The deploying user must be an Azure DevOps organization administrator. The pool appears in
*Organization settings → Agent pools* as `container-build`.

## Use

Nothing to configure in Azure DevOps. The pool is tagged with `container-registry` (the registry login server) and
`container-registry-client-id` (the agent identity). Managed DevOps Pools pass these tags to the agent VMs, and the
task reads them from the instance metadata service. Every pipeline is just [azure-pipelines.yml](azure-pipelines.yml):

```yaml
pool: container-build
steps:
  - task: ContainerBuild@0
```

The image is named `myacr.azurecr.io/<project>/<repository>` automatically. The task logs in with the agent's managed
identity (ACR token exchange), then runs the Safe Chain protected build, SBOM, scan and push.

To push somewhere else from a single pipeline, set `registry` or `image` on the task, or the `CONTAINER_REGISTRY` variable.
