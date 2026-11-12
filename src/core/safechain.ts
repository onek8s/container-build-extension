import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Exec } from './exec';

/**
 * Aikido Safe Chain (https://github.com/AikidoSec/safe-chain) protects package installs
 * (npm, yarn, pnpm, bun, pip, uv, poetry, ...) against malware and too-new packages.
 *
 * We download the pinned static Linux binary on the host, verify its checksum and then make it
 * available to every RUN instruction of the Dockerfile through BuildKit mounts. Nothing is added
 * to the resulting image and the user's Dockerfile does not need to be changed.
 */
export const SAFE_CHAIN_VERSION = '1.5.29';
const SHA256: Record<string, string> = {
  x64: '0a7287bbf5562610e1c4881b928037378c97b4ba7578694287b2ad3b7140b033',
  arm64: '0d565a91e2b1bf0e8ed0ab44cb22fad2aafc05259fe7d92eb40cafc41501ab59',
};

export const SAFE_CHAIN_CONTEXT = 'container-build-safe-chain';
const MOUNT_DIR = '/tmp/.container-build-safe-chain';

const MOUNTS = [
  // writable, not part of the image: safe-chain keeps its malware lists and certificates here
  `--mount=type=cache,id=${SAFE_CHAIN_CONTEXT},target=${MOUNT_DIR},mode=0777`,
  `--mount=type=bind,from=${SAFE_CHAIN_CONTEXT},source=bin,target=${MOUNT_DIR}/bin`,
  `--mount=type=bind,from=${SAFE_CHAIN_CONTEXT},source=shims,target=${MOUNT_DIR}/shims`,
].join(' ');
const PREFIX = `export PATH="${MOUNT_DIR}/shims:${MOUNT_DIR}/bin:$PATH";`;

export interface InstrumentResult {
  content: string;
  wrapped: number;
  skipped: number;
  reason?: string;
}

/**
 * Rewrites shell-form RUN instructions so that package managers run through safe-chain:
 *   RUN npm ci  ->  RUN --mount=... export PATH="<safe-chain shims>:$PATH"; npm ci
 * Exec-form RUN, heredocs and stages using a custom SHELL are left untouched.
 */
export function instrumentDockerfile(content: string): InstrumentResult {
  const lines = content.split('\n');
  // parser directives (only at the very top)
  for (const line of lines) {
    const m = line.match(/^#\s*([a-z]+)\s*=\s*(.*)$/i);
    if (!m) break;
    if (m[1].toLowerCase() === 'escape' && m[2].trim() !== '\\') {
      return { content, wrapped: 0, skipped: 0, reason: 'custom escape character (Windows Dockerfile)' };
    }
  }

  let continuation = false;
  let customShell = false;
  let wrapped = 0;
  let skipped = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (continuation) {
      if (!trimmed.startsWith('#')) continuation = /\\\s*$/.test(line);
      continue;
    }
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    continuation = /\\\s*$/.test(line);

    const instr = trimmed.match(/^([a-z]+)\b/i)?.[1]?.toUpperCase();
    if (instr === 'FROM') customShell = false;
    if (instr === 'SHELL') customShell = true;
    if (instr !== 'RUN') continue;

    const m = line.match(/^(\s*RUN)((?:\s+--\S+)*)(\s+)(.*)$/i);
    const rest = m?.[4] ?? '';
    if (!m || customShell || rest.startsWith('[') || /<<-?["']?[A-Za-z_]/.test(rest) || rest === '') {
      skipped++;
      continue;
    }
    lines[i] = `${m[1]}${m[2]} ${MOUNTS} ${PREFIX} ${rest}`;
    wrapped++;
  }
  return { content: lines.join('\n'), wrapped, skipped };
}

function sha256(file: string): string {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/**
 * Downloads (or reuses) the pinned safe-chain binary and prepares a directory with `bin/` and `shims/`
 * that is passed to the build as a named build context.
 */
export async function prepareSafeChain(
  exec: Exec,
  cacheDir: string,
  arch: string = process.arch,
  expected: string | undefined = SHA256[arch],
): Promise<string> {
  if (!expected) throw new Error(`safe-chain is not available for architecture '${arch}'`);
  const dir = path.join(cacheDir, 'container-build-safe-chain', SAFE_CHAIN_VERSION, arch);
  const bin = path.join(dir, 'bin', 'safe-chain');

  if (!fs.existsSync(bin) || sha256(bin) !== expected) {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(bin), { recursive: true });
    const url = `https://github.com/AikidoSec/safe-chain/releases/download/${SAFE_CHAIN_VERSION}/safe-chain-linuxstatic-${arch}`;
    const tmp = `${bin}.download`;
    await exec('curl', ['-fsSL', '--retry', '3', '-o', tmp, url], { silent: true });
    const actual = sha256(tmp);
    if (actual !== expected) {
      fs.rmSync(tmp, { force: true });
      throw new Error(`Checksum mismatch for ${url}: expected ${expected}, got ${actual}`);
    }
    fs.chmodSync(tmp, 0o755);
    fs.renameSync(tmp, bin);
  }

  if (!fs.existsSync(path.join(dir, 'shims', 'npm'))) {
    // `setup-ci` generates the shims next to the binary. Strip the CI integration variables so it
    // does not change the PATH of later pipeline steps, and capture its output (##vso commands).
    const env = { ...process.env };
    for (const k of ['GITHUB_PATH', 'BASH_ENV', 'TF_BUILD']) delete env[k];
    await exec(bin, ['setup-ci'], { silent: true, env });
  }
  // do not ship the host CA key into the build; safe-chain creates its own inside the build
  fs.rmSync(path.join(dir, 'certs'), { recursive: true, force: true });
  return dir;
}
