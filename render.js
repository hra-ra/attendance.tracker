/* ==========================================================================
   render.js
   The DOM/UI orchestration layer, and the app's entry point. Everything
   that touches `document` directly - modals, the settings sheet, toasts,
   sound, dark mode, export/import, and the three main views (Today / All
   Subjects / subject detail) - lives here, along with the render()
   dispatcher that every state-changing action in the other modules calls
   when it's done.

   This is the file index.html loads as `<script type="module">`. Module
   scripts don't leak top-level declarations onto `window` the way classic
   scripts do, so every function referenced by an inline onclick/onchange
   attribute (in index.html, or in the HTML strings built below and in
   calendar.js) has to be attached to `window` explicitly - see the bottom
   of this file.
   ========================================================================== */

import {
  state, DEFAULT_TARGET, WEEKDAYS, formatDate, normalizeSubjects, getDayEntry,
  isClassDay, sessionsForDay, getSessionStatus, save, saveHolidays, isHoliday,
  holidayLabelFor, pushUndoSnapshot, isMuted
} from './state.js';
import { stats, circularProgress, streakText, safeBunkChip } from './stats.js';
import { calendarView, changeMonth, toggleDayActions, markSession, markAllToday } from './calendar.js';
import {
  openApiKeyModal, closeApiKeyModal, outsideClickApiKey, saveApiKey,
  openScanModal, closeScanModal, outsideClickScan, handleScanFileSelect,
  setScanInputMode, validateScanTextInput, runScanAction,
  setReviewAction, cancelScanReview, outsideClickReview, commitScanResults
} from './scan.js';

/* ---------- Dark Mode Persistence ---------- */
if (localStorage.getItem("darkMode") === "true") {
  document.body.classList.add("dark");
}

export function toggleDark() {
  document.body.classList.toggle("dark");
  localStorage.setItem("darkMode", document.body.classList.contains("dark"));
  updateSwitches();
  render();
}

export function toggleMute() {
  const muted = !isMuted();
  localStorage.setItem("muted", muted);
  updateSwitches();
  showToast(muted ? "Sounds muted" : "Sounds on");
}

/* ---------- Settings bottom sheet ---------- */
export function openSettings() {
  updateSwitches();
  document.getElementById("sheetBackdrop").classList.add("show");
  document.getElementById("settingsSheet").classList.add("show");
}

export function closeSettings() {
  document.getElementById("sheetBackdrop").classList.remove("show");
  document.getElementById("settingsSheet").classList.remove("show");
}

function updateSwitches() {
  const darkSwitch = document.getElementById("darkSwitch");
  const soundSwitch = document.getElementById("soundSwitch");
  if (darkSwitch) darkSwitch.classList.toggle("on", document.body.classList.contains("dark"));
  if (soundSwitch) soundSwitch.classList.toggle("on", !isMuted());
}

/* ---------- Sound synthesis (no audio files needed) ---------- */
let audioCtx = null;
function getAudioCtx() {
  if (!audioCtx) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    audioCtx = new Ctx();
  }
  return audioCtx;
}

function playTone(freqStart, freqEnd, duration, type) {
  if (isMuted()) return;
  try {
    const ctx = getAudioCtx();
    if (!ctx) return;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.type = type || "sine";
    const now = ctx.currentTime;
    osc.frequency.setValueAtTime(freqStart, now);
    if (freqEnd && freqEnd !== freqStart) {
      osc.frequency.exponentialRampToValueAtTime(freqEnd, now + duration);
    }
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.16, now + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);
    osc.start(now);
    osc.stop(now + duration + 0.02);
  } catch (e) {
    /* Web Audio unavailable - fail silently */
  }
}

export function playSound(status) {
  if (status === "present") {
    playTone(720, 980, 0.16, "sine");       // bright quick upward chirp
  } else if (status === "absent") {
    playTone(190, 150, 0.2, "triangle");    // duller, lower thud
  } else if (status === "cancelled") {
    playTone(700, 340, 0.22, "sine");       // soft descending swoosh
  }
}

/* ---------- Toast (optionally offers a one-tap Undo) ---------- */
let toastTimer = null;
export function showToast(message, type, withUndo) {
  const toast = document.getElementById("toast");
  toast.innerHTML = "";

  const msgSpan = document.createElement("span");
  msgSpan.textContent = message;
  toast.appendChild(msgSpan);

  if (withUndo) {
    const undoBtn = document.createElement("button");
    undoBtn.className = "toast-undo";
    undoBtn.textContent = "Undo";
    undoBtn.onclick = function (e) {
      e.stopPropagation();
      performUndo();
    };
    toast.appendChild(undoBtn);
  }

  toast.className = "toast show" + (type === "error" ? " error" : "");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.className = "toast";
    if (withUndo) state.undoSnapshot = null; // undo window has closed
  }, withUndo ? 5000 : 2600);
}

/* ---------- Undo (generic, snapshot-based) ---------- */
function performUndo() {
  if (!state.undoSnapshot) return;
  state.subjects = state.undoSnapshot.subjects;
  state.holidays = state.undoSnapshot.holidays;
  state.undoSnapshot = null;
  save();
  saveHolidays();
  document.getElementById("toast").className = "toast";
  render();
  showToast("Undone");
}

/* ---------- Data Export/Import ---------- */
export function exportData() {
  const exportPayload = {
    subjects: state.subjects,
    holidays: state.holidays,
    darkMode: document.body.classList.contains("dark")
  };
  const blob = new Blob([JSON.stringify(exportPayload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `bunkr_backup_${formatDate(new Date())}.json`;
  a.click();
  URL.revokeObjectURL(url);
  showToast("Backup downloaded");
  closeSettings();
}

export function importData(event) {
  const file = event.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = function (e) {
    try {
      const imported = JSON.parse(e.target.result);
      if (!imported.subjects || !Array.isArray(imported.subjects)) {
        throw new Error("Missing subjects array");
      }
      state.subjects = imported.subjects;
      normalizeSubjects();
      state.holidays = Array.isArray(imported.holidays) ? imported.holidays : [];
      save();
      saveHolidays();
      if (imported.darkMode) {
        document.body.classList.add("dark");
        localStorage.setItem("darkMode", "true");
      } else {
        document.body.classList.remove("dark");
        localStorage.setItem("darkMode", "false");
      }
      closeSettings();
      goToList();
      showToast("Data restored successfully");
    } catch (error) {
      showToast("Invalid backup file", "error");
    }
  };
  reader.readAsText(file);
  event.target.value = ""; // reset input so re-selecting the same file still fires onchange
}

/* ---------- Semester breaks / off-days (modal UI) ---------- */
export function openHolidayModal() {
  closeSettings();
  renderHolidayList();
  document.getElementById("holidayModal").classList.add("show");
}

export function closeHolidayModal() {
  document.getElementById("holidayModal").classList.remove("show");
}

export function outsideClickHoliday(e) {
  if (e.target.id === "holidayModal") closeHolidayModal();
}

function renderHolidayList() {
  const list = document.getElementById("holidayList");
  const sorted = [...state.holidays].sort((a, b) => a.start.localeCompare(b.start));

  if (sorted.length === 0) {
    list.innerHTML = "<div class='holiday-empty'>No breaks added yet.</div>";
    return;
  }

  list.innerHTML = sorted.map(h => {
    const range = h.start === h.end ? h.start : (h.start + " \u2192 " + h.end);
    return "<div class='holiday-item'>" +
      "<span>" + h.label + "<br><small>" + range + "</small></span>" +
      "<button onclick=\"removeHoliday('" + h.id + "')\">Remove</button>" +
      "</div>";
  }).join("");
}

export function addHoliday() {
  const label = document.getElementById("holidayLabel").value.trim() || "Break";
  const start = document.getElementById("holidayStart").value;
  const end = document.getElementById("holidayEnd").value || start;

  if (!start) {
    showToast("Pick a start date", "error");
    return;
  }
  if (end < start) {
    showToast("End date is before start date", "error");
    return;
  }

  state.holidays.push({
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    label,
    start,
    end
  });
  saveHolidays();
  renderHolidayList();
  render();

  document.getElementById("holidayLabel").value = "";
  document.getElementById("holidayStart").value = "";
  document.getElementById("holidayEnd").value = "";
  showToast("Break added");
}

export function removeHoliday(id) {
  state.holidays = state.holidays.filter(h => h.id !== id);
  saveHolidays();
  renderHolidayList();
  render();
  showToast("Break removed");
}

/* ---------- Navigation: list <-> detail ---------- */
export function openSubject(i) {
  state.activeSubjectIndex = i;
  state.viewState = "detail";
  state.activeDayKey = null;
  state.currentMonth = new Date().getMonth();
  state.currentYear = new Date().getFullYear();
  history.pushState({ view: "detail", index: i }, "", "#subject-" + i);
  render();
}

export function goToList() {
  state.viewState = "list";
  state.activeSubjectIndex = null;
  state.activeDayKey = null;
  render();
}

export function backToList() {
  // Let the browser/hardware back button be the single source of truth
  // so the phone's back gesture doesn't leave the app entirely.
  history.back();
}

export function setListTab(tab) {
  state.listTab = tab;
  render();
}

window.addEventListener("popstate", function (e) {
  // Named navState, not state - `state` is already this module's
  // imported store object, and shadowing it here would silently break
  // every state.xxx reference below.
  const navState = e.state;
  if (navState && navState.view === "detail" && state.subjects[navState.index]) {
    state.activeSubjectIndex = navState.index;
    state.viewState = "detail";
  } else {
    state.activeSubjectIndex = null;
    state.viewState = "list";
  }
  state.activeDayKey = null;
  render();
});

/* Close an open day-actions popover when tapping anywhere else */
document.addEventListener("click", function (e) {
  if (state.activeDayKey === null) return;
  const dayEl = e.target.closest(".day");
  const key = dayEl ? dayEl.dataset.key : null;
  if (key !== state.activeDayKey) {
    state.activeDayKey = null;
    render();
  }
});

/* ---------- Modal (Add / Edit share one modal) ---------- */
export function onDayToggle(day) {
  const checkbox = document.querySelector(".checkbox-group input[value='" + day + "']");
  const stepper = document.querySelector(".day-stepper[data-day='" + day + "']");
  if (stepper) stepper.classList.toggle("disabled", !checkbox.checked);
  validateForm();
}

export function stepDaySessions(day, delta) {
  state.modalDaySessions[day] = Math.max(1, Math.min(6, (state.modalDaySessions[day] || 1) + delta));
  document.getElementById("sessions-" + day).textContent = state.modalDaySessions[day];
}

function resetDayStepperUI() {
  WEEKDAYS.forEach(day => {
    document.getElementById("sessions-" + day).textContent = state.modalDaySessions[day];
    const checkbox = document.querySelector(".checkbox-group input[value='" + day + "']");
    const stepper = document.querySelector(".day-stepper[data-day='" + day + "']");
    if (stepper) stepper.classList.toggle("disabled", !checkbox.checked);
  });
}

export function openModal() {
  state.editIndex = null;
  state.modalDaySessions = { Mon: 1, Tue: 1, Wed: 1, Thu: 1, Fri: 1 };
  document.getElementById("modalTitle").textContent = "Add Subject";
  document.getElementById("subjectName").value = "";
  document.querySelectorAll(".checkbox-group input").forEach(cb => cb.checked = false);
  document.getElementById("subjectTarget").value = DEFAULT_TARGET;
  document.getElementById("addBtn").innerText = "Add";
  resetDayStepperUI();
  validateForm();
  document.getElementById("modal").classList.add("show");
}

export function openEditModal(i) {
  state.editIndex = i;
  const sub = state.subjects[i];
  document.getElementById("modalTitle").textContent = "Edit Subject";
  document.getElementById("subjectName").value = sub.name;

  WEEKDAYS.forEach(day => {
    const entry = getDayEntry(sub, day);
    const checkbox = document.querySelector(".checkbox-group input[value='" + day + "']");
    checkbox.checked = !!entry;
    state.modalDaySessions[day] = entry ? entry.sessions : 1;
  });
  resetDayStepperUI();

  document.getElementById("subjectTarget").value = sub.target || DEFAULT_TARGET;

  document.getElementById("addBtn").innerText = "Save";
  validateForm();
  document.getElementById("modal").classList.add("show");
}

export function closeModal() {
  document.getElementById("modal").classList.remove("show");
  state.editIndex = null;
}

export function outsideClick(e) {
  if (e.target.id === "modal") closeModal();
}

/* ---------- Validation ---------- */
export function validateForm() {
  const name = document.getElementById("subjectName").value.trim();
  const checked = document.querySelectorAll(".checkbox-group input:checked");
  const target = parseInt(document.getElementById("subjectTarget").value, 10);
  const targetValid = !isNaN(target) && target >= 50 && target <= 100;
  document.getElementById("addBtn").disabled = !(name && checked.length > 0 && targetValid);
}

/* ---------- Add / Edit Subject ---------- */
export function addSubject() {
  const name = document.getElementById("subjectName").value.trim();
  const checked = document.querySelectorAll(".checkbox-group input:checked");
  const days = Array.from(checked).map(cb => ({
    day: cb.value,
    sessions: state.modalDaySessions[cb.value] || 1
  }));
  const target = parseInt(document.getElementById("subjectTarget").value, 10) || DEFAULT_TARGET;

  if (!name || days.length === 0) return;

  if (state.editIndex !== null) {
    state.subjects[state.editIndex].name = name;
    state.subjects[state.editIndex].days = days;
    state.subjects[state.editIndex].target = target;
    showToast("Subject updated");
  } else {
    state.subjects.push({ name: name, days: days, target: target, attendance: {} });
    showToast("Subject added");
  }

  save();
  render();
  closeModal();
}

/* ---------- Delete ---------- */
export function deleteSubject(i) {
  state.deleteIndex = i;
  document.getElementById("confirmModal").classList.add("show");
}

export function closeConfirm() {
  state.deleteIndex = null;
  document.getElementById("confirmModal").classList.remove("show");
}

export function confirmDelete() {
  if (state.deleteIndex !== null) {
    pushUndoSnapshot();
    state.subjects.splice(state.deleteIndex, 1);
    save();
    closeConfirm();
    goToList();
    showToast("Subject deleted", null, true);
    return;
  }
  closeConfirm();
}

/* ---------- List view: tabs + Today / All Subjects ---------- */
function renderListView() {
  const container = document.getElementById("subjects");

  let html = "<div class='list-tabs'>";
  html += "<button class='list-tab" + (state.listTab === "today" ? " active" : "") + "' onclick=\"setListTab('today')\">Today</button>";
  html += "<button class='list-tab" + (state.listTab === "all" ? " active" : "") + "' onclick=\"setListTab('all')\">All Subjects</button>";
  html += "</div>";

  html += (state.listTab === "today") ? todayViewHtml() : allSubjectsHtml();

  container.innerHTML = html;
}

function allSubjectsHtml() {
  if (state.subjects.length === 0) {
    return `
      <div class="empty-state">
        <div class="empty-icon">\uD83D\uDCDA</div>
        <div class="empty-title">No subjects yet</div>
        <div class="empty-text">Tap the + button to add your first subject and start tracking attendance.</div>
      </div>
    `;
  }

  let html = "";
  state.subjects.forEach(function (sub, i) {
    const target = sub.target || DEFAULT_TARGET;
    const s = stats(sub);
    const percent = s.total === 0 ? 0 : ((s.present / s.total) * 100).toFixed(1);

    html +=
      "<div class='subject-row' onclick='openSubject(" + i + ")'>" +
      "<div class='row-ring'>" + circularProgress(percent, 60, target) + "</div>" +
      "<div class='row-info'>" +
      "<div class='row-title'>" + sub.name + "</div>" +
      "<div class='row-meta'>" +
      "<span class='row-streak'>" + streakText(sub) + "</span>" +
      "<span class='row-target'>Target " + target + "%</span>" +
      "<span class='bunk-chip'>" + safeBunkChip(sub) + "</span>" +
      "</div>" +
      "</div>" +
      "<div class='row-chevron'>\u203A</div>" +
      "</div>";
  });
  return html;
}

function todayViewHtml() {
  if (isHoliday(state.todayString)) {
    const label = holidayLabelFor(state.todayString);
    return `
      <div class="empty-state">
        <div class="empty-icon">\uD83C\uDF89</div>
        <div class="empty-title">${label || "On a break"}</div>
        <div class="empty-text">Today's marked as a semester break, so there's nothing to track.</div>
      </div>
    `;
  }

  const todaysSubjects = [];
  state.subjects.forEach((sub, i) => {
    if (isClassDay(sub, state.todayDayShort)) todaysSubjects.push(i);
  });

  if (todaysSubjects.length === 0) {
    return `
      <div class="empty-state">
        <div class="empty-icon">\u2600\uFE0F</div>
        <div class="empty-title">No classes today</div>
        <div class="empty-text">Nothing scheduled for today. Enjoy the free day.</div>
      </div>
    `;
  }

  let totalUnits = 0, markedUnits = 0;
  todaysSubjects.forEach(i => {
    const sub = state.subjects[i];
    const sessionsCount = sessionsForDay(sub, state.todayDayShort);
    totalUnits += sessionsCount;
    for (let s = 0; s < sessionsCount; s++) {
      if (getSessionStatus(sub, state.todayString, s)) markedUnits++;
    }
  });

  const allDone = markedUnits === totalUnits;

  let html = "<div class='today-progress-row'>";
  html += "<div class='today-progress" + (allDone ? " done" : "") + "'>" +
    (allDone ? "\u2713 All done for today (" + totalUnits + "/" + totalUnits + ")" : markedUnits + " of " + totalUnits + " marked") +
    "</div>";
  if (!allDone) {
    html += "<button class='mark-all-btn' onclick='markAllToday()'>Mark All Present</button>";
  }
  html += "</div>";

  todaysSubjects.forEach(i => {
    const sub = state.subjects[i];
    const sessionsCount = sessionsForDay(sub, state.todayDayShort);

    html += "<div class='today-card'>";
    html += "<div class='today-card-title'>" + sub.name + "</div>";

    for (let s = 0; s < sessionsCount; s++) {
      const status = getSessionStatus(sub, state.todayString, s);
      const key = i + "-" + state.todayString;
      const animMatches = state.pendingAnim && state.pendingAnim.key === key && state.pendingAnim.sessionIndex === s;
      const tagClass = status ? "st-" + status : "st-unmarked";
      const tagLabel = status ? (status.charAt(0).toUpperCase() + status.slice(1)) : "Unmarked";

      html += "<div class='today-session-row" + (animMatches ? " anim-" + state.pendingAnim.status : "") + "'>";
      if (sessionsCount > 1) html += "<span class='today-session-label'>S" + (s + 1) + "</span>";
      html += "<span class='today-status-tag " + tagClass + "'>" + tagLabel + "</span>";
      html += "<div class='today-actions'>";
      html += "<button onclick=\"markSession(" + i + ",'" + state.todayString + "'," + s + ",'present')\">P</button>";
      html += "<button onclick=\"markSession(" + i + ",'" + state.todayString + "'," + s + ",'absent')\">A</button>";
      html += "<button onclick=\"markSession(" + i + ",'" + state.todayString + "'," + s + ",'cancelled')\">C</button>";
      html += "</div></div>";
    }

    html += "</div>";
  });

  return html;
}

/* ---------- Detail view ---------- */
function renderDetailView() {
  const container = document.getElementById("subjects");
  const sub = state.subjects[state.activeSubjectIndex];
  if (!sub) { goToList(); return; }

  const i = state.activeSubjectIndex;
  const target = sub.target || DEFAULT_TARGET;
  const s = stats(sub);
  const percent = s.total === 0 ? 0 : ((s.present / s.total) * 100).toFixed(1);

  container.innerHTML =
    "<div class='detail-topbar'>" +
    "<button class='back-btn' onclick='backToList()'>\u2039 Back</button>" +
    "<div class='detail-actions'>" +
    "<button class='icon-btn' onclick='openEditModal(" + i + ")'>Edit</button>" +
    "<button class='icon-btn danger-icon' onclick='deleteSubject(" + i + ")'>Delete</button>" +
    "</div>" +
    "</div>" +

    "<div class='subject'>" +
    "<div class='subject-header'>" +
    "<div class='subject-title'>" + sub.name + "<div class='target-label'>Target " + target + "%</div></div>" +
    circularProgress(percent, 100, target) +
    "</div>" +

    "<div class='header-divider'></div>" +

    "<div class='mini-stats'>" +
    "<div>Present<br><strong>" + s.present + "</strong></div>" +
    "<div>Absent<br><strong>" + (s.total - s.present) + "</strong></div>" +
    "<div>Total<br><strong>" + s.total + "</strong></div>" +
    "</div>" +

    "<div class='top-status-row'>" +
    "<div class='streak-text'>" + streakText(sub) + "</div>" +
    "<div class='bunk-chip'>" + safeBunkChip(sub) + "</div>" +
    "</div>" +

    "<div class='calendar-wrapper'>" +
    calendarView(sub, i) +
    "</div>" +
    "</div>";
}

/* ---------- Render dispatcher ---------- */
export function render() {
  const fab = document.getElementById("fab");
  const fabScan = document.getElementById("fabScan");
  if (state.viewState === "detail") {
    if (fab) fab.style.display = "none";
    if (fabScan) fabScan.style.display = "none";
    renderDetailView();
  } else {
    if (fab) fab.style.display = "";
    if (fabScan) fabScan.style.display = "";
    renderListView();
  }
}

/* ----------------------------------------------------------------------
   Expose every function referenced by an inline onclick/oninput/onchange
   attribute - in index.html or in the HTML strings built above and in
   calendar.js - as a global. Module scripts don't do this automatically
   the way classic scripts do, so without this, every button in the app
   would fail silently with "X is not defined" the moment it's tapped.
   ---------------------------------------------------------------------- */
Object.assign(window, {
  openSettings, closeSettings, toggleDark, toggleMute,
  openHolidayModal, closeHolidayModal, outsideClickHoliday, addHoliday, removeHoliday,
  exportData, importData,
  openModal, openEditModal, closeModal, outsideClick, validateForm, addSubject,
  onDayToggle, stepDaySessions,
  deleteSubject, closeConfirm, confirmDelete,
  openSubject, backToList, setListTab,
  changeMonth, toggleDayActions, markSession, markAllToday,
  openApiKeyModal, closeApiKeyModal, outsideClickApiKey, saveApiKey,
  openScanModal, closeScanModal, outsideClickScan, handleScanFileSelect,
  setScanInputMode, validateScanTextInput, runScanAction,
  setReviewAction, cancelScanReview, outsideClickReview, commitScanResults
});

/* ---------- App bootstrap ---------- */
// Make sure popping back to the very first page load lands on the list
history.replaceState({ view: "list" }, "", "#");
updateSwitches();
render();
const launchParams = new URLSearchParams(location.search);
if (launchParams.get("action") === "mark-today") {
  setListTab("today");
  markAllToday();
}