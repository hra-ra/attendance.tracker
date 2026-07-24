/* ==========================================================================
   scan.js
   Optional AI-assisted onboarding: photograph a timetable, send it to the
   Gemini API directly from the browser, and turn the structured JSON it
   returns into a reviewable list of subjects before anything touches
   state.subjects. Nothing here runs unless the person pastes their own
   Gemini API key - Bunkr stays a fully local-first, backend-free app
   either way; this is a convenience layered on top, not a dependency.

   Like calendar.js, this imports from render.js and is imported back by
   render.js - see the note in calendar.js for why that's safe here (every
   cross-imported render.js export is a hoisted `function` declaration, so
   the circular reference resolves fine at call time).
   ========================================================================== */

import { state, DEFAULT_TARGET, WEEKDAYS, save, pushUndoSnapshot, normalizeSubjects } from './state.js';
import { showToast, openSettings, closeSettings, setListTab } from './render.js';

const GEMINI_MODEL = "gemini-3.6-flash"; // change here if Google renames/retires this model again
const MAX_IMAGE_DIMENSION = 1600;        // downscale large camera photos before upload, for speed + payload size

let selectedImageBase64 = null;
let reviewSubjects = [];       // parsed + sanitized subjects, pending the person's review
let reviewRemoved = new Set(); // indices unchecked in the review list before committing

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

/* ---------- Scan modal ---------- */
export function openScanModal() {
  if (!getApiKey()) {
    showToast("Add your Gemini API key in Settings first", "error");
    openSettings();
    return;
  }
  selectedImageBase64 = null;
  document.getElementById("scanPreviewImg").style.display = "none";
  document.getElementById("scanDropLabel").style.display = "";
  document.getElementById("scanDropLabel").textContent = "Tap to choose a photo";
  setScanStatus("");
  document.getElementById("scanRunBtn").disabled = true;
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
      document.getElementById("scanRunBtn").disabled = false;
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

/* ---------- The Gemini request itself ---------- */
const SCAN_PROMPT = `You are analyzing a photo of a college class timetable/schedule grid.

Extract every distinct subject that appears, and for each one, list which weekdays it meets on (Monday through Friday only - ignore Saturday/Sunday) and how many separate time-slots/periods it occupies on each of those days.

Rules:
- Use short, clean subject names only (e.g. "Physics", "Physics Lab", "Data Structures"). Do NOT include professor names, room numbers, batch/section labels (like "Batch A1"), or building names in the subject name.
- If the same subject appears more than once on the same day in different periods, count that as multiple sessions for that day, not multiple entries.
- If a lab and its lecture are clearly different subjects (e.g. "Physics" vs "Physics Lab"), keep them separate. If two cells are just batch/section splits of the exact same session (e.g. "Physics Lab A1" and "Physics Lab A2" at the same time), treat that as ONE subject occurring once.
- Ignore weekend entries, free periods, lunch breaks, and any non-class rows or columns.
- Do not guess or invent anything not visible in the image. If the image doesn't look like a class timetable, or you can't confidently read it, return an empty array.

Return ONLY a JSON array matching the required schema - no markdown, no commentary.`;

const SCAN_RESPONSE_SCHEMA = {
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
      }
    },
    required: ["name", "days"]
  }
};

export function runScan() {
  if (!selectedImageBase64) return;
  const apiKey = getApiKey();
  if (!apiKey) {
    setScanStatus("No API key set - add one in Settings.", true);
    return;
  }

  document.getElementById("scanRunBtn").disabled = true;
  setScanStatus("Reading your timetable\u2026");

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

  fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": apiKey
    },
    body: JSON.stringify({
      contents: [{
        parts: [
          { text: SCAN_PROMPT },
          { inline_data: { mime_type: "image/jpeg", data: selectedImageBase64 } }
        ]
      }],
      generationConfig: {
        response_mime_type: "application/json",
        response_schema: SCAN_RESPONSE_SCHEMA
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

      const sanitized = sanitizeParsedSubjects(parsed);
      if (sanitized.length === 0) {
        throw new Error("No subjects found - try a clearer or more direct photo.");
      }

      closeScanModal();
      openReview(sanitized);
    })
    .catch(err => {
      setScanStatus(err.message || "Something went wrong.", true);
      document.getElementById("scanRunBtn").disabled = false;
    });
}

/* ---------- Sanitize whatever Gemini returned before it's ever shown ----------
   Never trust the model's output shape blindly, even with a response schema
   attached - this drops anything malformed rather than letting it corrupt
   state.subjects, and deliberately does NOT let the model set target%: that
   number isn't printed on any timetable, so it's not something worth asking
   an LLM to infer. Every imported subject starts at DEFAULT_TARGET and the
   person adjusts it afterward the normal way, same as any other subject. */
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
      attendance: {}
    });
  });
  return clean;
}

/* ---------- Review screen (nothing above this line ever touches state.subjects) ---------- */
function openReview(subjects) {
  reviewSubjects = subjects;
  reviewRemoved = new Set();
  renderReview();
  document.getElementById("reviewModal").classList.add("show");
}

export function cancelScanReview() {
  reviewSubjects = [];
  reviewRemoved = new Set();
  document.getElementById("reviewModal").classList.remove("show");
}

export function outsideClickReview(e) {
  if (e.target.id === "reviewModal") cancelScanReview();
}

export function toggleReviewItem(i) {
  if (reviewRemoved.has(i)) reviewRemoved.delete(i);
  else reviewRemoved.add(i);
  renderReview();
}

function renderReview() {
  const kept = reviewSubjects.length - reviewRemoved.size;

  document.getElementById("reviewSummary").textContent =
    "Found " + reviewSubjects.length + " subject" + (reviewSubjects.length === 1 ? "" : "s") +
    ". Uncheck anything that's wrong before adding - you can edit days, sessions, and target % afterward too.";

  document.getElementById("reviewList").innerHTML = reviewSubjects.map((sub, i) => {
    const removed = reviewRemoved.has(i);
    const dayLabel = sub.days.map(d => d.day + (d.sessions > 1 ? " \u00d7" + d.sessions : "")).join(", ");
    return "<label class='review-item" + (removed ? " removed" : "") + "'>" +
      "<input type='checkbox' " + (removed ? "" : "checked") + " onchange=\"toggleReviewItem(" + i + ")\">" +
      "<span class='review-item-text'><strong>" + sub.name + "</strong><br><small>" + dayLabel + "</small></span>" +
      "</label>";
  }).join("");

  const commitBtn = document.getElementById("reviewCommitBtn");
  commitBtn.textContent = "Add " + kept + " Subject" + (kept === 1 ? "" : "s");
  commitBtn.disabled = kept === 0;
}

export function commitScanResults() {
  const toAdd = reviewSubjects.filter((_, i) => !reviewRemoved.has(i));
  if (toAdd.length === 0) return;

  pushUndoSnapshot();
  state.subjects = [...state.subjects, ...toAdd];
  normalizeSubjects();
  save();

  document.getElementById("reviewModal").classList.remove("show");
  reviewSubjects = [];
  reviewRemoved = new Set();

  setListTab("all");
  showToast(toAdd.length + " subject" + (toAdd.length === 1 ? "" : "s") + " added", null, true);
}