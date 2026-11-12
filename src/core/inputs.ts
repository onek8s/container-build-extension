import * as path from 'node:path';
import type { Platform } from './platform';
import type { MachineSettings } from './azure';
import { resolveImage } from './registry';
import type { SbomFormat } from './scan';

export type PushMode = 'auto' | 'true' | 'false';

export interface Inputs {
  image: string;
  registry: string;
  repository: string;
  tags: string[];
  context: string;
  dockerfile: string;
  buildArgs: string[];
  target?: string;
  push: boolean;
  scan: boolean;
  severity: string;
  failOnVulnerabilities: boolean;
  ignoreUnfixed: boolean;
  trivyImage: string;
  sbom: boolean;
  sbomFormat: SbomFormat;
  safeChain: boolean;
}

export const DEFAULT_TRIVY_VERSION = '0.76.2';
export const DEFAULT_SEVERITY = 'CRITICAL,HIGH';
const SEVERITIES = ['UNKNOWN', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];

export function parseBool(value: string | undefined, defaultValue: boolean, name = 'value'): boolean {
  if (value === undefined || value === '') return defaultValue;
  const v = value.trim().toLowerCase();
  if (['true', 'yes', '1', 'on'].includes(v)) return true;
  if (['false', 'no', '0', 'off'].includes(v)) return false;
  throw new Error(`Invalid boolean for '${name}': '${value}'`);
}

/** Splits a newline and/or comma separated list. */
export function parseList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Splits newline separated list only (values may contain commas, e.g. build args). */
export function parseLines(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !s.startsWith('#'));
}

/**
 * Splits an image reference into registry and repository.
 * `nginx` -> docker.io / library/nginx is NOT expanded: we keep what the user wrote
 * and only derive the registry host for login.
 */
export function parseImage(image: string): { registry: string; repository: string } {
  let ref = image.trim().toLowerCase();
  if (!ref) throw new Error("Input 'image' is required");
  if (ref.includes('@')) throw new Error(`'image' must not contain a digest: ${image}`);
  // strip an accidental tag, but keep registry port (host:5000/name)
  const lastSlash = ref.lastIndexOf('/');
  const colon = ref.indexOf(':', lastSlash + 1);
  if (colon !== -1) ref = ref.substring(0, colon);
  if (!/^[a-z0-9]([a-z0-9._\-/:]*[a-z0-9])?$/.test(ref)) {
    throw new Error(`Invalid image name: '${image}'`);
  }
  const first = ref.split('/')[0];
  const hasRegistry = ref.includes('/') && (first.includes('.') || first.includes(':') || first === 'localhost');
  return { registry: hasRegistry ? first : 'docker.io', repository: ref };
}

export function readInputs(platform: Platform, machine?: MachineSettings): Inputs {
  const { context: ctx } = platform;
  const image = resolveImage(platform, machine);
  const { registry, repository } = parseImage(image);

  const context = path.resolve(ctx.workspace, platform.getInput('context') ?? '.');
  const dockerfileInput = platform.getInput('dockerfile');
  const dockerfile = dockerfileInput
    ? path.resolve(ctx.workspace, dockerfileInput)
    : path.join(context, 'Dockerfile');

  const pushMode = (platform.getInput('push') ?? 'auto').toLowerCase();
  let push: boolean;
  if (pushMode === 'auto') push = !ctx.isPullRequest;
  else push = parseBool(pushMode, true, 'push');

  const severity = (platform.getInput('severity') ?? DEFAULT_SEVERITY).toUpperCase().replace(/\s+/g, '');
  for (const s of severity.split(',')) {
    if (!SEVERITIES.includes(s)) throw new Error(`Invalid severity '${s}'. Allowed: ${SEVERITIES.join(',')}`);
  }

  const sbomFormat = (platform.getInput('sbomFormat') ?? 'cyclonedx').toLowerCase();
  if (sbomFormat !== 'cyclonedx' && sbomFormat !== 'spdx-json') {
    throw new Error(`Invalid sbomFormat '${sbomFormat}'. Allowed: cyclonedx, spdx-json`);
  }

  const trivyVersion = platform.getInput('trivyVersion') ?? DEFAULT_TRIVY_VERSION;

  return {
    image,
    registry,
    repository,
    tags: parseList(platform.getInput('tags')),
    context,
    dockerfile,
    buildArgs: parseLines(platform.getInput('buildArgs')),
    target: platform.getInput('target'),
    push,
    scan: parseBool(platform.getInput('scan'), true, 'scan'),
    severity,
    failOnVulnerabilities: parseBool(platform.getInput('failOnVulnerabilities'), true, 'failOnVulnerabilities'),
    ignoreUnfixed: parseBool(platform.getInput('ignoreUnfixed'), true, 'ignoreUnfixed'),
    sbom: parseBool(platform.getInput('sbom'), true, 'sbom'),
    sbomFormat,
    safeChain: parseBool(platform.getInput('safeChain'), true, 'safeChain'),
    trivyImage: trivyVersion.includes('/') ? trivyVersion : `ghcr.io/aquasecurity/trivy:${trivyVersion.replace(/^v/, '')}`,
  };
}
