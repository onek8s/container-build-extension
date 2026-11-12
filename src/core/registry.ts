import {
  acrCredentials,
  hasManagedIdentity,
  isAcr,
  machineSettings,
  TAG_REGISTRY,
  workloadIdentityFromEnv,
  type MachineSettings,
} from './azure';
import type { Exec } from './exec';
import type { BuildContext, Platform, RegistryCredentials } from './platform';

/** Well-known variable names: configure the registry once (org/project level) instead of in every pipeline. */
export const VAR_REGISTRY = 'CONTAINER_REGISTRY';
export const VAR_USERNAME = 'CONTAINER_REGISTRY_USERNAME';
export const VAR_PASSWORD = 'CONTAINER_REGISTRY_PASSWORD';

/**
 * Normalizes a registry given as host, host/namespace or URL:
 *   https://MyAcr.azurecr.io/ -> myacr.azurecr.io
 *   https://index.docker.io/v1/ -> docker.io
 *   ghcr.io/my-org -> ghcr.io/my-org
 */
export function normalizeRegistry(value: string): string {
  let r = value.trim().toLowerCase().replace(/^[a-z]+:\/\//, '').replace(/\/+$/, '');
  const [host, ...rest] = r.split('/');
  if (['index.docker.io', 'registry-1.docker.io', 'registry.hub.docker.com'].includes(host)) {
    // the v1 path is part of the classic Docker Hub URL, not a namespace
    r = ['docker.io', ...rest.filter((p, i) => !(i === 0 && p === 'v1'))].join('/');
  }
  return r;
}

export const registryHost = (registry: string) => normalizeRegistry(registry).split('/')[0];

/** Lower-cases and replaces characters that are not allowed in an image path component. */
export function sanitizeComponent(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/[._-]{2,}/g, '-')
    .replace(/^[._-]+|[._-]+$/g, '');
}

/** True when the image reference starts with a registry host (contains a dot, a port or is localhost). */
export function hasRegistryHost(image: string): boolean {
  const first = image.split('/')[0];
  return image.includes('/') && (first.includes('.') || first.includes(':') || first === 'localhost');
}

/**
 * Derives `<project>/<repository>` from the source: GitHub owner/repo, or Azure DevOps project/repo.
 * Docker Hub only supports one level below the namespace, so there only the repository is used.
 */
export function defaultImagePath(ctx: BuildContext, registry: string): string | undefined {
  const repo = ctx.repository ? sanitizeComponent(ctx.repository) : '';
  if (!repo) return undefined;
  if (registryHost(registry) === 'docker.io') return repo;
  const project = ctx.project ? sanitizeComponent(ctx.project) : '';
  return project ? `${project}/${repo}` : repo;
}

/** Registry configured in the pipeline: input > CONTAINER_REGISTRY variable > service connection. */
export function configuredRegistry(platform: Platform): string | undefined {
  return platform.getInput('registry') ?? platform.getVariable(VAR_REGISTRY) ?? platform.getDefaultRegistry();
}

/** True when the image name can only be completed with settings of the machine (VM tags). */
export function needsMachineSettings(platform: Platform): boolean {
  const image = platform.getInput('image');
  return !configuredRegistry(platform) && !(image && hasRegistryHost(image));
}

/**
 * Resolves the registry to use: input > CONTAINER_REGISTRY variable > service connection >
 * `container-registry` tag of the agent VM > platform fallback (ghcr.io on GitHub).
 */
export function resolveRegistry(platform: Platform, machine: MachineSettings = {}): string | undefined {
  const value = configuredRegistry(platform) ?? machine.registry ?? platform.getFallbackRegistry?.();
  return value ? normalizeRegistry(value) : undefined;
}

/** Resolves the full image name (without tag). */
export function resolveImage(platform: Platform, machine: MachineSettings = {}): string {
  const image = platform.getInput('image');
  const registry = resolveRegistry(platform, machine);
  if (image) {
    if (hasRegistryHost(image) || !registry) return image;
    return `${registry}/${image.replace(/^\/+/, '')}`;
  }
  if (!registry) {
    throw new Error(
      `Input 'image' is required when no registry is configured (input 'registry', variable ${VAR_REGISTRY} or tag '${TAG_REGISTRY}' of the agent VM).`,
    );
  }
  const path = defaultImagePath(platform.context, registry);
  if (!path) throw new Error("Cannot derive the image name from the repository; set input 'image'.");
  if (registryHost(registry) === 'docker.io' && !registry.includes('/')) {
    throw new Error("Docker Hub needs a namespace: set registry to 'docker.io/<namespace>' or set input 'image'.");
  }
  return `${registry}/${path}`;
}

export interface CredentialOptions {
  exec: Exec;
  env?: NodeJS.ProcessEnv;
  /** True when docker already has a login for the registry (e.g. from a previous step). */
  hasExistingLogin?: (registry: string) => boolean;
}

/**
 * Credentials for the registry the image is pushed to:
 *  1. explicit, platform-specific (inputs / service connection with username and password)
 *  2. CONTAINER_REGISTRY_USERNAME/PASSWORD, only when CONTAINER_REGISTRY points to the same registry host,
 *     so organization-wide credentials are never sent to another registry
 *  3. Azure Container Registry with an Entra identity:
 *     a. platform identity (Azure DevOps service connection, GitHub OIDC)
 *     b. an existing docker login is kept as is
 *     c. AKS workload identity of the agent pod
 *     d. managed identity of the agent VM
 *  4. platform fallback (GITHUB_TOKEN for ghcr.io)
 */
export async function resolveCredentials(
  platform: Platform,
  registry: string,
  opts: CredentialOptions,
): Promise<RegistryCredentials | undefined> {
  const explicit = platform.getCredentials(registry);
  if (explicit) return explicit;

  const configured = platform.getVariable(VAR_REGISTRY);
  const password = platform.getVariable(VAR_PASSWORD);
  if (password && configured && registryHost(configured) === registryHost(registry)) {
    const username = platform.getVariable(VAR_USERNAME);
    if (!username) throw new Error(`${VAR_USERNAME} is required when ${VAR_PASSWORD} is set`);
    return { registry: registryHost(configured), username, password, source: 'CONTAINER_REGISTRY_* variables' };
  }

  if (isAcr(registry)) {
    const mask = (v: string) => platform.setSecret(v);
    const identity = platform.getAzureIdentity?.(registry);
    if (identity) return acrCredentials(opts.exec, registry, identity, mask);
    if (opts.hasExistingLogin?.(registry)) return undefined;
    const workload = workloadIdentityFromEnv(opts.env ?? process.env);
    if (workload) return acrCredentials(opts.exec, registry, workload, mask);
    if (await hasManagedIdentity(opts.exec)) {
      const clientId =
        platform.getInput('azureClientId') ?? (opts.env ?? process.env).AZURE_CLIENT_ID ?? (await machineSettings(opts.exec)).clientId;
      return acrCredentials(opts.exec, registry, { kind: 'managed', source: 'managed identity', clientId }, mask);
    }
  }
  return platform.getFallbackCredentials?.(registry);
}
