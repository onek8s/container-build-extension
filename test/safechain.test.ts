import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { Exec } from '../src/core/exec';
import { instrumentDockerfile, prepareSafeChain, SAFE_CHAIN_CONTEXT, SAFE_CHAIN_VERSION } from '../src/core/safechain';

const MOUNT = `--mount=type=cache,id=${SAFE_CHAIN_CONTEXT}`;

describe('instrumentDockerfile', () => {
  it('wraps shell-form RUN and keeps flags, continuations and other instructions', () => {
    const src = [
      '# syntax=docker/dockerfile:1',
      'FROM node:22 AS build',
      'WORKDIR /app',
      'RUN --mount=type=cache,target=/root/.npm npm ci \\',
      '  # a comment inside a continuation',
      '  && npm run build',
      'run pip install -r requirements.txt',
      'FROM scratch',
      'COPY --from=build /app/dist /',
    ].join('\n');
    const r = instrumentDockerfile(src);
    expect(r).toMatchObject({ wrapped: 2, skipped: 0 });
    const lines = r.content.split('\n');
    expect(lines[0]).toBe('# syntax=docker/dockerfile:1');
    expect(lines[3]).toMatch(/^RUN --mount=type=cache,target=\/root\/.npm --mount=type=cache,id=container-build-safe-chain.* export PATH=".*shims:.*bin:\$PATH"; npm ci \\$/);
    expect(lines[4]).toBe('  # a comment inside a continuation');
    expect(lines[5]).toBe('  && npm run build');
    expect(lines[6]).toContain(MOUNT);
    expect(lines[6]).toMatch(/; pip install -r requirements.txt$/);
    expect(lines.slice(7)).toEqual(['FROM scratch', 'COPY --from=build /app/dist /']);
  });

  it('leaves exec form, heredocs and custom shells alone', () => {
    const src = [
      'FROM python:3',
      'RUN ["pip", "install", "x"]',
      'RUN <<EOF',
      'pip install y',
      'EOF',
      'SHELL ["/bin/bash", "-c"]',
      'RUN pip install z',
      'FROM node',
      'RUN npm ci',
    ].join('\n');
    const r = instrumentDockerfile(src);
    expect(r).toMatchObject({ wrapped: 1, skipped: 3 });
    const lines = r.content.split('\n');
    expect(lines.slice(0, 8)).toEqual(src.split('\n').slice(0, 8));
    expect(lines[8]).toContain(MOUNT);
  });

  it('does not touch RUN-looking lines inside a continuation', () => {
    const r = instrumentDockerfile('FROM a\nENV X=1 \\\n    RUN=2\nRUN echo hi');
    expect(r.wrapped).toBe(1);
    expect(r.content.split('\n')[2]).toBe('    RUN=2');
  });

  it('skips Windows Dockerfiles', () => {
    const r = instrumentDockerfile('# escape=`\nFROM mcr.microsoft.com/windows\nRUN echo hi');
    expect(r).toMatchObject({ wrapped: 0, reason: expect.stringContaining('escape') });
  });
});

describe('prepareSafeChain', () => {
  const content = 'fake-binary';
  const sha = createHash('sha256').update(content).digest('hex');

  function fakeExec(body = content) {
    const calls: string[][] = [];
    const exec: Exec = async (cmd, args, opts) => {
      calls.push([cmd, ...args]);
      if (cmd === 'curl') fs.writeFileSync(args[args.indexOf('-o') + 1], body);
      if (args[0] === 'setup-ci') {
        expect(opts?.env?.GITHUB_PATH).toBeUndefined();
        const dir = path.dirname(path.dirname(cmd));
        fs.mkdirSync(path.join(dir, 'shims'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'shims', 'npm'), '#!/bin/sh');
        fs.mkdirSync(path.join(dir, 'certs'), { recursive: true });
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    };
    return { exec, calls };
  }

  it('downloads, verifies, sets up shims and reuses the cache', async () => {
    const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-'));
    const { exec, calls } = fakeExec();
    process.env.GITHUB_PATH = '/should/not/leak';
    const dir = await prepareSafeChain(exec, cache, 'x64', sha);
    delete process.env.GITHUB_PATH;
    expect(dir).toBe(path.join(cache, 'container-build-safe-chain', SAFE_CHAIN_VERSION, 'x64'));
    expect(calls[0]).toEqual(expect.arrayContaining(['curl', expect.stringContaining(`/${SAFE_CHAIN_VERSION}/safe-chain-linuxstatic-x64`)]));
    expect(fs.existsSync(path.join(dir, 'shims', 'npm'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'certs'))).toBe(false);

    const second = fakeExec();
    await prepareSafeChain(second.exec, cache, 'x64', sha);
    expect(second.calls).toEqual([]);
  });

  it('rejects a binary with a wrong checksum', async () => {
    const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-'));
    await expect(prepareSafeChain(fakeExec('evil').exec, cache, 'x64', sha)).rejects.toThrow(/Checksum mismatch/);
    expect(fs.readdirSync(path.join(cache, 'container-build-safe-chain', SAFE_CHAIN_VERSION, 'x64', 'bin'))).toEqual([]);
  });

  it('rejects unsupported architectures', async () => {
    await expect(prepareSafeChain(fakeExec().exec, os.tmpdir(), 'ia32')).rejects.toThrow(/architecture/);
  });
});
