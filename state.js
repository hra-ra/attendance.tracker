/* ==========================================================================
   state.js
   Shared application state, plus the pure data-model helpers and
   persistence functions that don't touch the DOM. Every other module reads
   and writes through the single `state` object exported here rather than
   holding its own copy, so there's one source of truth no matter which
   module a change comes from.

   Note on the pattern: `state` itself is a `const` - it's never reassigned,
   only its properties are mutated (e.g. `state.subjects = newArr`). That's
   what lets other modules mutate shared state without needing setter
   functions for everything: reassigning an *imported binding* directly
   (`import { subjects } from './state.js'; subjects = x;`) is a SyntaxError
   in ES modules, but mutating a property on an imported object is always
   fine.
   ========================================================================== */

export const DEFAULT_TARGET = 75;
export const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri"];

/* ---------- Date utility ---------- */
export function formatDate(d) {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return year + "-" + month + "-" + day;
}

const today = new Date();

export const state = {
  subjects: JSON.parse(localStorage.getItem("subjects")) || [],

  // Semester breaks / off-days: global date ranges that apply across all
  // subjects (exams, holidays, term breaks). Stored separately from
  // subjects since they aren't tied to any one class.
  holidays: JSON.parse(localStorage.getItem("holidays")) || [],

  editIndex: null,
  deleteIndex: null,

  currentMonth: today.getMonth(),
  currentYear: today.getFullYear(),

  today: today,
  todayString: formatDate(today),
  todayDayShort: today.toLocaleString("en-us", { weekday: "short" }),

  viewState: "list",        // "list" | "detail"
  listTab: "today",         // "today" | "all" - which list-view tab is active
  activeSubjectIndex: null, // which subject the detail view is showing
  activeDayKey: null,       // which day's tap-popover is open, e.g. "2-2026-07-15"
  pendingAnim: null,        // { key, sessionIndex, status } while a mark animation is playing
  modalDaySessions: { Mon: 1, Tue: 1, Wed: 1, Thu: 1, Fri: 1 }, // per-day session counts currently set in the modal

  // Generic undo buffer: a few destructive/bulk actions snapshot the whole
  // subjects array right before they run, so a toast can offer one-tap undo.
  undoSnapshot: null
};

/* ---------- Data migration ---------- */
// v1 data: attendance[dateStr] was a plain status string, sub.days was a
// plain array of strings, no sessions concept at all.
// v2 data: attendance[dateStr] became an array of per-session statuses, and
// a single subject-wide "sessions" count was added.
// v3 (current): sessions are per weekday, since a subject can meet twice on
// Monday and once every other day. sub.days becomes an array of
// { day: "Mon", sessions: 2 } objects. Every step below is safe to run
// again on already-migrated data, so nobody's saved attendance ever breaks.
export function normalizeSubjects() {
  state.subjects.forEach(sub => {
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
    if (typeof sub.target !== "number" || isNaN(sub.target)) {
      sub.target = DEFAULT_TARGET;
    }
  });
}
normalizeSubjects();

/* ---------- Per-day / per-session model helpers ---------- */
export function getDayEntry(sub, dayShort) {
  return sub.days.find(d => d.day === dayShort);
}

export function isClassDay(sub, dayShort) {
  return !!getDayEntry(sub, dayShort);
}

export function sessionsForDay(sub, dayShort) {
  const entry = getDayEntry(sub, dayShort);
  return entry ? entry.sessions : 0;
}

export function getSessionStatus(sub, dateStr, sessionIndex) {
  const arr = sub.attendance[dateStr];
  return (arr && arr[sessionIndex]) || null;
}

/* ---------- Persistence ---------- */
export function save() {
  localStorage.setItem("subjects", JSON.stringify(state.subjects));
}

export function saveHolidays() {
  localStorage.setItem("holidays", JSON.stringify(state.holidays));
}

/* ---------- Semester breaks / off-days ---------- */
export function isHoliday(dateStr) {
  return state.holidays.some(h => dateStr >= h.start && dateStr <= h.end);
}

export function holidayLabelFor(dateStr) {
  const h = state.holidays.find(h => dateStr >= h.start && dateStr <= h.end);
  return h ? h.label : null;
}

/* ---------- Sound mute persistence ---------- */
export function isMuted() {
  return localStorage.getItem("muted") === "true";
}

/* ---------- Undo (generic, snapshot-based) ---------- */
export function pushUndoSnapshot() {
  state.undoSnapshot = JSON.parse(JSON.stringify(state.subjects));
}