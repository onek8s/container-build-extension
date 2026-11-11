import * as fs from 'node:fs';
import * as path from 'node:path';
import { Docker } from './docker';
import { exec as defaultExec, type Exec } from './exec';
import { readInputs } from './inputs';
import type { Platform } from './platform';
import { scanImage, summaryMarkdown, type ScanResult } from './scan';
import { resolveTags } from './tags';

export interface RunResult {
  imageRefs: string[];
  pushed: boolean;
  digest?: string;
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
  platform.info(`Scan:       ${inputs.scan ? `yes (${inputs.severity})` : 'no'}`);
  platform.info(`Push:       ${inputs.push ? 'yes' : 'no'}`);
  platform.info(`Docker:     ${await docker.version()}`);

  const labels: Record<string, string> = { 'org.opencontainers.image.created': new Date().toISOString() };
  if (ctx.sha) labels['org.opencontainers.image.revision'] = ctx.sha;

  const result: RunResult = { imageRefs, pushed: false };
  const summary: string[] = [`### Container build: \`${inputs.repository}\``, '', `Tags: ${tags.map((t) => `\`${t}\``).join(', ')}`, ''];

  await group(platform, 'Build image', () =>
    docker.build({
      context: inputs.context,
      dockerfile: inputs.dockerfile,
      imageRefs,
      buildArgs: inputs.buildArgs,
      target: inputs.target,
      labels,
    }),
  );

  if (inputs.scan) {
    const ignoreFile = [path.join(inputs.context, '.trivyignore'), path.join(ctx.workspace, '.trivyignore')].find((f) =>
      fs.existsSync(f),
    );
    const scan = await group(platform, 'Security scan (Trivy)', () =>
      scanImage(exec, {
        imageRef: imageRefs[0],
        trivyImage: inputs.trivyImage,
        severity: inputs.severity,
        ignoreUnfixed: inputs.ignoreUnfixed,
        tempDir: ctx.tempDir,
        ignoreFile,
      }),
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

  if (inputs.push) {
    const creds = platform.getCredentials(inputs.registry);
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
