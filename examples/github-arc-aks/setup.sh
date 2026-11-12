#!/usr/bin/env bash
# Sets up autoscaling GitHub runners on an existing AKS cluster with Actions Runner Controller,
# pushing to Azure Container Registry with AKS workload identity.
#
# Requires: az, kubectl (connected to the cluster) and helm.
set -euo pipefail

RESOURCE_GROUP=${RESOURCE_GROUP:?resource group of the AKS cluster}
AKS_NAME=${AKS_NAME:?AKS cluster name}
ACR_NAME=${ACR_NAME:?Azure Container Registry name}
GITHUB_CONFIG_URL=${GITHUB_CONFIG_URL:?e.g. https://github.com/my-org}
# GitHub App with "Self-hosted runners: read & write" (organization) permission
GITHUB_APP_ID=${GITHUB_APP_ID:?}
GITHUB_APP_INSTALLATION_ID=${GITHUB_APP_INSTALLATION_ID:?}
GITHUB_APP_PRIVATE_KEY_FILE=${GITHUB_APP_PRIVATE_KEY_FILE:?}

NAMESPACE=${NAMESPACE:-arc-runners}
SERVICE_ACCOUNT=container-build-runner
IDENTITY_NAME=${IDENTITY_NAME:-container-build-runners}

echo "Enabling OIDC issuer and workload identity on $AKS_NAME"
az aks update -g "$RESOURCE_GROUP" -n "$AKS_NAME" --enable-oidc-issuer --enable-workload-identity -o none
ISSUER=$(az aks show -g "$RESOURCE_GROUP" -n "$AKS_NAME" --query oidcIssuerProfile.issuerUrl -o tsv)

echo "Creating identity $IDENTITY_NAME with AcrPush on $ACR_NAME"
az identity create -g "$RESOURCE_GROUP" -n "$IDENTITY_NAME" -o none
CLIENT_ID=$(az identity show -g "$RESOURCE_GROUP" -n "$IDENTITY_NAME" --query clientId -o tsv)
PRINCIPAL_ID=$(az identity show -g "$RESOURCE_GROUP" -n "$IDENTITY_NAME" --query principalId -o tsv)
ACR_ID=$(az acr show -n "$ACR_NAME" --query id -o tsv)
ACR_SERVER=$(az acr show -n "$ACR_NAME" --query loginServer -o tsv)
az role assignment create --assignee-object-id "$PRINCIPAL_ID" --assignee-principal-type ServicePrincipal \
  --role AcrPush --scope "$ACR_ID" -o none
az identity federated-credential create -g "$RESOURCE_GROUP" --identity-name "$IDENTITY_NAME" \
  --name "$NAMESPACE-$SERVICE_ACCOUNT" --issuer "$ISSUER" \
  --subject "system:serviceaccount:$NAMESPACE:$SERVICE_ACCOUNT" --audiences api://AzureADTokenExchange -o none

echo "Installing Actions Runner Controller"
helm upgrade --install arc --namespace arc-systems --create-namespace \
  oci://ghcr.io/actions/actions-runner-controller-charts/gha-runner-scale-set-controller

kubectl create namespace "$NAMESPACE" --dry-run=client -o yaml | kubectl apply -f -
kubectl -n "$NAMESPACE" create serviceaccount "$SERVICE_ACCOUNT" --dry-run=client -o yaml | kubectl apply -f -
kubectl -n "$NAMESPACE" annotate serviceaccount "$SERVICE_ACCOUNT" --overwrite \
  "azure.workload.identity/client-id=$CLIENT_ID"
kubectl -n "$NAMESPACE" create secret generic arc-github-app --dry-run=client -o yaml \
  --from-literal=github_app_id="$GITHUB_APP_ID" \
  --from-literal=github_app_installation_id="$GITHUB_APP_INSTALLATION_ID" \
  --from-file=github_app_private_key="$GITHUB_APP_PRIVATE_KEY_FILE" | kubectl apply -f -

echo "Installing runner scale set 'container-build'"
helm upgrade --install container-build --namespace "$NAMESPACE" \
  -f "$(dirname "$0")/values.yaml" \
  --set githubConfigUrl="$GITHUB_CONFIG_URL" \
  --set "template.spec.containers[0].env[0].value=$ACR_SERVER" \
  oci://ghcr.io/actions/actions-runner-controller-charts/gha-runner-scale-set

echo "Done. Use 'runs-on: container-build' in workflows; images go to $ACR_SERVER/<owner>/<repository>."
