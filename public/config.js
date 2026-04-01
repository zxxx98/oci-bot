import { parseTerraformBotConfig } from "/tf-parser.js";
import { api, createToastController, getFormJson, highlightCurrentNav } from "/shared.js";

const ociForm = document.querySelector("#ociForm");
const botForm = document.querySelector("#botForm");
const tfImportZone = document.querySelector("#tfImportZone");
const tfFileInput = document.querySelector("#tfFileInput");
const toast = createToastController(document.querySelector("#toast"));

document.querySelector("#validateOciBtn").addEventListener("click", () => runAction(validateOci));
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

async function saveOciConfig() {
  await api("/api/oci/config", {
    method: "POST",
    body: JSON.stringify(getFormJson(ociForm)),
  });
  toast.show("OCI 配置已保存");
}

async function validateOci() {
  const result = await api("/api/oci/validate", { method: "POST" });
  toast.show(result.output || "OCI 配置可用");
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
  toast.show("抢机配置已保存");
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
  toast.show(`已从 ${file.name} 导入：${summary}`);
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

async function refreshOciConfig() {
  const { oci } = await api("/api/oci/config", { headers: {} });
  for (const [key, value] of Object.entries(oci)) {
    const field = ociForm.elements.namedItem(key);
    if (field) {
      field.value = value ?? "";
    }
  }
}

async function runAction(action) {
  try {
    await action();
  } catch (error) {
    toast.show(error.message, true);
  }
}

async function bootstrap() {
  highlightCurrentNav();
  await refreshOciConfig();
  await refreshConfig();
}

bootstrap().catch((error) => toast.show(error.message, true));
