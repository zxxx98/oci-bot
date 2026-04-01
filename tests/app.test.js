import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { PassThrough } from "node:stream";
import os from "node:os";
import path from "node:path";
import { appendBoundedOutput, createApp, createCommandRunner } from "../src/app.js";

async function startTestServer(options = {}) {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "oci-bot-test-"));
  const app = createApp({
    dataDir: path.join(tempDir, "data"),
    ociDir: path.join(tempDir, ".oci"),
    commandRunner: options.commandRunner,
    notificationSender: options.notificationSender,
    now: options.now,
    sseHeartbeatMs: options.sseHeartbeatMs,
    sseClientTtlMs: options.sseClientTtlMs,
  });

  await app.ready;

  const server = app.server.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  return {
    app,
    tempDir,
    baseUrl,
    close: async () => {
      await app.shutdown();
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

async function readSseMessages(response, expectedCount) {
  const decoder = new TextDecoder();
  const reader = response.body.getReader();
  let buffer = "";
  const messages = [];

  while (messages.length < expectedCount) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });

    while (true) {
      const boundary = buffer.indexOf("\n\n");
      if (boundary === -1) {
        break;
      }

      const rawMessage = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const dataLines = rawMessage
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart());

      if (dataLines.length > 0) {
        messages.push(dataLines.join("\n"));
      }
    }
  }

  reader.releaseLock();
  return messages;
}

test("GET /api/config returns default bot configuration", async () => {
  const ctx = await startTestServer();

  try {
    const response = await fetch(`${ctx.baseUrl}/api/config`);
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.config.displayName, "Oracle-ARM-Bot");
    assert.equal(body.config.intervalSeconds, 120);
    assert.equal(body.config.feishuWebhookUrl, "");
  } finally {
    await ctx.close();
  }
});

test("GET / redirects to /monitor", async () => {
  const ctx = await startTestServer();

  try {
    const response = await fetch(`${ctx.baseUrl}/`, { redirect: "manual" });

    assert.equal(response.status, 302);
    assert.equal(response.headers.get("location"), "/monitor");
  } finally {
    await ctx.close();
  }
});

test("GET /monitor includes monitor page status and logs entry points", async () => {
  const ctx = await startTestServer();

  try {
    const response = await fetch(`${ctx.baseUrl}/monitor`);
    const html = await response.text();

    assert.equal(response.status, 200);
    assert.match(html, /Oracle ARM 监控面板/);
    assert.match(html, /id="actionBtn"/);
    assert.match(html, /id="countdownValue"/);
    assert.match(html, /id="runtimeValue"/);
    assert.match(html, /id="statusIndicator"/);
    assert.match(html, /id="feedbackCard"/);
  } finally {
    await ctx.close();
  }
});

test("GET /config includes OCI setup and Terraform import sections", async () => {
  const ctx = await startTestServer();

  try {
    const response = await fetch(`${ctx.baseUrl}/config`);
    const html = await response.text();

    assert.equal(response.status, 200);
    assert.match(html, /id="ociForm"/);
    assert.match(html, /id="tfImportZone"/);
    assert.match(html, /id="ociHelpDisclosure"/);
    assert.match(html, /name="feishuWebhookUrl"/);
    assert.match(html, /id="testFeishuBtn"/);
  } finally {
    await ctx.close();
  }
});

test("GET /logs includes log stream indicator", async () => {
  const ctx = await startTestServer();

  try {
    const response = await fetch(`${ctx.baseUrl}/logs`);
    const html = await response.text();

    assert.equal(response.status, 200);
    assert.match(html, /id="logStreamStatus"/);
    assert.match(html, /id="logsView"/);
    assert.match(html, /id="logSummaryTitle"/);
    assert.match(html, /id="logCountValue"/);
    assert.match(html, /id="friendlyLogCard"/);
    assert.match(html, /id="clearLogsBtn"/);
  } finally {
    await ctx.close();
  }
});

test("split pages include shared navigation and icon markup", async () => {
  const ctx = await startTestServer();

  try {
    const response = await fetch(`${ctx.baseUrl}/monitor`);
    const html = await response.text();

    assert.equal(response.status, 200);
    assert.match(html, /rel="icon" href="\/icon\.svg"/);
    assert.match(html, /href="\/monitor"/);
    assert.match(html, /href="\/config"/);
    assert.match(html, /href="\/logs"/);
  } finally {
    await ctx.close();
  }
});

test("parseTerraformBotConfig extracts bot fields from main.tf-style content", async () => {
  const { parseTerraformBotConfig } = await import("../public/tf-parser.js");
  const tf = `
resource "oci_core_instance" "generated_oci_core_instance" {
  availability_domain = "EXAMPLE-AD-1"
  compartment_id = "ocid1.tenancy.oc1..exampleuniqueID"
  create_vnic_details {
    subnet_id = "ocid1.subnet.oc1.example-region-1.exampleuniqueID"
  }
  display_name = "example-instance"
  metadata = {
    "ssh_authorized_keys" = "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQCsanitizedExamplePublicKeyOnly user@example"
  }
  shape_config {
    memory_in_gbs = "12"
    ocpus = "2"
  }
  source_details {
    source_id = "ocid1.image.oc1.example-region-1.exampleuniqueID"
    source_type = "image"
  }
}`;

  const parsed = parseTerraformBotConfig(tf);

  assert.equal(parsed.compartmentId, "ocid1.tenancy.oc1..exampleuniqueID");
  assert.equal(parsed.availabilityDomain, "EXAMPLE-AD-1");
  assert.equal(parsed.subnetId, "ocid1.subnet.oc1.example-region-1.exampleuniqueID");
  assert.equal(parsed.imageId, "ocid1.image.oc1.example-region-1.exampleuniqueID");
  assert.equal(parsed.displayName, "example-instance");
  assert.equal(parsed.ocpus, 2);
  assert.equal(parsed.memory, 12);
  assert.match(parsed.sshAuthorizedKeys, /^ssh-rsa /);
  assert.equal(parsed.bootVolumeSize, undefined);
  assert.equal(parsed.intervalSeconds, undefined);
});

test("summarizeOciFeedback turns capacity errors into friendly guidance", async () => {
  const { summarizeOciFeedback } = await import("../public/oci-feedback.js");
  const summary = summarizeOciFeedback(`Out of Stock: ServiceError:
{
  "code": "InternalError",
  "message": "Out of host capacity.",
  "status": 500
}`);

  assert.equal(summary.level, "warning");
  assert.match(summary.title, /区域容量暂时不足/);
  assert.match(summary.message, /自动重试/);
});

test("POST /api/oci/config writes OCI config and private key", async () => {
  const ctx = await startTestServer();

  try {
    const payload = {
      tenancy: "ocid1.tenancy.oc1..example",
      user: "ocid1.user.oc1..example",
      fingerprint: "aa:bb:cc",
      region: "ap-singapore-1",
      privateKey: "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----",
    };

    const response = await fetch(`${ctx.baseUrl}/api/oci/config`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.ok, true);

    const configFile = await readFile(path.join(ctx.tempDir, ".oci", "config"), "utf8");
    const keyFile = await readFile(path.join(ctx.tempDir, ".oci", "oci_api_key.pem"), "utf8");

    assert.match(configFile, /\[DEFAULT\]/);
    assert.match(configFile, /region=ap-singapore-1/);
    assert.match(keyFile, /BEGIN PRIVATE KEY/);
  } finally {
    await ctx.close();
  }
});

test("GET /api/oci/config returns saved OCI form values for page reload", async () => {
  const ctx = await startTestServer();

  try {
    const payload = {
      tenancy: "ocid1.tenancy.oc1..example",
      user: "ocid1.user.oc1..example",
      fingerprint: "aa:bb:cc",
      region: "ap-singapore-1",
      privateKey: "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----",
    };

    await fetch(`${ctx.baseUrl}/api/oci/config`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });

    const response = await fetch(`${ctx.baseUrl}/api/oci/config`);
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.oci.tenancy, payload.tenancy);
    assert.equal(body.oci.user, payload.user);
    assert.equal(body.oci.fingerprint, payload.fingerprint);
    assert.equal(body.oci.region, payload.region);
    assert.match(body.oci.privateKey, /BEGIN PRIVATE KEY/);
  } finally {
    await ctx.close();
  }
});

test("POST /api/oci/validate returns command output when OCI config is valid", async () => {
  const commands = [];
  const ctx = await startTestServer({
    commandRunner: async (command, args) => {
      commands.push([command, ...args]);
      return { code: 0, stdout: '{"data":"namespace"}', stderr: "" };
    },
  });

  try {
    await fetch(`${ctx.baseUrl}/api/oci/config`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        tenancy: "ocid1.tenancy.oc1..example",
        user: "ocid1.user.oc1..example",
        fingerprint: "aa:bb:cc",
        region: "ap-singapore-1",
        privateKey: "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----",
      }),
    });

    const response = await fetch(`${ctx.baseUrl}/api/oci/validate`, { method: "POST" });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(commands.length, 1);
    assert.deepEqual(commands[0], ["oci", "os", "ns", "get"]);
  } finally {
    await ctx.close();
  }
});

test("POST /api/notify/feishu/test sends a test notification", async () => {
  const notifications = [];
  const ctx = await startTestServer({
    notificationSender: async (payload) => {
      notifications.push(payload);
    },
  });

  try {
    const response = await fetch(`${ctx.baseUrl}/api/notify/feishu/test`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        webhookUrl: "https://open.feishu.cn/mock/webhook",
      }),
    });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0].webhookUrl, "https://open.feishu.cn/mock/webhook");
    assert.match(notifications[0].text, /测试通知/);
  } finally {
    await ctx.close();
  }
});

test("job start retries on capacity and stops after success", async () => {
  const calls = [];
  const notifications = [];
  const responses = [
    { code: 1, stdout: "", stderr: "Out of capacity" },
    { code: 0, stdout: '{"opc-work-request-id":"wr1","lifecycle-state":"PROVISIONING"}', stderr: "" },
  ];

  const ctx = await startTestServer({
    notificationSender: async (payload) => {
      notifications.push(payload);
    },
    commandRunner: async (command, args) => {
      calls.push([command, ...args]);
      return responses.shift() ?? { code: 1, stdout: "", stderr: "unexpected" };
    },
  });

  try {
    const saveConfigResponse = await fetch(`${ctx.baseUrl}/api/config`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        subnetId: "subnet1",
        compartmentId: "compartment1",
        availabilityDomain: "AD-1",
        imageId: "image1",
        sshAuthorizedKeys: "ssh-rsa AAA test",
        intervalSeconds: 0,
        feishuWebhookUrl: "https://open.feishu.cn/mock/webhook",
      }),
    });
    assert.equal(saveConfigResponse.status, 200);

    const startResponse = await fetch(`${ctx.baseUrl}/api/job/start`, { method: "POST" });
    assert.equal(startResponse.status, 202);

    await new Promise((resolve) => setTimeout(resolve, 80));

    const statusResponse = await fetch(`${ctx.baseUrl}/api/job/status`);
    const statusBody = await statusResponse.json();

    assert.equal(statusBody.status.phase, "success");
    assert.equal(calls.length, 2);
    assert.match(statusBody.status.lastResult, /opc-work-request-id/);
    assert.ok(statusBody.status.startedAt);
    assert.equal(statusBody.status.nextRetryAt, null);
    assert.equal(notifications.length, 1);
    assert.match(JSON.stringify(notifications[0]), /Oracle-ARM-Bot/);
  } finally {
    await ctx.close();
  }
});

test("waiting status includes startedAt and nextRetryAt for countdown UI", async () => {
  const ctx = await startTestServer({
    commandRunner: async () => ({ code: 1, stdout: "", stderr: "Out of capacity" }),
  });

  try {
    await fetch(`${ctx.baseUrl}/api/config`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        subnetId: "subnet1",
        compartmentId: "compartment1",
        availabilityDomain: "AD-1",
        imageId: "image1",
        sshAuthorizedKeys: "ssh-rsa AAA test",
        intervalSeconds: 2,
      }),
    });

    await fetch(`${ctx.baseUrl}/api/job/start`, { method: "POST" });
    await new Promise((resolve) => setTimeout(resolve, 60));

    const statusResponse = await fetch(`${ctx.baseUrl}/api/job/status`);
    const statusBody = await statusResponse.json();

    assert.equal(statusBody.status.phase, "waiting");
    assert.ok(statusBody.status.startedAt);
    assert.ok(statusBody.status.nextRetryAt);
    assert.ok(Date.parse(statusBody.status.nextRetryAt) >= Date.parse(statusBody.status.lastAttemptAt));
  } finally {
    await ctx.close();
  }
});

test("POST /api/job/stop transitions a running job to stopped", async () => {
  const ctx = await startTestServer({
    commandRunner: async () => {
      await new Promise((resolve) => setTimeout(resolve, 250));
      return { code: 1, stdout: "", stderr: "Out of capacity" };
    },
  });

  try {
    await fetch(`${ctx.baseUrl}/api/config`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        subnetId: "subnet1",
        compartmentId: "compartment1",
        availabilityDomain: "AD-1",
        imageId: "image1",
        sshAuthorizedKeys: "ssh-rsa AAA test",
        intervalSeconds: 1,
      }),
    });

    await fetch(`${ctx.baseUrl}/api/job/start`, { method: "POST" });
    const stopResponse = await fetch(`${ctx.baseUrl}/api/job/stop`, { method: "POST" });
    const stopBody = await stopResponse.json();

    assert.equal(stopResponse.status, 200);
    assert.equal(stopBody.ok, true);

    await new Promise((resolve) => setTimeout(resolve, 20));

    const statusResponse = await fetch(`${ctx.baseUrl}/api/job/status`);
    const statusBody = await statusResponse.json();
    assert.equal(statusBody.status.phase, "stopped");
    assert.equal(statusBody.status.active, false);
    assert.ok(statusBody.status.endedAt);
    assert.ok(Date.parse(statusBody.status.endedAt) >= Date.parse(statusBody.status.startedAt));
  } finally {
    await ctx.close();
  }
});

test("app startup recovers persisted active job state left by an interrupted process", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "oci-bot-test-"));
  const dataDir = path.join(tempDir, "data");
  const now = new Date("2026-04-01T08:00:00.000Z");

  await mkdir(dataDir, { recursive: true });

  await writeFile(
    path.join(dataDir, "job-state.json"),
    `${JSON.stringify({
      phase: "waiting",
      message: "Out of Stock",
      lastAttemptAt: "2026-04-01T07:59:00.000Z",
      lastResult: "Out of capacity",
      lastError: "",
      active: true,
      startedAt: "2026-04-01T07:30:00.000Z",
      endedAt: null,
      nextRetryAt: "2026-04-01T08:01:00.000Z",
    }, null, 2)}\n`,
    "utf8",
  );

  const app = createApp({
    dataDir,
    ociDir: path.join(tempDir, ".oci"),
    now: () => now,
  });

  try {
    await app.ready;

    const server = app.server.listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    const address = server.address();
    const response = await fetch(`http://127.0.0.1:${address.port}/api/job/status`);
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.status.phase, "stopped");
    assert.equal(body.status.active, false);
    assert.equal(body.status.message, "Job interrupted by restart");
    assert.equal(body.status.nextRetryAt, null);
    assert.equal(body.status.endedAt, now.toISOString());

    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  } finally {
    await app.shutdown();
  }
});

test("GET /api/logs returns accumulated log lines", async () => {
  const ctx = await startTestServer({
    commandRunner: async () => ({ code: 1, stdout: "", stderr: "Out of capacity" }),
  });

  try {
    await fetch(`${ctx.baseUrl}/api/config`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        subnetId: "subnet1",
        compartmentId: "compartment1",
        availabilityDomain: "AD-1",
        imageId: "image1",
        sshAuthorizedKeys: "ssh-rsa AAA test",
        intervalSeconds: 0,
      }),
    });

    await fetch(`${ctx.baseUrl}/api/job/start`, { method: "POST" });
    await new Promise((resolve) => setTimeout(resolve, 40));

    const response = await fetch(`${ctx.baseUrl}/api/logs`);
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.ok(Array.isArray(body.logs));
    assert.ok(body.logs.some((line) => line.includes("Out of Stock") || line.includes("Requesting ARM Instance")));
  } finally {
    await ctx.close();
  }
});

test("logger keeps only the latest 100 lines", async () => {
  const ctx = await startTestServer();

  try {
    for (let index = 0; index < 120; index += 1) {
      await fetch(`${ctx.baseUrl}/api/config`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ displayName: `run-${index}` }),
      });
    }

    const response = await fetch(`${ctx.baseUrl}/api/logs`);
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.logs.length, 100);
    assert.ok(body.logs[0].includes("run-20") || body.logs[0].includes("Bot configuration saved."));
  } finally {
    await ctx.close();
  }
});

test("POST /api/logs/clear removes all existing log lines", async () => {
  const ctx = await startTestServer();

  try {
    await fetch(`${ctx.baseUrl}/api/config`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ displayName: "before-clear" }),
    });

    const clearResponse = await fetch(`${ctx.baseUrl}/api/logs/clear`, { method: "POST" });
    const clearBody = await clearResponse.json();

    assert.equal(clearResponse.status, 200);
    assert.equal(clearBody.ok, true);

    const response = await fetch(`${ctx.baseUrl}/api/logs`);
    const body = await response.json();
    assert.deepEqual(body.logs, []);
  } finally {
    await ctx.close();
  }
});

test("GET /api/logs/stream replays history and streams new log lines", async () => {
  const ctx = await startTestServer({
    commandRunner: async () => ({ code: 1, stdout: "", stderr: "Out of capacity" }),
  });

  try {
    await fetch(`${ctx.baseUrl}/api/config`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        subnetId: "subnet1",
        compartmentId: "compartment1",
        availabilityDomain: "AD-1",
        imageId: "image1",
        sshAuthorizedKeys: "ssh-rsa AAA test",
        intervalSeconds: 0,
      }),
    });

    const streamResponse = await fetch(`${ctx.baseUrl}/api/logs/stream`, {
      headers: { accept: "text/event-stream" },
    });

    assert.equal(streamResponse.status, 200);
    assert.match(streamResponse.headers.get("content-type") ?? "", /^text\/event-stream/);

    const eventsPromise = readSseMessages(streamResponse, 3);

    await fetch(`${ctx.baseUrl}/api/job/start`, { method: "POST" });

    const messages = await Promise.race([
      eventsPromise,
      new Promise((_, reject) => setTimeout(() => reject(new Error("Timed out waiting for SSE messages")), 1000)),
    ]);

    assert.ok(messages.some((line) => line.includes("Bot configuration saved.")));
    assert.ok(messages.some((line) => line.includes("Bot job started.")));
    assert.ok(messages.some((line) => line.includes("Requesting ARM Instance...")));

    await streamResponse.body.cancel();
  } finally {
    await ctx.close();
  }
});

test("appendBoundedOutput truncates oversized child output", () => {
  const stdout = appendBoundedOutput("", "a".repeat(20000), 4096);
  const stderr = appendBoundedOutput("", "b".repeat(20000), 4096);

  assert.ok(stdout.length <= 4096);
  assert.ok(stderr.length <= 4096);
  assert.match(stdout, /\[truncated\]$/);
  assert.match(stderr, /\[truncated\]$/);
});

test("createCommandRunner terminates hung child processes after timeout", async () => {
  const killSignals = [];
  const runner = createCommandRunner(() => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = (signal) => {
      killSignals.push(signal);
      if (signal === "SIGTERM") {
        setTimeout(() => child.emit("close", null), 5);
      }
      return true;
    };
    return child;
  });

  const result = await runner("oci", ["fake"], {
    timeoutMs: 50,
    unrefTimers: false,
  });

  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /timed out/i);
  assert.deepEqual(killSignals, ["SIGTERM"]);
});

test("GET /api/logs/stream expires long-lived subscribers", async () => {
  const ctx = await startTestServer({
    commandRunner: async () => ({ code: 1, stdout: "", stderr: "Out of capacity" }),
    sseHeartbeatMs: 20,
    sseClientTtlMs: 60,
  });

  try {
    const socket = await new Promise((resolve, reject) => {
      const client = createConnection({ host: "127.0.0.1", port: new URL(ctx.baseUrl).port }, () => resolve(client));
      client.on("error", reject);
    });
    socket.write([
      "GET /api/logs/stream HTTP/1.1",
      `Host: 127.0.0.1:${new URL(ctx.baseUrl).port}`,
      "Accept: text/event-stream",
      "",
      "",
    ].join("\r\n"));

    await new Promise((resolve) => setTimeout(resolve, 140));

    const response = await fetch(`${ctx.baseUrl}/api/logs`);
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.subscriberCount, 0);
  } finally {
    await ctx.close();
  }
});

test("createLogStreamController stop closes the active EventSource", async () => {
  global.window = global.window || {};

  let closeCount = 0;
  class FakeEventSource {
    constructor() {
      this.onopen = null;
      this.onmessage = null;
      this.onerror = null;
    }

    close() {
      closeCount += 1;
    }
  }

  global.window.EventSource = FakeEventSource;
  global.EventSource = FakeEventSource;

  const { createLogStreamController } = await import("../public/shared.js");
  const controller = createLogStreamController({
    logsView: { textContent: "" },
    statusElement: { textContent: "", className: "" },
    toast: { show() {} },
  });

  controller.startStream();
  controller.stop();

  assert.equal(closeCount, 1);

  delete global.EventSource;
});
