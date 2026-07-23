/* ==========================================================================
   calendar.js
   Everything about the month grid inside a subject's detail view: building
   its HTML, moving between months, opening/closing a day's tap-popover, and
   marking (or bulk-marking) individual sessions.

   This imports render()/playSound()/showToast() from render.js, and
   render.js imports calendarView() (etc.) from here - that's a circular
   import. ES modules allow this as long as neither side calls the other's
   export while the modules are still being evaluated (only later, inside
   event handlers), which is the case here: render() is only ever invoked
   from inside functions like markSession(), never at the top level of this
   file. It also only works because those render.js exports are `function`
   declarations (hoisted), not `const` arrow functions - a `const` export
   referenced this way could still be in its temporal dead zone when this
   module first loads.
   ========================================================================== */

import {
  state, formatDate, isHoliday, isClassDay, sessionsForDay,
  getSessionStatus, save, pushUndoSnapshot
} from './state.js';
import { render, playSound, showToast } from './render.js';

/* ---------- Month navigation ---------- */
export function changeMonth(offset) {
  state.currentMonth += offset;
  if (state.currentMonth > 11) { state.currentMonth = 0; state.currentYear++; }
  if (state.currentMonth < 0) { state.currentMonth = 11; state.currentYear--; }
  state.activeDayKey = null;
  render();
}

/* ---------- Day-actions popover ---------- */
// A day cell's popover only opens/closes on tap - this has no animation of
// its own, so simply looking at a date never produces any visual "pop".
export function toggleDayActions(index, dateStr) {
  const key = index + "-" + dateStr;
  state.activeDayKey = (state.activeDayKey === key) ? null : key;
  render();
}

/* ---------- Attendance (session-aware) ---------- */
export function markSession(index, dateStr, sessionIndex, status) {
  if (isHoliday(dateStr)) return; // off-days aren't markable

  const key = index + "-" + dateStr;
  state.activeDayKey = null;

  if (status === "clear") {
    const arr = state.subjects[index].attendance[dateStr];
    if (arr) {
      arr[sessionIndex] = null;
      if (arr.every(s => !s)) delete state.subjects[index].attendance[dateStr];
    }
    save();
    render();
    return;
  }

  // Play the sound immediately, then let the mark animation run on the
  // still-visible cell before the re-render commits the final state.
  playSound(status);
  state.pendingAnim = { key: key, sessionIndex: sessionIndex, status: status };
  render();

  setTimeout(() => {
    if (!state.subjects[index].attendance[dateStr]) state.subjects[index].attendance[dateStr] = [];
    state.subjects[index].attendance[dateStr][sessionIndex] = status;
    state.pendingAnim = null;
    save();
    render();
  }, 340);
}

/* ---------- Bulk action: mark every unmarked session scheduled today as Present ---------- */
export function markAllToday() {
  if (isHoliday(state.todayString)) {
    showToast("Today is marked as a break");
    return;
  }

  const toMark = []; // { subjectIndex, sessionIndex }
  state.subjects.forEach((sub, i) => {
    const sessionsCount = sessionsForDay(sub, state.todayDayShort);
    for (let s = 0; s < sessionsCount; s++) {
      if (!getSessionStatus(sub, state.todayString, s)) toMark.push({ i, s });
    }
  });

  if (toMark.length === 0) {
    showToast("Nothing left to mark for today");
    return;
  }

  pushUndoSnapshot();
  toMark.forEach(({ i, s }) => {
    if (!state.subjects[i].attendance[state.todayString]) state.subjects[i].attendance[state.todayString] = [];
    state.subjects[i].attendance[state.todayString][s] = "present";
  });
  save();
  playSound("present");
  render();
  showToast(toMark.length + " session" + (toMark.length === 1 ? "" : "s") + " marked present", null, true);
}

/* ---------- Calendar grid (used only in detail view) ---------- */
export function calendarView(sub, index) {
  const firstDay = new Date(state.currentYear, state.currentMonth, 1).getDay();
  const daysInMonth = new Date(state.currentYear, state.currentMonth + 1, 0).getDate();

  let html = "";
  html += "<div class='month-nav'>";
  html += "<div class='month-label'>" +
    new Date(state.currentYear, state.currentMonth)
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
    const dateObj = new Date(state.currentYear, state.currentMonth, d);
    const dateStr = formatDate(dateObj);
    const key = index + "-" + dateStr;
    const dayShort = dateObj.toLocaleString("en-us", { weekday: "short" });
    const isClass = isClassDay(sub, dayShort);
    const sessionsCount = sessionsForDay(sub, dayShort);
    const isToday = (dateStr === state.todayString);
    const isActive = (state.activeDayKey === key);
    const holidayHit = isHoliday(dateStr);
    const gridColumn = dateObj.getDay(); // 0 = Sunday (leftmost column) ... 6 = Saturday (rightmost column)

    let classes = "day";
    if (isClass) classes += " has-class";
    if (isToday) classes += " today";
    if (isActive) classes += " active";
    if (gridColumn === 0) classes += " col-edge-left";
    if (gridColumn === 6) classes += " col-edge-right";

    // Work out the aggregate look of the cell across all of that day's sessions.
    // Semester-break days skip this entirely - they're never markable, and
    // any older attendance data on a break date is excluded from stats too.
    let counts = { present: 0, absent: 0, cancelled: 0, marked: 0 };
    if (!holidayHit) {
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
    } else {
      classes += " holiday";
    }

    const animMatchesThisDay = state.pendingAnim && state.pendingAnim.key === key;
    if (animMatchesThisDay) classes += " anim-" + state.pendingAnim.status;

    const clickAttr = (isClass && !holidayHit) ? " onclick=\"toggleDayActions(" + index + ",'" + dateStr + "')\"" : "";

    html += "<div class='" + classes + "' data-key='" + key + "'" + clickAttr + ">" + d;

    if (animMatchesThisDay && state.pendingAnim.status === "present") {
      html += "<svg class='check-draw' viewBox='0 0 24 24'><path d='M5 13l4 4 10-10'/></svg>";
    }

    if (!holidayHit && sessionsCount > 1 && counts.marked > 0 && counts.marked < sessionsCount) {
      html += "<span class='day-fraction'>" + counts.marked + "/" + sessionsCount + "</span>";
    }

    if (isClass && !holidayHit) {
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