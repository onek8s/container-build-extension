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

/** Resolves the registry to use: input > CONTAINER_REGISTRY variable > platform default. */
export function resolveRegistry(platform: Platform): string | undefined {
  const value = platform.getInput('registry') ?? platform.getVariable(VAR_REGISTRY) ?? platform.getDefaultRegistry();
  return value ? normalizeRegistry(value) : undefined;
}

/** Resolves the full image name (without tag). */
export function resolveImage(platform: Platform): string {
  const image = platform.getInput('image');
  const registry = resolveRegistry(platform);
  if (image) {
    if (hasRegistryHost(image) || !registry) return image;
    return `${registry}/${image.replace(/^\/+/, '')}`;
  }
  if (!registry) {
    throw new Error(`Input 'image' is required when no registry is configured (input 'registry' or variable ${VAR_REGISTRY}).`);
  }
  const path = defaultImagePath(platform.context, registry);
  if (!path) throw new Error("Cannot derive the image name from the repository; set input 'image'.");
  if (registryHost(registry) === 'docker.io' && !registry.includes('/')) {
    throw new Error("Docker Hub needs a namespace: set registry to 'docker.io/<namespace>' or set input 'image'.");
  }
  return `${registry}/${path}`;
}

/**
 * Credentials for the registry the image is pushed to:
 *  1. explicit, platform-specific (inputs / service connection)
 *  2. CONTAINER_REGISTRY_USERNAME/PASSWORD, only when CONTAINER_REGISTRY points to the same registry host,
 *     so organization-wide credentials are never sent to another registry
 *  3. platform fallback (GITHUB_TOKEN for ghcr.io)
 */
export function resolveCredentials(platform: Platform, registry: string): RegistryCredentials | undefined {
  const explicit = platform.getCredentials(registry);
  if (explicit) return explicit;

  const configured = platform.getVariable(VAR_REGISTRY);
  const password = platform.getVariable(VAR_PASSWORD);
  if (password && configured && registryHost(configured) === registryHost(registry)) {
    const username = platform.getVariable(VAR_USERNAME);
    if (!username) throw new Error(`${VAR_USERNAME} is required when ${VAR_PASSWORD} is set`);
    return { registry: registryHost(configured), username, password };
  }
  return platform.getFallbackCredentials?.(registry);
}
