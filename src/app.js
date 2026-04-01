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
  feishuWebhookUrl: "",
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
  startedAt: null,
  endedAt: null,
  nextRetryAt: null,
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

function createRedirectResponse(res, location) {
  res.writeHead(302, {
    location,
    "cache-control": "no-store",
  });
  res.end();
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
    if (this.lines.length > 100) {
      this.lines = this.lines.slice(-100);
    }
    await writeFile(this.logPath, `${this.lines.join("\n")}\n`, "utf8");
    for (const subscriber of this.subscribers) {
      subscriber(line);
    }
    return line;
  }

  async clear() {
    this.lines = [];
    await writeFile(this.logPath, "", "utf8");
  }

  getLines() {
    return [...this.lines];
  }

  getSubscriberCount() {
    return this.subscribers.size;
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

function writeSseComment(res, comment) {
  res.write(`: ${String(comment).replace(/\r?\n/g, " ")}\n\n`);
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

  async getConfig() {
    const metadata = await this.getMetadata();
    if (!metadata.configured) {
      return {
        configured: false,
        tenancy: "",
        user: "",
        fingerprint: "",
        region: "",
        privateKey: "",
      };
    }

    const configText = await readFile(this.configPath, "utf8");
    const privateKey = await readFile(this.keyPath, "utf8");
    const values = {
      configured: true,
      tenancy: "",
      user: "",
      fingerprint: "",
      region: "",
      privateKey: privateKey.trim(),
    };

    for (const line of configText.split(/\r?\n/)) {
      const [rawKey, ...rawValueParts] = line.split("=");
      if (!rawKey || rawValueParts.length === 0) {
        continue;
      }

      const key = rawKey.trim();
      const value = rawValueParts.join("=").trim();
      if (["tenancy", "user", "fingerprint", "region"].includes(key)) {
        values[key] = value;
      }
    }

    return values;
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

export function appendBoundedOutput(current, chunk, maxOutputBytes) {
  const next = `${current}${chunk.toString()}`;
  if (!Number.isFinite(maxOutputBytes) || maxOutputBytes <= 0 || next.length <= maxOutputBytes) {
    return next;
  }

  const marker = "\n[truncated]";
  const sliceLength = Math.max(0, maxOutputBytes - marker.length);
  return `${next.slice(0, sliceLength)}${marker}`;
}

export function createCommandRunner(spawnImpl = spawn) {
  return function commandRunner(command, args, options = {}) {
    return new Promise((resolve, reject) => {
      const maxOutputBytes = Number(options.maxOutputBytes ?? 64 * 1024);
      const timeoutMs = Number(options.timeoutMs ?? 120000);
      const unrefTimers = options.unrefTimers !== false;
      const child = spawnImpl(command, args, {
        cwd: options.cwd,
        env: options.env,
        shell: false,
      });

      let stdout = "";
      let stderr = "";
      let timedOut = false;

      const killTimer = Number.isFinite(timeoutMs) && timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            stderr = appendBoundedOutput(stderr, "\nProcess timed out and was terminated.", maxOutputBytes);
            child.kill("SIGTERM");

            const forceKillTimer = setTimeout(() => {
              child.kill("SIGKILL");
            }, 1000);

            if (unrefTimers && forceKillTimer.unref) {
              forceKillTimer.unref();
            }
          }, timeoutMs)
        : null;

      if (unrefTimers && killTimer?.unref) {
        killTimer.unref();
      }

      child.stdout.on("data", (chunk) => {
        stdout = appendBoundedOutput(stdout, chunk, maxOutputBytes);
      });

      child.stderr.on("data", (chunk) => {
        stderr = appendBoundedOutput(stderr, chunk, maxOutputBytes);
      });

      child.on("error", (error) => {
        if (killTimer) {
          clearTimeout(killTimer);
        }
        reject(error);
      });
      child.on("close", (code) => {
        if (killTimer) {
          clearTimeout(killTimer);
        }
        resolve({ code: timedOut ? code ?? 124 : code ?? 1, stdout, stderr });
      });
    });
  };
}

export const defaultCommandRunner = createCommandRunner(spawn);

async function defaultNotificationSender({ webhookUrl, text }) {
  if (!webhookUrl) {
    return { skipped: true };
  }

  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({
      msg_type: "text",
      content: {
        text,
      },
    }),
  });

  if (!response.ok) {
    const details = await response.text().catch(() => "");
    throw new Error(`Feishu webhook failed: ${response.status} ${details}`.trim());
  }

  return { ok: true };
}

class BotJobRunner {
  constructor({ configStore, statusStore, logger, commandRunner, notificationSender, dataDir, now = () => new Date() }) {
    this.configStore = configStore;
    this.statusStore = statusStore;
    this.logger = logger;
    this.commandRunner = commandRunner;
    this.notificationSender = notificationSender;
    this.dataDir = dataDir;
    this.now = now;
    this.running = false;
    this.abortRequested = false;
    this.currentPromise = null;
  }

  async notifySuccess(config, output) {
    if (!String(config.feishuWebhookUrl ?? "").trim()) {
      return;
    }

    const text = [
      "OCI ARM 抢机成功",
      `实例名称: ${config.displayName || "Oracle-ARM-Bot"}`,
      `区域/可用域: ${config.availabilityDomain}`,
      `镜像: ${config.imageId}`,
      `时间: ${this.now().toISOString()}`,
      "",
      `返回摘要: ${output.slice(0, 500)}`,
    ].join("\n");

    await this.notificationSender({
      webhookUrl: config.feishuWebhookUrl,
      text,
    });
  }

  getStatus() {
    return this.statusStore.get();
  }

  async setStatus(patch) {
    const next = { ...this.statusStore.get(), ...patch };
    await this.statusStore.save(next);
    return next;
  }

  async reconcilePersistedState() {
    const status = this.statusStore.get();
    if (status.phase !== "running" && status.phase !== "waiting" && !status.active) {
      return status;
    }

    return this.setStatus({
      phase: "stopped",
      message: "Job interrupted by restart",
      active: false,
      endedAt: this.now().toISOString(),
      nextRetryAt: null,
    });
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

    const startedAt = this.now().toISOString();
    this.abortRequested = false;
    this.running = true;
    await this.setStatus({
      phase: "running",
      message: "Job started",
      active: true,
      lastError: "",
      startedAt,
      endedAt: null,
      nextRetryAt: null,
    });
    await this.logger.append("Bot job started.");

    this.currentPromise = this.runLoop().finally(async () => {
      this.running = false;
      if (this.abortRequested) {
        await this.setStatus({
          phase: "stopped",
          message: "Job stopped",
          active: false,
          endedAt: this.now().toISOString(),
          nextRetryAt: null,
        });
        await this.logger.append("Bot job stopped.");
      }
    });

    return { accepted: true };
  }

  async stop() {
    this.abortRequested = true;
    if (!this.running) {
      await this.setStatus({
        phase: "stopped",
        message: "Job stopped",
        active: false,
        endedAt: this.now().toISOString(),
        nextRetryAt: null,
      });
      return { ok: true, active: false };
    }
    await this.setStatus({
      phase: "stopped",
      message: "Stopping",
      active: false,
      endedAt: this.now().toISOString(),
      nextRetryAt: null,
    });
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
        nextRetryAt: null,
      });
      if (this.abortRequested) {
        return;
      }
      await this.logger.append("Requesting ARM Instance...");

      const result = await this.commandRunner(
        "oci",
        this.buildLaunchArgs(config, publicKeyPath, shapeConfigPath),
        {
          cwd: this.dataDir,
          env: {
            ...process.env,
            OCI_CLI_SKIP_FILE_PERMISSIONS_CHECK: "True",
            OCI_CLI_SUPPRESS_FILE_PERMISSIONS_WARNING: "True"
          }
        },
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
          endedAt: this.now().toISOString(),
          nextRetryAt: null,
        });
        await this.logger.append(`SUCCESS: ${classified.message}`);
        try {
          await this.notifySuccess(config, output);
          await this.logger.append("Feishu success notification sent.");
        } catch (error) {
          await this.logger.append(`Feishu notification failed: ${error.message}`);
        }
        return;
      }

      if (classified.phase === "waiting") {
        const delayMs = Math.max(0, Number(config.intervalSeconds) * 1000 * classified.retryDelayMultiplier);
      await this.setStatus({
        phase: "waiting",
        message: classified.message,
        lastResult: output,
        lastError: "",
        active: true,
        endedAt: null,
        nextRetryAt: new Date(this.now().getTime() + delayMs).toISOString(),
      });
        const label = classified.message === "Out of Stock" ? "Out of Stock" : "Rate Limited";
        await this.logger.append(`${label}: ${output || classified.message}`);
        await delay(delayMs, () => this.abortRequested);
        continue;
      }

      await this.setStatus({
        phase: "error",
        message: classified.message,
        lastResult: output,
        lastError: output,
        active: false,
        endedAt: this.now().toISOString(),
        nextRetryAt: null,
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

function getContentType(fileName) {
  const extension = path.extname(fileName).toLowerCase();
  switch (extension) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
      return "application/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".svg":
      return "image/svg+xml; charset=utf-8";
    default:
      return "text/plain; charset=utf-8";
  }
}

export function createApp({
  dataDir = path.resolve(process.cwd(), "data"),
  ociDir = "/root/.oci",
  commandRunner = defaultCommandRunner,
  notificationSender = defaultNotificationSender,
  now = () => new Date(),
  sseHeartbeatMs = 15000,
  sseClientTtlMs = 15 * 60 * 1000,
} = {}) {
  const configStore = new JsonFileStore(path.join(dataDir, "config.json"), DEFAULT_BOT_CONFIG);
  const statusStore = new JsonFileStore(path.join(dataDir, "job-state.json"), DEFAULT_STATUS);
  const logger = new Logger(path.join(dataDir, "logs", "app.log"), now);
  const ociConfigStore = new OciConfigStore(ociDir);
  const jobRunner = new BotJobRunner({ configStore, statusStore, logger, commandRunner, notificationSender, dataDir, now });

  const ready = Promise.all([
    configStore.init(),
    statusStore.init(),
    logger.init(),
    ociConfigStore.init(),
  ]).then(() => jobRunner.reconcilePersistedState());

  const server = http.createServer(async (req, res) => {
    await ready;

    const url = new URL(req.url, "http://127.0.0.1");

    try {
      if (req.method === "GET" && url.pathname === "/") {
        return createRedirectResponse(res, "/monitor");
      }

      if (req.method === "GET" && ["/monitor", "/config", "/logs"].includes(url.pathname)) {
        const fileName = `${url.pathname.slice(1)}.html`;
        const html = await getStaticContent(fileName);
        return createTextResponse(res, 200, html, getContentType(fileName));
      }

      if (req.method === "GET" && /^\/[\w.-]+\.(js|css|svg)$/.test(url.pathname)) {
        const fileName = url.pathname.slice(1);
        const content = await getStaticContent(fileName);
        return createTextResponse(res, 200, content, getContentType(fileName));
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

      if (req.method === "GET" && url.pathname === "/api/oci/config") {
        const oci = await ociConfigStore.getConfig();
        return createJsonResponse(res, 200, { oci });
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

      if (req.method === "POST" && url.pathname === "/api/notify/feishu/test") {
        const body = await readRequestBody(req);
        const webhookUrl = String(body.webhookUrl ?? "").trim();
        if (!webhookUrl) {
          return createJsonResponse(res, 400, { ok: false, message: "Missing Feishu webhook URL" });
        }

        await notificationSender({
          webhookUrl,
          text: `Oracle ARM Bot 测试通知\n时间: ${now().toISOString()}\n这是一条用于校验飞书 Webhook 配置的测试消息。`,
        });
        await logger.append("Feishu test notification sent.");
        return createJsonResponse(res, 200, { ok: true });
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
        return createJsonResponse(res, 200, { logs: logger.getLines(), subscriberCount: logger.getSubscriberCount() });
      }

      if (req.method === "POST" && url.pathname === "/api/logs/clear") {
        await logger.clear();
        return createJsonResponse(res, 200, { ok: true });
      }

      if (req.method === "GET" && url.pathname === "/api/logs/stream") {
        res.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-store",
          connection: "keep-alive",
          "x-accel-buffering": "no",
        });

        let closed = false;
        let unsubscribe = () => {};
        let heartbeatTimer = null;
        let ttlTimer = null;

        const cleanup = () => {
          if (closed) {
            return;
          }

          closed = true;
          unsubscribe();

          if (heartbeatTimer) {
            clearInterval(heartbeatTimer);
          }

          if (ttlTimer) {
            clearTimeout(ttlTimer);
          }

          if (!res.writableEnded) {
            res.end();
          }
        };

        const safeWrite = (writer) => {
          if (closed || req.destroyed || res.destroyed || res.writableEnded) {
            cleanup();
            return false;
          }

          try {
            writer();
            return true;
          } catch {
            cleanup();
            return false;
          }
        };

        for (const line of logger.getLines()) {
          if (!safeWrite(() => writeSseMessage(res, line))) {
            return;
          }
        }

        unsubscribe = logger.subscribe((line) => {
          safeWrite(() => writeSseMessage(res, line));
        });

        if (Number.isFinite(sseHeartbeatMs) && sseHeartbeatMs > 0) {
          heartbeatTimer = setInterval(() => {
            safeWrite(() => writeSseComment(res, "keepalive"));
          }, sseHeartbeatMs);

          if (heartbeatTimer.unref) {
            heartbeatTimer.unref();
          }
        }

        if (Number.isFinite(sseClientTtlMs) && sseClientTtlMs > 0) {
          ttlTimer = setTimeout(() => {
            cleanup();
          }, sseClientTtlMs);

          if (ttlTimer.unref) {
            ttlTimer.unref();
          }
        }

        req.on("close", cleanup);
        res.on("close", cleanup);
        req.on("error", cleanup);
        res.on("error", cleanup);
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
