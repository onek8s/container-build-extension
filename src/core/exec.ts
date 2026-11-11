import { spawn } from 'node:child_process';

export interface ExecOptions {
  /** Data written to stdin (e.g. password for --password-stdin). */
  input?: string;
  /** Capture stdout instead of streaming it to the log. */
  silent?: boolean;
  /** Do not throw on non-zero exit code. */
  ignoreReturnCode?: boolean;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type Exec = (command: string, args: string[], options?: ExecOptions) => Promise<ExecResult>;

export const exec: Exec = (command, args, options = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: [options.input !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d: Buffer) => {
      stdout += d.toString();
      if (!options.silent) process.stdout.write(d);
    });
    child.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString();
      if (!options.silent) process.stderr.write(d);
    });
    child.on('error', (err) => reject(new Error(`Failed to start '${command}': ${err.message}`)));
    child.on('close', (code) => {
      const exitCode = code ?? 1;
      if (exitCode !== 0 && !options.ignoreReturnCode) {
        const detail = options.silent && stderr.trim() ? `: ${stderr.trim()}` : '';
        reject(new Error(`'${command} ${args[0] ?? ''}' failed with exit code ${exitCode}${detail}`));
      } else {
        resolve({ exitCode, stdout, stderr });
      }
    });
    if (options.input !== undefined && child.stdin) {
      child.stdin.end(options.input);
    }
  });
