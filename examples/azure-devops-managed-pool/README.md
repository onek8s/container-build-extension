# Azure DevOps: Managed DevOps Pool + Azure Container Registry

Autoscaling Azure Pipelines agents in your subscription with
[Managed DevOps Pools](https://learn.microsoft.com/azure/devops/managed-devops-pools/overview). The agents push to
Azure Container Registry with a **user-assigned managed identity**: no service connection and no secrets.

`main.bicep` creates:

- a user-assigned managed identity with the **AcrPush** role on your registry
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

Create the variable group `container-registry` (*Pipelines → Library*) from the deployment outputs:

| Variable | Value |
|---|---|
| `CONTAINER_REGISTRY` | output `registry`, e.g. `myacr.azurecr.io` |
| `AZURE_CLIENT_ID` | output `agentIdentityClientId` (selects the identity on the agent) |

Then every pipeline is just [azure-pipelines.yml](azure-pipelines.yml):

```yaml
pool: container-build
variables:
  - group: container-registry
steps:
  - task: ContainerBuild@0
```

The image is named `myacr.azurecr.io/<project>/<repository>` automatically. The task finds the managed identity
of the agent, exchanges its token for an ACR token and pushes, after Safe Chain protected build, SBOM and scan.
