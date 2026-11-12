// Managed DevOps Pool, used by main.bicep.

param poolName string
param location string
param devCenterProjectId string
@description('Resource id of the user-assigned identity of the agents.')
param identityId string
@description('Client id of that identity, passed to the agents as tag.')
param identityClientId string
@description('Registry login server, passed to the agents as tag.')
param registry string
param organizationUrl string
param projects array
param maximumConcurrency int
param vmSize string
param subnetId string

resource pool 'Microsoft.DevOpsInfrastructure/pools@2024-10-19' = {
  name: poolName
  location: location
  // Managed DevOps Pools pass the pool's tags to the agent VMs. The container build task reads them from
  // the instance metadata service, so pipelines need no registry settings at all.
  tags: {
    'container-registry': registry
    'container-registry-client-id': identityClientId
  }
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${identityId}': {}
    }
  }
  properties: {
    devCenterProjectResourceId: devCenterProjectId
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
}

output name string = pool.name
