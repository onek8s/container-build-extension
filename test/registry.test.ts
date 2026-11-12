import { describe, expect, it } from 'vitest';
import {
  defaultImagePath,
  normalizeRegistry,
  resolveCredentials,
  resolveImage,
  sanitizeComponent,
} from '../src/core/registry';
import { FakePlatform } from './helpers';

const ctx = { isPullRequest: false, tempDir: '/tmp', workspace: '/w', project: 'Web Shop', repository: 'Front_End.App' };

function platform(inputs: Record<string, string> = {}, variables: Record<string, string> = {}, defaultRegistry?: string) {
  const p = new FakePlatform(inputs, ctx);
  p.variables = variables;
  p.defaultRegistry = defaultRegistry;
  return p;
}

describe('normalizeRegistry', () => {
  it.each([
    ['https://MyAcr.azurecr.io/', 'myacr.azurecr.io'],
    ['https://index.docker.io/v1/', 'docker.io'],
    ['registry-1.docker.io/myorg', 'docker.io/myorg'],
    ['ghcr.io/my-org', 'ghcr.io/my-org'],
    ['localhost:5000', 'localhost:5000'],
  ])('%s -> %s', (input, expected) => expect(normalizeRegistry(input)).toBe(expected));
});

describe('image naming', () => {
  it('sanitizes components', () => {
    expect(sanitizeComponent('Web Shop')).toBe('web-shop');
    expect(sanitizeComponent('--Front__End..App--')).toBe('front-end-app');
  });
  it('uses project/repository, only repository on Docker Hub', () => {
    expect(defaultImagePath(ctx, 'myacr.azurecr.io')).toBe('web-shop/front_end.app');
    expect(defaultImagePath(ctx, 'docker.io/myorg')).toBe('front_end.app');
    expect(defaultImagePath({ ...ctx, repository: undefined }, 'x.io')).toBeUndefined();
  });

  it('derives the image from registry input, variable or platform default', () => {
    expect(resolveImage(platform({ registry: 'myacr.azurecr.io' }))).toBe('myacr.azurecr.io/web-shop/front_end.app');
    expect(resolveImage(platform({}, { CONTAINER_REGISTRY: 'https://MyAcr.azurecr.io/team' }))).toBe(
      'myacr.azurecr.io/team/web-shop/front_end.app',
    );
    expect(resolveImage(platform({}, {}, 'ghcr.io'))).toBe('ghcr.io/web-shop/front_end.app');
    // input wins over variable, variable over default
    expect(resolveImage(platform({ registry: 'a.io' }, { CONTAINER_REGISTRY: 'b.io' }, 'c.io'))).toMatch(/^a\.io\//);
    expect(resolveImage(platform({}, { CONTAINER_REGISTRY: 'b.io' }, 'c.io'))).toMatch(/^b\.io\//);
  });

  it('prefixes a short image name with the registry and keeps full names', () => {
    expect(resolveImage(platform({ image: 'tools/api' }, { CONTAINER_REGISTRY: 'acr.io' }))).toBe('acr.io/tools/api');
    expect(resolveImage(platform({ image: 'other.io/x' }, { CONTAINER_REGISTRY: 'acr.io' }))).toBe('other.io/x');
    expect(resolveImage(platform({ image: 'nginx' }))).toBe('nginx');
  });

  it('explains what is missing', () => {
    expect(() => resolveImage(platform())).toThrow(/CONTAINER_REGISTRY/);
    expect(() => resolveImage(platform({ registry: 'docker.io' }))).toThrow(/namespace/);
    expect(resolveImage(platform({ registry: 'docker.io/myorg' }))).toBe('docker.io/myorg/front_end.app');
  });
});

describe('resolveCredentials', () => {
  const vars = { CONTAINER_REGISTRY: 'myacr.azurecr.io/team', CONTAINER_REGISTRY_USERNAME: 'u', CONTAINER_REGISTRY_PASSWORD: 'p' };

  it('uses organization variables for the configured registry', () => {
    expect(resolveCredentials(platform({}, vars), 'myacr.azurecr.io')).toEqual({
      registry: 'myacr.azurecr.io',
      username: 'u',
      password: 'p',
    });
  });

  it('never sends organization credentials to another registry', () => {
    expect(resolveCredentials(platform({}, vars), 'evil.example.com')).toBeUndefined();
    expect(resolveCredentials(platform({}, { CONTAINER_REGISTRY_USERNAME: 'u', CONTAINER_REGISTRY_PASSWORD: 'p' }), 'x.io')).toBeUndefined();
  });

  it('prefers explicit credentials and falls back to the platform', () => {
    const p = platform({}, vars);
    p.creds = { registry: 'myacr.azurecr.io', username: 'sc', password: 'scpw' };
    expect(resolveCredentials(p, 'myacr.azurecr.io')?.username).toBe('sc');

    const q = platform();
    q.getFallbackCredentials = (r) => ({ registry: r, username: 'actor', password: 'token' });
    expect(resolveCredentials(q, 'ghcr.io')?.password).toBe('token');
  });

  it('requires a username', () => {
    expect(() => resolveCredentials(platform({}, { CONTAINER_REGISTRY: 'a.io', CONTAINER_REGISTRY_PASSWORD: 'p' }), 'a.io')).toThrow(
      /USERNAME/,
    );
  });
});
