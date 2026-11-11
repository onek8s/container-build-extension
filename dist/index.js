"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// src/core/run.ts
var fs2 = __toESM(require("node:fs"));
var path3 = __toESM(require("node:path"));

// src/core/docker.ts
var Docker = class {
  constructor(exec2) {
    this.exec = exec2;
  }
  async version() {
    const r = await this.exec("docker", ["version", "--format", "{{.Server.Version}}"], { silent: true });
    return r.stdout.trim();
  }
  async login(creds) {
    await this.exec("docker", ["login", creds.registry, "--username", creds.username, "--password-stdin"], {
      input: creds.password,
      silent: true
    });
  }
  async logout(registry) {
    await this.exec("docker", ["logout", registry], { silent: true, ignoreReturnCode: true });
  }
  async build(opts) {
    const args = ["build", "--file", opts.dockerfile];
    for (const ref of opts.imageRefs) args.push("--tag", ref);
    for (const arg of opts.buildArgs) args.push("--build-arg", arg);
    for (const [k, v] of Object.entries(opts.labels)) args.push("--label", `${k}=${v}`);
    if (opts.target) args.push("--target", opts.target);
    args.push(opts.context);
    await this.exec("docker", args, { env: { ...process.env, DOCKER_BUILDKIT: "1" } });
  }
  async push(imageRef) {
    await this.exec("docker", ["push", imageRef]);
  }
  /** Returns the registry digest (sha256:...) of a pushed image, if available. */
  async repoDigest(repository, imageRef) {
    const r = await this.exec("docker", ["image", "inspect", "--format", "{{json .RepoDigests}}", imageRef], {
      silent: true,
      ignoreReturnCode: true
    });
    if (r.exitCode !== 0) return void 0;
    try {
      const digests = JSON.parse(r.stdout.trim());
      const match = digests.find((d) => d.split("@")[0] === repository) ?? digests[0];
      return match?.split("@")[1];
    } catch {
      return void 0;
    }
  }
};

// src/core/exec.ts
var import_node_child_process = require("node:child_process");
var exec = (command, args, options = {}) => new Promise((resolve2, reject) => {
  const child = (0, import_node_child_process.spawn)(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    stdio: [options.input !== void 0 ? "pipe" : "ignore", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (d) => {
    stdout += d.toString();
    if (!options.silent) process.stdout.write(d);
  });
  child.stderr?.on("data", (d) => {
    stderr += d.toString();
    if (!options.silent) process.stderr.write(d);
  });
  child.on("error", (err) => reject(new Error(`Failed to start '${command}': ${err.message}`)));
  child.on("close", (code) => {
    const exitCode = code ?? 1;
    if (exitCode !== 0 && !options.ignoreReturnCode) {
      const detail = options.silent && stderr.trim() ? `: ${stderr.trim()}` : "";
      reject(new Error(`'${command} ${args[0] ?? ""}' failed with exit code ${exitCode}${detail}`));
    } else {
      resolve2({ exitCode, stdout, stderr });
    }
  });
  if (options.input !== void 0 && child.stdin) {
    child.stdin.end(options.input);
  }
});

// src/core/inputs.ts
var path = __toESM(require("node:path"));
var DEFAULT_TRIVY_VERSION = "0.76.2";
var DEFAULT_SEVERITY = "CRITICAL,HIGH";
var SEVERITIES = ["UNKNOWN", "LOW", "MEDIUM", "HIGH", "CRITICAL"];
function parseBool(value, defaultValue, name = "value") {
  if (value === void 0 || value === "") return defaultValue;
  const v = value.trim().toLowerCase();
  if (["true", "yes", "1", "on"].includes(v)) return true;
  if (["false", "no", "0", "off"].includes(v)) return false;
  throw new Error(`Invalid boolean for '${name}': '${value}'`);
}
function parseList(value) {
  if (!value) return [];
  return value.split(/[\n,]/).map((s) => s.trim()).filter((s) => s.length > 0);
}
function parseLines(value) {
  if (!value) return [];
  return value.split(/\r?\n/).map((s) => s.trim()).filter((s) => s.length > 0 && !s.startsWith("#"));
}
function parseImage(image) {
  let ref = image.trim().toLowerCase();
  if (!ref) throw new Error("Input 'image' is required");
  if (ref.includes("@")) throw new Error(`'image' must not contain a digest: ${image}`);
  const lastSlash = ref.lastIndexOf("/");
  const colon = ref.indexOf(":", lastSlash + 1);
  if (colon !== -1) ref = ref.substring(0, colon);
  if (!/^[a-z0-9]([a-z0-9._\-/:]*[a-z0-9])?$/.test(ref)) {
    throw new Error(`Invalid image name: '${image}'`);
  }
  const first = ref.split("/")[0];
  const hasRegistry = ref.includes("/") && (first.includes(".") || first.includes(":") || first === "localhost");
  return { registry: hasRegistry ? first : "docker.io", repository: ref };
}
function readInputs(platform2) {
  const { context: ctx } = platform2;
  const image = platform2.getInput("image");
  if (!image) throw new Error("Input 'image' is required");
  const { registry, repository } = parseImage(image);
  const context = path.resolve(ctx.workspace, platform2.getInput("context") ?? ".");
  const dockerfileInput = platform2.getInput("dockerfile");
  const dockerfile = dockerfileInput ? path.resolve(ctx.workspace, dockerfileInput) : path.join(context, "Dockerfile");
  const pushMode = (platform2.getInput("push") ?? "auto").toLowerCase();
  let push;
  if (pushMode === "auto") push = !ctx.isPullRequest;
  else push = parseBool(pushMode, true, "push");
  const severity = (platform2.getInput("severity") ?? DEFAULT_SEVERITY).toUpperCase().replace(/\s+/g, "");
  for (const s of severity.split(",")) {
    if (!SEVERITIES.includes(s)) throw new Error(`Invalid severity '${s}'. Allowed: ${SEVERITIES.join(",")}`);
  }
  const trivyVersion = platform2.getInput("trivyVersion") ?? DEFAULT_TRIVY_VERSION;
  return {
    image,
    registry,
    repository,
    tags: parseList(platform2.getInput("tags")),
    context,
    dockerfile,
    buildArgs: parseLines(platform2.getInput("buildArgs")),
    target: platform2.getInput("target"),
    push,
    scan: parseBool(platform2.getInput("scan"), true, "scan"),
    severity,
    failOnVulnerabilities: parseBool(platform2.getInput("failOnVulnerabilities"), true, "failOnVulnerabilities"),
    ignoreUnfixed: parseBool(platform2.getInput("ignoreUnfixed"), true, "ignoreUnfixed"),
    trivyImage: trivyVersion.includes("/") ? trivyVersion : `ghcr.io/aquasecurity/trivy:${trivyVersion.replace(/^v/, "")}`
  };
}

// src/core/scan.ts
var fs = __toESM(require("node:fs"));
var path2 = __toESM(require("node:path"));
function parseTrivyReport(json) {
  const report = JSON.parse(json);
  const out = [];
  for (const result of report.Results ?? []) {
    for (const v of result.Vulnerabilities ?? []) {
      out.push({
        id: v.VulnerabilityID,
        pkg: v.PkgName,
        installed: v.InstalledVersion,
        fixed: v.FixedVersion || void 0,
        severity: v.Severity,
        title: v.Title,
        target: result.Target
      });
    }
  }
  return out;
}
function countBySeverity(vulns) {
  const counts = {};
  for (const v of vulns) counts[v.severity] = (counts[v.severity] ?? 0) + 1;
  return counts;
}
function proxyArgs(env) {
  const args = [];
  for (const name of ["HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "https_proxy", "http_proxy", "no_proxy"]) {
    const value = env[name];
    if (value && !(name.toUpperCase() !== "NO_PROXY" && /\/\/(localhost|127\.|\[::1\])/.test(value))) args.push("-e", name);
  }
  const ca = [env.SSL_CERT_FILE, env.NODE_EXTRA_CA_CERTS].find((f) => f && fs.existsSync(f));
  if (ca) args.push("-v", `${ca}:/etc/ssl/certs/ca-certificates.crt:ro`);
  return args;
}
async function scanImage(exec2, opts) {
  const workDir = fs.mkdtempSync(path2.join(opts.tempDir, "container-scan-"));
  const cacheDir = path2.join(opts.tempDir, "trivy-cache");
  fs.mkdirSync(cacheDir, { recursive: true });
  const tarFile = path2.join(workDir, "image.tar");
  const reportFile = path2.join(workDir, "trivy-report.json");
  try {
    await exec2("docker", ["save", "--output", tarFile, opts.imageRef], { silent: true });
    const run2 = ["run", "--rm", "-v", `${workDir}:/scan`, "-v", `${cacheDir}:/cache`];
    if (typeof process.getuid === "function" && process.getuid() !== 0) {
      run2.push("--user", `${process.getuid()}:${process.getgid?.() ?? 0}`, "-e", "HOME=/tmp");
    }
    if (opts.ignoreFile) run2.push("-v", `${opts.ignoreFile}:/scan-config/.trivyignore:ro`);
    run2.push(...proxyArgs(process.env));
    run2.push(opts.trivyImage);
    const trivyArgs = [
      "image",
      "--input",
      "/scan/image.tar",
      "--cache-dir",
      "/cache",
      "--scanners",
      "vuln",
      "--severity",
      opts.severity,
      "--format",
      "json",
      "--output",
      "/scan/trivy-report.json",
      "--exit-code",
      "0",
      "--no-progress"
    ];
    if (opts.ignoreUnfixed) trivyArgs.push("--ignore-unfixed");
    if (opts.ignoreFile) trivyArgs.push("--ignorefile", "/scan-config/.trivyignore");
    await exec2("docker", [...run2, ...trivyArgs]);
    await exec2("docker", [...run2, "convert", "--format", "table", "/scan/trivy-report.json"], {
      ignoreReturnCode: true
    });
    const vulnerabilities = parseTrivyReport(fs.readFileSync(reportFile, "utf8"));
    return { vulnerabilities, counts: countBySeverity(vulnerabilities), reportFile };
  } finally {
    fs.rmSync(tarFile, { force: true });
  }
}
function summaryMarkdown(result, severity, limit = 50) {
  const order = ["CRITICAL", "HIGH", "MEDIUM", "LOW", "UNKNOWN"];
  const lines = [];
  if (result.vulnerabilities.length === 0) {
    lines.push(`\u2705 No vulnerabilities found (severity: ${severity}).`);
    return lines.join("\n");
  }
  const counts = order.filter((s) => result.counts[s]).map((s) => `${s}: ${result.counts[s]}`);
  lines.push(`\u26A0\uFE0F Found ${result.vulnerabilities.length} vulnerabilities (${counts.join(", ")}).`, "");
  lines.push("| Severity | ID | Package | Installed | Fixed |", "|---|---|---|---|---|");
  const sorted = [...result.vulnerabilities].sort((a, b) => order.indexOf(a.severity) - order.indexOf(b.severity));
  for (const v of sorted.slice(0, limit)) {
    lines.push(`| ${v.severity} | ${v.id} | ${v.pkg} | ${v.installed} | ${v.fixed ?? ""} |`);
  }
  if (sorted.length > limit) lines.push("", `\u2026and ${sorted.length - limit} more. See the Trivy report in the log.`);
  return lines.join("\n");
}

// src/core/tags.ts
function sanitizeTag(value) {
  let tag = value.replace(/[^A-Za-z0-9_.-]/g, "-").replace(/^[.-]+/, "");
  tag = tag.substring(0, 128).replace(/-+$/, "");
  return tag;
}
function defaultTags(ctx) {
  const tags = [];
  const ref = ctx.ref ?? "";
  let m;
  if (m = ref.match(/^refs\/tags\/(.+)$/)) {
    const name = sanitizeTag(m[1]);
    tags.push(name);
    if (/^v\d/.test(name)) tags.push(name.substring(1));
  } else if (m = ref.match(/^refs\/pull\/(\d+)\//)) {
    tags.push(`pr-${m[1]}`);
  } else if (m = ref.match(/^refs\/heads\/(.+)$/)) {
    const branch = m[1];
    tags.push(branch === "main" || branch === "master" ? "latest" : sanitizeTag(branch));
  }
  if (ctx.sha && /^[0-9a-f]{7,}$/i.test(ctx.sha)) tags.push(ctx.sha.substring(0, 7).toLowerCase());
  if (tags.length === 0) tags.push("latest");
  return [...new Set(tags.filter((t) => t.length > 0))];
}
function resolveTags(userTags, ctx) {
  const tags = userTags.length > 0 ? userTags.map((t) => {
    const s = sanitizeTag(t);
    if (s !== t) throw new Error(`Invalid tag '${t}'. Tags may contain only [A-Za-z0-9_.-] (max 128 chars).`);
    return s;
  }) : defaultTags(ctx);
  return [...new Set(tags)];
}

// src/core/run.ts
async function group(platform2, name, fn) {
  platform2.startGroup(name);
  try {
    return await fn();
  } finally {
    platform2.endGroup();
  }
}
async function run(platform2, exec2 = exec) {
  const inputs = readInputs(platform2);
  const ctx = platform2.context;
  const docker = new Docker(exec2);
  const tags = resolveTags(inputs.tags, ctx);
  const imageRefs = tags.map((t) => `${inputs.repository}:${t}`);
  if (!fs2.existsSync(inputs.dockerfile)) throw new Error(`Dockerfile not found: ${inputs.dockerfile}`);
  platform2.info(`Image:      ${inputs.repository}`);
  platform2.info(`Tags:       ${tags.join(", ")}`);
  platform2.info(`Context:    ${inputs.context}`);
  platform2.info(`Dockerfile: ${inputs.dockerfile}`);
  platform2.info(`Scan:       ${inputs.scan ? `yes (${inputs.severity})` : "no"}`);
  platform2.info(`Push:       ${inputs.push ? "yes" : "no"}`);
  platform2.info(`Docker:     ${await docker.version()}`);
  const labels = { "org.opencontainers.image.created": (/* @__PURE__ */ new Date()).toISOString() };
  if (ctx.sha) labels["org.opencontainers.image.revision"] = ctx.sha;
  const result = { imageRefs, pushed: false };
  const summary = [`### Container build: \`${inputs.repository}\``, "", `Tags: ${tags.map((t) => `\`${t}\``).join(", ")}`, ""];
  await group(
    platform2,
    "Build image",
    () => docker.build({
      context: inputs.context,
      dockerfile: inputs.dockerfile,
      imageRefs,
      buildArgs: inputs.buildArgs,
      target: inputs.target,
      labels
    })
  );
  if (inputs.scan) {
    const ignoreFile = [path3.join(inputs.context, ".trivyignore"), path3.join(ctx.workspace, ".trivyignore")].find(
      (f) => fs2.existsSync(f)
    );
    const scan = await group(
      platform2,
      "Security scan (Trivy)",
      () => scanImage(exec2, {
        imageRef: imageRefs[0],
        trivyImage: inputs.trivyImage,
        severity: inputs.severity,
        ignoreUnfixed: inputs.ignoreUnfixed,
        tempDir: ctx.tempDir,
        ignoreFile
      })
    );
    result.scan = scan;
    platform2.setOutput("scanReport", scan.reportFile);
    platform2.setOutput("vulnerabilities", String(scan.vulnerabilities.length));
    summary.push("#### Security scan", "", summaryMarkdown(scan, inputs.severity), "");
    if (scan.vulnerabilities.length > 0) {
      const msg = `Found ${scan.vulnerabilities.length} vulnerabilities with severity ${inputs.severity}`;
      if (inputs.failOnVulnerabilities) {
        platform2.addSummary(summary.join("\n"));
        throw new Error(`${msg}. Image was not pushed. Fix them, add them to .trivyignore, or set failOnVulnerabilities to false.`);
      }
      platform2.warning(msg);
    } else {
      platform2.info("No vulnerabilities found.");
    }
  }
  if (inputs.push) {
    const creds = platform2.getCredentials(inputs.registry);
    if (creds) {
      platform2.setSecret(creds.password);
      platform2.info(`Logging in to ${creds.registry} as ${creds.username}`);
      await docker.login(creds);
    } else {
      platform2.info(`No credentials configured for ${inputs.registry}; using existing docker login.`);
    }
    try {
      await group(platform2, "Push image", async () => {
        for (const ref of imageRefs) await docker.push(ref);
      });
    } finally {
      if (creds) await docker.logout(creds.registry);
    }
    result.pushed = true;
    result.digest = await docker.repoDigest(inputs.repository, imageRefs[0]);
    if (result.digest) {
      platform2.setOutput("digest", result.digest);
      platform2.setOutput("imageRef", `${inputs.repository}@${result.digest}`);
      platform2.info(`Pushed ${inputs.repository}@${result.digest}`);
    }
    summary.push(`\u2705 Pushed${result.digest ? ` \`${inputs.repository}@${result.digest}\`` : ""}`);
  } else {
    platform2.info("Push skipped.");
    summary.push("\u2139\uFE0F Push skipped.");
  }
  platform2.setOutput("image", inputs.repository);
  platform2.setOutput("tags", imageRefs.join(","));
  platform2.addSummary(summary.join("\n"));
  return result;
}

// src/github/platform.ts
var fs3 = __toESM(require("node:fs"));
var os = __toESM(require("node:os"));
var kebab = (name) => name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
function escapeData(s) {
  return s.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}
var GitHubPlatform = class {
  constructor(env = process.env) {
    this.env = env;
    this.context = {
      sha: env.GITHUB_SHA,
      ref: env.GITHUB_REF,
      isPullRequest: ["pull_request", "pull_request_target"].includes(env.GITHUB_EVENT_NAME ?? ""),
      tempDir: env.RUNNER_TEMP || os.tmpdir(),
      workspace: env.GITHUB_WORKSPACE || process.cwd()
    };
  }
  name = "GitHub Actions";
  context;
  getInput(name) {
    const key = `INPUT_${kebab(name).replace(/ /g, "_").toUpperCase()}`;
    const value = this.env[key]?.trim();
    return value ? value : void 0;
  }
  getCredentials(registry) {
    const username = this.getInput("username");
    const password = this.getInput("password");
    if (password) {
      if (!username) throw new Error("Input 'username' is required when 'password' is set");
      return { registry, username, password };
    }
    const token = this.getInput("githubToken");
    if (registry === "ghcr.io" && token) {
      return { registry, username: username ?? this.env.GITHUB_ACTOR ?? "github-actions", password: token };
    }
    return void 0;
  }
  debug(message) {
    process.stdout.write(`::debug::${escapeData(message)}${os.EOL}`);
  }
  info(message) {
    process.stdout.write(`${message}${os.EOL}`);
  }
  warning(message) {
    process.stdout.write(`::warning::${escapeData(message)}${os.EOL}`);
  }
  error(message) {
    process.stdout.write(`::error::${escapeData(message)}${os.EOL}`);
  }
  startGroup(name) {
    process.stdout.write(`::group::${escapeData(name)}${os.EOL}`);
  }
  endGroup() {
    process.stdout.write(`::endgroup::${os.EOL}`);
  }
  setSecret(value) {
    for (const line of value.split(/\r?\n/)) if (line) process.stdout.write(`::add-mask::${escapeData(line)}${os.EOL}`);
  }
  setOutput(name, value) {
    const file = this.env.GITHUB_OUTPUT;
    const key = kebab(name);
    if (!file) {
      this.debug(`output ${key}=${value}`);
      return;
    }
    const delimiter = `ghadelimiter_${Math.random().toString(36).slice(2)}`;
    fs3.appendFileSync(file, `${key}<<${delimiter}${os.EOL}${value}${os.EOL}${delimiter}${os.EOL}`);
  }
  addSummary(markdown) {
    const file = this.env.GITHUB_STEP_SUMMARY;
    if (file) fs3.appendFileSync(file, `${markdown}${os.EOL}`);
  }
  setFailed(message) {
    this.error(message);
    process.exitCode = 1;
  }
};

// src/github/main.ts
var platform = new GitHubPlatform();
run(platform).catch((err) => platform.setFailed(err instanceof Error ? err.message : String(err)));
