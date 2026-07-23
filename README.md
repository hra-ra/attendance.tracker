Bunkr 🕳️
Know exactly how many classes you can skip.
Bunkr is a zero-dependency, offline-first Progressive Web App (PWA) designed to track academic attendance and calculate the exact margin of classes a student can afford to miss without dropping below their target threshold.
Built entirely with Vanilla JavaScript, semantic HTML, and raw CSS, Bunkr focuses on delivering a native-app feel through a highly optimized, lightweight architecture.

Technical Highlights (Why this isn't just another To-Do app)
Zero Dependencies: No React, no Vue, no component libraries. The entire state management, DOM orchestration, and routing are custom-built using ES modules.
Web Audio API Synthesizer: Instead of shipping bloated audio files for UI feedback, Bunkr generates dynamic sine and triangle wave tones on the fly using the browser's native AudioContext.
Offline-First PWA: Fully installable with a custom Service Worker (service-worker.js) that utilizes a cache-first strategy, allowing the app to function flawlessly without an internet connection.
Custom UI/UX Orchestration: Features native-feeling interactions including touch-friendly bottom sheets, non-blocking toast notifications with undo capabilities, and CSS-animated SVG circular progress rings.
Non-Destructive Data Migration: The state manager (state.js) includes built-in normalization logic to seamlessly migrate users' local data structures across version updates without breaking their attendance history.

Features
The "Safe to Skip" Algorithm: Dynamically calculates the exact number of consecutive classes you need to attend (or can safely bunk) to maintain your target percentage.
Session-Aware Tracking: Supports multiple sessions of the same subject on a single day.
Semester Break Management: Excludes holidays and term breaks from the calendar and statistics.
Action History & Undo: Snapshot-based state recovery for bulk actions (like marking a whole day present) and deletions.
Ink & Paper Theming: Full Light/Dark mode support seamlessly integrated via CSS variables.
Data Portability: JSON-based export/import functionality to manually backup and restore state.

Tech Stack
Logic: Vanilla ES Modules (ES6+)
Styling: Raw CSS (CSS Variables, keyframe animations, flexbox/grid)
Storage: localStorage API
Audio: Native Web Audio API
Deployment: PWA-ready (manifest.json, Service Worker)

Architecture Overview
The codebase strictly separates concerns without relying on a framework:
state.js: The single source of truth. Handles data models, persistence, and schema migrations.
render.js: The DOM/UI orchestration layer. Listens to state changes and acts as the central dispatcher.
stats.js: Pure mathematical calculations for progress rings, streaks, and skip-margins.
calendar.js: Computes the month grid and handles complex, multi-session day popovers.

Local Setup
Because Bunkr is purely static and zero-dependency, there is no build step.
Clone the repository
Bash
git clone https://github.com/yourusername/bunkr.git
Serve the directory using any local HTTP server. For example, using Python:
Bash
python3 -m http.server 8000
Open http://localhost:8000 in your browser.
