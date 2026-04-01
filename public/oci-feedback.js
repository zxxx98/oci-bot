function containsAny(text, patterns) {
  return patterns.some((pattern) => text.includes(pattern));
}

export function summarizeOciFeedback(raw) {
  const text = String(raw ?? "").trim();
  const lowered = text.toLowerCase();

  if (!text) {
    return {
      level: "neutral",
      title: "暂无详细信息",
      message: "系统正在等待新的任务状态更新。",
    };
  }

  if (containsAny(lowered, ["out of host capacity", "out of capacity", "capacity"])) {
    return {
      level: "warning",
      title: "区域容量暂时不足",
      message: "OCI 当前没有可分配的 ARM 宿主容量，系统会按照设定间隔继续自动重试。",
    };
  }

  if (containsAny(lowered, ["toomanyrequests", "rate limit", "rate limited"])) {
    return {
      level: "warning",
      title: "请求过于频繁",
      message: "OCI 触发了限流，系统会自动拉长等待时间后继续重试。",
    };
  }

  if (containsAny(lowered, ["opc-work-request-id", "provisioning"])) {
    return {
      level: "success",
      title: "实例创建请求已被接受",
      message: "OCI 已经接收请求并开始处理，可以继续关注后续状态变化。",
    };
  }

  if (containsAny(lowered, ["serviceerror", "internalerror", "request failed", "error"])) {
    return {
      level: "error",
      title: "OCI 返回异常",
      message: "请求已经到达 OCI，但返回了错误响应，建议结合原始详情继续排查。",
    };
  }

  return {
    level: "neutral",
    title: "收到新的执行反馈",
    message: "可以结合下方原始详情确认这次请求的具体返回内容。",
  };
}
