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
var fs5 = __toESM(require("node:fs"));
var path5 = __toESM(require("node:path"));

// src/core/azure.ts
var fs = __toESM(require("node:fs"));

// src/core/http.ts
var quote = (s) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
async function httpRequest(exec2, req) {
  const lines = [`url = ${quote(req.url)}`, `request = ${quote(req.method ?? (req.form || req.json ? "POST" : "GET"))}`];
  for (const [k, v] of Object.entries(req.headers ?? {})) lines.push(`header = ${quote(`${k}: ${v}`)}`);
  if (req.form) {
    const body = Object.entries(req.form).filter((e) => e[1] !== void 0).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");
    lines.push(`header = "Content-Type: application/x-www-form-urlencoded"`, `data = ${quote(body)}`);
  } else if (req.json !== void 0) {
    lines.push(`header = "Content-Type: application/json"`, `data = ${quote(JSON.stringify(req.json))}`);
  }
  const timeout = req.timeoutSeconds ?? 30;
  const args = ["-sS", "--fail-with-body", "--max-time", String(timeout), "--config", "-"];
  if (timeout > 5) args.unshift("--retry", "2");
  if (req.noProxy) args.unshift("--noproxy", "*");
  const host = new URL(req.url).host;
  const r = await exec2("curl", args, { input: lines.join("\n") + "\n", silent: true, ignoreReturnCode: true });
  if (r.exitCode !== 0) {
    const detail = r.stdout.trim().substring(0, 500) || r.stderr.trim();
    throw new Error(`HTTP request to ${host} failed (curl exit code ${r.exitCode}): ${detail}`);
  }
  try {
    return JSON.parse(r.stdout);
  } catch {
    throw new Error(`HTTP request to ${host} returned an invalid response`);
  }
}

// src/core/azure.ts
var ARM_RESOURCE = "https://management.azure.com/";
var DEFAULT_AUTHORITY = "https://login.microsoftonline.com";
var IMDS = "http://169.254.169.254/metadata/identity/oauth2/token";
var ACR_TOKEN_USERNAME = "00000000-0000-0000-0000-000000000000";
var isAcr = (registry) => /^[a-z0-9-]+\.azurecr\.[a-z.]+$/.test(registry.toLowerCase());
function workloadIdentityFromEnv(env) {
  const file = env.AZURE_FEDERATED_TOKEN_FILE;
  if (!file || !env.AZURE_CLIENT_ID || !env.AZURE_TENANT_ID) return void 0;
  return {
    kind: "federated",
    source: "AKS workload identity",
    tenantId: env.AZURE_TENANT_ID,
    clientId: env.AZURE_CLIENT_ID,
    authorityHost: env.AZURE_AUTHORITY_HOST,
    getAssertion: async () => fs.readFileSync(file, "utf8").trim()
  };
}
function jwtClaims(token) {
  try {
    return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
  } catch {
    return {};
  }
}
async function getEntraToken(exec2, identity, mask) {
  let token;
  if (identity.kind === "managed") {
    const query = new URLSearchParams({ "api-version": "2018-02-01", resource: ARM_RESOURCE });
    if (identity.clientId) query.set("client_id", identity.clientId);
    const r = await httpRequest(exec2, {
      url: `${IMDS}?${query}`,
      headers: { Metadata: "true" },
      noProxy: true,
      timeoutSeconds: 10
    });
    token = r.access_token;
  } else {
    const authority = (identity.authorityHost || DEFAULT_AUTHORITY).replace(/\/+$/, "");
    const form = {
      client_id: identity.clientId,
      scope: `${ARM_RESOURCE}.default`,
      grant_type: "client_credentials"
    };
    if (identity.kind === "federated") {
      const assertion = await identity.getAssertion();
      mask(assertion);
      form.client_assertion_type = "urn:ietf:params:oauth:client-assertion-type:jwt-bearer";
      form.client_assertion = assertion;
    } else {
      form.client_secret = identity.clientSecret;
    }
    const r = await httpRequest(exec2, {
      url: `${authority}/${encodeURIComponent(identity.tenantId)}/oauth2/v2.0/token`,
      form
    });
    token = r.access_token;
  }
  if (!token) throw new Error(`No access token received for ${identity.source}`);
  mask(token);
  return token;
}
async function exchangeAcrToken(exec2, registry, accessToken, mask) {
  const tenant = jwtClaims(accessToken).tid;
  const r = await httpRequest(exec2, {
    url: `https://${registry}/oauth2/exchange`,
    form: { grant_type: "access_token", service: registry, tenant, access_token: accessToken }
  });
  if (!r.refresh_token) throw new Error(`${registry} did not return a refresh token`);
  mask(r.refresh_token);
  return r.refresh_token;
}
async function acrCredentials(exec2, registry, identity, mask) {
  try {
    const accessToken = await getEntraToken(exec2, identity, mask);
    const refreshToken = await exchangeAcrToken(exec2, registry, accessToken, mask);
    return { registry, username: ACR_TOKEN_USERNAME, password: refreshToken, source: identity.source };
  } catch (err) {
    throw new Error(
      `Azure Container Registry login with ${identity.source} failed: ${err.message}. Make sure the identity has the AcrPush role on ${registry}.`
    );
  }
}
async function hasManagedIdentity(exec2) {
  const r = await exec2(
    "curl",
    [
      "-sS",
      "--noproxy",
      "*",
      "--max-time",
      "2",
      "-o",
      "/dev/null",
      "-w",
      "%{http_code}",
      "-H",
      "Metadata: true",
      "http://169.254.169.254/metadata/instance?api-version=2021-02-01"
    ],
    { silent: true, ignoreReturnCode: true }
  );
  return r.stdout.trim() === "200";
}
var TAG_REGISTRY = "container-registry";
var TAG_CLIENT_ID = "container-registry-client-id";
var machineSettingsPromise;
function machineSettings(exec2) {
  machineSettingsPromise ??= (async () => {
    try {
      const r = await httpRequest(exec2, {
        url: "http://169.254.169.254/metadata/instance/compute?api-version=2021-02-01",
        headers: { Metadata: "true" },
        noProxy: true,
        timeoutSeconds: 2
      });
      const tags = new Map((r.tagsList ?? []).map((t) => [t.name.toLowerCase().replace(/_/g, "-"), t.value.trim()]));
      return { registry: tags.get(TAG_REGISTRY) || void 0, clientId: tags.get(TAG_CLIENT_ID) || void 0 };
    } catch {
      return {};
    }
  })();
  return machineSettingsPromise;
}

// src/core/docker.ts
var fs2 = __toESM(require("node:fs"));
var os = __toESM(require("node:os"));
var path = __toESM(require("node:path"));
function hasDockerLogin(registry, env = process.env) {
  const file = path.join(env.DOCKER_CONFIG || path.join(os.homedir(), ".docker"), "config.json");
  try {
    const config = JSON.parse(fs2.readFileSync(file, "utf8"));
    const host = (k) => k.replace(/^[a-z]+:\/\//, "").split("/")[0].toLowerCase();
    return Object.keys(config.auths ?? {}).some((k) => host(k) === registry) || Object.keys(config.credHelpers ?? {}).some((k) => host(k) === registry);
  } catch {
    return false;
  }
}
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
    for (const [name, dir] of Object.entries(opts.buildContexts ?? {})) args.push("--build-context", `${name}=${dir}`);
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
var path2 = __toESM(require("node:path"));

// src/core/registry.ts
var VAR_REGISTRY = "CONTAINER_REGISTRY";
var VAR_USERNAME = "CONTAINER_REGISTRY_USERNAME";
var VAR_PASSWORD = "CONTAINER_REGISTRY_PASSWORD";
function normalizeRegistry(value) {
  let r = value.trim().toLowerCase().replace(/^[a-z]+:\/\//, "").replace(/\/+$/, "");
  const [host, ...rest] = r.split("/");
  if (["index.docker.io", "registry-1.docker.io", "registry.hub.docker.com"].includes(host)) {
    r = ["docker.io", ...rest.filter((p, i) => !(i === 0 && p === "v1"))].join("/");
  }
  return r;
}
var registryHost = (registry) => normalizeRegistry(registry).split("/")[0];
function sanitizeComponent(value) {
  return value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/[._-]{2,}/g, "-").replace(/^[._-]+|[._-]+$/g, "");
}
function hasRegistryHost(image) {
  const first = image.split("/")[0];
  return image.includes("/") && (first.includes(".") || first.includes(":") || first === "localhost");
}
function defaultImagePath(ctx, registry) {
  const repo = ctx.repository ? sanitizeComponent(ctx.repository) : "";
  if (!repo) return void 0;
  if (registryHost(registry) === "docker.io") return repo;
  const project = ctx.project ? sanitizeComponent(ctx.project) : "";
  return project ? `${project}/${repo}` : repo;
}
function configuredRegistry(platform2) {
  return platform2.getInput("registry") ?? platform2.getVariable(VAR_REGISTRY) ?? platform2.getDefaultRegistry();
}
function needsMachineSettings(platform2) {
  const image = platform2.getInput("image");
  return !configuredRegistry(platform2) && !(image && hasRegistryHost(image));
}
function resolveRegistry(platform2, machine = {}) {
  const value = configuredRegistry(platform2) ?? machine.registry ?? platform2.getFallbackRegistry?.();
  return value ? normalizeRegistry(value) : void 0;
}
function resolveImage(platform2, machine = {}) {
  const image = platform2.getInput("image");
  const registry = resolveRegistry(platform2, machine);
  if (image) {
    if (hasRegistryHost(image) || !registry) return image;
    return `${registry}/${image.replace(/^\/+/, "")}`;
  }
  if (!registry) {
    throw new Error(
      `Input 'image' is required when no registry is configured (input 'registry', variable ${VAR_REGISTRY} or tag '${TAG_REGISTRY}' of the agent VM).`
    );
  }
  const path6 = defaultImagePath(platform2.context, registry);
  if (!path6) throw new Error("Cannot derive the image name from the repository; set input 'image'.");
  if (registryHost(registry) === "docker.io" && !registry.includes("/")) {
    throw new Error("Docker Hub needs a namespace: set registry to 'docker.io/<namespace>' or set input 'image'.");
  }
  return `${registry}/${path6}`;
}
async function resolveCredentials(platform2, registry, opts) {
  const explicit = platform2.getCredentials(registry);
  if (explicit) return explicit;
  const configured = platform2.getVariable(VAR_REGISTRY);
  const password = platform2.getVariable(VAR_PASSWORD);
  if (password && configured && registryHost(configured) === registryHost(registry)) {
    const username = platform2.getVariable(VAR_USERNAME);
    if (!username) throw new Error(`${VAR_USERNAME} is required when ${VAR_PASSWORD} is set`);
    return { registry: registryHost(configured), username, password, source: "CONTAINER_REGISTRY_* variables" };
  }
  if (isAcr(registry)) {
    const mask = (v) => platform2.setSecret(v);
    const identity = platform2.getAzureIdentity?.(registry);
    if (identity) return acrCredentials(opts.exec, registry, identity, mask);
    if (opts.hasExistingLogin?.(registry)) return void 0;
    const workload = workloadIdentityFromEnv(opts.env ?? process.env);
    if (workload) return acrCredentials(opts.exec, registry, workload, mask);
    if (await hasManagedIdentity(opts.exec)) {
      const clientId = platform2.getInput("azureClientId") ?? (opts.env ?? process.env).AZURE_CLIENT_ID ?? (await machineSettings(opts.exec)).clientId;
      return acrCredentials(opts.exec, registry, { kind: "managed", source: "managed identity", clientId }, mask);
    }
  }
  return platform2.getFallbackCredentials?.(registry);
}

// src/core/inputs.ts
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
function readInputs(platform2, machine) {
  const { context: ctx } = platform2;
  const image = resolveImage(platform2, machine);
  const { registry, repository } = parseImage(image);
  const context = path2.resolve(ctx.workspace, platform2.getInput("context") ?? ".");
  const dockerfileInput = platform2.getInput("dockerfile");
  const dockerfile = dockerfileInput ? path2.resolve(ctx.workspace, dockerfileInput) : path2.join(context, "Dockerfile");
  const pushMode = (platform2.getInput("push") ?? "auto").toLowerCase();
  let push;
  if (pushMode === "auto") push = !ctx.isPullRequest;
  else push = parseBool(pushMode, true, "push");
  const severity = (platform2.getInput("severity") ?? DEFAULT_SEVERITY).toUpperCase().replace(/\s+/g, "");
  for (const s of severity.split(",")) {
    if (!SEVERITIES.includes(s)) throw new Error(`Invalid severity '${s}'. Allowed: ${SEVERITIES.join(",")}`);
  }
  const sbomFormat = (platform2.getInput("sbomFormat") ?? "cyclonedx").toLowerCase();
  if (sbomFormat !== "cyclonedx" && sbomFormat !== "spdx-json") {
    throw new Error(`Invalid sbomFormat '${sbomFormat}'. Allowed: cyclonedx, spdx-json`);
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
    sbom: parseBool(platform2.getInput("sbom"), true, "sbom"),
    sbomFormat,
    safeChain: parseBool(platform2.getInput("safeChain"), true, "safeChain"),
    trivyImage: trivyVersion.includes("/") ? trivyVersion : `ghcr.io/aquasecurity/trivy:${trivyVersion.replace(/^v/, "")}`
  };
}

// src/core/safechain.ts
var import_node_crypto = require("node:crypto");
var fs3 = __toESM(require("node:fs"));
var path3 = __toESM(require("node:path"));
var SAFE_CHAIN_VERSION = "1.5.29";
var SHA256 = {
  x64: "0a7287bbf5562610e1c4881b928037378c97b4ba7578694287b2ad3b7140b033",
  arm64: "0d565a91e2b1bf0e8ed0ab44cb22fad2aafc05259fe7d92eb40cafc41501ab59"
};
var SAFE_CHAIN_CONTEXT = "container-build-safe-chain";
var MOUNT_DIR = "/tmp/.container-build-safe-chain";
var MOUNTS = [
  // writable, not part of the image: safe-chain keeps its malware lists and certificates here
  `--mount=type=cache,id=${SAFE_CHAIN_CONTEXT},target=${MOUNT_DIR},mode=0777`,
  `--mount=type=bind,from=${SAFE_CHAIN_CONTEXT},source=bin,target=${MOUNT_DIR}/bin`,
  `--mount=type=bind,from=${SAFE_CHAIN_CONTEXT},source=shims,target=${MOUNT_DIR}/shims`
].join(" ");
var PREFIX = `export PATH="${MOUNT_DIR}/shims:${MOUNT_DIR}/bin:$PATH";`;
function instrumentDockerfile(content) {
  const lines = content.split("\n");
  for (const line of lines) {
    const m = line.match(/^#\s*([a-z]+)\s*=\s*(.*)$/i);
    if (!m) break;
    if (m[1].toLowerCase() === "escape" && m[2].trim() !== "\\") {
      return { content, wrapped: 0, skipped: 0, reason: "custom escape character (Windows Dockerfile)" };
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
      if (!trimmed.startsWith("#")) continuation = /\\\s*$/.test(line);
      continue;
    }
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    continuation = /\\\s*$/.test(line);
    const instr = trimmed.match(/^([a-z]+)\b/i)?.[1]?.toUpperCase();
    if (instr === "FROM") customShell = false;
    if (instr === "SHELL") customShell = true;
    if (instr !== "RUN") continue;
    const m = line.match(/^(\s*RUN)((?:\s+--\S+)*)(\s+)(.*)$/i);
    const rest = m?.[4] ?? "";
    if (!m || customShell || rest.startsWith("[") || /<<-?["']?[A-Za-z_]/.test(rest) || rest === "") {
      skipped++;
      continue;
    }
    lines[i] = `${m[1]}${m[2]} ${MOUNTS} ${PREFIX} ${rest}`;
    wrapped++;
  }
  return { content: lines.join("\n"), wrapped, skipped };
}
function sha256(file) {
  return (0, import_node_crypto.createHash)("sha256").update(fs3.readFileSync(file)).digest("hex");
}
async function prepareSafeChain(exec2, cacheDir, arch = process.arch, expected = SHA256[arch]) {
  if (!expected) throw new Error(`safe-chain is not available for architecture '${arch}'`);
  const dir = path3.join(cacheDir, "container-build-safe-chain", SAFE_CHAIN_VERSION, arch);
  const bin = path3.join(dir, "bin", "safe-chain");
  if (!fs3.existsSync(bin) || sha256(bin) !== expected) {
    fs3.rmSync(dir, { recursive: true, force: true });
    fs3.mkdirSync(path3.dirname(bin), { recursive: true });
    const url = `https://github.com/AikidoSec/safe-chain/releases/download/${SAFE_CHAIN_VERSION}/safe-chain-linuxstatic-${arch}`;
    const tmp = `${bin}.download`;
    await exec2("curl", ["-fsSL", "--retry", "3", "-o", tmp, url], { silent: true });
    const actual = sha256(tmp);
    if (actual !== expected) {
      fs3.rmSync(tmp, { force: true });
      throw new Error(`Checksum mismatch for ${url}: expected ${expected}, got ${actual}`);
    }
    fs3.chmodSync(tmp, 493);
    fs3.renameSync(tmp, bin);
  }
  if (!fs3.existsSync(path3.join(dir, "shims", "npm"))) {
    const env = { ...process.env };
    for (const k of ["GITHUB_PATH", "BASH_ENV", "TF_BUILD"]) delete env[k];
    await exec2(bin, ["setup-ci"], { silent: true, env });
  }
  fs3.rmSync(path3.join(dir, "certs"), { recursive: true, force: true });
  return dir;
}

// src/core/scan.ts
var fs4 = __toESM(require("node:fs"));
var path4 = __toESM(require("node:path"));
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
  const ca = [env.SSL_CERT_FILE, env.NODE_EXTRA_CA_CERTS].find((f) => f && fs4.existsSync(f));
  if (ca) args.push("-v", `${ca}:/etc/ssl/certs/ca-certificates.crt:ro`);
  return args;
}
var Trivy = class _Trivy {
  constructor(exec2, workDir, runArgs) {
    this.exec = exec2;
    this.workDir = workDir;
    this.runArgs = runArgs;
  }
  static async prepare(exec2, opts) {
    const workDir = fs4.mkdtempSync(path4.join(opts.tempDir, "container-scan-"));
    const cacheDir = path4.join(opts.tempDir, "trivy-cache");
    fs4.mkdirSync(cacheDir, { recursive: true });
    await exec2("docker", ["save", "--output", path4.join(workDir, "image.tar"), opts.imageRef], { silent: true });
    const run2 = ["run", "--rm", "-v", `${workDir}:/scan`, "-v", `${cacheDir}:/cache`];
    if (typeof process.getuid === "function" && process.getuid() !== 0) {
      run2.push("--user", `${process.getuid()}:${process.getgid?.() ?? 0}`, "-e", "HOME=/tmp");
    }
    if (opts.ignoreFile) run2.push("-v", `${opts.ignoreFile}:/scan-config/.trivyignore:ro`);
    run2.push(...proxyArgs(process.env));
    run2.push(opts.trivyImage);
    return new _Trivy(exec2, workDir, run2);
  }
  trivy(args, options = {}) {
    return this.exec("docker", [...this.runArgs, ...args], options);
  }
  /** Generates an SBOM of the image and returns its path on the host. */
  async sbom(format, repository) {
    const base = repository.replace(/[^a-z0-9.-]+/g, "_");
    const name = `${base}.${format === "cyclonedx" ? "cdx" : "spdx"}.json`;
    await this.trivy([
      "image",
      "--input",
      "/scan/image.tar",
      "--cache-dir",
      "/cache",
      "--format",
      format,
      "--output",
      `/scan/${name}`,
      "--no-progress",
      "--quiet"
    ]);
    return path4.join(this.workDir, name);
  }
  async scan(opts) {
    const args = [
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
    if (opts.ignoreUnfixed) args.push("--ignore-unfixed");
    if (opts.ignoreFile) args.push("--ignorefile", "/scan-config/.trivyignore");
    await this.trivy(args);
    await this.trivy(["convert", "--format", "table", "/scan/trivy-report.json"], { ignoreReturnCode: true });
    const reportFile = path4.join(this.workDir, "trivy-report.json");
    const vulnerabilities = parseTrivyReport(fs4.readFileSync(reportFile, "utf8"));
    return { vulnerabilities, counts: countBySeverity(vulnerabilities), reportFile };
  }
  /** Removes the (large) image tarball, keeps reports. */
  cleanup() {
    fs4.rmSync(path4.join(this.workDir, "image.tar"), { force: true });
  }
};
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
async function prepareBuild(platform2, exec2, inputs) {
  const plain = { dockerfile: inputs.dockerfile, buildContexts: {}, safeChain: "disabled" };
  if (!inputs.safeChain) return plain;
  if (process.platform !== "linux" || !["x64", "arm64"].includes(process.arch)) {
    platform2.warning(`safe-chain is only supported on Linux x64/arm64 agents; building without it.`);
    return { ...plain, safeChain: "unsupported agent" };
  }
  const result = instrumentDockerfile(fs5.readFileSync(inputs.dockerfile, "utf8"));
  if (result.wrapped === 0) {
    platform2.info(`safe-chain: no RUN instructions to protect${result.reason ? ` (${result.reason})` : ""}.`);
    return { ...plain, safeChain: "nothing to protect" };
  }
  const ctx = platform2.context;
  const safeChainDir = await prepareSafeChain(exec2, ctx.toolCacheDir ?? ctx.tempDir);
  const dir = fs5.mkdtempSync(path5.join(ctx.tempDir, "container-build-"));
  const dockerfile = path5.join(dir, path5.basename(inputs.dockerfile));
  fs5.writeFileSync(dockerfile, result.content);
  const ignore = `${inputs.dockerfile}.dockerignore`;
  if (fs5.existsSync(ignore)) fs5.copyFileSync(ignore, `${dockerfile}.dockerignore`);
  const skipped = result.skipped ? ` (${result.skipped} exec-form/heredoc/custom-shell RUN left as is)` : "";
  platform2.info(`safe-chain: protecting package installs in ${result.wrapped} RUN instruction(s)${skipped}.`);
  return { dockerfile, buildContexts: { [SAFE_CHAIN_CONTEXT]: safeChainDir }, safeChain: `${result.wrapped} RUN instruction(s)` };
}
async function run(platform2, exec2 = exec) {
  const machine = needsMachineSettings(platform2) ? await machineSettings(exec2) : void 0;
  if (machine?.registry) platform2.info(`Registry ${machine.registry} from the '${TAG_REGISTRY}' tag of the agent VM.`);
  const inputs = readInputs(platform2, machine);
  const ctx = platform2.context;
  const docker = new Docker(exec2);
  const tags = resolveTags(inputs.tags, ctx);
  const imageRefs = tags.map((t) => `${inputs.repository}:${t}`);
  if (!fs5.existsSync(inputs.dockerfile)) throw new Error(`Dockerfile not found: ${inputs.dockerfile}`);
  platform2.info(`Image:      ${inputs.repository}`);
  platform2.info(`Tags:       ${tags.join(", ")}`);
  platform2.info(`Context:    ${inputs.context}`);
  platform2.info(`Dockerfile: ${inputs.dockerfile}`);
  platform2.info(`SafeChain:  ${inputs.safeChain ? "yes" : "no"}`);
  platform2.info(`SBOM:       ${inputs.sbom ? inputs.sbomFormat : "no"}`);
  platform2.info(`Scan:       ${inputs.scan ? `yes (${inputs.severity})` : "no"}`);
  platform2.info(`Push:       ${inputs.push ? "yes" : "no"}`);
  platform2.info(`Docker:     ${await docker.version()}`);
  const labels = { "org.opencontainers.image.created": (/* @__PURE__ */ new Date()).toISOString() };
  if (ctx.sha) labels["org.opencontainers.image.revision"] = ctx.sha;
  const result = { imageRefs, pushed: false };
  const summary = [`### Container build: \`${inputs.repository}\``, "", `Tags: ${tags.map((t) => `\`${t}\``).join(", ")}`, ""];
  const build = await prepareBuild(platform2, exec2, inputs);
  await group(
    platform2,
    "Build image",
    () => docker.build({
      context: inputs.context,
      dockerfile: build.dockerfile,
      imageRefs,
      buildArgs: inputs.buildArgs,
      target: inputs.target,
      labels,
      buildContexts: build.buildContexts
    })
  );
  if (inputs.safeChain) summary.push(`\u{1F6E1}\uFE0F Package installs protected by [Aikido Safe Chain](https://github.com/AikidoSec/safe-chain): ${build.safeChain}`, "");
  if (inputs.sbom || inputs.scan) {
    const ignoreFile = [path5.join(inputs.context, ".trivyignore"), path5.join(ctx.workspace, ".trivyignore")].find(
      (f) => fs5.existsSync(f)
    );
    const trivy = await Trivy.prepare(exec2, {
      imageRef: imageRefs[0],
      trivyImage: inputs.trivyImage,
      tempDir: ctx.tempDir,
      ignoreFile
    });
    try {
      if (inputs.sbom) {
        const sbom = await group(platform2, `Generate SBOM (${inputs.sbomFormat})`, () => trivy.sbom(inputs.sbomFormat, inputs.repository));
        result.sbom = sbom;
        platform2.setOutput("sbom", sbom);
        platform2.publishArtifact("sbom", sbom);
        platform2.info(`SBOM written to ${sbom}`);
        summary.push(`\u{1F4E6} SBOM (${inputs.sbomFormat}) generated.`, "");
      }
      if (inputs.scan) {
        const scan = await group(
          platform2,
          "Security scan (Trivy)",
          () => trivy.scan({ severity: inputs.severity, ignoreUnfixed: inputs.ignoreUnfixed, ignoreFile })
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
    } finally {
      trivy.cleanup();
    }
  }
  if (inputs.push) {
    const creds = await resolveCredentials(platform2, inputs.registry, { exec: exec2, hasExistingLogin: hasDockerLogin });
    if (creds) {
      platform2.setSecret(creds.password);
      platform2.info(`Logging in to ${creds.registry}${creds.source ? ` with ${creds.source}` : ` as ${creds.username}`}`);
      await docker.login(creds);
    } else {
      platform2.info(`No credentials configured for ${inputs.registry}; using existing docker login.`);
      if (isAcr(inputs.registry)) {
        platform2.info(
          "No Azure identity found either (service connection, GitHub OIDC, AKS workload identity or managed identity of the agent)."
        );
      }
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
var fs6 = __toESM(require("node:fs"));
var os2 = __toESM(require("node:os"));
var kebab = (name) => name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
function escapeData(s) {
  return s.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}
var GitHubPlatform = class {
  constructor(env = process.env, exec2 = exec) {
    this.env = env;
    this.exec = exec2;
    const [owner, repo] = (env.GITHUB_REPOSITORY ?? "").split("/");
    this.context = {
      project: owner || void 0,
      repository: repo || void 0,
      sha: env.GITHUB_SHA,
      ref: env.GITHUB_REF,
      isPullRequest: ["pull_request", "pull_request_target"].includes(env.GITHUB_EVENT_NAME ?? ""),
      tempDir: env.RUNNER_TEMP || os2.tmpdir(),
      workspace: env.GITHUB_WORKSPACE || process.cwd(),
      toolCacheDir: env.RUNNER_TOOL_CACHE || void 0
    };
  }
  name = "GitHub Actions";
  context;
  getInput(name) {
    const key = `INPUT_${kebab(name).replace(/ /g, "_").toUpperCase()}`;
    const value = this.env[key]?.trim();
    return value ? value : void 0;
  }
  getVariable(name) {
    const value = this.env[name]?.trim();
    return value ? value : void 0;
  }
  getDefaultRegistry() {
    return void 0;
  }
  getFallbackRegistry() {
    return "ghcr.io";
  }
  getCredentials(registry) {
    const username = this.getInput("username");
    const password = this.getInput("password");
    if (!password) return void 0;
    if (!username) throw new Error("Input 'username' is required when 'password' is set");
    return { registry, username, password, source: "username/password inputs" };
  }
  /**
   * GitHub OIDC federated with a Microsoft Entra app registration or user-assigned managed identity.
   * Needs `permissions: id-token: write` and the client/tenant id (inputs or AZURE_CLIENT_ID/AZURE_TENANT_ID).
   */
  getAzureIdentity() {
    const explicitClientId = this.getInput("azureClientId");
    const clientId = explicitClientId ?? this.getVariable("AZURE_CLIENT_ID");
    const tenantId = this.getInput("azureTenantId") ?? this.getVariable("AZURE_TENANT_ID");
    const requestUrl = this.env.ACTIONS_ID_TOKEN_REQUEST_URL;
    const requestToken = this.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
    if (!clientId || !tenantId) return void 0;
    if (!explicitClientId && this.env.AZURE_FEDERATED_TOKEN_FILE) return void 0;
    if (!requestUrl || !requestToken) {
      this.info("No GitHub OIDC token available (add 'permissions: id-token: write' to use it for Azure).");
      return void 0;
    }
    return {
      kind: "federated",
      source: "GitHub OIDC",
      clientId,
      tenantId,
      authorityHost: this.getVariable("AZURE_AUTHORITY_HOST"),
      getAssertion: async () => {
        const sep = requestUrl.includes("?") ? "&" : "?";
        const r = await httpRequest(this.exec, {
          url: `${requestUrl}${sep}audience=${encodeURIComponent("api://AzureADTokenExchange")}`,
          headers: { Authorization: `Bearer ${requestToken}` }
        });
        if (!r.value) throw new Error("GitHub did not return an OIDC token");
        return r.value;
      }
    };
  }
  /** Zero-config GitHub Container Registry: use the workflow token. */
  getFallbackCredentials(registry) {
    const token = this.getInput("githubToken");
    if (registry !== "ghcr.io" || !token) return void 0;
    return { registry, username: this.getInput("username") ?? this.env.GITHUB_ACTOR ?? "github-actions", password: token, source: "GITHUB_TOKEN" };
  }
  debug(message) {
    process.stdout.write(`::debug::${escapeData(message)}${os2.EOL}`);
  }
  info(message) {
    process.stdout.write(`${message}${os2.EOL}`);
  }
  warning(message) {
    process.stdout.write(`::warning::${escapeData(message)}${os2.EOL}`);
  }
  error(message) {
    process.stdout.write(`::error::${escapeData(message)}${os2.EOL}`);
  }
  startGroup(name) {
    process.stdout.write(`::group::${escapeData(name)}${os2.EOL}`);
  }
  endGroup() {
    process.stdout.write(`::endgroup::${os2.EOL}`);
  }
  setSecret(value) {
    for (const line of value.split(/\r?\n/)) if (line) process.stdout.write(`::add-mask::${escapeData(line)}${os2.EOL}`);
  }
  setOutput(name, value) {
    const file = this.env.GITHUB_OUTPUT;
    const key = kebab(name);
    if (!file) {
      this.debug(`output ${key}=${value}`);
      return;
    }
    const delimiter = `ghadelimiter_${Math.random().toString(36).slice(2)}`;
    fs6.appendFileSync(file, `${key}<<${delimiter}${os2.EOL}${value}${os2.EOL}${delimiter}${os2.EOL}`);
  }
  addSummary(markdown) {
    const file = this.env.GITHUB_STEP_SUMMARY;
    if (file) fs6.appendFileSync(file, `${markdown}${os2.EOL}`);
  }
  publishArtifact() {
  }
  setFailed(message) {
    this.error(message);
    process.exitCode = 1;
  }
};

// src/github/main.ts
var platform = new GitHubPlatform();
run(platform).catch((err) => platform.setFailed(err instanceof Error ? err.message : String(err)));
