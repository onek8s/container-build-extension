import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ACR_TOKEN_USERNAME, acrCredentials, isAcr, workloadIdentityFromEnv } from '../src/core/azure';
import type { Exec } from '../src/core/exec';
import { httpRequest } from '../src/core/http';
import { resolveCredentials } from '../src/core/registry';
import { FakePlatform } from './helpers';

/** Fake curl: parses the stdin config and answers from a route table. */
function fakeCurl(routes: Record<string, unknown>, calls: Array<{ url: string; config: string }> = []): Exec {
  return async (cmd, args, opts) => {
    if (cmd !== 'curl') throw new Error(`unexpected ${cmd}`);
    if (args.includes('-w')) {
      // managed identity probe
      return { exitCode: 0, stdout: routes.imds ? '200' : '000', stderr: '' };
    }
    const config = opts?.input ?? '';
    const url = config.match(/^url = "(.*)"$/m)?.[1] ?? '';
    calls.push({ url, config });
    const key = Object.keys(routes).find((k) => url.includes(k));
    if (!key) return { exitCode: 22, stdout: '{"error":"not found"}', stderr: '' };
    return { exitCode: 0, stdout: JSON.stringify(routes[key]), stderr: '' };
  };
}

// header.payload.signature with tid claim
const jwt = (claims: object) => `x.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.y`;
const entraToken = jwt({ tid: 'tenant-1' });

describe('httpRequest', () => {
  it('passes everything through a curl config on stdin and escapes values', async () => {
    let seen: { args: string[]; input?: string } | undefined;
    const exec: Exec = async (_c, args, o) => {
      seen = { args, input: o?.input };
      return { exitCode: 0, stdout: '{"ok":true}', stderr: '' };
    };
    const r = await httpRequest(exec, { url: 'https://h/x', headers: { A: 'b"c\\d' }, form: { k: 'v w', skip: undefined }, noProxy: true });
    expect(r).toEqual({ ok: true });
    expect(seen?.args).toEqual(expect.arrayContaining(['--config', '-', '--noproxy', '*', '--fail-with-body']));
    expect(seen?.args.join(' ')).not.toContain('https://h/x');
    expect(seen?.input).toContain('header = "A: b\\"c\\\\d"');
    expect(seen?.input).toContain('data = "k=v%20w"');
    expect(seen?.input).toContain('request = "POST"');
  });

  it('reports failures with the response body', async () => {
    const exec: Exec = async () => ({ exitCode: 22, stdout: '{"error":"invalid_client"}', stderr: '' });
    await expect(httpRequest(exec, { url: 'https://login.example/t' })).rejects.toThrow(/login\.example.*invalid_client/);
  });
});

describe('Azure Container Registry login', () => {
  it('recognizes ACR hosts', () => {
    expect(isAcr('myacr.azurecr.io')).toBe(true);
    expect(isAcr('myacr.azurecr.cn')).toBe(true);
    expect(isAcr('ghcr.io')).toBe(false);
    expect(isAcr('azurecr.io.evil.com')).toBe(false);
  });

  it('exchanges a federated token for an ACR refresh token', async () => {
    const calls: Array<{ url: string; config: string }> = [];
    const exec = fakeCurl(
      { '/tenant-1/oauth2/v2.0/token': { access_token: entraToken }, '/oauth2/exchange': { refresh_token: 'acr-refresh' } },
      calls,
    );
    const masked: string[] = [];
    const creds = await acrCredentials(
      exec,
      'myacr.azurecr.io',
      { kind: 'federated', source: 'test', tenantId: 'tenant-1', clientId: 'app', getAssertion: async () => 'oidc' },
      (s) => masked.push(s),
    );
    expect(creds).toEqual({ registry: 'myacr.azurecr.io', username: ACR_TOKEN_USERNAME, password: 'acr-refresh', source: 'test' });
    expect(calls[0].url).toBe('https://login.microsoftonline.com/tenant-1/oauth2/v2.0/token');
    expect(calls[0].config).toContain('client_assertion=oidc');
    expect(calls[0].config).toContain('client_assertion_type=urn%3Aietf%3Aparams%3Aoauth%3Aclient-assertion-type%3Ajwt-bearer');
    expect(calls[0].config).toContain(`scope=${encodeURIComponent('https://management.azure.com/.default')}`);
    expect(calls[1].url).toBe('https://myacr.azurecr.io/oauth2/exchange');
    expect(calls[1].config).toContain('service=myacr.azurecr.io&tenant=tenant-1&access_token=');
    expect(masked).toEqual(['oidc', entraToken, 'acr-refresh']);
  });

  it('uses the instance metadata service for managed identities', async () => {
    const calls: Array<{ url: string; config: string }> = [];
    const exec = fakeCurl({ '169.254.169.254/metadata/identity': { access_token: entraToken }, '/oauth2/exchange': { refresh_token: 'r' } }, calls);
    await acrCredentials(exec, 'myacr.azurecr.io', { kind: 'managed', source: 'mi', clientId: 'uami' }, () => {});
    expect(calls[0].url).toContain('resource=https%3A%2F%2Fmanagement.azure.com%2F&client_id=uami');
    expect(calls[0].config).toContain('header = "Metadata: true"');
  });

  it('explains failures', async () => {
    const exec = fakeCurl({});
    await expect(
      acrCredentials(exec, 'myacr.azurecr.io', { kind: 'secret', source: 'sp', tenantId: 't', clientId: 'c', clientSecret: 's' }, () => {}),
    ).rejects.toThrow(/login with sp failed.*AcrPush/);
  });

  it('reads AKS workload identity from the environment', async () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wi-')), 'token');
    fs.writeFileSync(file, 'k8s-token\n');
    const identity = workloadIdentityFromEnv({ AZURE_CLIENT_ID: 'c', AZURE_TENANT_ID: 't', AZURE_FEDERATED_TOKEN_FILE: file });
    expect(identity).toMatchObject({ kind: 'federated', source: 'AKS workload identity', clientId: 'c', tenantId: 't' });
    expect(identity?.kind === 'federated' && (await identity.getAssertion())).toBe('k8s-token');
    expect(workloadIdentityFromEnv({ AZURE_CLIENT_ID: 'c' })).toBeUndefined();
  });
});

describe('resolveCredentials for ACR', () => {
  const ctx = { isPullRequest: false, tempDir: '/tmp', workspace: '/w' };
  const routes = { '/oauth2/v2.0/token': { access_token: entraToken }, '169.254.169.254/metadata/identity': { access_token: entraToken }, '/oauth2/exchange': { refresh_token: 'r' } };

  it('prefers the platform identity', async () => {
    const p = new FakePlatform({}, ctx);
    p.getAzureIdentity = () => ({ kind: 'federated', source: 'GitHub OIDC', tenantId: 't', clientId: 'c', getAssertion: async () => 'x' });
    const creds = await resolveCredentials(p, 'myacr.azurecr.io', { exec: fakeCurl(routes), env: {} });
    expect(creds).toMatchObject({ source: 'GitHub OIDC', username: ACR_TOKEN_USERNAME });
    expect(p.secrets).toContain('r');
  });

  it('keeps an existing docker login before trying agent identities', async () => {
    const creds = await resolveCredentials(new FakePlatform({}, ctx), 'myacr.azurecr.io', {
      exec: fakeCurl({ ...routes, imds: true }),
      env: {},
      hasExistingLogin: () => true,
    });
    expect(creds).toBeUndefined();
  });

  it('falls back to the managed identity of the agent', async () => {
    const creds = await resolveCredentials(new FakePlatform({}, ctx), 'myacr.azurecr.io', {
      exec: fakeCurl({ ...routes, imds: true }),
      env: { AZURE_CLIENT_ID: 'uami' },
    });
    expect(creds).toMatchObject({ source: 'managed identity' });
  });

  it('does nothing without an identity, and never for other registries', async () => {
    expect(await resolveCredentials(new FakePlatform({}, ctx), 'myacr.azurecr.io', { exec: fakeCurl(routes), env: {} })).toBeUndefined();
    expect(await resolveCredentials(new FakePlatform({}, ctx), 'ghcr.io', { exec: fakeCurl({ ...routes, imds: true }), env: {} })).toBeUndefined();
  });
});

describe('hasDockerLogin', async () => {
  const { hasDockerLogin } = await import('../src/core/docker');
  it('detects auths and credential helpers', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-'));
    fs.writeFileSync(
      path.join(dir, 'config.json'),
      JSON.stringify({ auths: { 'https://myacr.azurecr.io': {} }, credHelpers: { 'other.azurecr.io': 'acr-env' } }),
    );
    expect(hasDockerLogin('myacr.azurecr.io', { DOCKER_CONFIG: dir })).toBe(true);
    expect(hasDockerLogin('other.azurecr.io', { DOCKER_CONFIG: dir })).toBe(true);
    expect(hasDockerLogin('third.azurecr.io', { DOCKER_CONFIG: dir })).toBe(false);
    expect(hasDockerLogin('x.io', { DOCKER_CONFIG: path.join(dir, 'missing') })).toBe(false);
  });
});

describe('VM tags', async () => {
  const { machineSettings, resetMachineSettings } = await import('../src/core/azure');
  const { needsMachineSettings, resolveImage } = await import('../src/core/registry');
  const ctx = { isPullRequest: false, tempDir: '/tmp', workspace: '/w', project: 'Shop', repository: 'Web' };

  it('reads registry and client id from the instance metadata tags', async () => {
    resetMachineSettings();
    const calls: Array<{ url: string; config: string }> = [];
    const exec = fakeCurl(
      {
        '/metadata/instance/compute': {
          tagsList: [
            { name: 'Container_Registry', value: ' myacr.azurecr.io ' },
            { name: 'container-registry-client-id', value: 'uami' },
            { name: 'env', value: 'prod' },
          ],
        },
      },
      calls,
    );
    expect(await machineSettings(exec)).toEqual({ registry: 'myacr.azurecr.io', clientId: 'uami' });
    expect(calls[0].config).toContain('header = "Metadata: true"');
    // cached
    await machineSettings(exec);
    expect(calls).toHaveLength(1);
  });

  it('returns nothing outside of Azure', async () => {
    resetMachineSettings();
    expect(await machineSettings(fakeCurl({}))).toEqual({});
  });

  it('uses the tag after pipeline settings and before the GitHub fallback', () => {
    const p = new FakePlatform({}, ctx);
    p.fallbackRegistry = 'ghcr.io';
    expect(needsMachineSettings(p)).toBe(true);
    expect(resolveImage(p, { registry: 'myacr.azurecr.io' })).toBe('myacr.azurecr.io/shop/web');
    expect(resolveImage(p, {})).toBe('ghcr.io/shop/web');
    p.variables = { CONTAINER_REGISTRY: 'other.azurecr.io' };
    expect(needsMachineSettings(p)).toBe(false);
    expect(resolveImage(p, { registry: 'myacr.azurecr.io' })).toBe('other.azurecr.io/shop/web');
    expect(needsMachineSettings(new FakePlatform({ image: 'x.io/a' }, ctx))).toBe(false);
  });

  it('selects the managed identity from the client id tag', async () => {
    resetMachineSettings();
    const calls: Array<{ url: string; config: string }> = [];
    const exec = fakeCurl(
      {
        imds: true,
        '/metadata/instance/compute': { tagsList: [{ name: 'container-registry-client-id', value: 'tagged-uami' }] },
        '169.254.169.254/metadata/identity': { access_token: entraToken },
        '/oauth2/exchange': { refresh_token: 'r' },
      },
      calls,
    );
    await resolveCredentials(new FakePlatform({}, ctx), 'myacr.azurecr.io', { exec, env: {} });
    expect(calls.find((c) => c.url.includes('/metadata/identity'))?.url).toContain('client_id=tagged-uami');
    resetMachineSettings();
  });
});
