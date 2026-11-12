import * as fs from 'node:fs';
import * as path from 'node:path';
import { Docker } from './docker';
import { exec as defaultExec, type Exec } from './exec';
import { readInputs, type Inputs } from './inputs';
import type { Platform } from './platform';
import { resolveCredentials } from './registry';
import { instrumentDockerfile, prepareSafeChain, SAFE_CHAIN_CONTEXT } from './safechain';
import { summaryMarkdown, Trivy, type ScanResult } from './scan';
import { resolveTags } from './tags';

export interface RunResult {
  imageRefs: string[];
  pushed: boolean;
  digest?: string;
  sbom?: string;
  scan?: ScanResult;
}

async function group<T>(platform: Platform, name: string, fn: () => Promise<T>): Promise<T> {
  platform.startGroup(name);
  try {
    return await fn();
  } finally {
    platform.endGroup();
  }
}

/**
 * Returns the Dockerfile and extra build contexts to use. With safe-chain enabled this is an
 * instrumented copy of the user's Dockerfile; the original is never modified.
 */
async function prepareBuild(
  platform: Platform,
  exec: Exec,
  inputs: Inputs,
): Promise<{ dockerfile: string; buildContexts: Record<string, string>; safeChain: string }> {
  const plain = { dockerfile: inputs.dockerfile, buildContexts: {}, safeChain: 'disabled' };
  if (!inputs.safeChain) return plain;
  if (process.platform !== 'linux' || !['x64', 'arm64'].includes(process.arch)) {
    platform.warning(`safe-chain is only supported on Linux x64/arm64 agents; building without it.`);
    return { ...plain, safeChain: 'unsupported agent' };
  }

  const result = instrumentDockerfile(fs.readFileSync(inputs.dockerfile, 'utf8'));
  if (result.wrapped === 0) {
    platform.info(`safe-chain: no RUN instructions to protect${result.reason ? ` (${result.reason})` : ''}.`);
    return { ...plain, safeChain: 'nothing to protect' };
  }

  const ctx = platform.context;
  const safeChainDir = await prepareSafeChain(exec, ctx.toolCacheDir ?? ctx.tempDir);
  const dir = fs.mkdtempSync(path.join(ctx.tempDir, 'container-build-'));
  const dockerfile = path.join(dir, path.basename(inputs.dockerfile));
  fs.writeFileSync(dockerfile, result.content);
  // BuildKit looks for <Dockerfile>.dockerignore next to the Dockerfile before <context>/.dockerignore
  const ignore = `${inputs.dockerfile}.dockerignore`;
  if (fs.existsSync(ignore)) fs.copyFileSync(ignore, `${dockerfile}.dockerignore`);

  const skipped = result.skipped ? ` (${result.skipped} exec-form/heredoc/custom-shell RUN left as is)` : '';
  platform.info(`safe-chain: protecting package installs in ${result.wrapped} RUN instruction(s)${skipped}.`);
  return { dockerfile, buildContexts: { [SAFE_CHAIN_CONTEXT]: safeChainDir }, safeChain: `${result.wrapped} RUN instruction(s)` };
}

export async function run(platform: Platform, exec: Exec = defaultExec): Promise<RunResult> {
  const inputs = readInputs(platform);
  const ctx = platform.context;
  const docker = new Docker(exec);
  const tags = resolveTags(inputs.tags, ctx);
  const imageRefs = tags.map((t) => `${inputs.repository}:${t}`);

  if (!fs.existsSync(inputs.dockerfile)) throw new Error(`Dockerfile not found: ${inputs.dockerfile}`);

  platform.info(`Image:      ${inputs.repository}`);
  platform.info(`Tags:       ${tags.join(', ')}`);
  platform.info(`Context:    ${inputs.context}`);
  platform.info(`Dockerfile: ${inputs.dockerfile}`);
  platform.info(`SafeChain:  ${inputs.safeChain ? 'yes' : 'no'}`);
  platform.info(`SBOM:       ${inputs.sbom ? inputs.sbomFormat : 'no'}`);
  platform.info(`Scan:       ${inputs.scan ? `yes (${inputs.severity})` : 'no'}`);
  platform.info(`Push:       ${inputs.push ? 'yes' : 'no'}`);
  platform.info(`Docker:     ${await docker.version()}`);

  const labels: Record<string, string> = { 'org.opencontainers.image.created': new Date().toISOString() };
  if (ctx.sha) labels['org.opencontainers.image.revision'] = ctx.sha;

  const result: RunResult = { imageRefs, pushed: false };
  const summary: string[] = [`### Container build: \`${inputs.repository}\``, '', `Tags: ${tags.map((t) => `\`${t}\``).join(', ')}`, ''];

  const build = await prepareBuild(platform, exec, inputs);
  await group(platform, 'Build image', () =>
    docker.build({
      context: inputs.context,
      dockerfile: build.dockerfile,
      imageRefs,
      buildArgs: inputs.buildArgs,
      target: inputs.target,
      labels,
      buildContexts: build.buildContexts,
    }),
  );
  if (inputs.safeChain) summary.push(`🛡️ Package installs protected by [Aikido Safe Chain](https://github.com/AikidoSec/safe-chain): ${build.safeChain}`, '');

  if (inputs.sbom || inputs.scan) {
    const ignoreFile = [path.join(inputs.context, '.trivyignore'), path.join(ctx.workspace, '.trivyignore')].find((f) =>
      fs.existsSync(f),
    );
    const trivy = await Trivy.prepare(exec, {
      imageRef: imageRefs[0],
      trivyImage: inputs.trivyImage,
      tempDir: ctx.tempDir,
      ignoreFile,
    });
    try {
      if (inputs.sbom) {
        const sbom = await group(platform, `Generate SBOM (${inputs.sbomFormat})`, () => trivy.sbom(inputs.sbomFormat, inputs.repository));
        result.sbom = sbom;
        platform.setOutput('sbom', sbom);
        platform.publishArtifact('sbom', sbom);
        platform.info(`SBOM written to ${sbom}`);
        summary.push(`📦 SBOM (${inputs.sbomFormat}) generated.`, '');
      }

      if (inputs.scan) {
        const scan = await group(platform, 'Security scan (Trivy)', () =>
          trivy.scan({ severity: inputs.severity, ignoreUnfixed: inputs.ignoreUnfixed, ignoreFile }),
        );
        result.scan = scan;
        platform.setOutput('scanReport', scan.reportFile);
        platform.setOutput('vulnerabilities', String(scan.vulnerabilities.length));
        summary.push('#### Security scan', '', summaryMarkdown(scan, inputs.severity), '');

        if (scan.vulnerabilities.length > 0) {
          const msg = `Found ${scan.vulnerabilities.length} vulnerabilities with severity ${inputs.severity}`;
          if (inputs.failOnVulnerabilities) {
            platform.addSummary(summary.join('\n'));
            throw new Error(`${msg}. Image was not pushed. Fix them, add them to .trivyignore, or set failOnVulnerabilities to false.`);
          }
          platform.warning(msg);
        } else {
          platform.info('No vulnerabilities found.');
        }
      }
    } finally {
      trivy.cleanup();
    }
  }

  if (inputs.push) {
    const creds = resolveCredentials(platform, inputs.registry);
    if (creds) {
      platform.setSecret(creds.password);
      platform.info(`Logging in to ${creds.registry} as ${creds.username}`);
      await docker.login(creds);
    } else {
      platform.info(`No credentials configured for ${inputs.registry}; using existing docker login.`);
    }
    try {
      await group(platform, 'Push image', async () => {
        for (const ref of imageRefs) await docker.push(ref);
      });
    } finally {
      if (creds) await docker.logout(creds.registry);
    }
    result.pushed = true;
    result.digest = await docker.repoDigest(inputs.repository, imageRefs[0]);
    if (result.digest) {
      platform.setOutput('digest', result.digest);
      platform.setOutput('imageRef', `${inputs.repository}@${result.digest}`);
      platform.info(`Pushed ${inputs.repository}@${result.digest}`);
    }
    summary.push(`✅ Pushed${result.digest ? ` \`${inputs.repository}@${result.digest}\`` : ''}`);
  } else {
    platform.info('Push skipped.');
    summary.push('ℹ️ Push skipped.');
  }

  platform.setOutput('image', inputs.repository);
  platform.setOutput('tags', imageRefs.join(','));
  platform.addSummary(summary.join('\n'));
  return result;
}
