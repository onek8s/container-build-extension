#!/usr/bin/env bash
# Creates the Azure side of the Azure DevOps e2e tests and Marketplace publishing:
#   - an Entra app registration + service principal that GitHub Actions signs in as (OIDC, no secret)
#     with federated credentials for the GitHub environments "azure-devops-e2e" and "marketplace"
#   - optionally an Azure Container Registry for the tests
# Then follow docs/azure-devops-e2e.md for the Azure DevOps and Marketplace steps.
#
# Requires: az (logged in), permission to create app registrations.
set -euo pipefail

GITHUB_REPO=${GITHUB_REPO:-onek8s/container-build-extension}
APP_NAME=${APP_NAME:-container-build-extension-ci}
RESOURCE_GROUP=${RESOURCE_GROUP:-}       # set to also create the test registry
ACR_NAME=${ACR_NAME:-}
LOCATION=${LOCATION:-westeurope}

TENANT_ID=$(az account show --query tenantId -o tsv)

echo "Creating app registration $APP_NAME"
APP_ID=$(az ad app list --display-name "$APP_NAME" --query '[0].appId' -o tsv)
if [ -z "$APP_ID" ]; then
  APP_ID=$(az ad app create --display-name "$APP_NAME" --query appId -o tsv)
fi
az ad sp show --id "$APP_ID" >/dev/null 2>&1 || az ad sp create --id "$APP_ID" -o none
SP_OBJECT_ID=$(az ad sp show --id "$APP_ID" --query id -o tsv)

for env in azure-devops-e2e marketplace; do
  name="github-${env}"
  if ! az ad app federated-credential list --id "$APP_ID" --query "[?name=='${name}']" -o tsv | grep -q .; then
    echo "Adding federated credential for GitHub environment ${env}"
    az ad app federated-credential create --id "$APP_ID" --parameters "{
      \"name\": \"${name}\",
      \"issuer\": \"https://token.actions.githubusercontent.com\",
      \"subject\": \"repo:${GITHUB_REPO}:environment:${env}\",
      \"audiences\": [\"api://AzureADTokenExchange\"]
    }" -o none
  fi
done

if [ -n "$RESOURCE_GROUP" ] && [ -n "$ACR_NAME" ]; then
  echo "Creating test registry $ACR_NAME"
  az group create -n "$RESOURCE_GROUP" -l "$LOCATION" -o none
  az acr show -n "$ACR_NAME" >/dev/null 2>&1 || az acr create -g "$RESOURCE_GROUP" -n "$ACR_NAME" --sku Basic -o none
  echo "ACR login server: $(az acr show -n "$ACR_NAME" --query loginServer -o tsv)"
fi

cat <<OUT

Done. Set these GitHub repository variables (Settings -> Secrets and variables -> Actions -> Variables):
  AZURE_TENANT_ID        = ${TENANT_ID}
  AZURE_DEVOPS_CLIENT_ID = ${APP_ID}

Service principal object id (Enterprise applications), used when adding it to Azure DevOps:
  ${SP_OBJECT_ID}

Next steps: docs/azure-devops-e2e.md
OUT
