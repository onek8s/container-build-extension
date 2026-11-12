# Examples: autoscaling self-hosted agents and runners on Azure

| Example | Platform | Autoscaling | Login to Azure Container Registry |
|---|---|---|---|
| [azure-devops-managed-pool](azure-devops-managed-pool) | Azure DevOps | [Managed DevOps Pools](https://learn.microsoft.com/azure/devops/managed-devops-pools/overview) | user-assigned managed identity |
| [github-arc-aks](github-arc-aks) | GitHub | [Actions Runner Controller](https://github.com/actions/actions-runner-controller) on AKS | AKS workload identity |

Without your own infrastructure, GitHub-hosted runners (optionally larger runners with Azure private networking) can
push to Azure Container Registry with [GitHub OIDC](../README.md#github-oidc).
