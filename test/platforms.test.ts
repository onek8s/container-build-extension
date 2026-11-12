import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AzurePlatform } from '../src/azure/platform';
import { GitHubPlatform } from '../src/github/platform';

afterEach(() => vi.restoreAllMocks());

describe('GitHubPlatform', () => {
  it('reads kebab-case inputs and context', () => {
    const p = new GitHubPlatform({
      'INPUT_BUILD-ARGS': ' A=1 ',
      INPUT_IMAGE: 'ghcr.io/o/a',
      GITHUB_SHA: 'abc',
      GITHUB_REF: 'refs/pull/1/merge',
      GITHUB_EVENT_NAME: 'pull_request',
    });
    expect(p.getInput('buildArgs')).toBe('A=1');
    expect(p.getInput('failOnVulnerabilities')).toBeUndefined();
    expect(p.context).toMatchObject({ sha: 'abc', ref: 'refs/pull/1/merge', isPullRequest: true });
  });

  it('uses github token for ghcr.io only', () => {
    const p = new GitHubPlatform({ 'INPUT_GITHUB-TOKEN': 'tok', GITHUB_ACTOR: 'me' });
    expect(p.getCredentials('ghcr.io')).toBeUndefined();
    expect(p.getFallbackCredentials('ghcr.io')).toEqual({ registry: 'ghcr.io', username: 'me', password: 'tok' });
    expect(p.getFallbackCredentials('docker.io')).toBeUndefined();
  });

  it('prefers explicit username/password', () => {
    const p = new GitHubPlatform({ INPUT_USERNAME: 'u', INPUT_PASSWORD: 'p', 'INPUT_GITHUB-TOKEN': 'tok' });
    expect(p.getCredentials('ghcr.io')).toEqual({ registry: 'ghcr.io', username: 'u', password: 'p' });
    expect(() => new GitHubPlatform({ INPUT_PASSWORD: 'p' }).getCredentials('x.io')).toThrow(/username/);
  });

  it('derives naming context from GITHUB_REPOSITORY and reads env variables', () => {
    const p = new GitHubPlatform({ GITHUB_REPOSITORY: 'OneK8s/My_App', CONTAINER_REGISTRY: ' acr.io ' });
    expect(p.context).toMatchObject({ project: 'OneK8s', repository: 'My_App' });
    expect(p.getVariable('CONTAINER_REGISTRY')).toBe('acr.io');
    expect(p.getDefaultRegistry()).toBe('ghcr.io');
  });

  it('writes outputs to GITHUB_OUTPUT', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gh-')), 'out');
    new GitHubPlatform({ GITHUB_OUTPUT: file }).setOutput('imageRef', 'a@sha256:1');
    expect(fs.readFileSync(file, 'utf8')).toMatch(/^image-ref<<(\S+)\na@sha256:1\n\1\n$/);
  });
});

describe('AzurePlatform', () => {
  const id = '1f2e3d4c-aaaa-bbbb-cccc-000000000001';
  const ID = id.toUpperCase();

  it('reads docker registry service connection and removes secrets from env', () => {
    const env: NodeJS.ProcessEnv = {
      INPUT_CONTAINERREGISTRY: id,
      [`ENDPOINT_AUTH_SCHEME_${ID}`]: 'UsernamePassword',
      [`ENDPOINT_AUTH_PARAMETER_${ID}_USERNAME`]: 'user',
      [`ENDPOINT_AUTH_PARAMETER_${ID}_PASSWORD`]: 'secret',
      [`ENDPOINT_AUTH_PARAMETER_${ID}_REGISTRY`]: 'https://index.docker.io/v1/',
    };
    const p = new AzurePlatform(env);
    expect(p.getCredentials('docker.io')).toEqual({ registry: 'https://index.docker.io/v1/', username: 'user', password: 'secret' });
    expect(Object.keys(env).some((k) => k.startsWith('ENDPOINT_AUTH'))).toBe(false);
  });

  it('reads ACR service principal connection', () => {
    const p = new AzurePlatform({
      INPUT_CONTAINERREGISTRY: id,
      [`ENDPOINT_AUTH_SCHEME_${ID}`]: 'ServicePrincipal',
      [`ENDPOINT_DATA_${ID}_REGISTRYTYPE`]: 'ACR',
      [`ENDPOINT_AUTH_PARAMETER_${ID}_LOGINSERVER`]: 'MyAcr.azurecr.io',
      [`ENDPOINT_AUTH_PARAMETER_${ID}_SERVICEPRINCIPALID`]: 'spid',
      [`ENDPOINT_AUTH_PARAMETER_${ID}_SERVICEPRINCIPALKEY`]: 'spkey',
    });
    expect(p.getCredentials('myacr.azurecr.io')).toEqual({ registry: 'myacr.azurecr.io', username: 'spid', password: 'spkey' });
  });

  it('explains unsupported schemes', () => {
    const p = new AzurePlatform({
      INPUT_CONTAINERREGISTRY: id,
      [`ENDPOINT_AUTH_SCHEME_${ID}`]: 'WorkloadIdentityFederation',
      [`ENDPOINT_DATA_${ID}_REGISTRYTYPE`]: 'ACR',
    });
    expect(() => p.getCredentials('x.azurecr.io')).toThrow(/az acr login/);
  });

  it('reads plain and secret variables and the naming context', () => {
    const env: NodeJS.ProcessEnv = {
      CONTAINER_REGISTRY: 'myacr.azurecr.io',
      SECRET_CONTAINER_REGISTRY_PASSWORD: 'pw',
      SYSTEM_TEAMPROJECT: 'Web Shop',
      BUILD_REPOSITORY_NAME: 'owner/Front.End',
    };
    const p = new AzurePlatform(env);
    expect(p.getVariable('CONTAINER_REGISTRY')).toBe('myacr.azurecr.io');
    expect(p.getVariable('CONTAINER_REGISTRY_PASSWORD')).toBe('pw');
    expect(env.SECRET_CONTAINER_REGISTRY_PASSWORD).toBeUndefined();
    expect(p.context).toMatchObject({ project: 'Web Shop', repository: 'Front.End' });
  });

  it('uses the service connection registry as default registry', () => {
    const p = new AzurePlatform({
      INPUT_CONTAINERREGISTRY: id,
      [`ENDPOINT_URL_${ID}`]: 'https://index.docker.io/v1/',
      [`ENDPOINT_AUTH_PARAMETER_${ID}_LOGINSERVER`]: 'myacr.azurecr.io',
    });
    expect(p.getDefaultRegistry()).toBe('myacr.azurecr.io');
    expect(new AzurePlatform({}).getDefaultRegistry()).toBeUndefined();
  });

  it('maps context and escapes logging commands', () => {
    const p = new AzurePlatform({ BUILD_SOURCEBRANCH: 'refs/heads/main', BUILD_SOURCEVERSION: 'abc', BUILD_REASON: 'PullRequest' });
    expect(p.context).toMatchObject({ ref: 'refs/heads/main', sha: 'abc', isPullRequest: true });
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    p.setOutput('digest', 'a;b]\nc');
    expect(write).toHaveBeenCalledWith('##vso[task.setvariable variable=digest;isOutput=true]a;b]%0Ac' + os.EOL);
  });
});
