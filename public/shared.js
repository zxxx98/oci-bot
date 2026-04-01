export async function api(path, options = {}) {
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

export function getFormJson(form) {
  const formData = new FormData(form);
  return Object.fromEntries(formData.entries());
}

export function createToastController(element) {
  return {
    show(message, isError = false) {
      element.textContent = message;
      element.style.background = isError ? "rgba(145, 47, 47, 0.96)" : "rgba(33, 52, 57, 0.92)";
      element.classList.add("show");
      clearTimeout(this.timer);
      this.timer = setTimeout(() => element.classList.remove("show"), 2600);
    },
  };
}

export function highlightCurrentNav() {
  const currentPath = window.location.pathname;
  for (const link of document.querySelectorAll("[data-nav-link]")) {
    const active = link.getAttribute("href") === currentPath;
    link.classList.toggle("active", active);
    if (active) {
      link.setAttribute("aria-current", "page");
    } else {
      link.removeAttribute("aria-current");
    }
  }
}

export function createStatusPresenter(statusBadge, statusView) {
  return {
    render(status) {
      statusBadge.textContent = status.phase.toUpperCase();
      statusBadge.dataset.phase = status.phase;
      statusView.textContent = JSON.stringify(status, null, 2);
    },
  };
}

export function startPolling(task, intervalMs) {
  const timer = setInterval(() => {
    task().catch(() => {});
  }, intervalMs);

  return () => clearInterval(timer);
}

export function createLogStreamController({ logsView, statusElement, toast, onUpdate = () => {} }) {
  const state = {
    lines: [],
    eventSource: null,
    replayPending: false,
    mode: "connecting",
    stopCurrent: null,
  };

  function setStatus(mode, message) {
    state.mode = mode;
    statusElement.textContent = message;
    statusElement.className = `stream-indicator ${mode}`;
    onUpdate({ ...state });
  }

  function render(lines) {
    state.lines = [...lines];
    logsView.textContent = state.lines.join("\n") || "暂无日志";
    onUpdate({ ...state });
  }

  function append(line) {
    state.lines.push(line);
    if (state.lines.length > 500) {
      state.lines = state.lines.slice(-500);
    }
    logsView.textContent = state.lines.join("\n") || "暂无日志";
    onUpdate({ ...state });
  }

  async function refreshLogs() {
    const { logs } = await api("/api/logs", { headers: {} });
    render(logs);
  }

  function startPollingLogs() {
    setStatus("fallback", "日志通过轮询更新");
    refreshLogs().catch((error) => toast.show(error.message, true));
    return startPolling(async () => {
      try {
        await refreshLogs();
      } catch (error) {
        toast.show(error.message, true);
      }
    }, 3000);
  }

  function stop() {
    state.stopCurrent?.();
    state.stopCurrent = null;
    state.eventSource = null;
  }

  function startStream() {
    stop();

    if (!window.EventSource) {
      state.stopCurrent = startPollingLogs();
      return state.stopCurrent;
    }

    setStatus("reconnecting", "实时日志连接中");
    const eventSource = new window.EventSource("/api/logs/stream");
    state.eventSource = eventSource;

    eventSource.onopen = () => {
      state.replayPending = true;
      setStatus("live", "实时日志已连接");
    };

    eventSource.onmessage = (event) => {
      if (state.replayPending) {
        state.lines = [];
        state.replayPending = false;
      }
      append(event.data);
    };

    eventSource.onerror = () => {
      setStatus("reconnecting", "实时日志重连中");
    };

    state.stopCurrent = () => {
      eventSource.close();
      if (state.eventSource === eventSource) {
        state.eventSource = null;
      }
    };

    return state.stopCurrent;
  }

  return {
    refreshLogs,
    startStream,
    stop,
  };
}
