// Azure DevOps Managed DevOps Pool with autoscaling Linux agents that push to Azure Container Registry
// with a user-assigned managed identity (no service connection, no secrets).
//
//   az deployment group create -g <resource-group> -f main.bicep \
//     -p organizationUrl=https://dev.azure.com/<org> acrName=<registry-name>
//
// Prerequisites: resource provider Microsoft.DevOpsInfrastructure registered, and the deploying user is
// an Azure DevOps organization administrator (the pool is created in the organization).

@description('Azure DevOps organization URL, e.g. https://dev.azure.com/contoso')
param organizationUrl string

@description('Projects the pool is available to. Empty: all projects.')
param projects array = []

@description('Name of an existing Azure Container Registry in this resource group.')
param acrName string

@description('Name of the agent pool (also the pool name used in pipelines).')
param poolName string = 'container-build'

param location string = resourceGroup().location

@description('Maximum number of agents running at the same time.')
@minValue(1)
param maximumConcurrency int = 4

@description('VM size of the agents.')
param vmSize string = 'Standard_D4ads_v5'

@description('Optional subnet resource id for VNet injection, e.g. to reach a private-endpoint registry. The subnet must be delegated to Microsoft.DevOpsInfrastructure/pools.')
param subnetId string = ''

resource acr 'Microsoft.ContainerRegistry/registries@2023-07-01' existing = {
  name: acrName
}

// Identity of the agents: the extension logs in to the registry with it through the instance metadata service.
resource agentIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: '${poolName}-agents'
  location: location
}

var acrPushRoleId = '8311e382-0749-4cb8-b61a-304f252e45ec'

resource acrPush 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(acr.id, agentIdentity.id, acrPushRoleId)
  scope: acr
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', acrPushRoleId)
    principalId: agentIdentity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

// Managed DevOps Pools are attached to a Dev Center project.
resource devCenter 'Microsoft.DevCenter/devcenters@2024-02-01' = {
  name: '${poolName}-devcenter'
  location: location
}

resource devCenterProject 'Microsoft.DevCenter/projects@2024-02-01' = {
  name: '${poolName}-project'
  location: location
  properties: {
    devCenterId: devCenter.id
  }
}

resource pool 'Microsoft.DevOpsInfrastructure/pools@2024-10-19' = {
  name: poolName
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${agentIdentity.id}': {}
    }
  }
  properties: {
    devCenterProjectResourceId: devCenterProject.id
    maximumConcurrency: maximumConcurrency
    organizationProfile: {
      kind: 'AzureDevOps'
      organizations: [
        {
          url: organizationUrl
          projects: projects
          parallelism: maximumConcurrency
        }
      ]
      permissionProfile: {
        kind: 'CreatorOnly'
      }
    }
    // Fresh agent for every job; agents are started ahead of demand based on the job history.
    agentProfile: {
      kind: 'Stateless'
      resourcePredictionsProfile: {
        kind: 'Automatic'
        predictionPreference: 'Balanced'
      }
    }
    fabricProfile: {
      kind: 'Vmss'
      sku: {
        name: vmSize
      }
      // Azure Pipelines image: Docker is preinstalled.
      images: [
        {
          wellKnownImageName: 'ubuntu-24.04/latest'
          aliases: [
            'ubuntu-24.04'
          ]
        }
      ]
      storageProfile: {
        osDiskStorageAccountType: 'StandardSSD'
      }
      networkProfile: empty(subnetId) ? null : {
        subnetId: subnetId
      }
    }
  }
  dependsOn: [
    acrPush
  ]
}

output poolName string = pool.name
output agentIdentityClientId string = agentIdentity.properties.clientId
output registry string = acr.properties.loginServer
