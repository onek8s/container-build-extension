import * as fs from 'node:fs';
import type { Exec } from './exec';
import { httpRequest } from './http';
import type { RegistryCredentials } from './platform';

/**
 * Microsoft Entra ID identities that can push to Azure Container Registry without stored passwords.
 * The flow is the same as `az acr login`: Entra access token -> ACR refresh token -> docker login.
 */
export type AzureIdentity =
  | {
      kind: 'federated';
      /** e.g. "Azure DevOps service connection", "GitHub OIDC", "AKS workload identity" */
      source: string;
      tenantId: string;
      clientId: string;
      authorityHost?: string;
      /** Returns the federated (OIDC) token of the workload. */
      getAssertion: () => Promise<string>;
    }
  | { kind: 'secret'; source: string; tenantId: string; clientId: string; clientSecret: string; authorityHost?: string }
  | { kind: 'managed'; source: string; clientId?: string };

/** ACR accepts Entra tokens for Azure Resource Manager (the same audience `az acr login` uses). */
const ARM_RESOURCE = 'https://management.azure.com/';
const DEFAULT_AUTHORITY = 'https://login.microsoftonline.com';
const IMDS = 'http://169.254.169.254/metadata/identity/oauth2/token';
/** Username docker uses for ACR refresh tokens. */
export const ACR_TOKEN_USERNAME = '00000000-0000-0000-0000-000000000000';

export const isAcr = (registry: string) => /^[a-z0-9-]+\.azurecr\.[a-z.]+$/.test(registry.toLowerCase());

/** Workload identity injected into AKS pods (e.g. self-hosted agents/runners on AKS). */
export function workloadIdentityFromEnv(env: NodeJS.ProcessEnv): AzureIdentity | undefined {
  const file = env.AZURE_FEDERATED_TOKEN_FILE;
  if (!file || !env.AZURE_CLIENT_ID || !env.AZURE_TENANT_ID) return undefined;
  return {
    kind: 'federated',
    source: 'AKS workload identity',
    tenantId: env.AZURE_TENANT_ID,
    clientId: env.AZURE_CLIENT_ID,
    authorityHost: env.AZURE_AUTHORITY_HOST,
    getAssertion: async () => fs.readFileSync(file, 'utf8').trim(),
  };
}

function jwtClaims(token: string): Record<string, unknown> {
  try {
    return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
  } catch {
    return {};
  }
}

export async function getEntraToken(exec: Exec, identity: AzureIdentity, mask: (s: string) => void): Promise<string> {
  let token: string;
  if (identity.kind === 'managed') {
    const query = new URLSearchParams({ 'api-version': '2018-02-01', resource: ARM_RESOURCE });
    if (identity.clientId) query.set('client_id', identity.clientId);
    const r = await httpRequest<{ access_token: string }>(exec, {
      url: `${IMDS}?${query}`,
      headers: { Metadata: 'true' },
      noProxy: true,
      timeoutSeconds: 10,
    });
    token = r.access_token;
  } else {
    const authority = (identity.authorityHost || DEFAULT_AUTHORITY).replace(/\/+$/, '');
    const form: Record<string, string> = {
      client_id: identity.clientId,
      scope: `${ARM_RESOURCE}.default`,
      grant_type: 'client_credentials',
    };
    if (identity.kind === 'federated') {
      const assertion = await identity.getAssertion();
      mask(assertion);
      form.client_assertion_type = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';
      form.client_assertion = assertion;
    } else {
      form.client_secret = identity.clientSecret;
    }
    const r = await httpRequest<{ access_token: string }>(exec, {
      url: `${authority}/${encodeURIComponent(identity.tenantId)}/oauth2/v2.0/token`,
      form,
    });
    token = r.access_token;
  }
  if (!token) throw new Error(`No access token received for ${identity.source}`);
  mask(token);
  return token;
}

/** Exchanges an Entra access token for an ACR refresh token usable with docker login. */
export async function exchangeAcrToken(exec: Exec, registry: string, accessToken: string, mask: (s: string) => void): Promise<string> {
  const tenant = jwtClaims(accessToken).tid as string | undefined;
  const r = await httpRequest<{ refresh_token: string }>(exec, {
    url: `https://${registry}/oauth2/exchange`,
    form: { grant_type: 'access_token', service: registry, tenant, access_token: accessToken },
  });
  if (!r.refresh_token) throw new Error(`${registry} did not return a refresh token`);
  mask(r.refresh_token);
  return r.refresh_token;
}

export async function acrCredentials(
  exec: Exec,
  registry: string,
  identity: AzureIdentity,
  mask: (s: string) => void,
): Promise<RegistryCredentials> {
  try {
    const accessToken = await getEntraToken(exec, identity, mask);
    const refreshToken = await exchangeAcrToken(exec, registry, accessToken, mask);
    return { registry, username: ACR_TOKEN_USERNAME, password: refreshToken, source: identity.source };
  } catch (err) {
    throw new Error(
      `Azure Container Registry login with ${identity.source} failed: ${(err as Error).message}. ` +
        `Make sure the identity has the AcrPush role on ${registry}.`,
    );
  }
}

/** True when the instance metadata service offers a managed identity (Azure VM / VMSS agents). */
export async function hasManagedIdentity(exec: Exec): Promise<boolean> {
  const r = await exec(
    'curl',
    ['-sS', '--noproxy', '*', '--max-time', '2', '-o', '/dev/null', '-w', '%{http_code}', '-H', 'Metadata: true',
      'http://169.254.169.254/metadata/instance?api-version=2021-02-01'],
    { silent: true, ignoreReturnCode: true },
  );
  return r.stdout.trim() === '200';
}

/** Settings an Azure VM (agent, Managed DevOps Pool agent, runner) provides through its tags. */
export interface MachineSettings {
  /** tag `container-registry` */
  registry?: string;
  /** tag `container-registry-client-id`: client id of the managed identity to use */
  clientId?: string;
}

export const TAG_REGISTRY = 'container-registry';
export const TAG_CLIENT_ID = 'container-registry-client-id';

let machineSettingsPromise: Promise<MachineSettings> | undefined;

/**
 * Reads the tags of the Azure VM the agent runs on from the instance metadata service (no permissions
 * needed). Returns {} outside of Azure. The result is cached for the process.
 */
export function machineSettings(exec: Exec): Promise<MachineSettings> {
  machineSettingsPromise ??= (async () => {
    try {
      const r = await httpRequest<{ tagsList?: Array<{ name: string; value: string }> }>(exec, {
        url: 'http://169.254.169.254/metadata/instance/compute?api-version=2021-02-01',
        headers: { Metadata: 'true' },
        noProxy: true,
        timeoutSeconds: 2,
      });
      const tags = new Map((r.tagsList ?? []).map((t) => [t.name.toLowerCase().replace(/_/g, '-'), t.value.trim()]));
      return { registry: tags.get(TAG_REGISTRY) || undefined, clientId: tags.get(TAG_CLIENT_ID) || undefined };
    } catch {
      return {};
    }
  })();
  return machineSettingsPromise;
}

/** For tests. */
export function resetMachineSettings(): void {
  machineSettingsPromise = undefined;
}
