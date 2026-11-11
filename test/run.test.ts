import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Exec, ExecOptions } from '../src/core/exec';
import { run } from '../src/core/run';
import { FakePlatform } from './helpers';

function setup(vulns: unknown[] = []) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-'));
  fs.writeFileSync(path.join(workspace, 'Dockerfile'), 'FROM scratch\n');
  const calls: Array<{ args: string[]; opts?: ExecOptions }> = [];
  const exec: Exec = async (cmd, args, opts) => {
    calls.push({ args, opts });
    const out = (stdout = '') => ({ exitCode: 0, stdout, stderr: '' });
    if (args[0] === 'version') return out('29.0.0');
    if (args[0] === 'image' && args[1] === 'inspect') return out('["reg.io/app@sha256:deadbeef"]');
    if (args[0] === 'run' && args.includes('--output')) {
      const mount = args[args.indexOf('-v') + 1].split(':')[0];
      fs.writeFileSync(path.join(mount, 'trivy-report.json'), JSON.stringify({ Results: [{ Target: 'x', Vulnerabilities: vulns }] }));
    }
    return out();
  };
  const ctx = { ref: 'refs/heads/main', sha: '1234567890', isPullRequest: false, tempDir: workspace, workspace };
  return { workspace, calls, exec, ctx };
}

const vuln = { VulnerabilityID: 'CVE-1', PkgName: 'openssl', InstalledVersion: '1', FixedVersion: '2', Severity: 'HIGH' };

describe('run', () => {
  it('builds, scans, logs in, pushes and sets outputs', async () => {
    const { calls, exec, ctx } = setup();
    const p = new FakePlatform({ image: 'reg.io/app' }, ctx, { registry: 'reg.io', username: 'u', password: 'pw' });
    const r = await run(p, exec);

    const cmds = calls.map((c) => c.args[0]);
    expect(cmds).toEqual(['version', 'build', 'save', 'run', 'run', 'login', 'push', 'push', 'logout', 'image']);
    const build = calls[1].args;
    expect(build).toEqual(expect.arrayContaining(['--tag', 'reg.io/app:latest', '--tag', 'reg.io/app:1234567']));
    expect(calls.find((c) => c.args[0] === 'login')?.opts?.input).toBe('pw');
    expect(p.secrets).toContain('pw');
    expect(r.digest).toBe('sha256:deadbeef');
    expect(p.outputs).toMatchObject({
      image: 'reg.io/app',
      tags: 'reg.io/app:latest,reg.io/app:1234567',
      digest: 'sha256:deadbeef',
      imageRef: 'reg.io/app@sha256:deadbeef',
      vulnerabilities: '0',
    });
    expect(p.summary).toContain('No vulnerabilities');
  });

  it('fails without pushing when vulnerabilities are found', async () => {
    const { calls, exec, ctx } = setup([vuln]);
    const p = new FakePlatform({ image: 'reg.io/app' }, ctx);
    await expect(run(p, exec)).rejects.toThrow(/Found 1 vulnerabilities/);
    expect(calls.some((c) => c.args[0] === 'push')).toBe(false);
    expect(p.summary).toContain('CVE-1');
  });

  it('only warns when failOnVulnerabilities is false', async () => {
    const { calls, exec, ctx } = setup([vuln]);
    const p = new FakePlatform({ image: 'reg.io/app', failOnVulnerabilities: 'false' }, ctx);
    await run(p, exec);
    expect(calls.some((c) => c.args[0] === 'push')).toBe(true);
    expect(p.logs.some((l) => l.startsWith('WARN'))).toBe(true);
  });

  it('skips scan and push when disabled', async () => {
    const { calls, exec, ctx } = setup();
    const p = new FakePlatform({ image: 'reg.io/app', scan: 'false', push: 'false', tags: 'v1' }, ctx);
    const r = await run(p, exec);
    expect(calls.map((c) => c.args[0])).toEqual(['version', 'build']);
    expect(r.imageRefs).toEqual(['reg.io/app:v1']);
    expect(r.pushed).toBe(false);
  });

  it('fails when Dockerfile is missing', async () => {
    const { exec, ctx } = setup();
    await expect(run(new FakePlatform({ image: 'reg.io/app', dockerfile: 'nope' }, ctx), exec)).rejects.toThrow(/Dockerfile not found/);
  });
});

describe('proxyArgs', async () => {
  const { proxyArgs } = await import('../src/core/scan');
  it('forwards proxy env and CA bundle', () => {
    const ca = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ca-')), 'ca.crt');
    fs.writeFileSync(ca, '');
    expect(proxyArgs({ HTTPS_PROXY: 'http://p:3128', SSL_CERT_FILE: ca })).toEqual([
      '-e', 'HTTPS_PROXY', '-v', `${ca}:/etc/ssl/certs/ca-certificates.crt:ro`,
    ]);
    expect(proxyArgs({})).toEqual([]);
    expect(proxyArgs({ HTTPS_PROXY: 'http://127.0.0.1:8080' })).toEqual([]);
  });
});
