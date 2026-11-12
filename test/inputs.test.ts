import { describe, expect, it } from 'vitest';
import { parseBool, parseImage, parseLines, parseList, readInputs } from '../src/core/inputs';
import { FakePlatform } from './helpers';

const ctx = { ref: 'refs/heads/main', sha: 'abc1234', isPullRequest: false, tempDir: '/tmp', workspace: '/w' };

describe('parseImage', () => {
  it.each([
    ['myacr.azurecr.io/team/app', 'myacr.azurecr.io', 'myacr.azurecr.io/team/app'],
    ['ghcr.io/Owner/App', 'ghcr.io', 'ghcr.io/owner/app'],
    ['localhost:5000/app', 'localhost:5000', 'localhost:5000/app'],
    ['localhost/app', 'localhost', 'localhost/app'],
    ['user/app', 'docker.io', 'user/app'],
    ['nginx', 'docker.io', 'nginx'],
    ['ghcr.io/o/app:1.0', 'ghcr.io', 'ghcr.io/o/app'],
  ])('%s', (image, registry, repository) => expect(parseImage(image)).toEqual({ registry, repository }));

  it('rejects digests and garbage', () => {
    expect(() => parseImage('a/b@sha256:abc')).toThrow();
    expect(() => parseImage('a b')).toThrow();
    expect(() => parseImage('')).toThrow();
  });
});

describe('parsers', () => {
  it('bool', () => {
    expect(parseBool(undefined, true)).toBe(true);
    expect(parseBool('False', true)).toBe(false);
    expect(() => parseBool('maybe', true)).toThrow();
  });
  it('list', () => expect(parseList('a, b\nc,,')).toEqual(['a', 'b', 'c']));
  it('lines keep commas', () => expect(parseLines('A=1,2\n# c\n\nB=x')).toEqual(['A=1,2', 'B=x']));
});

describe('readInputs', () => {
  it('applies defaults', () => {
    const i = readInputs(new FakePlatform({ image: 'ghcr.io/o/app' }, ctx));
    expect(i).toMatchObject({
      registry: 'ghcr.io',
      context: '/w',
      dockerfile: '/w/Dockerfile',
      push: true,
      scan: true,
      severity: 'CRITICAL,HIGH',
      failOnVulnerabilities: true,
      ignoreUnfixed: true,
      sbom: true,
      sbomFormat: 'cyclonedx',
      safeChain: true,
    });
    expect(i.trivyImage).toMatch(/^ghcr\.io\/aquasecurity\/trivy:\d/);
  });
  it('auto push is off for pull requests', () => {
    expect(readInputs(new FakePlatform({ image: 'a.io/b' }, { ...ctx, isPullRequest: true })).push).toBe(false);
    expect(readInputs(new FakePlatform({ image: 'a.io/b', push: 'true' }, { ...ctx, isPullRequest: true })).push).toBe(true);
  });
  it('resolves paths', () => {
    const i = readInputs(new FakePlatform({ image: 'a.io/b', context: 'app', dockerfile: 'build/Dockerfile.prod' }, ctx));
    expect(i.context).toBe('/w/app');
    expect(i.dockerfile).toBe('/w/build/Dockerfile.prod');
  });
  it('validates severity', () => {
    expect(() => readInputs(new FakePlatform({ image: 'a.io/b', severity: 'HIGH,BAD' }, ctx))).toThrow(/severity/);
  });
  it('validates sbomFormat', () => {
    expect(readInputs(new FakePlatform({ image: 'a.io/b', sbomFormat: 'SPDX-JSON' }, ctx)).sbomFormat).toBe('spdx-json');
    expect(() => readInputs(new FakePlatform({ image: 'a.io/b', sbomFormat: 'xml' }, ctx))).toThrow(/sbomFormat/);
  });
  it('requires image', () => expect(() => readInputs(new FakePlatform({}, ctx))).toThrow(/image/));
});
