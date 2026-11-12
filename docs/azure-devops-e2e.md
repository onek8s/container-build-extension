# Azure DevOps end-to-end tests and Marketplace publishing

The GitHub CI of this repository can test the extension on **real Azure DevOps agents** and publish it to the
**Visual Studio Marketplace**, authenticated with **GitHub OIDC → Microsoft Entra service principal**. No PAT or other
secret is stored anywhere.

```
GitHub Actions (PR / main)
  ├─ build + package dev extension  onek8s.container-build-dev  (task ContainerBuildDev, version 0.<minor>.<run>)
  ├─ OIDC → Entra service principal → Azure DevOps token
  ├─ tfx extension publish --share-with <org>        (private, test organization only)
  ├─ wait until the organization has that version installed
  └─ queue test/azure-devops/e2e.yml and wait for the result
        ├─ ACR via Docker Registry service connection (workload identity federation)
        ├─ ACR via Azure Resource Manager service connection (workload identity federation)
        ├─ malicious npm package is blocked by safe-chain
        └─ optional: zero-config on a Managed DevOps Pool (VM tags + managed identity)

Release workflow → same service principal → tfx extension publish (onek8s.container-build)
```

The dev extension has its own extension id, task id and task name, so it can be installed next to the released one.

## 1. Azure: service principal for GitHub (and a test registry)

```bash
az login
RESOURCE_GROUP=container-build-e2e ACR_NAME=containerbuilde2e ./scripts/setup-azure-devops-e2e.sh
```

This creates the app registration `container-build-extension-ci` with federated credentials for the GitHub
environments `azure-devops-e2e` and `marketplace` of this repository, and a Basic tier registry. It prints the values for
the next steps.

## 2. Visual Studio Marketplace publisher

1. Create the publisher `onek8s` at https://marketplace.visualstudio.com/manage, or change `publisher` in
   `azure/vss-extension.json`.
2. Add the service principal as a member of the publisher with the **Contributor** role. To get its identity, run the
   *Azure DevOps e2e* workflow once after step 4. The step *Show service principal identity* prints the `id` to add,
   even though the publish step fails until the service principal is a member.

## 3. Azure DevOps test organization

1. Create an organization (the free tier is fine) and a project, e.g. `container-build-e2e`.
2. **Add the service principal**: *Organization settings → Users → Add users*, search for `container-build-extension-ci`.
   Give it **Basic** access and add it to the project's **Contributors** group, so it can queue pipelines.
3. **Let it install the dev extension**: *Organization settings → Extensions → Security*, add the service principal as
   **Manager**. The workflow installs the shared dev extension itself on the first run.
4. **Service connections** (*Project settings → Service connections*):
   - `e2e-acr`: *Docker Registry → Azure Container Registry → Workload Identity federation*, with the test registry.
   - `e2e-arm`: *Azure Resource Manager → Workload identity federation (automatic)*, scoped to the test resource group.
     Grant its service principal **AcrPush** on the registry.
5. **Pipeline**: *Pipelines → New pipeline → GitHub → onek8s/container-build-extension → Existing YAML file →
   `/test/azure-devops/e2e.yml`*. Save it without running, note its id (`definitionId=` in the URL), and allow it to
   use the two service connections on first run (or mark them "Grant access permission to all pipelines").
6. **Agents**: new organizations need a [free parallel job grant](https://aka.ms/azpipelines-parallelism-request) for
   Microsoft-hosted agents. Optionally deploy [examples/azure-devops-managed-pool](../examples/azure-devops-managed-pool)
   with the test registry to also test the zero-config path.

## 4. GitHub repository variables

| Variable | Example |
|---|---|
| `AZURE_TENANT_ID` | printed by the setup script |
| `AZURE_DEVOPS_CLIENT_ID` | printed by the setup script |
| `ADO_ORGANIZATION` | `onek8s-e2e` (enables the workflow) |
| `ADO_PROJECT` | `container-build-e2e` |
| `ADO_PIPELINE_ID` | the pipeline id from step 3.5 |
| `E2E_ACR` | `containerbuilde2e.azurecr.io` |
| `ADO_MANAGED_POOL` | optional: name of the Managed DevOps Pool |

The workflow runs for pull requests from this repository, pushes to `main` and on demand. Runs are serialized,
because Marketplace versions must increase and the organization has one dev extension installed at a time.

Releases publish `onek8s.container-build` to the Marketplace with the same service principal (environment
`marketplace`) as soon as `AZURE_DEVOPS_CLIENT_ID` is set. The extension is private (`"public": false` in
`azure/vss-extension.json`) and shared with `ADO_ORGANIZATION`. Make it public once the publisher is verified.
You can protect the `marketplace` environment with required reviewers in *Settings → Environments*.
