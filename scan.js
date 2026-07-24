/* ==========================================================================
   scan.js
   Optional AI-assisted onboarding, now covering four combinations of the
   same idea: photo-or-text input, producing either subjects (from a
   timetable) or semester breaks (from an academic calendar). All four route
   through one shared Gemini-calling core (callGemini) so the prompt/schema
   is the only thing that differs between them.

   Nothing here runs unless the person pastes their own Gemini API key -
   Bunkr stays a fully local-first, backend-free app either way; this is a
   convenience layered on top, not a dependency.

   Like calendar.js, this imports from render.js and is imported back by
   render.js - see the note in calendar.js for why that's safe here (every
   cross-imported render.js export is a hoisted `function` declaration, so
   the circular reference resolves fine at call time).
   ========================================================================== */

import {
  state, DEFAULT_TARGET, WEEKDAYS, save, saveHolidays, pushUndoSnapshot, normalizeSubjects
} from './state.js';
import { showToast, openSettings, closeSettings, setListTab } from './render.js';

const GEMINI_MODEL = "gemini-3.6-flash"; // change here if Google renames/retires this model again
const MAX_IMAGE_DIMENSION = 1600;        // downscale large camera photos before upload, for speed + payload size
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

let selectedImageBase64 = null;
let scanInputMode = "photo";      // "photo" | "text" - which section of the Scan modal is active
let scanTargetMode = "timetable"; // "timetable" | "breaks" - what this scan run is trying to extract

// Review state. Each item is { data, matchIndex, action }. `matchIndex` is
// only meaningful in "timetable" mode (an existing subject with the same
// name, or -1). `action` is "add" | "merge" | "skip" for timetable items,
// or just "add" | "skip" for breaks.
let reviewMode = "timetable";
let reviewItems = [];

/* ---------- Tiny HTML-escaping helper ----------
   Subject names, notes, and break labels can come from a person typing
   freely OR from whatever an LLM decides to output - neither is safe to
   drop straight into innerHTML. Everything user- or model-supplied that
   gets rendered in the review list goes through this first. */
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/* ---------- API key storage ---------- */
// The key lives only in this browser's localStorage. It's read here and
// attached directly to a request that goes straight from this browser to
// Google's endpoint - it never passes through any server Bunkr controls,
// because there isn't one.
function getApiKey() {
  return (localStorage.getItem("geminiApiKey") || "").trim();
}

export function openApiKeyModal() {
  closeSettings();
  document.getElementById("apiKeyInput").value = getApiKey();
  document.getElementById("apiKeyModal").classList.add("show");
}

export function closeApiKeyModal() {
  document.getElementById("apiKeyModal").classList.remove("show");
}

export function outsideClickApiKey(e) {
  if (e.target.id === "apiKeyModal") closeApiKeyModal();
}

export function saveApiKey() {
  const key = document.getElementById("apiKeyInput").value.trim();
  if (!key) {
    localStorage.removeItem("geminiApiKey");
    showToast("API key cleared");
  } else {
    localStorage.setItem("geminiApiKey", key);
    showToast("API key saved");
  }
  closeApiKeyModal();
}

/* ---------- Scan modal ----------
   targetMode is passed in by whoever opens the modal: the camera FAB opens
   it as 'timetable', the "Scan Academic Calendar" button in the Semester
   Breaks modal opens the exact same modal as 'breaks'. Same UI, same
   pipeline, different prompt/schema/commit-target under the hood. */
export function openScanModal(targetMode) {
  scanTargetMode = targetMode || "timetable";

  if (!getApiKey()) {
    showToast("Add your Gemini API key in Settings first", "error");
    openSettings();
    return;
  }

  selectedImageBase64 = null;
  document.getElementById("scanPreviewImg").style.display = "none";
  document.getElementById("scanDropLabel").style.display = "";
  document.getElementById("scanDropLabel").textContent = "Tap to choose a photo";
  document.getElementById("scanTextInput").value = "";
  setScanInputMode("photo");
  setScanStatus("");

  document.getElementById("scanModalTitle").textContent =
    scanTargetMode === "breaks" ? "Scan Academic Calendar" : "Scan Timetable";
  document.getElementById("scanModalHint").textContent =
    scanTargetMode === "breaks"
      ? "Photo or describe your college's academic calendar. Gemini finds the semester breaks - nothing is added until you review."
      : "Take or upload a photo of your timetable, or describe it in words instead. Gemini reads it and lists the subjects it finds - nothing is added until you review.";

  document.getElementById("scanModal").classList.add("show");
}

export function closeScanModal() {
  document.getElementById("scanModal").classList.remove("show");
}

export function outsideClickScan(e) {
  if (e.target.id === "scanModal") closeScanModal();
}

function setScanStatus(message, isError) {
  const el = document.getElementById("scanStatus");
  el.textContent = message;
  el.className = "scan-status" + (message ? " show" : "") + (isError ? " error" : "");
}

/* ---------- Photo vs. text input toggle ---------- */
export function setScanInputMode(mode) {
  scanInputMode = mode;
  document.getElementById("scanTabPhoto").classList.toggle("active", mode === "photo");
  document.getElementById("scanTabText").classList.toggle("active", mode === "text");
  document.getElementById("scanPhotoSection").style.display = mode === "photo" ? "" : "none";
  document.getElementById("scanTextSection").style.display = mode === "text" ? "" : "none";
  updateScanRunButton();
}

export function validateScanTextInput() {
  updateScanRunButton();
}

function updateScanRunButton() {
  const btn = document.getElementById("scanRunBtn");
  if (scanInputMode === "photo") {
    btn.textContent = "Scan";
    btn.disabled = !selectedImageBase64;
  } else {
    btn.textContent = "Parse Text";
    btn.disabled = document.getElementById("scanTextInput").value.trim().length === 0;
  }
}

/* ---------- Image selection + downscale ---------- */
export function handleScanFileSelect(event) {
  const file = event.target.files[0];
  if (!file) return;

  setScanStatus("");
  resizeImageToBase64(file, MAX_IMAGE_DIMENSION)
    .then(base64 => {
      selectedImageBase64 = base64;
      const img = document.getElementById("scanPreviewImg");
      img.src = "data:image/jpeg;base64," + base64;
      img.style.display = "";
      document.getElementById("scanDropLabel").style.display = "none";
      updateScanRunButton();
    })
    .catch(() => {
      setScanStatus("Couldn't read that image - try a different photo.", true);
    });
}

function resizeImageToBase64(file, maxDim) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("file read failed"));
    reader.onload = e => {
      const img = new Image();
      img.onerror = () => reject(new Error("image decode failed"));
      img.onload = () => {
        let { width, height } = img;
        if (width > maxDim || height > maxDim) {
          if (width > height) {
            height = Math.round((height * maxDim) / width);
            width = maxDim;
          } else {
            width = Math.round((width * maxDim) / height);
            height = maxDim;
          }
        }
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        canvas.getContext("2d").drawImage(img, 0, 0, width, height);
        const dataUrl = canvas.toDataURL("image/jpeg", 0.85);
        resolve(dataUrl.split(",")[1]); // strip the "data:image/jpeg;base64," prefix
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  });
}

/* ---------- Prompts + schemas ----------
   Every prompt asks for an optional "note" field per item - a short string
   the model fills in only when it's genuinely unsure about something (a
   smudged cell, an ambiguous session count, a date it had to infer). Left
   out entirely when the model is confident. That note gets shown right in
   the review list rather than silently discarded, so a shaky guess is
   visibly flagged instead of looking exactly as certain as everything else. */
const SUBJECT_RULES = `Rules:
- Use short, clean subject names only (e.g. "Physics", "Physics Lab", "Data Structures"). Do NOT include professor names, room numbers, batch/section labels (like "Batch A1"), or building names in the subject name.
- If the same subject appears more than once on the same day in different periods, count that as multiple sessions for that day, not multiple entries.
- If a lab and its lecture are clearly different subjects (e.g. "Physics" vs "Physics Lab"), keep them separate. If two cells are just batch/section splits of the exact same session (e.g. "Physics Lab A1" and "Physics Lab A2" at the same time), treat that as ONE subject occurring once.
- Only include Monday through Friday. Ignore weekend entries, free periods, lunch breaks, and any non-class rows or columns.
- If you're not fully confident about a subject's schedule (a smudged or ambiguous cell, an unclear session count, etc.), include a brief "note" explaining what's uncertain. Omit "note" entirely when you're confident.
- Do not guess or invent anything not stated or shown. If nothing usable is present, return an empty array.

Return ONLY a JSON array matching the required schema - no markdown, no commentary.`;

const SUBJECT_RESPONSE_SCHEMA = {
  type: "ARRAY",
  items: {
    type: "OBJECT",
    properties: {
      name: { type: "STRING" },
      days: {
        type: "ARRAY",
        items: {
          type: "OBJECT",
          properties: {
            day: { type: "STRING", enum: ["Mon", "Tue", "Wed", "Thu", "Fri"] },
            sessions: { type: "INTEGER" }
          },
          required: ["day", "sessions"]
        }
      },
      note: { type: "STRING" }
    },
    required: ["name", "days"]
  }
};

const BREAKS_RULES = `Rules:
- Only include multi-day breaks or single holidays that mean there are NO classes. Skip exam periods unless they're explicitly marked as a break from classes too.
- Give each one a short, clear label (e.g. "Diwali Break", "Mid-Sem Break", "Republic Day").
- Dates must be in YYYY-MM-DD format. If a year isn't shown, infer it from context if you reasonably can; otherwise skip that entry rather than guessing.
- If you're unsure about an exact date, include a brief "note" explaining what's uncertain. Omit "note" entirely when you're confident.
- Do not guess or invent anything not stated or shown. If nothing usable is present, return an empty array.

Return ONLY a JSON array matching the required schema - no markdown, no commentary.`;

const BREAKS_RESPONSE_SCHEMA = {
  type: "ARRAY",
  items: {
    type: "OBJECT",
    properties: {
      label: { type: "STRING" },
      start: { type: "STRING" },
      end: { type: "STRING" },
      note: { type: "STRING" }
    },
    required: ["label", "start", "end"]
  }
};

function buildPrompt(userText) {
  if (scanTargetMode === "breaks") {
    const intro = userText
      ? `You are converting a plain-language description of a college academic calendar into a list of semester breaks/holidays.\n\nDescription:\n"""\n${userText}\n"""\n`
      : `You are analyzing a photo of a college academic calendar or holiday notice.\n\nExtract every semester break, holiday, or no-class period listed, with its date range.\n`;
    return intro + "\n" + BREAKS_RULES;
  }

  const intro = userText
    ? `You are converting a plain-language description of a college class schedule into structured data.\n\nDescription:\n"""\n${userText}\n"""\n`
    : `You are analyzing a photo of a college class timetable/schedule grid.\n\nExtract every distinct subject that appears, and for each one, list which weekdays it meets on and how many separate time-slots/periods it occupies on each of those days.\n`;
  return intro + "\n" + SUBJECT_RULES;
}

function currentSchema() {
  return scanTargetMode === "breaks" ? BREAKS_RESPONSE_SCHEMA : SUBJECT_RESPONSE_SCHEMA;
}

/* ---------- The shared Gemini-calling core ----------
   Every one of the four scan flavors (photo/text x timetable/breaks) funnels
   through this. It never trusts the raw HTTP status or shape - a non-2xx
   response, an empty candidate, or a body that isn't valid JSON all reject
   with a message meant to be shown directly to the person, not a stack trace. */
function callGemini(parts, schema) {
  const apiKey = getApiKey();
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

  return fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": apiKey
    },
    body: JSON.stringify({
      contents: [{ parts }],
      generationConfig: {
        response_mime_type: "application/json",
        response_schema: schema
      }
    })
  })
    .then(res => {
      if (!res.ok) {
        if (res.status === 400 || res.status === 403) {
          throw new Error("Your API key looks invalid, or doesn't have access to this model.");
        }
        if (res.status === 429) {
          throw new Error("Rate limit hit - wait a moment and try again.");
        }
        throw new Error("Gemini couldn't process that request (HTTP " + res.status + ").");
      }
      return res.json();
    })
    .then(data => {
      const text = data.candidates
        && data.candidates[0]
        && data.candidates[0].content
        && data.candidates[0].content.parts
        && data.candidates[0].content.parts[0]
        && data.candidates[0].content.parts[0].text;

      if (!text) throw new Error("Gemini returned an empty response.");

      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch (e) {
        throw new Error("Couldn't parse Gemini's response as JSON.");
      }
      if (!Array.isArray(parsed)) throw new Error("Unexpected response shape from Gemini.");
      return parsed;
    });
}

/* ---------- Kick off a scan/parse run from whichever input tab is active ---------- */
export function runScanAction() {
  if (scanInputMode === "photo") {
    if (!selectedImageBase64) return;
    runGeminiRequest([
      { text: buildPrompt() },
      { inline_data: { mime_type: "image/jpeg", data: selectedImageBase64 } }
    ], scanTargetMode === "breaks" ? "Reading the calendar\u2026" : "Reading your timetable\u2026");
  } else {
    const text = document.getElementById("scanTextInput").value.trim();
    if (!text) return;
    runGeminiRequest([{ text: buildPrompt(text) }], "Reading your description\u2026");
  }
}

function runGeminiRequest(parts, statusMsg) {
  if (!getApiKey()) {
    setScanStatus("No API key set - add one in Settings.", true);
    return;
  }

  document.getElementById("scanRunBtn").disabled = true;
  setScanStatus(statusMsg);

  callGemini(parts, currentSchema())
    .then(parsed => {
      if (scanTargetMode === "breaks") {
        const clean = sanitizeParsedBreaks(parsed);
        if (clean.length === 0) throw new Error("No breaks found - try a clearer photo or more detail.");
        closeScanModal();
        openReview("breaks", clean);
      } else {
        const clean = sanitizeParsedSubjects(parsed);
        if (clean.length === 0) throw new Error("No subjects found - try a clearer photo or more detail.");
        closeScanModal();
        openReview("timetable", clean);
      }
    })
    .catch(err => {
      setScanStatus(err.message || "Something went wrong.", true);
      document.getElementById("scanRunBtn").disabled = false;
    });
}

/* ---------- Sanitize whatever Gemini returned before it's ever shown ----------
   Never trust the model's output shape blindly, even with a response schema
   attached - this drops anything malformed rather than letting it corrupt
   state, and deliberately does NOT let the model set a subject's target%:
   that number isn't printed on any timetable, so it's not something worth
   asking an LLM to infer. Every imported subject starts at DEFAULT_TARGET
   and the person adjusts it afterward the normal way. */
function sanitizeParsedSubjects(parsed) {
  const clean = [];
  parsed.forEach(item => {
    if (!item || typeof item.name !== "string" || !item.name.trim()) return;
    if (!Array.isArray(item.days)) return;

    const days = item.days
      .filter(d => d && WEEKDAYS.includes(d.day))
      .map(d => ({
        day: d.day,
        sessions: Math.max(1, Math.min(6, parseInt(d.sessions, 10) || 1))
      }));

    if (days.length === 0) return;

    clean.push({
      name: item.name.trim().slice(0, 60),
      days,
      target: DEFAULT_TARGET,
      attendance: {},
      note: (typeof item.note === "string" && item.note.trim()) ? item.note.trim().slice(0, 140) : null
    });
  });
  return clean;
}

function sanitizeParsedBreaks(parsed) {
  const clean = [];
  parsed.forEach(item => {
    if (!item || typeof item.label !== "string" || !item.label.trim()) return;
    if (typeof item.start !== "string" || !DATE_RE.test(item.start)) return;

    const start = item.start;
    let end = (typeof item.end === "string" && DATE_RE.test(item.end)) ? item.end : start;
    if (end < start) end = start; // nonsensical range - clamp to a single valid day rather than guess

    clean.push({
      label: item.label.trim().slice(0, 60),
      start,
      end,
      note: (typeof item.note === "string" && item.note.trim()) ? item.note.trim().slice(0, 140) : null
    });
  });
  return clean;
}

/* ---------- Matching against subjects that already exist ----------
   Powers the merge-on-rescan flow: re-scanning a revised timetable
   shouldn't just pile up duplicate subjects next to the ones already
   tracked all semester. Matching is deliberately simple (trimmed,
   case-insensitive name equality) rather than fuzzy - a plain, predictable
   rule the person can reason about beats a clever one that silently merges
   two subjects that just happen to sound similar. */
function findExistingSubjectIndex(name) {
  const key = name.trim().toLowerCase();
  return state.subjects.findIndex(s => s.name.trim().toLowerCase() === key);
}

/* ---------- Review screen (nothing above this line ever touches state) ---------- */
function openReview(mode, items) {
  reviewMode = mode;
  reviewItems = items.map(data => {
    const matchIndex = mode === "timetable" ? findExistingSubjectIndex(data.name) : -1;
    return { data, matchIndex, action: matchIndex >= 0 ? "merge" : "add" };
  });
  renderReview();
  document.getElementById("reviewModal").classList.add("show");
}

function closeReviewModal() {
  reviewItems = [];
  document.getElementById("reviewModal").classList.remove("show");
}

export function cancelScanReview() {
  closeReviewModal();
}

export function outsideClickReview(e) {
  if (e.target.id === "reviewModal") cancelScanReview();
}

export function setReviewAction(i, action) {
  reviewItems[i].action = action;
  renderReview();
}

function renderReview() {
  const kept = reviewItems.filter(it => it.action !== "skip").length;
  const noun = reviewMode === "timetable" ? "subject" : "break";

  document.getElementById("reviewSummary").textContent = reviewMode === "timetable"
    ? "Found " + reviewItems.length + " subject" + (reviewItems.length === 1 ? "" : "s") +
      ". Review each one - anything matching an existing subject's name defaults to merging its schedule in, rather than creating a duplicate."
    : "Found " + reviewItems.length + " break" + (reviewItems.length === 1 ? "" : "s") +
      ". Uncheck anything that's wrong before adding.";

  document.getElementById("reviewList").innerHTML = reviewItems.map((item, i) => {
    const noteHtml = item.data.note
      ? "<div class='review-note'>\u26A0 " + escapeHtml(item.data.note) + "</div>"
      : "";

    if (reviewMode === "timetable") {
      const dayLabel = item.data.days.map(d => d.day + (d.sessions > 1 ? " \u00d7" + d.sessions : "")).join(", ");
      const matched = item.matchIndex >= 0;
      const options = matched
        ? [["merge", "Merge into existing"], ["add", "Add as new"], ["skip", "Skip"]]
        : [["add", "Add"], ["skip", "Skip"]];

      const selectHtml = "<select onchange=\"setReviewAction(" + i + ", this.value)\">" +
        options.map(([value, label]) =>
          "<option value='" + value + "'" + (item.action === value ? " selected" : "") + ">" + label + "</option>"
        ).join("") +
        "</select>";

      return "<div class='review-item" + (item.action === "skip" ? " removed" : "") + "'>" +
        "<div class='review-item-text'><strong>" + escapeHtml(item.data.name) + "</strong>" +
        (matched ? " <span class='review-match-badge'>matches existing</span>" : "") +
        "<br><small>" + escapeHtml(dayLabel) + "</small>" + noteHtml + "</div>" +
        selectHtml +
        "</div>";
    }

    // breaks mode - simpler, just add/skip
    const range = item.data.start === item.data.end ? item.data.start : (item.data.start + " \u2192 " + item.data.end);
    return "<label class='review-item" + (item.action === "skip" ? " removed" : "") + "'>" +
      "<input type='checkbox' " + (item.action === "skip" ? "" : "checked") +
      " onchange=\"setReviewAction(" + i + ", this.checked ? 'add' : 'skip')\">" +
      "<span class='review-item-text'><strong>" + escapeHtml(item.data.label) + "</strong><br><small>" + range + "</small>" + noteHtml + "</span>" +
      "</label>";
  }).join("");

  const commitBtn = document.getElementById("reviewCommitBtn");
  commitBtn.textContent = "Add " + kept + " " + noun.charAt(0).toUpperCase() + noun.slice(1) + (kept === 1 ? "" : "s");
  commitBtn.disabled = kept === 0;
}

export function commitScanResults() {
  if (reviewMode === "timetable") commitSubjects();
  else commitBreaks();
}

function commitSubjects() {
  const toAdd = reviewItems.filter(it => it.action === "add").map(it => it.data);
  const toMerge = reviewItems.filter(it => it.action === "merge");

  if (toAdd.length === 0 && toMerge.length === 0) return;

  pushUndoSnapshot();
  // Merging only replaces the schedule (days/sessions) on the existing
  // subject - its name, target%, and all recorded attendance history stay
  // exactly as they were. Re-scanning a revised timetable shouldn't ever
  // reset a semester's worth of tracked data.
  toMerge.forEach(it => {
    state.subjects[it.matchIndex].days = it.data.days;
  });
  state.subjects = [...state.subjects, ...toAdd];
  normalizeSubjects();
  save();

  closeReviewModal();
  setListTab("all");

  const parts = [];
  if (toAdd.length) parts.push(toAdd.length + " added");
  if (toMerge.length) parts.push(toMerge.length + " updated");
  showToast(parts.join(", "), null, true);
}

function commitBreaks() {
  const toAdd = reviewItems.filter(it => it.action === "add").map(it => ({
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    label: it.data.label,
    start: it.data.start,
    end: it.data.end
  }));
  if (toAdd.length === 0) return;

  pushUndoSnapshot();
  state.holidays = [...state.holidays, ...toAdd];
  saveHolidays();

  closeReviewModal();
  showToast(toAdd.length + " break" + (toAdd.length === 1 ? "" : "s") + " added", null, true);
}