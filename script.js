let editIndex = null;
let deleteIndex = null;
let subjects = JSON.parse(localStorage.getItem("subjects")) || [];
const TARGET = 75;

let currentMonth = new Date().getMonth();
let currentYear = new Date().getFullYear();

const today = new Date();
const todayString = formatDate(today);

/* ---------- View state ---------- */
let viewState = "list";        // "list" | "detail"
let activeSubjectIndex = null; // which subject the detail view is showing
let activeDayKey = null;       // which day's tap-popover is open, e.g. "2-2026-07-15"
let pendingAnim = null;        // { key, status } while a mark animation is playing

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
  render();
}

/* ---------- Sound mute persistence ---------- */
function isMuted() {
  return localStorage.getItem("muted") === "true";
}

function toggleMute() {
  const muted = !isMuted();
  localStorage.setItem("muted", muted);
  updateMuteButton();
  showToast(muted ? "Sounds muted" : "Sounds on");
}

function updateMuteButton() {
  const btn = document.getElementById("muteToggle");
  if (btn) btn.textContent = isMuted() ? "Unmute Sounds" : "Mute Sounds";
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
    // Bright quick upward chirp
    playTone(720, 980, 0.16, "sine");
  } else if (status === "absent") {
    // Duller, lower thud - not harsh, just distinct
    playTone(190, 150, 0.2, "triangle");
  } else if (status === "cancelled") {
    // Soft descending swoosh - cancelled is neutral/relieving, not bad
    playTone(700, 340, 0.22, "sine");
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
      save();
      if (imported.darkMode) {
        document.body.classList.add("dark");
        localStorage.setItem("darkMode", "true");
      } else {
        document.body.classList.remove("dark");
        localStorage.setItem("darkMode", "false");
      }
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
function openModal() {
  editIndex = null;
  document.getElementById("modalTitle").textContent = "Add Subject";
  document.getElementById("subjectName").value = "";
  document.querySelectorAll(".checkbox-group input").forEach(cb => cb.checked = false);
  document.getElementById("addBtn").innerText = "Add";
  validateForm();
  document.getElementById("modal").classList.add("show");
}

function openEditModal(i) {
  editIndex = i;
  const sub = subjects[i];
  document.getElementById("modalTitle").textContent = "Edit Subject";
  document.getElementById("subjectName").value = sub.name;

  document.querySelectorAll(".checkbox-group input").forEach(cb => {
    cb.checked = sub.days.includes(cb.value);
  });

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
  const days = Array.from(checked).map(cb => cb.value);

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

/* ---------- Attendance ---------- */
function toggleDayActions(index, dateStr) {
  const key = index + "-" + dateStr;
  activeDayKey = (activeDayKey === key) ? null : key;
  render();
}

function markDate(index, dateStr, status) {
  const key = index + "-" + dateStr;
  activeDayKey = null;

  if (status === "clear") {
    delete subjects[index].attendance[dateStr];
    save();
    render();
    return;
  }

  // Play the sound immediately, then let the mark animation run on the
  // still-visible cell before the re-render commits the final state.
  playSound(status);
  pendingAnim = { key: key, status: status };
  render();

  setTimeout(() => {
    subjects[index].attendance[dateStr] = status;
    pendingAnim = null;
    save();
    render();
  }, 340);
}

function stats(sub) {
  let present = 0, total = 0;
  for (let d in sub.attendance) {
    // Cancelled classes don't count towards total or present
    if (sub.attendance[d] === "cancelled") continue;

    total++;
    if (sub.attendance[d] === "present") present++;
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
    .filter(d => sub.attendance[d] === "present")
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
    // Smallest x such that (present + x) / (total + x) >= TARGET/100
    // solves to x >= 3*total - 4*present when TARGET = 75
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
    const status = sub.attendance[dateStr];
    const dayShort = dateObj.toLocaleString("en-us", { weekday: "short" });
    const isClass = sub.days.includes(dayShort);
    const isToday = (dateStr === todayString);
    const isActive = (activeDayKey === key);
    const anim = (pendingAnim && pendingAnim.key === key) ? pendingAnim.status : null;

    let classes = "day";
    if (isClass) classes += " has-class";
    if (status === "present") classes += " present";
    if (status === "absent") classes += " absent";
    if (status === "cancelled") classes += " cancelled";
    if (isToday) classes += " today";
    if (isActive) classes += " active";
    if (anim) classes += " anim-" + anim;

    const clickAttr = isClass ? " onclick=\"toggleDayActions(" + index + ",'" + dateStr + "')\"" : "";

    html += "<div class='" + classes + "' data-key='" + key + "'" + clickAttr + ">" + d;

    if (anim === "present") {
      html += "<svg class='check-draw' viewBox='0 0 24 24'><path d='M5 13l4 4 10-10'/></svg>";
    }

    if (isClass) {
      html += "<div class='popover' onclick='event.stopPropagation()'>";
      html += "<button onclick=\"markDate(" + index + ",'" + dateStr + "','present')\">P</button>";
      html += "<button onclick=\"markDate(" + index + ",'" + dateStr + "','absent')\">A</button>";
      html += "<button onclick=\"markDate(" + index + ",'" + dateStr + "','cancelled')\">C</button>";
      html += "<button onclick=\"markDate(" + index + ",'" + dateStr + "','clear')\">\u2715</button>";
      html += "</div>";
    }

    html += "</div>";
  }

  html += "</div>";
  return html;
}

/* ---------- List view ---------- */
function renderListView() {
  const container = document.getElementById("subjects");

  if (subjects.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">\uD83D\uDCDA</div>
        <div class="empty-title">No subjects yet</div>
        <div class="empty-text">Tap the + button to add your first subject and start tracking attendance.</div>
      </div>
    `;
    return;
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

  container.innerHTML = html;
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
updateMuteButton();
render();