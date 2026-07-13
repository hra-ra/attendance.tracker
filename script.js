let deleteIndex = null;
let subjects = JSON.parse(localStorage.getItem("subjects")) || [];
const TARGET = 75;

let currentMonth = new Date().getMonth();
let currentYear = new Date().getFullYear();

const today = new Date();
const todayString = formatDate(today);

/* ---------- Date Utility ----------
   IMPORTANT: we build date-key strings from LOCAL date parts, not
   date.toISOString(). toISOString() converts to UTC first, and for
   timezones ahead of UTC (like India, UTC+5:30) that silently shifts
   the date back by one day - e.g. attendance marked on the 15th was
   being saved under the 14th. formatDate() avoids that. */
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
  localStorage.setItem("darkMode",
    document.body.classList.contains("dark"));
}

/* ---------- Utilities ---------- */
function save() {
  localStorage.setItem("subjects", JSON.stringify(subjects));
}

function openModal() {
  document.getElementById("modal").classList.add("show");
}

function outsideClick(e) {
  if (e.target.id === "modal") {
    document.getElementById("modal").classList.remove("show");
  }
}

/* ---------- Validation ---------- */
function validateForm() {
  const name = document.getElementById("subjectName").value.trim();
  const checked = document.querySelectorAll(".checkbox-group input:checked");
  document.getElementById("addBtn").disabled = !(name && checked.length > 0);
}

/* ---------- Add Subject ---------- */
function addSubject() {
  const name = document.getElementById("subjectName").value.trim();
  const checked = document.querySelectorAll(".checkbox-group input:checked");
  const days = Array.from(checked).map(cb => cb.value);

  if (!name || days.length === 0) return;

  subjects.push({ name: name, days: days, attendance: {} });
  save();
  render();

  document.getElementById("subjectName").value = "";
  checked.forEach(cb => cb.checked = false);
  document.getElementById("addBtn").disabled = true;
  document.getElementById("modal").classList.remove("show");
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
      <circle class="ring-bg"
        cx="50" cy="50" r="${radius}" />
      <circle class="ring-progress"
        cx="50" cy="50" r="${radius}"
        stroke-dasharray="${circumference}"
        stroke-dashoffset="${offset}" />
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

/* ---------- Safe Bunk Chip ---------- */
function safeBunkChip(sub) {
  const s = stats(sub);
  if (s.total === 0) return "<span class='neutral'>No Data</span>";

  const currentPercent = (s.present / s.total) * 100;

  if (currentPercent < TARGET) {
    return "<span class='danger'>Below Target</span>";
  }

  let canSkip = 0;
  while ((s.present / (s.total + canSkip)) * 100 >= TARGET) {
    canSkip++;
  }

  canSkip = canSkip - 1;

  if (canSkip <= 0) {
    return "<span class='warning'>No Safe Bunks</span>";
  }

  if (canSkip === 1) {
    return "<span class='safe'>Safe to Skip 1 Class</span>";
  }

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
    if (isToday) classes += " today";

    html += "<div class='" + classes + "'>" + d;

    if (isClass) {
      html += "<div class='popover'>";
      html += "<button onclick=\"markDate(" + index + ",'" + dateStr + "','present')\">P</button>";
      html += "<button onclick=\"markDate(" + index + ",'" + dateStr + "','absent')\">A</button>";
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

  subjects.forEach(function (sub, i) {
    const s = stats(sub);
    const percent = s.total === 0 ? 0 :
      ((s.present / s.total) * 100).toFixed(1);

    const div = document.createElement("div");
    div.className = "subject";

    div.innerHTML =
      "<button class='delete-btn' onclick='deleteSubject(" + i + ")'>Delete</button>" +

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
