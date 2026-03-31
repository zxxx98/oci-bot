import { parseTerraformBotConfig } from "/tf-parser.js";

const ociForm = document.querySelector("#ociForm");
const botForm = document.querySelector("#botForm");
const statusView = document.querySelector("#statusView");
const logsView = document.querySelector("#logsView");
const statusBadge = document.querySelector("#statusBadge");
const toast = document.querySelector("#toast");
const logStreamStatus = document.querySelector("#logStreamStatus");
const tfImportZone = document.querySelector("#tfImportZone");
const tfFileInput = document.querySelector("#tfFileInput");
const logState = {
  lines: [],
  eventSource: null,
  replayPending: false,
  mode: "connecting",
};

document.querySelector("#validateOciBtn").addEventListener("click", () => runAction(validateOci));
document.querySelector("#startBtn").addEventListener("click", () => runAction(startJob));
document.querySelector("#stopBtn").addEventListener("click", () => runAction(stopJob));
ociForm.addEventListener("submit", (event) => {
  event.preventDefault();
  runAction(saveOciConfig);
});
botForm.addEventListener("submit", (event) => {
  event.preventDefault();
  runAction(saveBotConfig);
});
tfImportZone.addEventListener("click", () => tfFileInput.click());
tfImportZone.addEventListener("keydown", (event) => {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    tfFileInput.click();
  }
});
tfImportZone.addEventListener("dragover", (event) => {
  event.preventDefault();
  tfImportZone.classList.add("dragover");
});
tfImportZone.addEventListener("dragleave", () => {
  tfImportZone.classList.remove("dragover");
});
tfImportZone.addEventListener("drop", (event) => {
  event.preventDefault();
  tfImportZone.classList.remove("dragover");
  const [file] = event.dataTransfer?.files ?? [];
  if (file) {
    runAction(() => importTerraformFile(file));
  }
});
tfFileInput.addEventListener("change", () => {
  const [file] = tfFileInput.files ?? [];
  if (file) {
    runAction(() => importTerraformFile(file));
    tfFileInput.value = "";
  }
});

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "content-type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body.error || body.message || body.output || `Request failed: ${response.status}`);
  }
  return body;
}

function getFormJson(form) {
  const formData = new FormData(form);
  return Object.fromEntries(formData.entries());
}

function applyBotConfigPatch(patch) {
  const appliedFields = [];

  for (const [key, value] of Object.entries(patch)) {
    if (value == null || value === "") {
      continue;
    }

    const field = botForm.elements.namedItem(key);
    if (!field) {
      continue;
    }

    field.value = value;
    appliedFields.push(key);
  }

  return appliedFields;
}

function showToast(message, isError = false) {
  toast.textContent = message;
  toast.style.background = isError ? "rgba(145, 47, 47, 0.96)" : "rgba(33, 52, 57, 0.92)";
  toast.classList.add("show");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove("show"), 2600);
}

function setLogStreamStatus(mode, message) {
  logState.mode = mode;
  logStreamStatus.textContent = message;
  logStreamStatus.className = `stream-indicator ${mode}`;
}

async function saveOciConfig() {
  await api("/api/oci/config", {
    method: "POST",
    body: JSON.stringify(getFormJson(ociForm)),
  });
  showToast("OCI 配置已保存");
}

async function validateOci() {
  const result = await api("/api/oci/validate", { method: "POST" });
  showToast(result.output || "OCI 配置可用");
}

async function saveBotConfig() {
  const payload = getFormJson(botForm);
  payload.ocpus = Number(payload.ocpus);
  payload.memory = Number(payload.memory);
  payload.bootVolumeSize = Number(payload.bootVolumeSize);
  payload.intervalSeconds = Number(payload.intervalSeconds);
  await api("/api/config", {
    method: "POST",
    body: JSON.stringify(payload),
  });
  showToast("抢机配置已保存");
}

async function importTerraformFile(file) {
  const text = await file.text();
  const parsed = parseTerraformBotConfig(text);
  const appliedFields = applyBotConfigPatch(parsed);

  if (appliedFields.length === 0) {
    throw new Error("未从该 tf 文件中识别到可导入的抢机字段");
  }

  const labels = {
    subnetId: "Subnet ID",
    compartmentId: "Compartment ID",
    availabilityDomain: "Availability Domain",
    imageId: "Image ID",
    displayName: "Display Name",
    sshAuthorizedKeys: "SSH Authorized Keys",
    ocpus: "OCPUs",
    memory: "Memory",
  };

  const summary = appliedFields.map((field) => labels[field] || field).join("、");
  showToast(`已从 ${file.name} 导入：${summary}`);
}

async function startJob() {
  await api("/api/job/start", { method: "POST" });
  showToast("任务已启动");
  await refreshStatus();
}

async function stopJob() {
  await api("/api/job/stop", { method: "POST" });
  showToast("任务已停止");
  await refreshStatus();
}

async function refreshConfig() {
  const { config } = await api("/api/config", { headers: {} });
  for (const [key, value] of Object.entries(config)) {
    const field = botForm.elements.namedItem(key);
    if (field) {
      field.value = value ?? "";
    }
  }
}

async function refreshStatus() {
  const { status } = await api("/api/job/status", { headers: {} });
  statusBadge.textContent = status.phase.toUpperCase();
  statusView.textContent = JSON.stringify(status, null, 2);
}

async function refreshLogs() {
  const { logs } = await api("/api/logs", { headers: {} });
  renderLogs(logs);
}

function renderLogs(lines) {
  logState.lines = [...lines];
  logsView.textContent = logState.lines.join("\n") || "暂无日志";
}

function appendLogLine(line) {
  logState.lines.push(line);
  if (logState.lines.length > 500) {
    logState.lines = logState.lines.slice(-500);
  }
  logsView.textContent = logState.lines.join("\n") || "暂无日志";
}

function startLogsPolling() {
  setLogStreamStatus("fallback", "日志通过轮询更新");
  refreshLogs();
  setInterval(async () => {
    try {
      await refreshLogs();
    } catch (error) {
      showToast(error.message, true);
    }
  }, 3000);
}

function startLogsStream() {
  if (!window.EventSource) {
    startLogsPolling();
    return;
  }

  logState.eventSource?.close();
  setLogStreamStatus("reconnecting", "实时日志连接中");
  const eventSource = new EventSource("/api/logs/stream");
  logState.eventSource = eventSource;

  eventSource.onopen = () => {
    logState.replayPending = true;
    setLogStreamStatus("live", "实时日志已连接");
  };

  eventSource.onmessage = (event) => {
    if (logState.replayPending) {
      logState.lines = [];
      logState.replayPending = false;
    }
    appendLogLine(event.data);
  };

  eventSource.onerror = () => {
    setLogStreamStatus("reconnecting", "实时日志重连中");
  };
}

async function runAction(action) {
  try {
    await action();
  } catch (error) {
    showToast(error.message, true);
  }
}

async function bootstrap() {
  await refreshConfig();
  await refreshStatus();
  startLogsStream();
  setInterval(async () => {
    try {
      await refreshStatus();
    } catch (error) {
      showToast(error.message, true);
    }
  }, 3000);
}

bootstrap().catch((error) => showToast(error.message, true));
