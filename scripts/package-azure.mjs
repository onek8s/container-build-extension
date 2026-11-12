// Packages the Azure DevOps extension (.vsix).
//
//   node scripts/package-azure.mjs                          -> dist-azure/onek8s.container-build-<version>.vsix
//   node scripts/package-azure.mjs --dev --patch 1234       -> dist-azure-dev/onek8s.container-build-dev-<major>.<minor>.1234.vsix
//
// The dev variant has its own extension id, task id and task name (ContainerBuildDev), so it can be installed
// next to the released extension in a test organization. Every dev build needs a higher patch number.
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';

export const DEV_EXTENSION_ID = 'container-build-dev';
export const DEV_TASK_ID = '0fd229fb-31a8-4429-9e4c-597a90679731';
export const DEV_TASK_NAME = 'ContainerBuildDev';

/** Rewrites the manifest and task definition of a copy of azure/ into the dev variant. */
export function toDevVariant(ext, task, patch) {
  const [major, minor] = ext.version.split('.').map(Number);
  const version = `${major}.${minor}.${patch}`;
  return {
    ext: { ...ext, id: DEV_EXTENSION_ID, name: `${ext.name} (dev)`, version, public: false },
    task: {
      ...task,
      id: DEV_TASK_ID,
      name: DEV_TASK_NAME,
      friendlyName: `${task.friendlyName} (dev)`,
      version: { Major: major, Minor: minor, Patch: patch },
    },
    version,
  };
}

function main() {
  const { values } = parseArgs({
    options: { dev: { type: 'boolean', default: false }, patch: { type: 'string' }, out: { type: 'string' } },
  });
  const out = resolve(values.out ?? (values.dev ? 'dist-azure-dev' : 'dist-azure'));
  if (!readFileSync('azure/tasks/ContainerBuild/index.js', 'utf8')) throw new Error('Run npm run build first');

  const dir = mkdtempSync(join(tmpdir(), 'vsix-'));
  try {
    cpSync('azure', dir, { recursive: true });
    if (values.dev) {
      const patch = Number(values.patch);
      if (!Number.isInteger(patch) || patch < 0) throw new Error('--dev needs --patch <number>');
      const extFile = join(dir, 'vss-extension.json');
      const taskFile = join(dir, 'tasks/ContainerBuild/task.json');
      const dev = toDevVariant(JSON.parse(readFileSync(extFile, 'utf8')), JSON.parse(readFileSync(taskFile, 'utf8')), patch);
      writeFileSync(extFile, JSON.stringify(dev.ext, null, 2));
      writeFileSync(taskFile, JSON.stringify(dev.task, null, 2));
      console.log(`Dev extension ${dev.ext.publisher}.${DEV_EXTENSION_ID} ${dev.version}`);
    }
    execFileSync('npx', ['tfx', 'extension', 'create', '--root', dir, '--manifest-globs', 'vss-extension.json', '--output-path', out], {
      stdio: 'inherit',
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main();
