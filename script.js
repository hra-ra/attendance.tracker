let editIndex = null;
let deleteIndex = null;
let subjects = JSON.parse(localStorage.getItem("subjects")) || [];
const TARGET = 75;

let currentMonth = new Date().getMonth();
let currentYear = new Date().getFullYear();

const today = new Date();
const todayString = formatDate(today);

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
      render();
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
    render();
    showToast("Subject deleted");
  }
  closeConfirm();
}

/* ---------- Attendance ---------- */
function markDate(index, dateStr, status) {
  if (status === "clear") {
    delete subjects[index].attendance[dateStr];
  } else {
    subjects[index].attendance[dateStr] = status;
  }
  save();
  render();
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

function circularProgress(percent) {
  const radius = 42;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (percent / 100) * circumference;

  let colorClass = "ring-low";
  if (percent >= 85) colorClass = "ring-high";
  else if (percent >= 75) colorClass = "ring-target";
  else if (percent >= 60) colorClass = "ring-mid";

  return `
  <div class="ring-container ${colorClass}">
    <svg width="100" height="100">
      <circle class="ring-bg" cx="50" cy="50" r="${radius}" />
      <circle class="ring-progress" cx="50" cy="50" r="${radius}" stroke-dasharray="${circumference}" stroke-dashoffset="${offset}" />
    </svg>
    <div class="ring-text">${percent}%</div>
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
  render();
}

/* ---------- Calendar ---------- */
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
    const status = sub.attendance[dateStr];
    const dayShort = dateObj.toLocaleString("en-us", { weekday: "short" });
    const isClass = sub.days.includes(dayShort);
    const isToday = (dateStr === todayString);

    let classes = "day";
    if (status === "present") classes += " present";
    if (status === "absent") classes += " absent";
    if (status === "cancelled") classes += " cancelled";
    if (isToday) classes += " today";

    html += "<div class='" + classes + "'>" + d;

    if (isClass) {
      html += "<div class='popover'>";
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

/* ---------- Render ---------- */
function render() {
  const container = document.getElementById("subjects");
  container.innerHTML = "";

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

  subjects.forEach(function (sub, i) {
    const s = stats(sub);
    const percent = s.total === 0 ? 0 : ((s.present / s.total) * 100).toFixed(1);

    const div = document.createElement("div");
    div.className = "subject";

    div.innerHTML =
      "<div class='subject-actions'>" +
      "<button class='icon-btn' onclick='openEditModal(" + i + ")'>Edit</button>" +
      "<button class='icon-btn danger-icon' onclick='deleteSubject(" + i + ")'>Delete</button>" +
      "</div>" +

      "<div class='subject-header'>" +
      "<div class='subject-title'>" + sub.name + "</div>" +
      circularProgress(percent) +
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
      "</div>";

    container.appendChild(div);
  });
}

render();