import { api, createLogStreamController, createToastController, highlightCurrentNav } from "/shared.js";
import { summarizeOciFeedback } from "/oci-feedback.js";

const toast = createToastController(document.querySelector("#toast"));
const logsView = document.querySelector("#logsView");
const statusElement = document.querySelector("#logStreamStatus");
const statusIndicator = document.querySelector("#statusIndicator");
const logSummaryTitle = document.querySelector("#logSummaryTitle");
const logSummaryMessage = document.querySelector("#logSummaryMessage");
const logCountValue = document.querySelector("#logCountValue");
const lastLogTimeValue = document.querySelector("#lastLogTimeValue");
const logModeValue = document.querySelector("#logModeValue");
const friendlyLogCard = document.querySelector("#friendlyLogCard");
const friendlyLogTitle = document.querySelector("#friendlyLogTitle");
const friendlyLogMessage = document.querySelector("#friendlyLogMessage");
const clearLogsBtn = document.querySelector("#clearLogsBtn");

clearLogsBtn.addEventListener("click", async () => {
  try {
    await api("/api/logs/clear", { method: "POST" });
    logsView.textContent = "暂无日志";
    renderSummary({ lines: [], mode: "live" });
    toast.show("日志已清理");
  } catch (error) {
    toast.show(error.message, true);
  }
});

function formatLogTime(line) {
  const match = String(line ?? "").match(/^\[([^\]]+)\]/);
  if (!match) {
    return "--";
  }

  const date = new Date(match[1]);
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

function renderSummary(state) {
  const count = state.lines.length;
  const latestLine = count > 0 ? state.lines[count - 1] : "";

  logCountValue.textContent = String(count);
  lastLogTimeValue.textContent = formatLogTime(latestLine);

  const modeMap = {
    live: { title: "实时日志已连接", message: "当前通过 SSE 持续推送最新日志。", tone: "success", modeLabel: "实时流" },
    reconnecting: { title: "日志重连中", message: "连接短暂中断，正在自动恢复实时日志。", tone: "warning", modeLabel: "重连中" },
    fallback: { title: "轮询模式", message: "浏览器已回退到轮询模式，日志会按固定间隔刷新。", tone: "warning", modeLabel: "轮询" },
    connecting: { title: "日志连接初始化中", message: "正在准备日志流与摘要统计。", tone: "idle", modeLabel: "初始化中" },
  };

  const meta = modeMap[state.mode] || modeMap.connecting;
  logSummaryTitle.textContent = meta.title;
  logSummaryMessage.textContent = meta.message;
  logModeValue.textContent = meta.modeLabel;
  statusIndicator.className = `status-indicator status-indicator-${meta.tone}`;

  const feedback = summarizeOciFeedback(latestLine.replace(/^\[[^\]]+\]\s*/, ""));
  friendlyLogCard.className = `panel feedback-card feedback-card-${feedback.level}`;
  friendlyLogTitle.textContent = feedback.title;
  friendlyLogMessage.textContent = feedback.message;
}

const logs = createLogStreamController({
  logsView,
  statusElement,
  toast,
  onUpdate: renderSummary,
});

function handlePageInactive() {
  logs.stop();
}

function handlePageActive() {
  if (document.visibilityState && document.visibilityState !== "visible") {
    return;
  }
  logs.startStream();
}

highlightCurrentNav();
handlePageActive();
window.addEventListener("beforeunload", handlePageInactive);
window.addEventListener("pagehide", handlePageInactive);
window.addEventListener("pageshow", handlePageActive);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") {
    handlePageInactive();
    return;
  }
  handlePageActive();
});
