let editIndex = null;
let deleteIndex = null;
let subjects = JSON.parse(localStorage.getItem("subjects")) || [];
const TARGET = 75;

let currentMonth = new Date().getMonth();
let currentYear = new Date().getFullYear();

const today = new Date();
const todayString = formatDate(today);
const todayDayShort = today.toLocaleString("en-us", { weekday: "short" });

/* ---------- View state ---------- */
let viewState = "list";        // "list" | "detail"
let listTab = "today";         // "today" | "all" - which list-view tab is active
let activeSubjectIndex = null; // which subject the detail view is showing
let activeDayKey = null;       // which day's tap-popover is open, e.g. "2-2026-07-15"
let pendingAnim = null;        // { key, sessionIndex, status } while a mark animation is playing
let modalDaySessions = { Mon: 1, Tue: 1, Wed: 1, Thu: 1, Fri: 1 }; // per-day session counts currently set in the modal

/* ---------- Data migration ---------- */
// v1 data: attendance[dateStr] was a plain status string, sub.days was a
// plain array of strings, no sessions concept at all.
// v2 data: attendance[dateStr] became an array of per-session statuses, and
// a single subject-wide "sessions" count was added.
// v3 (current): sessions are per weekday, since a subject can meet twice on
// Monday and once every other day. sub.days becomes an array of
// { day: "Mon", sessions: 2 } objects. Every step below is safe to run
// again on already-migrated data, so nobody's saved attendance ever breaks.
function normalizeSubjects() {
  subjects.forEach(sub => {
    if (Array.isArray(sub.days) && sub.days.length && typeof sub.days[0] === "string") {
      const uniformSessions = sub.sessions || 1;
      sub.days = sub.days.map(d => ({ day: d, sessions: uniformSessions }));
    }
    delete sub.sessions;
    for (let d in sub.attendance) {
      if (!Array.isArray(sub.attendance[d])) {
        sub.attendance[d] = [sub.attendance[d]];
      }
    }
  });
}
normalizeSubjects();

/* ---------- Per-day helpers ---------- */
function getDayEntry(sub, dayShort) {
  return sub.days.find(d => d.day === dayShort);
}

function isClassDay(sub, dayShort) {
  return !!getDayEntry(sub, dayShort);
}

function sessionsForDay(sub, dayShort) {
  const entry = getDayEntry(sub, dayShort);
  return entry ? entry.sessions : 0;
}

/* ---------- Date Utility ---------- */
function formatDate(d) {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return year + "-" + month + "-" + day;
}

/* ---------- Dark Mode Persistence ---------- */
if (localStorage.getItem("darkMode") === "true") {
  document.body.classList.add("dark");
}

function toggleDark() {
  document.body.classList.toggle("dark");
  localStorage.setItem("darkMode", document.body.classList.contains("dark"));
  updateSwitches();
  render();
}

/* ---------- Sound mute persistence ---------- */
function isMuted() {
  return localStorage.getItem("muted") === "true";
}

function toggleMute() {
  const muted = !isMuted();
  localStorage.setItem("muted", muted);
  updateSwitches();
  showToast(muted ? "Sounds muted" : "Sounds on");
}

/* ---------- Settings bottom sheet ---------- */
function openSettings() {
  updateSwitches();
  document.getElementById("sheetBackdrop").classList.add("show");
  document.getElementById("settingsSheet").classList.add("show");
}

function closeSettings() {
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

function playSound(status) {
  if (status === "present") {
    playTone(720, 980, 0.16, "sine");       // bright quick upward chirp
  } else if (status === "absent") {
    playTone(190, 150, 0.2, "triangle");    // duller, lower thud
  } else if (status === "cancelled") {
    playTone(700, 340, 0.22, "sine");       // soft descending swoosh
  }
}

/* ---------- Toast ---------- */
let toastTimer = null;
function showToast(message, type) {
  const toast = document.getElementById("toast");
  toast.textContent = message;
  toast.className = "toast show" + (type === "error" ? " error" : "");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.className = "toast";
  }, 2600);
}

/* ---------- Data Export/Import ---------- */
function exportData() {
  const exportPayload = {
    subjects: subjects,
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

function importData(event) {
  const file = event.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = function (e) {
    try {
      const imported = JSON.parse(e.target.result);
      if (!imported.subjects || !Array.isArray(imported.subjects)) {
        throw new Error("Missing subjects array");
      }
      subjects = imported.subjects;
      normalizeSubjects();
      save();
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

/* ---------- Utilities ---------- */
function save() {
  localStorage.setItem("subjects", JSON.stringify(subjects));
}

/* ---------- Navigation: list <-> detail ---------- */
function openSubject(i) {
  activeSubjectIndex = i;
  viewState = "detail";
  activeDayKey = null;
  currentMonth = new Date().getMonth();
  currentYear = new Date().getFullYear();
  history.pushState({ view: "detail", index: i }, "", "#subject-" + i);
  render();
}

function goToList() {
  viewState = "list";
  activeSubjectIndex = null;
  activeDayKey = null;
  render();
}

function backToList() {
  // Let the browser/hardware back button be the single source of truth
  // so the phone's back gesture doesn't leave the app entirely.
  history.back();
}

function setListTab(tab) {
  listTab = tab;
  render();
}

window.addEventListener("popstate", function (e) {
  const state = e.state;
  if (state && state.view === "detail" && subjects[state.index]) {
    activeSubjectIndex = state.index;
    viewState = "detail";
  } else {
    activeSubjectIndex = null;
    viewState = "list";
  }
  activeDayKey = null;
  render();
});

/* Close an open day-actions popover when tapping anywhere else */
document.addEventListener("click", function (e) {
  if (activeDayKey === null) return;
  const dayEl = e.target.closest(".day");
  const key = dayEl ? dayEl.dataset.key : null;
  if (key !== activeDayKey) {
    activeDayKey = null;
    render();
  }
});

/* ---------- Modal (Add / Edit share one modal) ---------- */
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri"];

function onDayToggle(day) {
  const checkbox = document.querySelector(".checkbox-group input[value='" + day + "']");
  const stepper = document.querySelector(".day-stepper[data-day='" + day + "']");
  if (stepper) stepper.classList.toggle("disabled", !checkbox.checked);
  validateForm();
}

function stepDaySessions(day, delta) {
  modalDaySessions[day] = Math.max(1, Math.min(6, (modalDaySessions[day] || 1) + delta));
  document.getElementById("sessions-" + day).textContent = modalDaySessions[day];
}

function resetDayStepperUI() {
  WEEKDAYS.forEach(day => {
    document.getElementById("sessions-" + day).textContent = modalDaySessions[day];
    const checkbox = document.querySelector(".checkbox-group input[value='" + day + "']");
    const stepper = document.querySelector(".day-stepper[data-day='" + day + "']");
    if (stepper) stepper.classList.toggle("disabled", !checkbox.checked);
  });
}

function openModal() {
  editIndex = null;
  modalDaySessions = { Mon: 1, Tue: 1, Wed: 1, Thu: 1, Fri: 1 };
  document.getElementById("modalTitle").textContent = "Add Subject";
  document.getElementById("subjectName").value = "";
  document.querySelectorAll(".checkbox-group input").forEach(cb => cb.checked = false);
  document.getElementById("addBtn").innerText = "Add";
  resetDayStepperUI();
  validateForm();
  document.getElementById("modal").classList.add("show");
}

function openEditModal(i) {
  editIndex = i;
  const sub = subjects[i];
  document.getElementById("modalTitle").textContent = "Edit Subject";
  document.getElementById("subjectName").value = sub.name;

  WEEKDAYS.forEach(day => {
    const entry = getDayEntry(sub, day);
    const checkbox = document.querySelector(".checkbox-group input[value='" + day + "']");
    checkbox.checked = !!entry;
    modalDaySessions[day] = entry ? entry.sessions : 1;
  });
  resetDayStepperUI();

  document.getElementById("addBtn").innerText = "Save";
  validateForm();
  document.getElementById("modal").classList.add("show");
}

function closeModal() {
  document.getElementById("modal").classList.remove("show");
  editIndex = null;
}

function outsideClick(e) {
  if (e.target.id === "modal") closeModal();
}

/* ---------- Validation ---------- */
function validateForm() {
  const name = document.getElementById("subjectName").value.trim();
  const checked = document.querySelectorAll(".checkbox-group input:checked");
  document.getElementById("addBtn").disabled = !(name && checked.length > 0);
}

/* ---------- Add / Edit Subject ---------- */
function addSubject() {
  const name = document.getElementById("subjectName").value.trim();
  const checked = document.querySelectorAll(".checkbox-group input:checked");
  const days = Array.from(checked).map(cb => ({
    day: cb.value,
    sessions: modalDaySessions[cb.value] || 1
  }));

  if (!name || days.length === 0) return;

  if (editIndex !== null) {
    subjects[editIndex].name = name;
    subjects[editIndex].days = days;
    showToast("Subject updated");
  } else {
    subjects.push({ name: name, days: days, attendance: {} });
    showToast("Subject added");
  }

  save();
  render();
  closeModal();
}

/* ---------- Delete ---------- */
function deleteSubject(i) {
  deleteIndex = i;
  document.getElementById("confirmModal").classList.add("show");
}

function closeConfirm() {
  deleteIndex = null;
  document.getElementById("confirmModal").classList.remove("show");
}

function confirmDelete() {
  if (deleteIndex !== null) {
    subjects.splice(deleteIndex, 1);
    save();
    closeConfirm();
    goToList();
    showToast("Subject deleted");
    return;
  }
  closeConfirm();
}

/* ---------- Attendance (session-aware) ---------- */
// A day cell's popover only opens/closes on tap - this has no animation of
// its own, so simply looking at a date never produces any visual "pop".
function toggleDayActions(index, dateStr) {
  const key = index + "-" + dateStr;
  activeDayKey = (activeDayKey === key) ? null : key;
  render();
}

function getSessionStatus(sub, dateStr, sessionIndex) {
  const arr = sub.attendance[dateStr];
  return (arr && arr[sessionIndex]) || null;
}

function markSession(index, dateStr, sessionIndex, status) {
  const key = index + "-" + dateStr;
  activeDayKey = null;

  if (status === "clear") {
    const arr = subjects[index].attendance[dateStr];
    if (arr) {
      arr[sessionIndex] = null;
      if (arr.every(s => !s)) delete subjects[index].attendance[dateStr];
    }
    save();
    render();
    return;
  }

  // Play the sound immediately, then let the mark animation run on the
  // still-visible cell before the re-render commits the final state.
  playSound(status);
  pendingAnim = { key: key, sessionIndex: sessionIndex, status: status };
  render();

  setTimeout(() => {
    if (!subjects[index].attendance[dateStr]) subjects[index].attendance[dateStr] = [];
    subjects[index].attendance[dateStr][sessionIndex] = status;
    pendingAnim = null;
    save();
    render();
  }, 340);
}

function stats(sub) {
  let present = 0, total = 0;
  for (let d in sub.attendance) {
    sub.attendance[d].forEach(status => {
      if (!status || status === "cancelled") return;
      total++;
      if (status === "present") present++;
    });
  }
  return { present, total };
}

function circularProgress(percent, size) {
  size = size || 100;
  const strokeWidth = size <= 70 ? 6 : 8;
  const radius = size / 2 - strokeWidth - 2;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (percent / 100) * circumference;
  const c = size / 2;

  let colorClass = "ring-low";
  if (percent >= 85) colorClass = "ring-high";
  else if (percent >= 75) colorClass = "ring-target";
  else if (percent >= 60) colorClass = "ring-mid";

  const fontSize = Math.max(11, Math.round(size * 0.15));

  return `
  <div class="ring-container ${colorClass}" style="width:${size}px;height:${size}px;">
    <svg width="${size}" height="${size}">
      <circle class="ring-bg" cx="${c}" cy="${c}" r="${radius}" style="stroke-width:${strokeWidth}px;" />
      <circle class="ring-progress" cx="${c}" cy="${c}" r="${radius}" style="stroke-width:${strokeWidth}px;" stroke-dasharray="${circumference}" stroke-dashoffset="${offset}" />
    </svg>
    <div class="ring-text" style="font-size:${fontSize}px;">${percent}%</div>
  </div>
  `;
}

/* ---------- Streak ---------- */
function streakText(sub) {
  const dates = Object.keys(sub.attendance)
    .filter(d => sub.attendance[d].some(s => s === "present"))
    .sort()
    .reverse();

  if (dates.length === 0) return "No streak";

  let streak = 1;
  for (let i = 1; i < dates.length; i++) {
    const prev = new Date(dates[i - 1]);
    const curr = new Date(dates[i]);
    const diff = (prev - curr) / (1000 * 60 * 60 * 24);
    if (diff === 1) streak++;
    else break;
  }

  return streak + " Day Streak \uD83D\uDD25";
}

/* ---------- Safe Bunk / Needed-to-recover Math ---------- */
function safeBunkChip(sub) {
  const s = stats(sub);
  if (s.total === 0) return "<span class='neutral'>No Data</span>";

  const currentPercent = (s.present / s.total) * 100;

  if (currentPercent < TARGET) {
    const needed = Math.max(1, Math.ceil(3 * s.total - 4 * s.present));
    return "<span class='danger'>Attend " + needed + " more in a row</span>";
  }

  let canSkip = 0;
  while ((s.present / (s.total + canSkip)) * 100 >= TARGET) {
    canSkip++;
  }
  canSkip = canSkip - 1;

  if (canSkip <= 0) return "<span class='warning'>On the edge</span>";
  if (canSkip === 1) return "<span class='safe'>Safe to Skip 1 Class</span>";
  return "<span class='safe'>Safe to Skip " + canSkip + " Classes</span>";
}

/* ---------- Month Navigation ---------- */
function changeMonth(offset) {
  currentMonth += offset;
  if (currentMonth > 11) { currentMonth = 0; currentYear++; }
  if (currentMonth < 0) { currentMonth = 11; currentYear--; }
  activeDayKey = null;
  render();
}

/* ---------- Calendar (used only in detail view) ---------- */
function calendarView(sub, index) {
  const firstDay = new Date(currentYear, currentMonth, 1).getDay();
  const daysInMonth = new Date(currentYear, currentMonth + 1, 0).getDate();

  let html = "";
  html += "<div class='month-nav'>";
  html += "<div class='month-label'>" +
    new Date(currentYear, currentMonth)
      .toLocaleString("en-us", { month: "long", year: "numeric" }) +
    "</div>";
  html += "<div class='month-arrows'>";
  html += "<span onclick='changeMonth(-1)'>&lt;</span>";
  html += "<span onclick='changeMonth(1)'>&gt;</span>";
  html += "</div></div>";

  html += "<div class='calendar-grid'>";

  for (let i = 0; i < firstDay; i++) {
    html += "<div></div>";
  }

  for (let d = 1; d <= daysInMonth; d++) {
    const dateObj = new Date(currentYear, currentMonth, d);
    const dateStr = formatDate(dateObj);
    const key = index + "-" + dateStr;
    const dayShort = dateObj.toLocaleString("en-us", { weekday: "short" });
    const isClass = isClassDay(sub, dayShort);
    const sessionsCount = sessionsForDay(sub, dayShort);
    const isToday = (dateStr === todayString);
    const isActive = (activeDayKey === key);

    let classes = "day";
    if (isClass) classes += " has-class";
    if (isToday) classes += " today";
    if (isActive) classes += " active";

    // Work out the aggregate look of the cell across all of that day's sessions
    let counts = { present: 0, absent: 0, cancelled: 0, marked: 0 };
    for (let s = 0; s < sessionsCount; s++) {
      const st = getSessionStatus(sub, dateStr, s);
      if (st) {
        counts.marked++;
        counts[st] = (counts[st] || 0) + 1;
      }
    }
    if (counts.marked > 0) {
      if (counts.present === sessionsCount) classes += " present";
      else if (counts.absent === sessionsCount) classes += " absent";
      else if (counts.cancelled === sessionsCount) classes += " cancelled";
      else classes += " mixed";
    }

    const animMatchesThisDay = pendingAnim && pendingAnim.key === key;
    if (animMatchesThisDay) classes += " anim-" + pendingAnim.status;

    const clickAttr = isClass ? " onclick=\"toggleDayActions(" + index + ",'" + dateStr + "')\"" : "";

    html += "<div class='" + classes + "' data-key='" + key + "'" + clickAttr + ">" + d;

    if (animMatchesThisDay && pendingAnim.status === "present") {
      html += "<svg class='check-draw' viewBox='0 0 24 24'><path d='M5 13l4 4 10-10'/></svg>";
    }

    if (sessionsCount > 1 && counts.marked > 0 && counts.marked < sessionsCount) {
      html += "<span class='day-fraction'>" + counts.marked + "/" + sessionsCount + "</span>";
    }

    if (isClass) {
      if (sessionsCount === 1) {
        html += "<div class='popover' onclick='event.stopPropagation()'>";
        html += "<button onclick=\"markSession(" + index + ",'" + dateStr + "',0,'present')\">P</button>";
        html += "<button onclick=\"markSession(" + index + ",'" + dateStr + "',0,'absent')\">A</button>";
        html += "<button onclick=\"markSession(" + index + ",'" + dateStr + "',0,'cancelled')\">C</button>";
        html += "<button onclick=\"markSession(" + index + ",'" + dateStr + "',0,'clear')\">\u2715</button>";
        html += "</div>";
      } else {
        html += "<div class='popover multi' onclick='event.stopPropagation()'>";
        for (let s = 0; s < sessionsCount; s++) {
          html += "<div class='session-row'>";
          html += "<span class='session-label'>S" + (s + 1) + "</span>";
          html += "<button onclick=\"markSession(" + index + ",'" + dateStr + "'," + s + ",'present')\">P</button>";
          html += "<button onclick=\"markSession(" + index + ",'" + dateStr + "'," + s + ",'absent')\">A</button>";
          html += "<button onclick=\"markSession(" + index + ",'" + dateStr + "'," + s + ",'cancelled')\">C</button>";
          html += "<button onclick=\"markSession(" + index + ",'" + dateStr + "'," + s + ",'clear')\">\u2715</button>";
          html += "</div>";
        }
        html += "</div>";
      }
    }

    html += "</div>";
  }

  html += "</div>";
  return html;
}

/* ---------- List view: tabs + Today / All Subjects ---------- */
function renderListView() {
  const container = document.getElementById("subjects");

  let html = "<div class='list-tabs'>";
  html += "<button class='list-tab" + (listTab === "today" ? " active" : "") + "' onclick=\"setListTab('today')\">Today</button>";
  html += "<button class='list-tab" + (listTab === "all" ? " active" : "") + "' onclick=\"setListTab('all')\">All Subjects</button>";
  html += "</div>";

  html += (listTab === "today") ? todayViewHtml() : allSubjectsHtml();

  container.innerHTML = html;
}

function allSubjectsHtml() {
  if (subjects.length === 0) {
    return `
      <div class="empty-state">
        <div class="empty-icon">\uD83D\uDCDA</div>
        <div class="empty-title">No subjects yet</div>
        <div class="empty-text">Tap the + button to add your first subject and start tracking attendance.</div>
      </div>
    `;
  }

  let html = "";
  subjects.forEach(function (sub, i) {
    const s = stats(sub);
    const percent = s.total === 0 ? 0 : ((s.present / s.total) * 100).toFixed(1);

    html +=
      "<div class='subject-row' onclick='openSubject(" + i + ")'>" +
      "<div class='row-ring'>" + circularProgress(percent, 60) + "</div>" +
      "<div class='row-info'>" +
      "<div class='row-title'>" + sub.name + "</div>" +
      "<div class='row-meta'>" +
      "<span class='row-streak'>" + streakText(sub) + "</span>" +
      "<span class='bunk-chip'>" + safeBunkChip(sub) + "</span>" +
      "</div>" +
      "</div>" +
      "<div class='row-chevron'>\u203A</div>" +
      "</div>";
  });
  return html;
}

function todayViewHtml() {
  const todaysSubjects = [];
  subjects.forEach((sub, i) => {
    if (isClassDay(sub, todayDayShort)) todaysSubjects.push(i);
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
    const sub = subjects[i];
    const sessionsCount = sessionsForDay(sub, todayDayShort);
    totalUnits += sessionsCount;
    for (let s = 0; s < sessionsCount; s++) {
      if (getSessionStatus(sub, todayString, s)) markedUnits++;
    }
  });

  const allDone = markedUnits === totalUnits;

  let html = "<div class='today-progress" + (allDone ? " done" : "") + "'>" +
    (allDone ? "\u2713 All done for today (" + totalUnits + "/" + totalUnits + ")" : markedUnits + " of " + totalUnits + " marked") +
    "</div>";

  todaysSubjects.forEach(i => {
    const sub = subjects[i];
    const sessionsCount = sessionsForDay(sub, todayDayShort);

    html += "<div class='today-card'>";
    html += "<div class='today-card-title'>" + sub.name + "</div>";

    for (let s = 0; s < sessionsCount; s++) {
      const status = getSessionStatus(sub, todayString, s);
      const key = i + "-" + todayString;
      const animMatches = pendingAnim && pendingAnim.key === key && pendingAnim.sessionIndex === s;
      const tagClass = status ? "st-" + status : "st-unmarked";
      const tagLabel = status ? (status.charAt(0).toUpperCase() + status.slice(1)) : "Unmarked";

      html += "<div class='today-session-row" + (animMatches ? " anim-" + pendingAnim.status : "") + "'>";
      if (sessionsCount > 1) html += "<span class='today-session-label'>S" + (s + 1) + "</span>";
      html += "<span class='today-status-tag " + tagClass + "'>" + tagLabel + "</span>";
      html += "<div class='today-actions'>";
      html += "<button onclick=\"markSession(" + i + ",'" + todayString + "'," + s + ",'present')\">P</button>";
      html += "<button onclick=\"markSession(" + i + ",'" + todayString + "'," + s + ",'absent')\">A</button>";
      html += "<button onclick=\"markSession(" + i + ",'" + todayString + "'," + s + ",'cancelled')\">C</button>";
      html += "</div></div>";
    }

    html += "</div>";
  });

  return html;
}

/* ---------- Detail view ---------- */
function renderDetailView() {
  const container = document.getElementById("subjects");
  const sub = subjects[activeSubjectIndex];
  if (!sub) { goToList(); return; }

  const i = activeSubjectIndex;
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
    "<div class='subject-title'>" + sub.name + "</div>" +
    circularProgress(percent, 100) +
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
function render() {
  const fab = document.getElementById("fab");
  if (viewState === "detail") {
    if (fab) fab.style.display = "none";
    renderDetailView();
  } else {
    if (fab) fab.style.display = "";
    renderListView();
  }
}

// Make sure popping back to the very first page load lands on the list
history.replaceState({ view: "list" }, "", "#");
updateSwitches();
render();