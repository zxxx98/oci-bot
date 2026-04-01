import { api, createToastController, highlightCurrentNav, startPolling } from "/shared.js";
import { summarizeOciFeedback } from "/oci-feedback.js";

const statusBadge = document.querySelector("#statusBadge");
const statusIndicator = document.querySelector("#statusIndicator");
const phaseTitle = document.querySelector("#phaseTitle");
const phaseMessage = document.querySelector("#phaseMessage");
const actionBtn = document.querySelector("#actionBtn");
const countdownValue = document.querySelector("#countdownValue");
const countdownNote = document.querySelector("#countdownNote");
const runtimeValue = document.querySelector("#runtimeValue");
const runtimeNote = document.querySelector("#runtimeNote");
const lastAttemptValue = document.querySelector("#lastAttemptValue");
const lastResultValue = document.querySelector("#lastResultValue");
const lastErrorValue = document.querySelector("#lastErrorValue");
const feedbackCard = document.querySelector("#feedbackCard");
const feedbackTitle = document.querySelector("#feedbackTitle");
const feedbackMessage = document.querySelector("#feedbackMessage");
const feedbackRawView = document.querySelector("#feedbackRawView");
const toast = createToastController(document.querySelector("#toast"));

let latestStatus = null;
let syncInFlight = false;

actionBtn.addEventListener("click", () => runAction(toggleJob));

function isActivePhase(phase) {
  return phase === "running" || phase === "waiting";
}

function formatDuration(ms) {
  if (ms == null || ms < 0) {
    return "--";
  }

  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours.toString().padStart(2, "0")}:${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
  }
  return `${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
}

function formatDateTime(value) {
  if (!value) {
    return "--";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "--";
  }

  return new Intl.DateTimeFormat("zh-CN", {
    hour12: false,
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(date);
}

function summarizeText(value, fallback) {
  const text = String(value ?? "").trim();
  if (!text) {
    return fallback;
  }
  return text.length > 140 ? `${text.slice(0, 140)}...` : text;
}

function getPhaseMeta(status) {
  switch (status.phase) {
    case "success":
      return {
        title: "任务完成",
        tone: "success",
        actionLabel: "开始任务",
        actionClass: "",
        message: status.message || "实例已经创建完成。",
      };
    case "running":
      return {
        title: "请求进行中",
        tone: "warning",
        actionLabel: "结束任务",
        actionClass: "danger",
        message: status.message || "正在向 OCI 发起实例创建请求。",
      };
    case "waiting":
      return {
        title: "等待重试",
        tone: "warning",
        actionLabel: "结束任务",
        actionClass: "danger",
        message: status.message || "当前进入等待重试阶段。",
      };
    case "error":
      return {
        title: "任务异常",
        tone: "error",
        actionLabel: "开始任务",
        actionClass: "",
        message: status.message || "任务执行中出现异常。",
      };
    case "stopped":
      return {
        title: "已停止",
        tone: "error",
        actionLabel: "开始任务",
        actionClass: "",
        message: status.message || "任务已经停止。",
      };
    default:
      return {
        title: "待机中",
        tone: "idle",
        actionLabel: "开始任务",
        actionClass: "",
        message: status.message || "尚未开始任务。",
      };
  }
}

function renderStatus(status) {
  latestStatus = status;
  const meta = getPhaseMeta(status);

  statusBadge.textContent = status.phase.toUpperCase();
  statusBadge.dataset.phase = status.phase;
  statusIndicator.className = `status-indicator status-indicator-${meta.tone}`;
  phaseTitle.textContent = meta.title;
  phaseMessage.textContent = meta.message;

  actionBtn.textContent = meta.actionLabel;
  actionBtn.className = meta.actionClass ? meta.actionClass : "";

  const now = Date.now();
  const nextRetryMs = status.nextRetryAt ? Math.max(0, new Date(status.nextRetryAt).getTime() - now) : null;
  const runtimeEnd = isActivePhase(status.phase) ? now : status.endedAt ? new Date(status.endedAt).getTime() : now;
  const runtimeMs = status.startedAt ? Math.max(0, runtimeEnd - new Date(status.startedAt).getTime()) : null;

  if (status.phase === "waiting" && nextRetryMs != null) {
    countdownValue.textContent = formatDuration(nextRetryMs);
    countdownNote.textContent = `预计于 ${formatDateTime(status.nextRetryAt)} 再次尝试`;
  } else if (status.phase === "success") {
    countdownValue.textContent = "--";
    countdownNote.textContent = "任务已完成";
  } else if (status.phase === "running") {
    countdownValue.textContent = "--";
    countdownNote.textContent = "请求进行中";
  } else {
    countdownValue.textContent = "--";
    countdownNote.textContent = "未计划重试";
  }

  if (runtimeMs != null) {
    runtimeValue.textContent = formatDuration(runtimeMs);
    runtimeNote.textContent = isActivePhase(status.phase)
      ? `开始于 ${formatDateTime(status.startedAt)}`
      : `结束于 ${formatDateTime(status.endedAt)}`;
  } else {
    runtimeValue.textContent = "--";
    runtimeNote.textContent = "任务尚未启动";
  }

  lastAttemptValue.textContent = formatDateTime(status.lastAttemptAt);
  lastResultValue.textContent = summarizeText(status.lastResult, "暂无结果");
  lastErrorValue.textContent = summarizeText(status.lastError, "暂无错误");

  const rawFeedback = status.lastError || status.lastResult;
  const feedback = summarizeOciFeedback(rawFeedback);
  feedbackCard.className = `panel feedback-card feedback-card-${feedback.level}`;
  feedbackTitle.textContent = feedback.title;
  feedbackMessage.textContent = feedback.message;
  feedbackRawView.textContent = rawFeedback || "暂无原始详情";
}

async function refreshStatus() {
  if (syncInFlight) {
    return;
  }

  syncInFlight = true;
  try {
    const { status } = await api("/api/job/status", { headers: {} });
    renderStatus(status);
  } finally {
    syncInFlight = false;
  }
}

async function startJob() {
  await api("/api/job/start", { method: "POST" });
  toast.show("任务已启动");
  await refreshStatus();
}

async function stopJob() {
  await api("/api/job/stop", { method: "POST" });
  toast.show("任务已停止");
  await refreshStatus();
}

async function toggleJob() {
  if (latestStatus && isActivePhase(latestStatus.phase)) {
    await stopJob();
    return;
  }
  await startJob();
}

async function runAction(action) {
  try {
    await action();
  } catch (error) {
    toast.show(error.message, true);
  }
}

function refreshDerivedTime() {
  if (!latestStatus) {
    return;
  }
  renderStatus(latestStatus);
}

async function bootstrap() {
  highlightCurrentNav();
  await refreshStatus();
  startPolling(() => {
    refreshDerivedTime();
    return Promise.resolve();
  }, 1000);
  startPolling(async () => {
    try {
      await refreshStatus();
    } catch (error) {
      toast.show(error.message, true);
    }
  }, 10000);

  const refreshOnReturn = () => {
    if (document.visibilityState && document.visibilityState !== "visible") {
      return;
    }
    refreshStatus().catch((error) => toast.show(error.message, true));
  };

  window.addEventListener("focus", refreshOnReturn);
  window.addEventListener("pageshow", refreshOnReturn);
  document.addEventListener("visibilitychange", refreshOnReturn);
}

bootstrap().catch((error) => toast.show(error.message, true));
