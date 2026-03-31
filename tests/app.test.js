import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createApp } from "../src/app.js";

async function startTestServer(options = {}) {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "oci-bot-test-"));
  const app = createApp({
    dataDir: path.join(tempDir, "data"),
    ociDir: path.join(tempDir, ".oci"),
    commandRunner: options.commandRunner,
    now: options.now,
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
  } finally {
    await ctx.close();
  }
});

test("GET / includes log stream status indicator", async () => {
  const ctx = await startTestServer();

  try {
    const response = await fetch(`${ctx.baseUrl}/`);
    const html = await response.text();

    assert.equal(response.status, 200);
    assert.match(html, /id="logStreamStatus"/);
  } finally {
    await ctx.close();
  }
});

test("GET / includes Terraform import dropzone", async () => {
  const ctx = await startTestServer();

  try {
    const response = await fetch(`${ctx.baseUrl}/`);
    const html = await response.text();

    assert.equal(response.status, 200);
    assert.match(html, /id="tfImportZone"/);
  } finally {
    await ctx.close();
  }
});

test("GET / includes OCI setup help disclosure", async () => {
  const ctx = await startTestServer();

  try {
    const response = await fetch(`${ctx.baseUrl}/`);
    const html = await response.text();

    assert.equal(response.status, 200);
    assert.match(html, /id="ociHelpDisclosure"/);
  } finally {
    await ctx.close();
  }
});

test("GET / includes app icon markup", async () => {
  const ctx = await startTestServer();

  try {
    const response = await fetch(`${ctx.baseUrl}/`);
    const html = await response.text();

    assert.equal(response.status, 200);
    assert.match(html, /rel="icon" href="\/icon\.svg"/);
    assert.match(html, /id="heroIcon"/);
  } finally {
    await ctx.close();
  }
});

test("parseTerraformBotConfig extracts bot fields from main.tf-style content", async () => {
  const { parseTerraformBotConfig } = await import("../public/tf-parser.js");
  const tf = await readFile(path.resolve("main.tf"), "utf8");

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

test("job start retries on capacity and stops after success", async () => {
  const calls = [];
  const responses = [
    { code: 1, stdout: "", stderr: "Out of capacity" },
    { code: 0, stdout: '{"opc-work-request-id":"wr1","lifecycle-state":"PROVISIONING"}', stderr: "" },
  ];

  const ctx = await startTestServer({
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
  } finally {
    await ctx.close();
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
