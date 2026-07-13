const ACCOUNTS = {
  huaan: "华安期货",
  shengda: "盛达期货",
};

const state = {
  imageDataUrl: "",
  selectedDate: "",
  records: [],
  account: accountFromPath(),
  reminderTimer: null,
  audioContext: null,
  editingRecord: null,
};

const els = {
  accountTitle: document.querySelector("#accountTitle"),
  accountLinks: document.querySelectorAll("[data-account-link]"),
  tradeDate: document.querySelector("#tradeDate"),
  noteInput: document.querySelector("#noteInput"),
  soundTestBtn: document.querySelector("#soundTestBtn"),
  saveBtn: document.querySelector("#saveBtn"),
  pasteZone: document.querySelector("#pasteZone"),
  emptyPreview: document.querySelector("#emptyPreview"),
  previewImage: document.querySelector("#previewImage"),
  statusLine: document.querySelector("#statusLine"),
  dateList: document.querySelector("#dateList"),
  recordsList: document.querySelector("#recordsList"),
  recordsTitle: document.querySelector("#recordsTitle"),
  recordsMeta: document.querySelector("#recordsMeta"),
  refreshBtn: document.querySelector("#refreshBtn"),
  clearPreviewBtn: document.querySelector("#clearPreviewBtn"),
  viewerDialog: document.querySelector("#viewerDialog"),
  viewerImage: document.querySelector("#viewerImage"),
  viewerTitle: document.querySelector("#viewerTitle"),
  viewerNote: document.querySelector("#viewerNote"),
  closeViewerBtn: document.querySelector("#closeViewerBtn"),
  reminderDialog: document.querySelector("#reminderDialog"),
  reminderTitle: document.querySelector("#reminderTitle"),
  reminderText: document.querySelector("#reminderText"),
  reminderDismissBtn: document.querySelector("#reminderDismissBtn"),
  reminderLaterBtn: document.querySelector("#reminderLaterBtn"),
  reminderGoBtn: document.querySelector("#reminderGoBtn"),
  noteDialog: document.querySelector("#noteDialog"),
  noteForm: document.querySelector("#noteForm"),
  noteDialogTitle: document.querySelector("#noteDialogTitle"),
  noteEditInput: document.querySelector("#noteEditInput"),
  noteCancelBtn: document.querySelector("#noteCancelBtn"),
  noteSaveBtn: document.querySelector("#noteSaveBtn"),
};

function accountFromPath() {
  const slug = window.location.pathname.split("/").filter(Boolean)[0] || "huaan";
  return ACCOUNTS[slug] ? slug : "huaan";
}

function apiPath(path) {
  return `/api/accounts/${state.account}${path}`;
}

function todayString() {
  const now = new Date();
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}

function reminderKey(kind, date = todayString()) {
  return `future-record:${kind}:${state.account}:${date}`;
}

function getAudioContext() {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) return null;
  if (!state.audioContext) {
    state.audioContext = new AudioContextClass();
  }
  return state.audioContext;
}

async function unlockAudio() {
  const audioContext = getAudioContext();
  if (!audioContext || audioContext.state !== "suspended") return;
  try {
    await audioContext.resume();
  } catch {
    // Browser may block audio until a user gesture; the visual reminder still works.
  }
}

async function playReminderSound() {
  const audioContext = getAudioContext();
  if (!audioContext) return false;
  await unlockAudio();
  if (audioContext.state !== "running") return false;

  for (let index = 0; index < 3; index += 1) {
    const start = audioContext.currentTime + index * 0.48;
    const oscillator = audioContext.createOscillator();
    const gain = audioContext.createGain();

    oscillator.type = "square";
    oscillator.frequency.setValueAtTime(740, start);
    oscillator.frequency.setValueAtTime(980, start + 0.12);
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(0.35, start + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.32);

    oscillator.connect(gain);
    gain.connect(audioContext.destination);
    oscillator.start(start);
    oscillator.stop(start + 0.34);
  }

  return true;
}

function isAfterReminderTime() {
  const now = new Date();
  return now.getHours() > 15 || (now.getHours() === 15 && now.getMinutes() >= 0);
}

function setStatus(message, tone = "neutral") {
  els.statusLine.textContent = message;
  els.statusLine.dataset.tone = tone;
}

function setPreview(dataUrl) {
  state.imageDataUrl = dataUrl;
  els.previewImage.src = dataUrl;
  els.previewImage.hidden = false;
  els.emptyPreview.hidden = true;
  els.saveBtn.disabled = false;
  els.clearPreviewBtn.disabled = false;
  setStatus("截图已载入，可以保存。", "success");
}

function clearPreview() {
  state.imageDataUrl = "";
  els.previewImage.removeAttribute("src");
  els.previewImage.hidden = true;
  els.emptyPreview.hidden = false;
  els.saveBtn.disabled = true;
  els.clearPreviewBtn.disabled = true;
}

async function fileToPngDataUrl(file) {
  const imageUrl = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = "async";
    const loaded = new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = () => reject(new Error("无法读取图片"));
    });
    img.src = imageUrl;
    await loaded;

    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0);
    return canvas.toDataURL("image/png");
  } finally {
    URL.revokeObjectURL(imageUrl);
  }
}

async function handleImageFile(file) {
  if (!file || !file.type.startsWith("image/")) {
    setStatus("剪贴板里没有图片。", "error");
    return;
  }
  const dataUrl = await fileToPngDataUrl(file);
  setPreview(dataUrl);
}

async function handlePaste(event) {
  const items = Array.from(event.clipboardData?.items || []);
  const imageItem = items.find((item) => item.type.startsWith("image/"));
  if (!imageItem) {
    return;
  }

  event.preventDefault();
  await handleImageFile(imageItem.getAsFile());
}

async function apiJson(url, options = {}) {
  const response = await fetch(url, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  if (!response.ok) {
    let detail = `${response.status} ${response.statusText}`;
    try {
      const body = await response.json();
      detail = body.detail || detail;
    } catch {
      // Keep the HTTP status text.
    }
    throw new Error(detail);
  }
  return response.json();
}

async function loadDates() {
  const dates = await apiJson(apiPath("/dates"));
  renderDates(dates);
}

async function loadRecords() {
  const date = els.tradeDate.value;
  const records = await apiJson(apiPath(`/records?trade_date=${encodeURIComponent(date)}`));
  state.records = records;
  renderRecords(records);
}

async function hasTodayRecord() {
  const today = todayString();
  const records = await apiJson(apiPath(`/records?trade_date=${encodeURIComponent(today)}`));
  return records.length > 0;
}

async function checkDailyReminder() {
  if (!isAfterReminderTime()) return;

  const today = todayString();
  if (localStorage.getItem(reminderKey("dismissed", today)) === "1") return;

  const snoozedUntil = Number(localStorage.getItem(reminderKey("snoozedUntil", today)) || "0");
  if (snoozedUntil > Date.now()) return;

  if (els.reminderDialog.open) return;
  if (await hasTodayRecord()) return;

  els.reminderTitle.textContent = `${ACCOUNTS[state.account]}截图提醒`;
  els.reminderText.textContent = `现在已经 15:00 以后，${ACCOUNTS[state.account]} 今天还没有保存交易截图。`;
  els.reminderDialog.showModal();
  playReminderSound().catch(() => {
    // Audio is a convenience; do not interrupt the reminder flow if it is blocked.
  });
}

function closeReminder() {
  if (els.reminderDialog.open) {
    els.reminderDialog.close();
  }
}

function startReminderTimer() {
  if (state.reminderTimer) {
    window.clearInterval(state.reminderTimer);
  }
  state.reminderTimer = window.setInterval(() => {
    checkDailyReminder().catch((error) => {
      setStatus(`提醒检查失败：${error.message}`, "error");
    });
  }, 60 * 1000);
}

function renderDates(dates) {
  els.dateList.innerHTML = "";
  const selected = els.tradeDate.value;

  const todayButton = document.createElement("button");
  todayButton.type = "button";
  todayButton.className = `date-row${selected === todayString() ? " active" : ""}`;
  todayButton.innerHTML = `<span>今天</span><strong>${todayString()}</strong>`;
  todayButton.addEventListener("click", () => selectDate(todayString()));
  els.dateList.append(todayButton);

  for (const item of dates) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `date-row${selected === item.trade_date ? " active" : ""}`;
    button.innerHTML = `<span>${item.trade_date}</span><strong>${item.count} 张</strong>`;
    button.addEventListener("click", () => selectDate(item.trade_date));
    els.dateList.append(button);
  }
}

function renderRecords(records) {
  els.recordsList.innerHTML = "";
  els.recordsTitle.textContent = `${ACCOUNTS[state.account]} ${els.tradeDate.value} 记录`;
  els.recordsMeta.textContent = records.length ? `${records.length} 张截图` : "暂无记录";

  if (!records.length) {
    const empty = document.createElement("div");
    empty.className = "records-empty";
    empty.textContent = "当前日期还没有保存截图。";
    els.recordsList.append(empty);
    return;
  }

  for (const record of records) {
    const item = document.createElement("article");
    item.className = "record-item";

    const thumbButton = document.createElement("button");
    thumbButton.type = "button";
    thumbButton.className = "thumb-button";
    thumbButton.addEventListener("click", () => openViewer(record));

    const img = document.createElement("img");
    img.src = record.image_url;
    img.alt = `${record.trade_date} 第 ${record.sequence_no} 张截图`;
    thumbButton.append(img);

    const meta = document.createElement("div");
    meta.className = "record-meta";
    meta.innerHTML = `
      <strong>#${String(record.sequence_no).padStart(4, "0")}</strong>
      <span>${formatTime(record.created_at)}</span>
      <p>${escapeText(record.note || "无备注")}</p>
    `;

    const actions = document.createElement("div");
    actions.className = "record-actions";

    const editBtn = document.createElement("button");
    editBtn.type = "button";
    editBtn.className = "secondary-button";
    editBtn.textContent = "编辑备注";
    editBtn.addEventListener("click", () => openNoteEditor(record));
    actions.append(editBtn);

    const deleteBtn = document.createElement("button");
    deleteBtn.type = "button";
    deleteBtn.className = "danger-button";
    deleteBtn.textContent = "删除";
    deleteBtn.addEventListener("click", () => deleteRecord(record));
    actions.append(deleteBtn);

    item.append(thumbButton, meta, actions);
    els.recordsList.append(item);
  }
}

function escapeText(value) {
  const div = document.createElement("div");
  div.textContent = value;
  return div.innerHTML;
}

function formatTime(value) {
  if (!value) return "";
  return value.replace("T", " ").slice(0, 16);
}

async function selectDate(date) {
  els.tradeDate.value = date;
  state.selectedDate = date;
  await Promise.all([loadDates(), loadRecords()]);
}

async function saveRecord() {
  if (!state.imageDataUrl) {
    setStatus("请先粘贴截图。", "error");
    return;
  }

  els.saveBtn.disabled = true;
  setStatus("正在保存...", "neutral");

  try {
    await apiJson(apiPath("/records"), {
      method: "POST",
      body: JSON.stringify({
        trade_date: els.tradeDate.value,
        note: els.noteInput.value,
        image_base64: state.imageDataUrl,
      }),
    });
    clearPreview();
    els.noteInput.value = "";
    await Promise.all([loadDates(), loadRecords()]);
    if (els.tradeDate.value === todayString()) {
      closeReminder();
    }
    setStatus("已保存。", "success");
  } catch (error) {
    els.saveBtn.disabled = false;
    setStatus(`保存失败：${error.message}`, "error");
  }
}

async function deleteRecord(record) {
  const ok = window.confirm(`确认删除 ${record.trade_date} #${String(record.sequence_no).padStart(4, "0")}？`);
  if (!ok) return;

  try {
    await apiJson(apiPath(`/records/${record.id}`), { method: "DELETE" });
    await Promise.all([loadDates(), loadRecords()]);
    setStatus("已删除。", "success");
  } catch (error) {
    setStatus(`删除失败：${error.message}`, "error");
  }
}

function openNoteEditor(record) {
  state.editingRecord = record;
  els.noteDialogTitle.textContent = `${record.trade_date} #${String(record.sequence_no).padStart(4, "0")} 备注`;
  els.noteEditInput.value = record.note || "";
  els.noteDialog.showModal();
  els.noteEditInput.focus();
  els.noteEditInput.select();
}

function closeNoteEditor() {
  state.editingRecord = null;
  els.noteDialog.close();
  els.noteEditInput.value = "";
  els.noteSaveBtn.disabled = false;
  els.noteSaveBtn.textContent = "保存备注";
}

async function saveEditedNote() {
  const record = state.editingRecord;
  if (!record) return;

  els.noteSaveBtn.disabled = true;
  els.noteSaveBtn.textContent = "保存中...";

  try {
    const updatedRecord = await apiJson(apiPath(`/records/${record.id}`), {
      method: "PATCH",
      body: JSON.stringify({ note: els.noteEditInput.value }),
    });
    closeNoteEditor();
    await loadRecords();
    setStatus(`${updatedRecord.trade_date} #${String(updatedRecord.sequence_no).padStart(4, "0")} 备注已更新。`, "success");
  } catch (error) {
    els.noteSaveBtn.disabled = false;
    els.noteSaveBtn.textContent = "保存备注";
    setStatus(`保存备注失败：${error.message}`, "error");
  }
}

function openViewer(record) {
  els.viewerImage.src = record.image_url;
  els.viewerTitle.textContent = `${record.trade_date} #${String(record.sequence_no).padStart(4, "0")}`;
  els.viewerNote.textContent = record.note || "";
  els.viewerDialog.showModal();
}

function closeViewer() {
  els.viewerDialog.close();
  els.viewerImage.removeAttribute("src");
}

async function refreshAll() {
  await Promise.all([loadDates(), loadRecords()]);
  setStatus("已刷新。", "neutral");
}

async function init() {
  els.accountTitle.textContent = ACCOUNTS[state.account];
  for (const link of els.accountLinks) {
    link.classList.toggle("active", link.dataset.accountLink === state.account);
  }

  els.tradeDate.value = todayString();
  state.selectedDate = els.tradeDate.value;

  document.addEventListener("paste", handlePaste);
  document.addEventListener("pointerdown", unlockAudio, { once: true });
  document.addEventListener("keydown", unlockAudio, { once: true });
  document.addEventListener("paste", unlockAudio, { once: true });
  els.pasteZone.addEventListener("click", () => els.pasteZone.focus());
  els.pasteZone.addEventListener("dragover", (event) => {
    event.preventDefault();
    els.pasteZone.classList.add("dragging");
  });
  els.pasteZone.addEventListener("dragleave", () => els.pasteZone.classList.remove("dragging"));
  els.pasteZone.addEventListener("drop", async (event) => {
    event.preventDefault();
    els.pasteZone.classList.remove("dragging");
    await handleImageFile(event.dataTransfer.files[0]);
  });

  els.saveBtn.addEventListener("click", saveRecord);
  els.soundTestBtn.addEventListener("click", async () => {
    els.soundTestBtn.disabled = true;
    els.soundTestBtn.textContent = "播放中...";
    const played = await playReminderSound();
    setStatus(played ? "已播放测试提示音。" : "浏览器暂时拦截了声音，请再点一次测试提示音。", played ? "neutral" : "error");
    window.setTimeout(() => {
      els.soundTestBtn.disabled = false;
      els.soundTestBtn.textContent = "测试提示音";
    }, 1600);
  });
  els.clearPreviewBtn.addEventListener("click", () => {
    clearPreview();
    setStatus("预览已清空。", "neutral");
  });
  els.refreshBtn.addEventListener("click", refreshAll);
  els.tradeDate.addEventListener("change", async () => {
    state.selectedDate = els.tradeDate.value;
    await Promise.all([loadDates(), loadRecords()]);
  });
  els.closeViewerBtn.addEventListener("click", closeViewer);
  els.viewerDialog.addEventListener("click", (event) => {
    if (event.target === els.viewerDialog) closeViewer();
  });
  els.reminderDismissBtn.addEventListener("click", () => {
    localStorage.setItem(reminderKey("dismissed"), "1");
    closeReminder();
  });
  els.reminderLaterBtn.addEventListener("click", () => {
    localStorage.setItem(reminderKey("snoozedUntil"), String(Date.now() + 30 * 60 * 1000));
    closeReminder();
  });
  els.reminderGoBtn.addEventListener("click", async () => {
    closeReminder();
    await selectDate(todayString());
    els.pasteZone.focus();
    setStatus("请粘贴今天的交易截图。", "neutral");
  });
  els.noteForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    await saveEditedNote();
  });
  els.noteCancelBtn.addEventListener("click", closeNoteEditor);
  els.noteDialog.addEventListener("click", (event) => {
    if (event.target === els.noteDialog) closeNoteEditor();
  });

  await Promise.all([loadDates(), loadRecords()]);
  startReminderTimer();
  await checkDailyReminder();
  setStatus("准备就绪。", "neutral");
}

init().catch((error) => {
  setStatus(`初始化失败：${error.message}`, "error");
});
