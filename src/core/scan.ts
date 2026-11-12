import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Exec } from './exec';

export interface Vulnerability {
  id: string;
  pkg: string;
  installed: string;
  fixed?: string;
  severity: string;
  title?: string;
  target: string;
}

export interface ScanResult {
  vulnerabilities: Vulnerability[];
  counts: Record<string, number>;
  reportFile: string;
}

interface TrivyReport {
  Results?: Array<{
    Target: string;
    Vulnerabilities?: Array<{
      VulnerabilityID: string;
      PkgName: string;
      InstalledVersion: string;
      FixedVersion?: string;
      Severity: string;
      Title?: string;
    }>;
  }>;
}

export function parseTrivyReport(json: string): Vulnerability[] {
  const report = JSON.parse(json) as TrivyReport;
  const out: Vulnerability[] = [];
  for (const result of report.Results ?? []) {
    for (const v of result.Vulnerabilities ?? []) {
      out.push({
        id: v.VulnerabilityID,
        pkg: v.PkgName,
        installed: v.InstalledVersion,
        fixed: v.FixedVersion || undefined,
        severity: v.Severity,
        title: v.Title,
        target: result.Target,
      });
    }
  }
  return out;
}

export function countBySeverity(vulns: Vulnerability[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const v of vulns) counts[v.severity] = (counts[v.severity] ?? 0) + 1;
  return counts;
}

/**
 * Forwards proxy settings and a custom CA bundle (corporate proxies, self-hosted agents)
 * to the scanner container so it can download its vulnerability database.
 */
export function proxyArgs(env: NodeJS.ProcessEnv): string[] {
  const args: string[] = [];
  for (const name of ['HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'no_proxy']) {
    const value = env[name];
    // a proxy on the host's loopback is not reachable from inside the container
    if (value && !(name.toUpperCase() !== 'NO_PROXY' && /\/\/(localhost|127\.|\[::1\])/.test(value))) args.push('-e', name);
  }
  const ca = [env.SSL_CERT_FILE, env.NODE_EXTRA_CA_CERTS].find((f) => f && fs.existsSync(f));
  if (ca) args.push('-v', `${ca}:/etc/ssl/certs/ca-certificates.crt:ro`);
  return args;
}

export type SbomFormat = 'cyclonedx' | 'spdx-json';

/**
 * Runs Trivy in a container against a locally built image.
 * The image is exported once with `docker save`, so no docker socket has to be shared with the
 * scanner, which keeps it working with remote / rootless daemons too.
 */
export class Trivy {
  private constructor(
    private readonly exec: Exec,
    readonly workDir: string,
    private readonly runArgs: string[],
  ) {}

  static async prepare(
    exec: Exec,
    opts: { imageRef: string; trivyImage: string; tempDir: string; ignoreFile?: string },
  ): Promise<Trivy> {
    const workDir = fs.mkdtempSync(path.join(opts.tempDir, 'container-scan-'));
    const cacheDir = path.join(opts.tempDir, 'trivy-cache');
    fs.mkdirSync(cacheDir, { recursive: true });
    await exec('docker', ['save', '--output', path.join(workDir, 'image.tar'), opts.imageRef], { silent: true });

    const run = ['run', '--rm', '-v', `${workDir}:/scan`, '-v', `${cacheDir}:/cache`];
    if (typeof process.getuid === 'function' && process.getuid() !== 0) {
      run.push('--user', `${process.getuid()}:${process.getgid?.() ?? 0}`, '-e', 'HOME=/tmp');
    }
    if (opts.ignoreFile) run.push('-v', `${opts.ignoreFile}:/scan-config/.trivyignore:ro`);
    run.push(...proxyArgs(process.env));
    run.push(opts.trivyImage);
    return new Trivy(exec, workDir, run);
  }

  private trivy(args: string[], options = {}) {
    return this.exec('docker', [...this.runArgs, ...args], options);
  }

  /** Generates an SBOM of the image and returns its path on the host. */
  async sbom(format: SbomFormat, repository: string): Promise<string> {
    const base = repository.replace(/[^a-z0-9.-]+/g, '_');
    const name = `${base}.${format === 'cyclonedx' ? 'cdx' : 'spdx'}.json`;
    await this.trivy([
      'image', '--input', '/scan/image.tar', '--cache-dir', '/cache',
      '--format', format, '--output', `/scan/${name}`, '--no-progress', '--quiet',
    ]);
    return path.join(this.workDir, name);
  }

  async scan(opts: { severity: string; ignoreUnfixed: boolean; ignoreFile?: string }): Promise<ScanResult> {
    const args = [
      'image', '--input', '/scan/image.tar', '--cache-dir', '/cache',
      '--scanners', 'vuln', '--severity', opts.severity,
      '--format', 'json', '--output', '/scan/trivy-report.json',
      '--exit-code', '0', '--no-progress',
    ];
    if (opts.ignoreUnfixed) args.push('--ignore-unfixed');
    if (opts.ignoreFile) args.push('--ignorefile', '/scan-config/.trivyignore');
    await this.trivy(args);
    // human readable table in the log
    await this.trivy(['convert', '--format', 'table', '/scan/trivy-report.json'], { ignoreReturnCode: true });

    const reportFile = path.join(this.workDir, 'trivy-report.json');
    const vulnerabilities = parseTrivyReport(fs.readFileSync(reportFile, 'utf8'));
    return { vulnerabilities, counts: countBySeverity(vulnerabilities), reportFile };
  }

  /** Removes the (large) image tarball, keeps reports. */
  cleanup(): void {
    fs.rmSync(path.join(this.workDir, 'image.tar'), { force: true });
  }
}

export function summaryMarkdown(result: ScanResult, severity: string, limit = 50): string {
  const order = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'UNKNOWN'];
  const lines: string[] = [];
  if (result.vulnerabilities.length === 0) {
    lines.push(`✅ No vulnerabilities found (severity: ${severity}).`);
    return lines.join('\n');
  }
  const counts = order.filter((s) => result.counts[s]).map((s) => `${s}: ${result.counts[s]}`);
  lines.push(`⚠️ Found ${result.vulnerabilities.length} vulnerabilities (${counts.join(', ')}).`, '');
  lines.push('| Severity | ID | Package | Installed | Fixed |', '|---|---|---|---|---|');
  const sorted = [...result.vulnerabilities].sort((a, b) => order.indexOf(a.severity) - order.indexOf(b.severity));
  for (const v of sorted.slice(0, limit)) {
    lines.push(`| ${v.severity} | ${v.id} | ${v.pkg} | ${v.installed} | ${v.fixed ?? ''} |`);
  }
  if (sorted.length > limit) lines.push('', `…and ${sorted.length - limit} more. See the Trivy report in the log.`);
  return lines.join('\n');
}
