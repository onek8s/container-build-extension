import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { Exec } from '../src/core/exec';
import { FakePlatform } from './helpers';

vi.mock('../src/core/safechain', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/core/safechain')>()),
  prepareSafeChain: vi.fn(async () => '/cache/safe-chain'),
}));

const supported = process.platform === 'linux' && ['x64', 'arm64'].includes(process.arch);

describe.runIf(supported)('run with safe-chain', () => {
  it('builds an instrumented copy of the Dockerfile with the safe-chain build context', async () => {
    const { run } = await import('../src/core/run');
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-'));
    const original = 'FROM node\nRUN npm ci\n';
    fs.writeFileSync(path.join(workspace, 'Dockerfile'), original);
    fs.writeFileSync(path.join(workspace, 'Dockerfile.dockerignore'), 'node_modules\n');
    const builds: string[][] = [];
    const exec: Exec = async (_cmd, args) => {
      if (args[0] === 'build') builds.push(args);
      return { exitCode: 0, stdout: '', stderr: '' };
    };
    const ctx = { ref: 'refs/heads/main', sha: '1234567890', isPullRequest: false, tempDir: workspace, workspace };
    const p = new FakePlatform({ image: 'reg.io/app', scan: 'false', sbom: 'false', push: 'false' }, ctx);
    await run(p, exec);

    const args = builds[0];
    expect(args).toEqual(expect.arrayContaining(['--build-context', 'container-build-safe-chain=/cache/safe-chain']));
    const dockerfile = args[args.indexOf('--file') + 1];
    expect(dockerfile).not.toBe(path.join(workspace, 'Dockerfile'));
    expect(fs.readFileSync(dockerfile, 'utf8')).toContain('--mount=type=bind,from=container-build-safe-chain');
    expect(fs.readFileSync(`${dockerfile}.dockerignore`, 'utf8')).toBe('node_modules\n');
    expect(fs.readFileSync(path.join(workspace, 'Dockerfile'), 'utf8')).toBe(original);
    expect(p.summary).toContain('Safe Chain');
  });

  it('skips the minimum package age (not malware) on a re-run', async () => {
    const { run } = await import('../src/core/run');
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-'));
    fs.writeFileSync(path.join(workspace, 'Dockerfile'), 'FROM node\nRUN npm ci\n');
    const builds: string[][] = [];
    const exec: Exec = async (_c, args) => {
      if (args[0] === 'build') builds.push(args);
      return { exitCode: 0, stdout: '', stderr: '' };
    };
    const ctx = { isPullRequest: false, tempDir: workspace, workspace, attempt: 2 };
    await run(new FakePlatform({ image: 'reg.io/app', scan: 'false', sbom: 'false', push: 'false' }, ctx), exec);
    const dockerfile = builds[0][builds[0].indexOf('--file') + 1];
    expect(fs.readFileSync(dockerfile, 'utf8')).toContain('source=shims-skip-minimum-age,');
  });

  it('uses the original Dockerfile when there is nothing to protect', async () => {
    const { run } = await import('../src/core/run');
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-'));
    fs.writeFileSync(path.join(workspace, 'Dockerfile'), 'FROM scratch\nCOPY a /a\n');
    const builds: string[][] = [];
    const exec: Exec = async (_c, args) => {
      if (args[0] === 'build') builds.push(args);
      return { exitCode: 0, stdout: '', stderr: '' };
    };
    const ctx = { isPullRequest: false, tempDir: workspace, workspace };
    await run(new FakePlatform({ image: 'reg.io/app', scan: 'false', sbom: 'false', push: 'false' }, ctx), exec);
    expect(builds[0]).not.toContain('--build-context');
    expect(builds[0][builds[0].indexOf('--file') + 1]).toBe(path.join(workspace, 'Dockerfile'));
  });
});
