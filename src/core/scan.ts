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

/**
 * Scans a locally built image with Trivy running in a container.
 * The image is exported with `docker save` so no docker socket has to be shared with the scanner,
 * which keeps it working with remote / rootless daemons too.
 */
export async function scanImage(
  exec: Exec,
  opts: {
    imageRef: string;
    trivyImage: string;
    severity: string;
    ignoreUnfixed: boolean;
    tempDir: string;
    ignoreFile?: string;
  },
): Promise<ScanResult> {
  const workDir = fs.mkdtempSync(path.join(opts.tempDir, 'container-scan-'));
  const cacheDir = path.join(opts.tempDir, 'trivy-cache');
  fs.mkdirSync(cacheDir, { recursive: true });
  const tarFile = path.join(workDir, 'image.tar');
  const reportFile = path.join(workDir, 'trivy-report.json');

  try {
    await exec('docker', ['save', '--output', tarFile, opts.imageRef], { silent: true });

    const run = ['run', '--rm', '-v', `${workDir}:/scan`, '-v', `${cacheDir}:/cache`];
    if (typeof process.getuid === 'function' && process.getuid() !== 0) {
      run.push('--user', `${process.getuid()}:${process.getgid?.() ?? 0}`, '-e', 'HOME=/tmp');
    }
    if (opts.ignoreFile) run.push('-v', `${opts.ignoreFile}:/scan-config/.trivyignore:ro`);
    run.push(...proxyArgs(process.env));
    run.push(opts.trivyImage);

    const trivyArgs = [
      'image',
      '--input', '/scan/image.tar',
      '--cache-dir', '/cache',
      '--scanners', 'vuln',
      '--severity', opts.severity,
      '--format', 'json',
      '--output', '/scan/trivy-report.json',
      '--exit-code', '0',
      '--no-progress',
    ];
    if (opts.ignoreUnfixed) trivyArgs.push('--ignore-unfixed');
    if (opts.ignoreFile) trivyArgs.push('--ignorefile', '/scan-config/.trivyignore');
    await exec('docker', [...run, ...trivyArgs]);

    // human readable table in the log
    await exec('docker', [...run, 'convert', '--format', 'table', '/scan/trivy-report.json'], {
      ignoreReturnCode: true,
    });

    const vulnerabilities = parseTrivyReport(fs.readFileSync(reportFile, 'utf8'));
    return { vulnerabilities, counts: countBySeverity(vulnerabilities), reportFile };
  } finally {
    fs.rmSync(tarFile, { force: true });
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
