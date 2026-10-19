const $ = (id) => document.getElementById(id);
const DEFAULT_HTML = `<!doctype html>
<html lang="ru">
<head><meta charset="utf-8"></head>
<body style="margin:0;padding:35px;background:#f3f5f9;font-family:Arial,sans-serif">
<table role="presentation" cellspacing="0" cellpadding="0" style="max-width:560px;width:100%;margin:auto;background:#fff;border-radius:14px">
<tr><td style="padding:42px 40px">
  <div style="font-size:13px;font-weight:bold;letter-spacing:2px;color:#5366d8">MAILSLURP PREVIEW</div>
  <h1 style="font-size:30px;line-height:1.25;color:#17233c;margin:28px 0 12px">Привет! Это тестовое письмо.</h1>
  <p style="color:#64748b;font-size:16px;line-height:1.7">Посмотрите, как это письмо выглядит в Gmail, Outlook и на мобильных устройствах.</p>
  <table role="presentation" cellspacing="0" cellpadding="0"><tr><td style="background:#4255dc;border-radius:7px;padding:14px 24px">
  <a href="https://www.mailslurp.com" style="color:white;text-decoration:none;font-weight:bold">Посмотреть MailSlurp →</a>
  </td></tr></table>
  <p style="margin-top:30px;font-size:12px;color:#94a3b8">Письмо создано автоматически для теста отображения.</p>
</td></tr></table>
</body>
</html>`;
$("html").value = DEFAULT_HTML;

const state = { runId: null, startTime: 0, timer: null, busy: false, screenshotIds: new Set() };
const DEFAULT_TARGETS = new Set(["gmail_chromium_web", "outlook_classic_windows", "ios_mail_physical_device"]);
const TERMINAL = new Set(["COMPLETED", "COMPLETE", "FINISHED", "SUCCEEDED", "FAILED", "CANCELLED", "CANCELED"]);
const SUCCESS = new Set(["COMPLETED", "COMPLETE", "FINISHED", "SUCCEEDED", "SUCCESS"]);
let targets = [];

async function api(path, init = {}) {
  const response = await fetch(path, { cache: "no-store", ...init });
  const value = await response.json().catch(() => null);
  if (!response.ok) throw new Error(value?.error || `HTTP ${response.status}`);
  return value;
}

function showError(message, id = "global-error") {
  const element = $(id);
  element.textContent = message;
  element.classList.remove("hidden");
}
function clearErrors() {
  $("global-error").classList.add("hidden");
  $("run-error").classList.add("hidden");
}

function setStage(status, description) {
  $("run-status").textContent = status;
  $("progress-message").textContent = description;
}

function updateSelectedCount() {
  const count = document.querySelectorAll('input[name="target"]:checked').length;
  $("selected-count").textContent = `${count} выбрано`;
}

function renderTargets(items) {
  targets = items;
  const list = $("targets");
  list.replaceChildren();
  items.forEach((target) => {
    const label = document.createElement("label");
    label.className = "target-option";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.name = "target";
    input.value = target.id;
    input.checked = DEFAULT_TARGETS.has(target.id);
    input.addEventListener("change", updateSelectedCount);
    const copy = document.createElement("span");
    copy.className = "target-copy";
    const name = document.createElement("strong");
    name.textContent = target.title;
    const platform = document.createElement("small");
    platform.textContent = target.platform;
    copy.append(name, platform);
    label.append(input, copy);
    list.append(label);
  });
  updateSelectedCount();
}

function displayRunArea() {
  $("empty-state").classList.add("hidden");
  $("run-details").classList.remove("hidden");
}

function setBusy(busy) {
  state.busy = busy;
  $("start-button").disabled = busy;
  $("button-label").textContent = busy ? "Выполняется проверка…" : "Отправить и получить скриншоты";
}

function renderStatuses(items) {
  const holder = $("target-statuses");
  holder.replaceChildren();
  items.forEach((target) => {
    const row = document.createElement("div");
    row.className = "status-item";
    const dot = document.createElement("span");
    dot.className = "status-dot";
    if (SUCCESS.has(String(target.status).toUpperCase())) dot.classList.add("success");
    if (String(target.status).toUpperCase() === "FAILED") dot.classList.add("failed");
    const name = document.createElement("span");
    name.textContent = target.name;
    const status = document.createElement("span");
    status.className = "status-text";
    status.textContent = target.status;
    row.append(dot, name, status);
    holder.append(row);
  });
}

function addScreenshots(items) {
  items.forEach((shot) => {
    if (state.screenshotIds.has(shot.id)) return;
    state.screenshotIds.add(shot.id);
    const card = document.createElement("button");
    card.type = "button";
    card.className = "shot-card";
    const image = document.createElement("img");
    image.src = shot.imageUrl;
    image.alt = `Скриншот: ${shot.title}`;
    image.loading = "lazy";
    const label = document.createElement("div");
    label.className = "shot-label";
    const name = document.createElement("strong");
    name.textContent = shot.title;
    const action = document.createElement("span");
    action.textContent = "Увеличить ↗";
    label.append(name, action);
    card.append(image, label);
    card.addEventListener("click", () => {
      $("lightbox-title").textContent = shot.title;
      $("lightbox-image").src = shot.imageUrl;
      $("lightbox").showModal();
    });
    $("gallery").append(card);
  });
}

async function poll() {
  if (!state.runId) return;
  try {
    const result = await api(`/api/runs/${state.runId}`);
    setStage(result.status, "Скриншоты отображаются по мере завершения отдельных клиентов.");
    renderStatuses(result.targets || []);
    addScreenshots(result.screenshots || []);
    const statuses = result.targets || [];
    const completed = statuses.filter((target) => TERMINAL.has(String(target.status).toUpperCase())).length;
    const total = statuses.length || document.querySelectorAll('input[name="target"]:checked').length;
    const percentage = total ? Math.round((completed / total) * 100) : 0;
    $("progress-fill").style.width = `${percentage}%`;
    $("progress-label").textContent = "Обработка почтовыми клиентами";
    $("progress-value").textContent = `${completed} / ${total}`;
    const done = TERMINAL.has(String(result.status).toUpperCase()) || (statuses.length > 0 && completed === statuses.length);
    if (done) {
      setBusy(false);
      $("progress-message").textContent = `Обработка завершена. Скриншотов: ${state.screenshotIds.size}.`;
      if (!state.screenshotIds.size) showError("Рендеринг завершён без скриншотов. Проверьте статусы клиентов.", "run-error");
      return;
    }
  } catch (error) {
    showError(`Не удалось получить статус: ${error.message}`, "run-error");
  }
  if (Date.now() - state.startTime >= 12 * 60 * 1000) {
    showError("Ожидание превысило 12 минут. Скриншоты можно проверить новым запросом после запуска нового теста.", "run-error");
    setBusy(false);
    return;
  }
  state.timer = setTimeout(poll, 3500);
}

$("preview-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (state.busy) return;
  clearErrors();
  const selected = [...document.querySelectorAll('input[name="target"]:checked')].map((input) => input.value);
  if (!selected.length) return showError("Выберите хотя бы один почтовый клиент.");
  clearTimeout(state.timer);
  state.runId = null;
  state.screenshotIds.clear();
  $("gallery").replaceChildren();
  $("target-statuses").replaceChildren();
  $("progress-fill").style.width = "0%";
  $("progress-value").textContent = "—";
  $("inbox-address").textContent = "Создаём тестовый inbox…";
  displayRunArea();
  setStage("Отправка", "Создаём временный inbox, отправляем письмо и ждём его получения.");
  setBusy(true);
  try {
    const run = await api("/api/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ subject: $("subject").value, html: $("html").value, targets: selected }),
    });
    state.runId = run.runId;
    state.startTime = Date.now();
    $("inbox-address").textContent = run.inboxAddress;
    setStage("Рендеринг", "MailSlurp формирует скриншоты в выбранных клиентах.");
    await poll();
  } catch (error) {
    setBusy(false);
    setStage("Ошибка", "Не удалось запустить тестовое письмо.");
    showError(error.message);
  }
});

$("lightbox-close").addEventListener("click", () => $("lightbox").close());
$("lightbox").addEventListener("click", (event) => {
  if (event.target === $("lightbox")) $("lightbox").close();
});

async function initialize() {
  try {
    const [health, targetData] = await Promise.all([api("/api/health"), api("/api/targets")]);
    renderTargets(targetData.targets || []);
    $("connection").textContent = health.configured ? "API подключён" : "Нужен API-ключ";
    $("connection-dot").classList.toggle("online", health.configured);
    if (!health.configured) {
      $("start-button").disabled = true;
      showError("Задайте MAILSLURP_API_KEY на сервере и перезапустите приложение.");
    }
  } catch (error) {
    $("connection").textContent = "Сервер недоступен";
    $("start-button").disabled = true;
    showError(`Ошибка подключения: ${error.message}`);
  }
}
initialize();
