/* ==========================================================================
   stats.js
   Pure, DOM-free calculations: attendance stats, the safe-to-skip math, the
   progress-ring markup, and streak text. Nothing here touches `document` or
   localStorage directly - every function takes what it needs as an argument
   (or reads it from state.js) and returns a value or an HTML string.
   ========================================================================== */

import { isHoliday, DEFAULT_TARGET } from './state.js';

export function stats(sub) {
  let present = 0, total = 0;
  for (let d in sub.attendance) {
    if (isHoliday(d)) continue;
    sub.attendance[d].forEach(status => {
      if (!status || status === "cancelled") return;
      total++;
      if (status === "present") present++;
    });
  }
  return { present, total };
}

export function circularProgress(percent, size, target) {
  size = size || 100;
  target = target || DEFAULT_TARGET;
  const strokeWidth = size <= 70 ? 6 : 8;
  const radius = size / 2 - strokeWidth - 2;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (percent / 100) * circumference;
  const c = size / 2;

  let colorClass = "ring-low";
  if (percent >= target) colorClass = "ring-high";
  else if (percent >= target - 10) colorClass = "ring-target";
  else if (percent >= target - 25) colorClass = "ring-mid";

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
export function streakText(sub) {
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
export function safeBunkChip(sub) {
  const target = sub.target || DEFAULT_TARGET;
  const s = stats(sub);
  if (s.total === 0) return "<span class='neutral'>No Data</span>";

  const currentPercent = (s.present / s.total) * 100;
  const t = target / 100;

  if (currentPercent < target) {
    // Smallest x such that (present + x) / (total + x) >= t
    // A tiny epsilon keeps floating-point rounding (e.g. 1 - 0.9 !== 0.1 exactly)
    // from pushing an exact boundary value up by one.
    const raw = (t * s.total - s.present) / (1 - t);
    const needed = Math.max(1, Math.ceil(raw - 1e-9));
    return "<span class='danger'>Attend " + needed + " more in a row</span>";
  }

  let canSkip = 0;
  while ((s.present / (s.total + canSkip)) * 100 >= target - 1e-9) {
    canSkip++;
  }
  canSkip = canSkip - 1;

  if (canSkip <= 0) return "<span class='warning'>On the edge</span>";
  if (canSkip === 1) return "<span class='safe'>Safe to Skip 1 Class</span>";
  return "<span class='safe'>Safe to Skip " + canSkip + " Classes</span>";
}