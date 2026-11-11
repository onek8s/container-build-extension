// Bundles the shared core + platform adapter into a single file per target.
import { build } from 'esbuild';
import { readFileSync, writeFileSync } from 'node:fs';

const common = { bundle: true, platform: 'node', target: 'node20', format: 'cjs', minify: false, legalComments: 'none' };

await build({ ...common, entryPoints: ['src/github/main.ts'], outfile: 'dist/index.js' });
await build({ ...common, entryPoints: ['src/azure/main.ts'], outfile: 'azure/tasks/ContainerBuild/index.js' });

// Keep the Azure task + extension versions in sync with package.json
const { version } = JSON.parse(readFileSync('package.json', 'utf8'));
const [Major, Minor, Patch] = version.split('.').map(Number);
const taskFile = 'azure/tasks/ContainerBuild/task.json';
const task = JSON.parse(readFileSync(taskFile, 'utf8'));
task.version = { Major, Minor, Patch };
writeFileSync(taskFile, JSON.stringify(task, null, 2) + '\n');
const extFile = 'azure/vss-extension.json';
const ext = JSON.parse(readFileSync(extFile, 'utf8'));
ext.version = version;
writeFileSync(extFile, JSON.stringify(ext, null, 2) + '\n');
console.log(`Built dist/index.js and azure/tasks/ContainerBuild/index.js (v${version})`);
