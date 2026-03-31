import http from "node:http";
import path from "node:path";
import { mkdir, readFile, writeFile, access } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { spawn } from "node:child_process";

const DEFAULT_BOT_CONFIG = {
  subnetId: "",
  compartmentId: "",
  availabilityDomain: "",
  imageId: "",
  displayName: "Oracle-ARM-Bot",
  sshAuthorizedKeys: "",
  ocpus: 2,
  memory: 12,
  bootVolumeSize: 150,
  intervalSeconds: 120,
};

const DEFAULT_STATUS = {
  phase: "idle",
  message: "Not started",
  lastAttemptAt: null,
  lastResult: "",
  lastError: "",
  active: false,
};

function createJsonResponse(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(payload));
}

function createTextResponse(res, statusCode, payload, contentType = "text/plain; charset=utf-8") {
  res.writeHead(statusCode, {
    "content-type": contentType,
    "cache-control": "no-store",
  });
  res.end(payload);
}

async function readRequestBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  if (chunks.length === 0) {
    return {};
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

async function fileExists(targetPath) {
  try {
    await access(targetPath, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function normalizeMultiline(value) {
  return String(value ?? "").replace(/\r\n/g, "\n").trim();
}

class JsonFileStore {
  constructor(filePath, defaults) {
    this.filePath = filePath;
    this.defaults = defaults;
    this.data = structuredClone(defaults);
  }

  async init() {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    if (await fileExists(this.filePath)) {
      const raw = await readFile(this.filePath, "utf8");
      this.data = { ...structuredClone(this.defaults), ...JSON.parse(raw) };
    } else {
      await this.save(this.defaults);
    }
  }

  get() {
    return structuredClone(this.data);
  }

  async save(nextValue) {
    this.data = { ...structuredClone(this.defaults), ...nextValue };
    await writeFile(this.filePath, `${JSON.stringify(this.data, null, 2)}\n`, "utf8");
    return this.get();
  }
}

class Logger {
  constructor(logPath, now = () => new Date()) {
    this.logPath = logPath;
    this.now = now;
    this.lines = [];
    this.subscribers = new Set();
  }

  async init() {
    await mkdir(path.dirname(this.logPath), { recursive: true });
    if (await fileExists(this.logPath)) {
      const existing = await readFile(this.logPath, "utf8");
      this.lines = existing.split(/\r?\n/).filter(Boolean);
    }
  }

  async append(message) {
    const line = `[${this.now().toISOString()}] ${message}`;
    this.lines.push(line);
    if (this.lines.length > 500) {
      this.lines = this.lines.slice(-500);
    }
    await writeFile(this.logPath, `${this.lines.join("\n")}\n`, "utf8");
    for (const subscriber of this.subscribers) {
      subscriber(line);
    }
    return line;
  }

  getLines() {
    return [...this.lines];
  }

  subscribe(listener) {
    this.subscribers.add(listener);
    return () => {
      this.subscribers.delete(listener);
    };
  }
}

function writeSseMessage(res, data) {
  res.write(`data: ${String(data).replace(/\r?\n/g, "\ndata: ")}\n\n`);
}

class OciConfigStore {
  constructor(ociDir) {
    this.ociDir = ociDir;
    this.configPath = path.join(ociDir, "config");
    this.keyPath = path.join(ociDir, "oci_api_key.pem");
  }

  async init() {
    await mkdir(this.ociDir, { recursive: true });
  }

  async save(input) {
    const config = {
      tenancy: String(input.tenancy ?? "").trim(),
      user: String(input.user ?? "").trim(),
      fingerprint: String(input.fingerprint ?? "").trim(),
      region: String(input.region ?? "").trim(),
      privateKey: normalizeMultiline(input.privateKey),
    };

    for (const [key, value] of Object.entries(config)) {
      if (!value) {
        throw new Error(`Missing OCI field: ${key}`);
      }
    }

    await mkdir(this.ociDir, { recursive: true });
    await writeFile(this.keyPath, `${config.privateKey}\n`, { encoding: "utf8", mode: 0o600 });

    const configText = [
      "[DEFAULT]",
      `user=${config.user}`,
      `fingerprint=${config.fingerprint}`,
      `tenancy=${config.tenancy}`,
      `region=${config.region}`,
      `key_file=${this.keyPath.replace(/\\/g, "/")}`,
      "",
    ].join("\n");

    await writeFile(this.configPath, configText, "utf8");
    return this.getMetadata();
  }

  async getMetadata() {
    const configured = await fileExists(this.configPath);
    return {
      configured,
      configPath: this.configPath,
      keyPath: this.keyPath,
    };
  }
}

function defaultCommandRunner(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

class BotJobRunner {
  constructor({ configStore, statusStore, logger, commandRunner, dataDir, now = () => new Date() }) {
    this.configStore = configStore;
    this.statusStore = statusStore;
    this.logger = logger;
    this.commandRunner = commandRunner;
    this.dataDir = dataDir;
    this.now = now;
    this.running = false;
    this.abortRequested = false;
    this.currentPromise = null;
  }

  getStatus() {
    return this.statusStore.get();
  }

  async setStatus(patch) {
    const next = { ...this.statusStore.get(), ...patch };
    await this.statusStore.save(next);
    return next;
  }

  async validateOci() {
    return this.commandRunner("oci", ["os", "ns", "get"], { cwd: this.dataDir, env: process.env });
  }

  buildLaunchArgs(config, publicKeyPath, shapeConfigPath) {
    return [
      "compute",
      "instance",
      "launch",
      "--availability-domain",
      config.availabilityDomain,
      "--compartment-id",
      config.compartmentId,
      "--shape",
      "VM.Standard.A1.Flex",
      "--shape-config",
      `file://${shapeConfigPath.replace(/\\/g, "/")}`,
      "--display-name",
      config.displayName,
      "--image-id",
      config.imageId,
      "--boot-volume-size-in-gbs",
      String(config.bootVolumeSize),
      "--subnet-id",
      config.subnetId,
      "--ssh-authorized-keys-file",
      publicKeyPath,
    ];
  }

  async prepareAttemptFiles(config) {
    const runtimeDir = path.join(this.dataDir, "runtime");
    await mkdir(runtimeDir, { recursive: true });

    const publicKeyPath = path.join(runtimeDir, "oracle_key.pub");
    const shapeConfigPath = path.join(runtimeDir, "shape_config.json");

    await writeFile(publicKeyPath, `${normalizeMultiline(config.sshAuthorizedKeys)}\n`, "utf8");
    await writeFile(shapeConfigPath, JSON.stringify({ ocpus: Number(config.ocpus), memoryInGBs: Number(config.memory) }), "utf8");

    return { publicKeyPath, shapeConfigPath };
  }

  classifyResult(output) {
    const text = output.trim();
    const lowered = text.toLowerCase();

    if (lowered.includes("capacity")) {
      return { phase: "waiting", message: "Out of Stock", retryDelayMultiplier: 1 };
    }
    if (lowered.includes("toomanyrequests")) {
      return { phase: "waiting", message: "Rate Limited", retryDelayMultiplier: 2 };
    }
    if (lowered.includes("opc-work-request-id") || lowered.includes("provisioning")) {
      return { phase: "success", message: "Instance provisioned", retryDelayMultiplier: 0 };
    }
    return { phase: "error", message: "Unexpected Response", retryDelayMultiplier: 1 };
  }

  async start() {
    if (this.running) {
      return { accepted: false, reason: "Job already running" };
    }

    const config = this.configStore.get();
    for (const field of ["subnetId", "compartmentId", "availabilityDomain", "imageId", "sshAuthorizedKeys"]) {
      if (!String(config[field] ?? "").trim()) {
        throw new Error(`Missing required bot config: ${field}`);
      }
    }

    this.abortRequested = false;
    this.running = true;
    await this.setStatus({
      phase: "running",
      message: "Job started",
      active: true,
      lastError: "",
    });
    await this.logger.append("Bot job started.");

    this.currentPromise = this.runLoop().finally(async () => {
      this.running = false;
      if (this.abortRequested) {
        await this.setStatus({ phase: "stopped", message: "Job stopped", active: false });
        await this.logger.append("Bot job stopped.");
      }
    });

    return { accepted: true };
  }

  async stop() {
    this.abortRequested = true;
    if (!this.running) {
      await this.setStatus({ phase: "stopped", message: "Job stopped", active: false });
      return { ok: true, active: false };
    }
    await this.setStatus({ phase: "stopped", message: "Stopping", active: false });
    return { ok: true, active: false };
  }

  async runLoop() {
    while (!this.abortRequested) {
      const config = this.configStore.get();
      const { publicKeyPath, shapeConfigPath } = await this.prepareAttemptFiles(config);
      if (this.abortRequested) {
        return;
      }
      const timestamp = this.now().toISOString();
      await this.setStatus({
        phase: "running",
        message: "Requesting ARM Instance",
        lastAttemptAt: timestamp,
        active: true,
      });
      if (this.abortRequested) {
        return;
      }
      await this.logger.append("Requesting ARM Instance...");

      const result = await this.commandRunner(
        "oci",
        this.buildLaunchArgs(config, publicKeyPath, shapeConfigPath),
        { cwd: this.dataDir, env: process.env },
      );

      if (this.abortRequested) {
        return;
      }

      const output = `${result.stdout}${result.stderr}`.trim();
      const classified = this.classifyResult(output);

      if (classified.phase === "success") {
        await this.setStatus({
          phase: "success",
          message: classified.message,
          lastResult: output,
          lastError: "",
          active: false,
        });
        await this.logger.append(`SUCCESS: ${classified.message}`);
        return;
      }

      if (classified.phase === "waiting") {
        await this.setStatus({
          phase: "waiting",
          message: classified.message,
          lastResult: output,
          lastError: "",
          active: true,
        });
        const label = classified.message === "Out of Stock" ? "Out of Stock" : "Rate Limited";
        await this.logger.append(`${label}: ${output || classified.message}`);
        const delayMs = Math.max(0, Number(config.intervalSeconds) * 1000 * classified.retryDelayMultiplier);
        await delay(delayMs, () => this.abortRequested);
        continue;
      }

      await this.setStatus({
        phase: "error",
        message: classified.message,
        lastResult: output,
        lastError: output,
        active: false,
      });
      await this.logger.append(`Unexpected Response: ${output || "No output"}`);
      return;
    }
  }

  async shutdown() {
    this.abortRequested = true;
    if (this.currentPromise) {
      await this.currentPromise.catch(() => {});
    }
  }
}

async function delay(ms, shouldAbort) {
  if (ms <= 0) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    return;
  }

  const started = Date.now();
  while (Date.now() - started < ms) {
    if (shouldAbort()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(100, ms)));
  }
}

function getStaticContent(fileName) {
  const publicDir = path.resolve(process.cwd(), "public");
  return readFile(path.join(publicDir, fileName), "utf8");
}

export function createApp({ dataDir = path.resolve(process.cwd(), "data"), ociDir = "/root/.oci", commandRunner = defaultCommandRunner, now = () => new Date() } = {}) {
  const configStore = new JsonFileStore(path.join(dataDir, "config.json"), DEFAULT_BOT_CONFIG);
  const statusStore = new JsonFileStore(path.join(dataDir, "job-state.json"), DEFAULT_STATUS);
  const logger = new Logger(path.join(dataDir, "logs", "app.log"), now);
  const ociConfigStore = new OciConfigStore(ociDir);
  const jobRunner = new BotJobRunner({ configStore, statusStore, logger, commandRunner, dataDir, now });

  const ready = Promise.all([
    configStore.init(),
    statusStore.init(),
    logger.init(),
    ociConfigStore.init(),
  ]);

  const server = http.createServer(async (req, res) => {
    await ready;

    const url = new URL(req.url, "http://127.0.0.1");

    try {
      if (req.method === "GET" && url.pathname === "/") {
        const html = await getStaticContent("index.html");
        return createTextResponse(res, 200, html, "text/html; charset=utf-8");
      }

      if (req.method === "GET" && url.pathname === "/app.js") {
        const js = await getStaticContent("app.js");
        return createTextResponse(res, 200, js, "application/javascript; charset=utf-8");
      }

      if (req.method === "GET" && url.pathname === "/tf-parser.js") {
        const js = await getStaticContent("tf-parser.js");
        return createTextResponse(res, 200, js, "application/javascript; charset=utf-8");
      }

      if (req.method === "GET" && url.pathname === "/icon.svg") {
        const svg = await getStaticContent("icon.svg");
        return createTextResponse(res, 200, svg, "image/svg+xml; charset=utf-8");
      }

      if (req.method === "GET" && url.pathname === "/styles.css") {
        const css = await getStaticContent("styles.css");
        return createTextResponse(res, 200, css, "text/css; charset=utf-8");
      }

      if (req.method === "GET" && url.pathname === "/api/config") {
        return createJsonResponse(res, 200, { config: configStore.get() });
      }

      if (req.method === "POST" && url.pathname === "/api/config") {
        const body = await readRequestBody(req);
        const saved = await configStore.save({ ...configStore.get(), ...body });
        await logger.append("Bot configuration saved.");
        return createJsonResponse(res, 200, { ok: true, config: saved });
      }

      if (req.method === "POST" && url.pathname === "/api/oci/config") {
        const body = await readRequestBody(req);
        const metadata = await ociConfigStore.save(body);
        await logger.append("OCI configuration saved.");
        return createJsonResponse(res, 200, { ok: true, oci: metadata });
      }

      if (req.method === "POST" && url.pathname === "/api/oci/validate") {
        const result = await jobRunner.validateOci();
        const output = `${result.stdout}${result.stderr}`.trim();
        if (result.code === 0) {
          await logger.append("OCI validation succeeded.");
          return createJsonResponse(res, 200, { ok: true, output });
        }
        await logger.append(`OCI validation failed: ${output}`);
        return createJsonResponse(res, 400, { ok: false, output });
      }

      if (req.method === "POST" && url.pathname === "/api/job/start") {
        const result = await jobRunner.start();
        if (!result.accepted) {
          return createJsonResponse(res, 409, { ok: false, message: result.reason });
        }
        return createJsonResponse(res, 202, { ok: true });
      }

      if (req.method === "POST" && url.pathname === "/api/job/stop") {
        const result = await jobRunner.stop();
        return createJsonResponse(res, 200, result);
      }

      if (req.method === "GET" && url.pathname === "/api/job/status") {
        return createJsonResponse(res, 200, { status: jobRunner.getStatus() });
      }

      if (req.method === "GET" && url.pathname === "/api/logs") {
        return createJsonResponse(res, 200, { logs: logger.getLines() });
      }

      if (req.method === "GET" && url.pathname === "/api/logs/stream") {
        res.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-store",
          connection: "keep-alive",
          "x-accel-buffering": "no",
        });

        for (const line of logger.getLines()) {
          writeSseMessage(res, line);
        }

        const unsubscribe = logger.subscribe((line) => {
          writeSseMessage(res, line);
        });

        const cleanup = () => {
          unsubscribe();
        };

        req.on("close", cleanup);
        res.on("close", cleanup);
        return;
      }

      return createJsonResponse(res, 404, { error: "Not Found" });
    } catch (error) {
      await logger.append(`Request failed: ${error.message}`);
      return createJsonResponse(res, 500, { error: error.message });
    }
  });

  return {
    ready,
    server,
    shutdown: async () => {
      await jobRunner.shutdown();
    },
  };
}
