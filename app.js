"use strict";

const STORAGE_KEY = "martini:v1";
const DISPLAY_QUEUE_SIZE = 4;
const ACTIVE_QUEUE_SIZE = 2;
const UNDO_WINDOW_MS = 5000;
const OVER_WARN_THRESHOLD_MIN = 2;

const dom = {};
const state = createDefaultState();
let now = new Date();
let isLiveHardWrapEditing = false;

document.addEventListener("DOMContentLoaded", init);

function init() {
  cacheDom();
  restoreState();
  bindEvents();
  seedHardWrapInput();
  tick();
  window.setInterval(tick, 1000);
  window.addEventListener("resize", syncLayoutChrome);
  registerServiceWorker();
}

function createDefaultState() {
  return {
    version: 4,
    fileName: "",
    draftHardWrapTime: "",
    startedAt: "",
    hardWrapAt: "",
    activeShotId: "",
    shots: [],
    extraShots: [],
    lastActionAt: "",
    // lastUndo is transient — never persisted
  };
}

function cacheDom() {
  const ids = [
    "appShell",
    "topShell",
    "alertBanner",
    "currentTime",
    "dayStatus",
    "loadedFileName",
    "paceIndicatorDisplay",
    "hardWrapCard",
    "hardWrapEditButton",
    "hardWrapEditHint",
    "hardWrapDisplay",
    "liveHardWrapEditor",
    "liveHardWrapInput",
    "liveHardWrapDoneButton",
    "forecastWrapDisplay",
    "paceStatusDisplay",
    "requiredRemainingDisplay",
    "setupPanel",
    "trackerPanel",
    "csvInput",
    "importSummary",
    "hardWrapInput",
    "startDayButton",
    "resetButton",
    "liveResetButton",
    "exportButton",
    "currentShotPanel",
    "currentShotTitle",
    "currentShotBadges",
    "currentShotScene",
    "currentShotLabel",
    "currentShotMinutes",
    "currentShotLive",
    "currentShotDeadline",
    "upNextList",
    "morePendingPanel",
    "morePendingList",
    "lastActionText",
    "doneCount",
    "skippedCount",
    "extraShotCount",
    "totalShotCount",
    "doneButton",
    "skipButton",
    "addShotButton",
    "actionBar",
    "undoToast",
    "undoToastText",
    "undoToastButton",
  ];

  ids.forEach((id) => {
    dom[id] = document.getElementById(id);
  });
}

function bindEvents() {
  dom.csvInput.addEventListener("change", handleCsvFile);
  dom.hardWrapInput.addEventListener("change", handleHardWrapChange);
  dom.hardWrapEditButton.addEventListener("click", openLiveHardWrapEditor);
  dom.liveHardWrapInput.addEventListener("change", handleHardWrapChange);
  dom.liveHardWrapInput.addEventListener("keydown", handleLiveHardWrapKeydown);
  dom.liveHardWrapDoneButton.addEventListener("click", closeLiveHardWrapEditor);
  dom.startDayButton.addEventListener("click", startDay);
  dom.doneButton.addEventListener("click", () => resolveCurrentShot("done"));
  dom.skipButton.addEventListener("click", () => resolveCurrentShot("skipped"));
  dom.addShotButton.addEventListener("click", addExtraShot);
  dom.resetButton.addEventListener("click", resetDay);
  dom.liveResetButton.addEventListener("click", resetDay);
  dom.exportButton.addEventListener("click", exportDayLog);
  dom.undoToastButton.addEventListener("click", undoLastResolution);
}

function handleHardWrapChange(event) {
  const nextValue = event.target.value || "";
  if (!nextValue) {
    if (event.target === dom.liveHardWrapInput) {
      closeLiveHardWrapEditor();
    } else {
      state.draftHardWrapTime = "";
      persistState();
      render();
    }
    return;
  }

  applyHardWrapValue(nextValue, { closeEditor: event.target === dom.liveHardWrapInput });
}

async function handleCsvFile(event) {
  const [file] = event.target.files || [];
  if (!file) {
    return;
  }

  try {
    const text = await file.text();
    const parsedShots = parseShotCsv(text);

    state.fileName = file.name;
    state.shots = parsedShots;
    state.extraShots = [];
    state.lastActionAt = "";
    state.startedAt = "";
    state.hardWrapAt = "";
    state.activeShotId = parsedShots[0] ? parsedShots[0].id : "";
    state.lastUndo = null;
    isLiveHardWrapEditing = false;

    if (!state.draftHardWrapTime) {
      state.draftHardWrapTime = getRoundedFutureTime(12);
    }

    persistState();
    seedHardWrapInput();
    render();
  } catch (error) {
    window.alert(error.message);
    dom.csvInput.value = "";
  }
}

function startDay() {
  if (!state.shots.length) {
    window.alert("Import a CSV shot list before starting the day.");
    return;
  }

  const hardWrapValue = dom.hardWrapInput.value;
  if (!hardWrapValue) {
    window.alert("Set a hard wrap time before starting.");
    return;
  }

  now = new Date();
  state.startedAt = now.toISOString();
  state.hardWrapAt = composeFutureDateFromTime(now, hardWrapValue).toISOString();
  state.lastActionAt = state.startedAt;
  state.lastUndo = null;
  isLiveHardWrapEditing = false;
  setActiveShot(state.activeShotId);

  persistState();
  render();
}

function resolveCurrentShot(nextStatus) {
  const currentShot = getActiveShot();
  if (!currentShot || !state.startedAt) {
    return;
  }

  const wasLastRequired = nextStatus === "done" && isLastRequiredShot(currentShot);
  const stamp = new Date().toISOString();

  // Snapshot for undo BEFORE mutating
  state.lastUndo = {
    shotId: currentShot.id,
    prevStatus: currentShot.status,
    prevResolvedAt: currentShot.resolvedAt,
    prevDoneAt: currentShot.doneAt,
    prevSkippedAt: currentShot.skippedAt,
    prevStartedAt: currentShot.startedAt,
    prevActiveShotId: state.activeShotId,
    prevLastActionAt: state.lastActionAt,
    expiresAt: Date.now() + UNDO_WINDOW_MS,
    action: nextStatus,
    wasLastRequired,
  };

  currentShot.status = nextStatus;
  currentShot.resolvedAt = stamp;
  currentShot.doneAt = nextStatus === "done" ? stamp : "";
  currentShot.skippedAt = nextStatus === "skipped" ? stamp : "";
  state.lastActionAt = stamp;
  state.activeShotId = getNextPendingShotId(currentShot.id);

  persistState();
  render();

  if (wasLastRequired) {
    playMartiniClink();
  }
}

function undoLastResolution() {
  const u = state.lastUndo;
  if (!u || Date.now() > u.expiresAt) {
    state.lastUndo = null;
    render();
    return;
  }

  const shot = state.shots.find((s) => s.id === u.shotId);
  if (!shot) {
    state.lastUndo = null;
    render();
    return;
  }

  shot.status = u.prevStatus;
  shot.resolvedAt = u.prevResolvedAt || "";
  shot.doneAt = u.prevDoneAt || "";
  shot.skippedAt = u.prevSkippedAt || "";
  shot.startedAt = u.prevStartedAt || "";
  state.activeShotId = u.prevActiveShotId || shot.id;
  state.lastActionAt = u.prevLastActionAt || "";
  state.lastUndo = null;

  persistState();
  render();
}

function isLastRequiredShot(shot) {
  if (shot.priority !== 1) {
    return false;
  }

  const remainingRequired = state.shots.filter(
    (s) => s.priority === 1 && s.status === "pending" && s.id !== shot.id
  );

  return remainingRequired.length === 0;
}

// ── MARTINI GLASS CLINK — Web Audio API, no assets ──
function playMartiniClink() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();

    function strike(freq, startTime, duration, gain) {
      const osc = ctx.createOscillator();
      const env = ctx.createGain();

      osc.type = "sine";
      osc.frequency.setValueAtTime(freq, startTime);
      osc.frequency.exponentialRampToValueAtTime(freq * 0.995, startTime + duration);

      env.gain.setValueAtTime(0, startTime);
      env.gain.linearRampToValueAtTime(gain, startTime + 0.004);
      env.gain.exponentialRampToValueAtTime(0.0001, startTime + duration);

      osc.connect(env);
      env.connect(ctx.destination);

      osc.start(startTime);
      osc.stop(startTime + duration);
    }

    const t = ctx.currentTime;
    // Fundamental + harmonics for a crystal glass ring
    strike(1318, t, 2.2, 0.28);        // E6 — primary ring
    strike(2637, t + 0.005, 1.6, 0.14); // E7 — shimmer
    strike(1976, t + 0.002, 1.8, 0.10); // B6 — body
    strike(3520, t + 0.008, 1.0, 0.06); // A7 — sparkle

    // Close context after sound completes
    setTimeout(() => ctx.close(), 2800);
  } catch (error) {
    // Silently fail on browsers that block audio
  }
}

function addExtraShot() {
  if (!state.startedAt) {
    return;
  }

  const stamp = new Date().toISOString();
  state.extraShots.push({
    id: `extra-${stamp}`,
    timestamp: stamp,
  });
  state.lastActionAt = stamp;

  persistState();
  render();
}

function resetDay() {
  const hasWork =
    state.shots.some((s) => s.status !== "pending") ||
    state.extraShots.length > 0;

  if (hasWork) {
    const exportFirst = window.confirm(
      "Export today's log as CSV before clearing? (Cancel skips export.)"
    );
    if (exportFirst) {
      exportDayLog();
    }
  }

  if (!window.confirm("Clear the current MARTINI day and shot list?")) {
    return;
  }

  Object.assign(state, createDefaultState());
  isLiveHardWrapEditing = false;
  dom.csvInput.value = "";
  seedHardWrapInput(true);
  persistState();
  render();
}

// ── CSV EXPORT ──
function exportDayLog() {
  const header = [
    "id",
    "scene",
    "label",
    "planned_minutes",
    "priority",
    "status",
    "started_at",
    "resolved_at",
    "deadline_tag",
  ].join(",");

  const plannedRows = state.shots.map((s) =>
    [
      s.id,
      s.scene,
      s.label,
      s.plannedMinutes,
      s.priority,
      s.status,
      s.startedAt || "",
      s.resolvedAt || "",
      s.deadlineTag || "",
    ]
      .map(csvEscape)
      .join(",")
  );

  const extraRows = state.extraShots.map((e, i) =>
    [
      `extra-${i + 1}`,
      "",
      "+1 pickup",
      "",
      "",
      "extra",
      "",
      e.timestamp,
      "",
    ]
      .map(csvEscape)
      .join(",")
  );

  const csv = [header, ...plannedRows, ...extraRows].join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);

  const stamp = new Date().toISOString().slice(0, 10);
  const baseName =
    (state.fileName || "day").replace(/\.csv$/i, "").replace(/[^a-z0-9_-]+/gi, "-") || "day";
  const filename = `martini-log-${baseName}-${stamp}.csv`;

  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function csvEscape(value) {
  const s = String(value ?? "");
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function tick() {
  now = new Date();

  // Auto-expire undo window
  if (state.lastUndo && Date.now() > state.lastUndo.expiresAt) {
    state.lastUndo = null;
  }

  render();
}

function render() {
  if (syncActiveShotSelection()) {
    persistState();
  }

  // Stamp active shot's startedAt lazily here so tick catches it too
  stampActiveShotStartedAt();

  const metrics = computeMetrics();
  const alert = pickTopAlert(metrics);
  const stateIndicator = getStateIndicator(metrics);
  const canEditHardWrap = Boolean(state.startedAt);

  if (!canEditHardWrap && isLiveHardWrapEditing) {
    isLiveHardWrapEditing = false;
  }

  dom.appShell.classList.toggle("live-mode", Boolean(state.startedAt));
  dom.appShell.classList.toggle("setup-mode", !state.startedAt);
  dom.currentTime.textContent = formatTime(now);
  dom.loadedFileName.textContent = state.fileName || "No shot list loaded";
  dom.loadedFileName.hidden = Boolean(state.startedAt);
  dom.dayStatus.textContent = state.startedAt
    ? `Started ${formatTime(new Date(state.startedAt), true)}`
    : "Waiting to start";
  dom.paceIndicatorDisplay.textContent = stateIndicator.label;
  dom.paceIndicatorDisplay.className = `state-indicator ${stateIndicator.className}`;

  dom.hardWrapCard.classList.toggle("is-editable", canEditHardWrap);
  dom.hardWrapCard.classList.toggle("is-editing", canEditHardWrap && isLiveHardWrapEditing);
  dom.hardWrapEditButton.tabIndex = canEditHardWrap ? 0 : -1;
  dom.hardWrapEditButton.setAttribute("aria-disabled", String(!canEditHardWrap));
  dom.hardWrapEditHint.hidden = !canEditHardWrap;
  dom.liveHardWrapEditor.hidden = !canEditHardWrap || !isLiveHardWrapEditing;
  if (document.activeElement !== dom.liveHardWrapInput) {
    dom.liveHardWrapInput.value = getEditableHardWrapInputValue();
  }
  dom.hardWrapDisplay.textContent = getHardWrapDisplayText();
  dom.forecastWrapDisplay.textContent = metrics.forecastWrapAt
    ? formatTime(metrics.forecastWrapAt, true)
    : "--";
  dom.paceStatusDisplay.textContent = metrics.paceStatus;
  dom.requiredRemainingDisplay.textContent = String(metrics.requiredRemainingCount);
  dom.importSummary.textContent = state.shots.length
    ? `${state.shots.length} shots loaded`
    : "Choose a CSV file";

  dom.alertBanner.textContent = alert.message;
  dom.alertBanner.className = `alert-banner ${alert.className}`;

  dom.setupPanel.hidden = Boolean(state.startedAt);
  dom.liveResetButton.hidden = !state.startedAt;
  dom.doneCount.textContent = String(metrics.doneCount);
  dom.skippedCount.textContent = String(metrics.skippedCount);
  dom.extraShotCount.textContent = String(state.extraShots.length);
  dom.totalShotCount.textContent = String(state.shots.length);
  dom.lastActionText.textContent = state.lastActionAt
    ? `Last action ${formatTime(new Date(state.lastActionAt), true)}`
    : "No actions yet.";

  // Export enabled once there's any recorded work
  const hasWork =
    state.shots.some((s) => s.status !== "pending") || state.extraShots.length > 0;
  dom.exportButton.disabled = !hasWork;

  renderCurrentShot(metrics.currentShot);
  renderQueue(metrics.queueShots, metrics.currentShot);
  renderMorePending(metrics.morePendingShots);
  dom.morePendingPanel.hidden = !state.startedAt || metrics.morePendingShots.length === 0;

  renderUndoToast();

  const canStart = !state.startedAt && state.shots.length > 0 && Boolean(dom.hardWrapInput.value);
  dom.startDayButton.disabled = !canStart;

  const hasCurrentShot = Boolean(metrics.currentShot);
  dom.doneButton.disabled = !state.startedAt || !hasCurrentShot;
  dom.skipButton.disabled = !state.startedAt || !hasCurrentShot;
  dom.addShotButton.disabled = !state.startedAt;

  syncLayoutChrome();
}

function renderUndoToast() {
  const u = state.lastUndo;
  if (!u || Date.now() > u.expiresAt) {
    dom.undoToast.hidden = true;
    return;
  }

  const shot = state.shots.find((s) => s.id === u.shotId);
  if (!shot) {
    dom.undoToast.hidden = true;
    return;
  }

  const verb = u.action === "done" ? "marked DONE" : "SKIPPED";
  dom.undoToastText.textContent = `Shot ${shot.id} ${verb}.`;
  dom.undoToast.hidden = false;
}

function renderCurrentShot(shot) {
  dom.currentShotBadges.innerHTML = "";

  if (!shot) {
    dom.currentShotPanel.classList.add("is-empty");
    dom.currentShotTitle.textContent = state.startedAt ? "Shot list complete" : "No active shot";
    dom.currentShotScene.textContent = state.startedAt
      ? "All planned shots have been resolved."
      : "Load a shot list to begin.";
    dom.currentShotLabel.textContent = state.startedAt
      ? "Use +1 SHOT for any extra pickups still happening."
      : "The next pending shot will appear here.";
    dom.currentShotMinutes.textContent = "Planned -- min";
    dom.currentShotLive.hidden = true;
    dom.currentShotDeadline.textContent = "No deadline";
    return;
  }

  dom.currentShotPanel.classList.remove("is-empty");
  dom.currentShotTitle.textContent = `Shot ${shot.id}`;
  dom.currentShotScene.textContent = `Scene ${shot.scene}`;
  dom.currentShotLabel.textContent = shot.label;
  dom.currentShotMinutes.textContent = `Planned ${formatMinutes(shot.plannedMinutes)}`;
  dom.currentShotDeadline.textContent = shot.deadlineTag
    ? `Deadline ${formatDeadlineText(shot.deadlineTag)}`
    : "No deadline";

  // Per-shot live timer
  if (state.startedAt && shot.startedAt) {
    const elapsedMin = (now.getTime() - new Date(shot.startedAt).getTime()) / 60000;
    const overBy = elapsedMin - shot.plannedMinutes;
    if (overBy > 0) {
      dom.currentShotLive.textContent = `Over by ${Math.round(overBy)} min`;
    } else {
      dom.currentShotLive.textContent = `Live ${Math.max(0, Math.round(elapsedMin))} min`;
    }
    dom.currentShotLive.classList.toggle("is-over", overBy > OVER_WARN_THRESHOLD_MIN);
    dom.currentShotLive.hidden = false;
  } else {
    dom.currentShotLive.hidden = true;
    dom.currentShotLive.classList.remove("is-over");
  }

  if (state.startedAt) {
    appendBadge("Active", "badge-active");
  }

  const priorityLabel = shot.priority === 1 ? "Must-Have" : shot.priority === 2 ? "Want" : "Nice";
  const priorityClass = shot.priority === 1 ? "badge-p1" : shot.priority === 2 ? "badge-p2" : "badge-p3";
  appendBadge(priorityLabel, priorityClass);

  if (shot.deadlineTag) {
    appendBadge(formatDeadlineText(shot.deadlineTag), "badge-deadline");
  }
}

function renderQueue(shots, currentShot) {
  dom.upNextList.innerHTML = "";

  if (!shots.length) {
    const empty = document.createElement("div");
    empty.className = "queue-empty";
    empty.textContent = getQueueEmptyMessage(currentShot);
    dom.upNextList.appendChild(empty);
    return;
  }

  shots.forEach((shot) => {
    dom.upNextList.appendChild(buildPendingShotCard(shot, { compact: true, interactive: Boolean(state.startedAt) }));
  });
}

function renderMorePending(shots) {
  dom.morePendingList.innerHTML = "";

  if (!shots.length) {
    return;
  }

  shots.forEach((shot) => {
    dom.morePendingList.appendChild(buildPendingShotCard(shot));
  });
}

function computeMetrics() {
  const pendingShots = getPendingShots();
  const currentShot = getActiveShot(pendingShots);
  const orderedPendingShots = getPendingShotsInWorkingOrder(pendingShots, currentShot);
  const queueSize = state.startedAt ? ACTIVE_QUEUE_SIZE : DISPLAY_QUEUE_SIZE;
  const queueShots = orderedPendingShots.slice(1, 1 + queueSize);
  const morePendingShots = state.startedAt ? orderedPendingShots.slice(1 + queueSize) : [];
  const doneCount = state.shots.filter((shot) => shot.status === "done").length;
  const skippedCount = state.shots.filter((shot) => shot.status === "skipped").length;

  // Priority 1 = Must-Have (was required:true), counts for required remaining
  const requiredRemaining = orderedPendingShots.filter((shot) => shot.priority === 1);
  const requiredRemainingCount = requiredRemaining.length;

  const plannedResolvedMinutes = sumMinutes(state.shots.filter((shot) => shot.status !== "pending"));
  const remainingPlannedMinutes = sumMinutes(orderedPendingShots);
  const startedAt = state.startedAt ? new Date(state.startedAt) : null;
  const hardWrapAt = state.hardWrapAt ? new Date(state.hardWrapAt) : null;
  const elapsedMinutes = startedAt ? Math.max(0, (now.getTime() - startedAt.getTime()) / 60000) : 0;

  const paceRatio = computePaceRatio(startedAt, plannedResolvedMinutes, elapsedMinutes, currentShot);

  let forecastWrapAt = null;
  if (startedAt) {
    const forecastRemainingMinutes = orderedPendingShots.length
      ? remainingPlannedMinutes * paceRatio
      : 0;
    forecastWrapAt = new Date(now.getTime() + forecastRemainingMinutes * 60000);
  }

  const behindMinutes = startedAt ? Math.max(0, elapsedMinutes - plannedResolvedMinutes) : 0;
  const paceStatus = describePace(startedAt, plannedResolvedMinutes, paceRatio, behindMinutes);
  const forecastPastHardWrap = Boolean(
    startedAt &&
      hardWrapAt &&
      forecastWrapAt &&
      forecastWrapAt.getTime() > hardWrapAt.getTime() &&
      orderedPendingShots.length
  );

  const requiredRisk = getRequiredRisk(requiredRemaining, hardWrapAt, paceRatio);
  const deadlineConflicts = getDeadlineConflicts(orderedPendingShots, startedAt, paceRatio);

  return {
    currentShot,
    queueShots,
    morePendingShots,
    doneCount,
    skippedCount,
    requiredRemainingCount,
    behindMinutes,
    paceStatus,
    hardWrapAt,
    forecastWrapAt,
    forecastPastHardWrap,
    requiredRisk,
    deadlineConflicts,
  };
}

// Improved pace ratio with cold-start handling.
// - Once any shots resolve, use resolved-vs-elapsed as the signal.
// - Cold start: if the active shot is already past its plan, factor that in.
// - Floor at 0.5 (up from 0.1) so a fluke fast first shot can't make the forecast absurd.
function computePaceRatio(startedAt, plannedResolvedMinutes, elapsedMinutes, currentShot) {
  if (!startedAt) return 1;

  if (plannedResolvedMinutes > 0) {
    return Math.max(0.5, elapsedMinutes / plannedResolvedMinutes);
  }

  // Cold start — nothing resolved yet
  if (currentShot && currentShot.startedAt && currentShot.plannedMinutes > 0) {
    const activeElapsedMin = Math.max(
      0,
      (now.getTime() - new Date(currentShot.startedAt).getTime()) / 60000
    );
    if (activeElapsedMin > currentShot.plannedMinutes) {
      return Math.max(1, activeElapsedMin / currentShot.plannedMinutes);
    }
  }

  return 1;
}

function getRequiredRisk(requiredShots, hardWrapAt, paceRatio) {
  if (!state.startedAt || !hardWrapAt || !requiredShots.length) {
    return { count: 0 };
  }

  let cumulativeMinutes = 0;
  let atRiskCount = 0;

  requiredShots.forEach((shot) => {
    cumulativeMinutes += shot.plannedMinutes * paceRatio;
    const finishAt = new Date(now.getTime() + cumulativeMinutes * 60000);
    if (finishAt.getTime() > hardWrapAt.getTime()) {
      atRiskCount += 1;
    }
  });

  return { count: atRiskCount };
}

// Deadline conflicts: accumulate time for ALL pending shots (because P3 still
// takes time on the day), but only surface conflicts for P1/P2. P3 is silent.
function getDeadlineConflicts(pendingShots, startedAt, paceRatio) {
  if (!state.startedAt || !pendingShots.length) {
    return [];
  }

  let cumulativeMinutes = 0;
  const reference = startedAt || now;
  const conflicts = [];

  pendingShots.forEach((shot) => {
    cumulativeMinutes += shot.plannedMinutes * paceRatio;
    if (shot.priority === 3) return; // silent by design

    const predictedFinish = new Date(now.getTime() + cumulativeMinutes * 60000);
    const deadlineAt = parseDeadlineTag(shot.deadlineTag, reference);
    if (deadlineAt && predictedFinish.getTime() > deadlineAt.getTime()) {
      conflicts.push({ shot, deadlineAt, predictedFinish });
    }
  });

  return conflicts.sort((left, right) => {
    if (left.shot.priority !== right.shot.priority) {
      return left.shot.priority - right.shot.priority;
    }
    return left.deadlineAt.getTime() - right.deadlineAt.getTime();
  });
}

function pickTopAlert(metrics) {
  if (!state.startedAt) {
    if (!state.shots.length) {
      return {
        className: "alert-neutral",
        message: "Import a shot list and set hard wrap to begin.",
      };
    }

    return {
      className: "alert-neutral",
      message: `${state.shots.length} shots loaded. Start Day locks the app into tap-only tracking.`,
    };
  }

  // Priority 1 shot with a deadline conflict — highest urgency
  const p1Conflict = metrics.deadlineConflicts.find((c) => c.shot.priority === 1);
  if (p1Conflict) {
    return {
      className: "alert-danger",
      message: `Must-Have deadline risk: Shot ${p1Conflict.shot.id} forecasts ${formatTime(
        p1Conflict.predictedFinish, true
      )} against ${formatTime(p1Conflict.deadlineAt, true)}.`,
    };
  }

  // Priority 1 shots at risk before hard wrap
  if (metrics.requiredRisk.count > 0) {
    return {
      className: "alert-danger",
      message: `${metrics.requiredRisk.count} must-have shot${
        metrics.requiredRisk.count === 1 ? "" : "s"
      } at risk before hard wrap.`,
    };
  }

  // Priority 2 deadline conflict
  const p2Conflict = metrics.deadlineConflicts.find((c) => c.shot.priority === 2);
  if (p2Conflict) {
    return {
      className: "alert-warning",
      message: `Deadline conflict: Shot ${p2Conflict.shot.id} slips past ${formatTime(
        p2Conflict.deadlineAt, true
      )}.`,
    };
  }

  if (metrics.forecastPastHardWrap && metrics.hardWrapAt && metrics.forecastWrapAt) {
    return {
      className: "alert-warning",
      message: `Forecast wrap ${formatTime(metrics.forecastWrapAt, true)} is past hard wrap ${formatTime(
        metrics.hardWrapAt, true
      )}.`,
    };
  }

  if (metrics.behindMinutes >= 5) {
    return {
      className: "alert-warning",
      message: `Behind schedule by ${Math.round(metrics.behindMinutes)} planned minute${
        Math.round(metrics.behindMinutes) === 1 ? "" : "s"
      }.`,
    };
  }

  if (!metrics.currentShot) {
    return {
      className: "alert-success",
      message: "All planned shots are resolved. Only extras remain, if needed.",
    };
  }

  return {
    className: "alert-success",
    message: metrics.hardWrapAt && metrics.forecastWrapAt
      ? `On pace. Forecast wrap ${formatTime(metrics.forecastWrapAt, true)} against hard wrap ${formatTime(
          metrics.hardWrapAt, true
        )}.`
      : "On pace.",
  };
}

function getStateIndicator(metrics) {
  if (!state.startedAt) {
    return { label: "READY", className: "state-ready" };
  }

  // P1/P2 deadline risks or any required risk → state-risk
  const hasActionableDeadlineRisk = metrics.deadlineConflicts.some(
    (c) => c.shot.priority === 1 || c.shot.priority === 2
  );
  if (hasActionableDeadlineRisk || metrics.requiredRisk.count > 0) {
    return { label: "DEADLINE RISK", className: "state-risk" };
  }

  if (metrics.forecastPastHardWrap || metrics.behindMinutes >= 5 || metrics.paceStatus.startsWith("Behind")) {
    return { label: "BEHIND", className: "state-behind" };
  }

  return { label: "ON PACE", className: "state-on-pace" };
}

function parseShotCsv(text) {
  const rows = parseCsvRows(text);
  if (!rows.length) {
    throw new Error("The CSV file is empty.");
  }

  const headers = rows[0].map((header) => normalizeHeader(header));
  const fieldIndexes = {
    id: findHeaderIndex(headers, ["id", "shotid"]),
    scene: findHeaderIndex(headers, ["scene", "scenenumber"]),
    label: findHeaderIndex(headers, ["label", "shot", "description", "shotlabel"]),
    plannedMinutes: findHeaderIndex(headers, [
      "plannedminutes", "plannedmins", "plannedminute", "minutes", "mins", "min",
    ]),
    // Accept both old "required" and new "priority" column names
    priority: findHeaderIndex(headers, ["priority", "required", "musthave", "mustshoot"]),
    deadlineTag: findHeaderIndex(headers, ["deadlinetag", "deadline", "optionaldeadlinetag", "tag"]),
  };

  const requiredFields = ["id", "scene", "label", "plannedMinutes", "priority"];
  const missing = requiredFields.filter((field) => fieldIndexes[field] === -1);
  if (missing.length) {
    throw new Error(`Missing required CSV columns: ${missing.join(", ")}.`);
  }

  const shots = rows
    .slice(1)
    .filter((row) => row.some((value) => value.trim().length > 0))
    .map((row, index) => buildShotFromRow(row, fieldIndexes, index + 2));

  if (!shots.length) {
    throw new Error("No shot rows were found after the header.");
  }

  assertUniqueShotIds(shots);
  return shots;
}

function parseCsvRows(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let inQuotes = false;

  const normalizedText = text.replace(/\uFEFF/g, "");

  for (let index = 0; index < normalizedText.length; index += 1) {
    const char = normalizedText[index];
    const nextChar = normalizedText[index + 1];

    if (inQuotes) {
      if (char === '"' && nextChar === '"') {
        cell += '"';
        index += 1;
      } else if (char === '"') {
        inQuotes = false;
      } else {
        cell += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
      continue;
    }

    if (char === ",") {
      row.push(cell.trim());
      cell = "";
      continue;
    }

    if (char === "\n") {
      row.push(cell.trim());
      rows.push(row);
      row = [];
      cell = "";
      continue;
    }

    if (char !== "\r") {
      cell += char;
    }
  }

  if (cell.length > 0 || row.length > 0) {
    row.push(cell.trim());
    rows.push(row);
  }

  return rows.filter((currentRow) => currentRow.length > 1 || currentRow[0] !== "");
}

function buildShotFromRow(row, fieldIndexes, csvLineNumber) {
  const id = getCell(row, fieldIndexes.id);
  const scene = getCell(row, fieldIndexes.scene);
  const label = getCell(row, fieldIndexes.label);

  if (!id || !scene || !label) {
    throw new Error(`Missing id, scene, or label on CSV line ${csvLineNumber}.`);
  }

  const plannedMinutesRaw = getCell(row, fieldIndexes.plannedMinutes);
  const plannedMinutes = Number.parseFloat(plannedMinutesRaw);
  if (!Number.isFinite(plannedMinutes) || plannedMinutes <= 0) {
    throw new Error(`Invalid planned minutes on CSV line ${csvLineNumber}.`);
  }

  return {
    id,
    scene,
    label,
    plannedMinutes,
    priority: parsePriorityValue(getCell(row, fieldIndexes.priority)),
    deadlineTag: fieldIndexes.deadlineTag === -1 ? "" : getCell(row, fieldIndexes.deadlineTag),
    status: "pending",
    startedAt: "",
    resolvedAt: "",
    doneAt: "",
    skippedAt: "",
  };
}

function getCell(row, index) {
  return String(row[index] || "").trim();
}

function parsePriorityValue(value) {
  const normalized = value.trim().toLowerCase();

  // Numeric priority — 1, 2, or 3
  if (normalized === "1") return 1;
  if (normalized === "2") return 2;
  if (normalized === "3") return 3;

  // Legacy boolean "required" support
  if (["true", "yes", "y", "required", "musthave"].includes(normalized)) return 1;
  if (["false", "no", "n", "optional"].includes(normalized)) return 3;

  // Default to priority 3 (nice to have) if unrecognized
  return 3;
}

function normalizeHeader(value) {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function findHeaderIndex(headers, candidates) {
  return headers.findIndex((header) => candidates.includes(header));
}

function getPendingShots() {
  return state.shots.filter((shot) => shot.status === "pending");
}

function getActiveShot(pendingShots = getPendingShots()) {
  if (!pendingShots.length) {
    return null;
  }

  if (state.activeShotId) {
    const activeShot = pendingShots.find((shot) => shot.id === state.activeShotId);
    if (activeShot) {
      return activeShot;
    }
  }

  return pendingShots[0];
}

function setActiveShot(id) {
  const pendingShots = getPendingShots();
  if (!pendingShots.length) {
    state.activeShotId = "";
    return null;
  }

  const requestedId = id ? String(id) : "";
  const nextActiveShot = requestedId ? pendingShots.find((shot) => shot.id === requestedId) || null : null;
  const chosen = nextActiveShot || pendingShots[0];
  state.activeShotId = chosen.id;

  // Stamp startedAt on first activation while live
  if (state.startedAt && !chosen.startedAt) {
    chosen.startedAt = new Date().toISOString();
  }

  return chosen;
}

// Called every tick — ensures the active shot has a startedAt once the day is running
function stampActiveShotStartedAt() {
  if (!state.startedAt) return;
  const active = getActiveShot();
  if (active && !active.startedAt) {
    active.startedAt = new Date().toISOString();
    // No persistState here — caller's render cycle handles persistence on actions;
    // the timestamp will persist on the next user action. Acceptable trade-off.
  }
}

function handleActiveShotSelection(id) {
  if (!state.startedAt) {
    return;
  }

  const activeShot = setActiveShot(id);
  if (!activeShot) {
    return;
  }

  persistState();
  render();
}

function syncActiveShotSelection() {
  const currentShot = getActiveShot();
  const nextActiveShotId = currentShot ? currentShot.id : "";

  if (state.activeShotId !== nextActiveShotId) {
    state.activeShotId = nextActiveShotId;
    return true;
  }

  return false;
}

function getPendingShotsInWorkingOrder(pendingShots = getPendingShots(), activeShot = getActiveShot(pendingShots)) {
  if (!activeShot) {
    return pendingShots;
  }

  const activeIndex = state.shots.findIndex((shot) => shot.id === activeShot.id);
  if (activeIndex === -1) {
    return pendingShots;
  }

  return [...state.shots.slice(activeIndex), ...state.shots.slice(0, activeIndex)].filter(
    (shot) => shot.status === "pending"
  );
}

function getNextPendingShotId(referenceShotId) {
  const pendingShots = getPendingShots();
  if (!pendingShots.length) {
    return "";
  }

  const referenceIndex = state.shots.findIndex((shot) => shot.id === referenceShotId);
  if (referenceIndex === -1) {
    return pendingShots[0].id;
  }

  for (let index = referenceIndex + 1; index < state.shots.length; index += 1) {
    if (state.shots[index].status === "pending") {
      return state.shots[index].id;
    }
  }

  return pendingShots[0].id;
}

function assertUniqueShotIds(shots) {
  const seen = new Set();

  shots.forEach((shot) => {
    if (seen.has(shot.id)) {
      throw new Error(`Duplicate shot id "${shot.id}" found in CSV. Shot ids must be unique.`);
    }
    seen.add(shot.id);
  });
}

function buildPendingShotCard(shot, options = {}) {
  const { compact = false, interactive = true } = options;
  const element = document.createElement(interactive ? "button" : "article");
  if (interactive) {
    element.type = "button";
  }
  element.className = compact
    ? `queue-item${interactive ? " queue-item-button" : ""}`
    : `pending-item${interactive ? " pending-item-button" : ""}`;
  element.dataset.shotId = shot.id;
  if (interactive) {
    element.addEventListener("click", () => handleActiveShotSelection(shot.id));
  }

  const row = document.createElement("div");
  row.className = compact ? "queue-row" : "pending-row";

  const content = document.createElement("div");
  content.className = compact ? "queue-copy" : "pending-copy";

  const title = document.createElement("p");
  title.className = compact ? "queue-title" : "pending-title";
  title.textContent = shot.label;

  const meta = document.createElement("p");
  meta.className = compact ? "queue-meta" : "pending-meta";
  meta.textContent = compact
    ? interactive
      ? "Make current"
      : `Shot ${shot.id} | Scene ${shot.scene}`
    : `Shot ${shot.id} | Scene ${shot.scene}${interactive ? " | Make current" : ""}`;

  const duration = document.createElement("strong");
  duration.className = compact ? "queue-time" : "pending-time";
  duration.textContent = formatMinutes(shot.plannedMinutes);

  content.append(title, meta);
  row.append(content, duration);
  element.appendChild(row);
  return element;
}

function getQueueEmptyMessage(currentShot) {
  if (!state.startedAt) {
    return "Import a shot list to preview the queue.";
  }

  if (currentShot) {
    return "No other pending shots. SKIP only resolves the current shot.";
  }

  return "No more pending shots.";
}

function sumMinutes(shots) {
  return shots.reduce((total, shot) => total + shot.plannedMinutes, 0);
}

function describePace(startedAt, plannedResolvedMinutes, paceRatio, behindMinutes) {
  if (!startedAt) return "Ready";
  if (plannedResolvedMinutes <= 0) {
    if (behindMinutes >= 5) return `Behind ${Math.round(behindMinutes)} min`;
    return "Waiting for first lock";
  }
  if (paceRatio > 1.08) return `Behind ${Math.round((paceRatio - 1) * 100)}%`;
  if (paceRatio < 0.92) return `Ahead ${Math.round((1 - paceRatio) * 100)}%`;
  if (behindMinutes >= 5) return `Behind ${Math.round(behindMinutes)} min`;
  return "On pace";
}

function parseDeadlineTag(tag, referenceDate) {
  if (!tag) return null;

  const match = tag.match(/(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?/i);
  if (!match) return null;

  let hours = Number.parseInt(match[1], 10);
  const minutes = Number.parseInt(match[2] || "0", 10);
  const period = match[3] ? match[3].toLowerCase().replace(/\./g, "") : "";

  if (period) {
    if (period === "pm" && hours < 12) hours += 12;
    if (period === "am" && hours === 12) hours = 0;
  }

  if (hours > 23 || minutes > 59) return null;

  const deadline = new Date(referenceDate);
  deadline.setHours(hours, minutes, 0, 0);

  if (deadline.getTime() < referenceDate.getTime()) {
    deadline.setDate(deadline.getDate() + 1);
  }

  return deadline;
}

function formatTime(date, includeDayWhenNeeded = false) {
  const showDay = includeDayWhenNeeded && date.toDateString() !== now.toDateString();
  const formatter = new Intl.DateTimeFormat([], {
    weekday: showDay ? "short" : undefined,
    hour: "numeric",
    minute: "2-digit",
  });
  return formatter.format(date);
}

function formatMinutes(minutes) {
  const rounded = Math.round(minutes * 10) / 10;
  return `${rounded} min`;
}

function formatDeadlineText(tag) {
  return tag.trim();
}

function appendBadge(text, className) {
  const badge = document.createElement("span");
  badge.className = `badge ${className}`;
  badge.textContent = text;
  dom.currentShotBadges.appendChild(badge);
}

function getHardWrapDisplayText() {
  if (state.hardWrapAt) {
    return formatTime(new Date(state.hardWrapAt), true);
  }

  if (dom.hardWrapInput.value) {
    return formatTime(composeFutureDateFromTime(now, dom.hardWrapInput.value), true);
  }

  return "--";
}

function applyHardWrapValue(timeValue, options = {}) {
  const { closeEditor = false } = options;

  state.draftHardWrapTime = timeValue;
  dom.hardWrapInput.value = timeValue;

  if (state.startedAt) {
    state.hardWrapAt = composeDateOnReferenceDay(getHardWrapReferenceDate(), timeValue).toISOString();
  } else {
    state.hardWrapAt = "";
  }

  if (closeEditor) {
    isLiveHardWrapEditing = false;
  }

  persistState();
  render();
}

function composeFutureDateFromTime(reference, timeValue) {
  const [rawHour, rawMinute] = timeValue.split(":").map((value) => Number.parseInt(value, 10));
  const composed = new Date(reference);
  composed.setHours(rawHour, rawMinute, 0, 0);

  if (composed.getTime() <= reference.getTime()) {
    composed.setDate(composed.getDate() + 1);
  }

  return composed;
}

function composeDateOnReferenceDay(reference, timeValue) {
  const [rawHour, rawMinute] = timeValue.split(":").map((value) => Number.parseInt(value, 10));
  const composed = new Date(reference);
  composed.setHours(rawHour, rawMinute, 0, 0);
  return composed;
}

function seedHardWrapInput(force = false) {
  if (!force && dom.hardWrapInput.value) {
    return;
  }

  const sourceTime = state.draftHardWrapTime || deriveHardWrapInputFromState() || getRoundedFutureTime(12);
  dom.hardWrapInput.value = sourceTime;

  if (!state.draftHardWrapTime) {
    state.draftHardWrapTime = sourceTime;
    persistState();
  }
}

function getEditableHardWrapInputValue() {
  return state.draftHardWrapTime || deriveHardWrapInputFromState() || dom.hardWrapInput.value || "";
}

function getHardWrapReferenceDate() {
  if (state.hardWrapAt) return new Date(state.hardWrapAt);
  if (state.startedAt) return new Date(state.startedAt);
  return now;
}

function openLiveHardWrapEditor() {
  if (!state.startedAt) return;

  isLiveHardWrapEditing = true;
  render();

  window.requestAnimationFrame(() => {
    dom.liveHardWrapInput.focus({ preventScroll: true });
    if (typeof dom.liveHardWrapInput.showPicker === "function") {
      try {
        dom.liveHardWrapInput.showPicker();
      } catch (error) {
        // Ignore browsers that block programmatic picker access.
      }
    }
  });
}

function closeLiveHardWrapEditor() {
  if (!isLiveHardWrapEditing) return;
  isLiveHardWrapEditing = false;
  render();
}

function handleLiveHardWrapKeydown(event) {
  if (event.key === "Escape") {
    event.preventDefault();
    closeLiveHardWrapEditor();
  }
}

function deriveHardWrapInputFromState() {
  const date = state.hardWrapAt ? new Date(state.hardWrapAt) : null;
  if (!date) return "";
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function getRoundedFutureTime(offsetHours) {
  const future = new Date();
  future.setMinutes(Math.ceil(future.getMinutes() / 15) * 15, 0, 0);
  future.setHours(future.getHours() + offsetHours);
  return `${String(future.getHours()).padStart(2, "0")}:${String(future.getMinutes()).padStart(2, "0")}`;
}

function restoreState() {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return;

    const parsed = JSON.parse(raw);
    Object.assign(state, createDefaultState(), parsed);
    if (normalizeRestoredState()) {
      persistState();
    }
  } catch (error) {
    console.warn("Unable to restore MARTINI state", error);
  }
}

function normalizeRestoredState() {
  let changed = false;

  if (!Array.isArray(state.shots)) { state.shots = []; changed = true; }
  if (!Array.isArray(state.extraShots)) { state.extraShots = []; changed = true; }
  if (typeof state.activeShotId !== "string") { state.activeShotId = ""; changed = true; }
  if (typeof state.fileName !== "string") { state.fileName = ""; changed = true; }
  if (typeof state.draftHardWrapTime !== "string") { state.draftHardWrapTime = ""; changed = true; }
  if (state.draftHardWrapTime && !isValidTimeInputValue(state.draftHardWrapTime)) {
    state.draftHardWrapTime = ""; changed = true;
  }
  if (typeof state.startedAt !== "string") { state.startedAt = ""; changed = true; }
  if (state.startedAt && !isValidDateValue(state.startedAt)) { state.startedAt = ""; changed = true; }
  if (typeof state.hardWrapAt !== "string") { state.hardWrapAt = ""; changed = true; }
  if (state.hardWrapAt && !isValidDateValue(state.hardWrapAt)) { state.hardWrapAt = ""; changed = true; }
  if (typeof state.lastActionAt !== "string") { state.lastActionAt = ""; changed = true; }
  if (state.lastActionAt && !isValidDateValue(state.lastActionAt)) { state.lastActionAt = ""; changed = true; }

  // Always clear transient undo on load — stale undo across sessions is dangerous
  if (state.lastUndo) { state.lastUndo = null; changed = true; }

  if (state.version !== 4) { state.version = 4; changed = true; }

  // Migrate old boolean required -> priority, and ensure startedAt field
  state.shots.forEach((shot) => {
    if (typeof shot.required === "boolean" && shot.priority === undefined) {
      shot.priority = shot.required ? 1 : 3;
      delete shot.required;
      changed = true;
    }
    if (shot.priority === undefined) {
      shot.priority = 3;
      changed = true;
    }
    if (typeof shot.startedAt !== "string") {
      shot.startedAt = "";
      changed = true;
    }
  });

  if (!state.draftHardWrapTime) {
    const derivedHardWrapInput = deriveHardWrapInputFromState();
    if (derivedHardWrapInput) {
      state.draftHardWrapTime = derivedHardWrapInput;
      changed = true;
    }
  }

  if (syncActiveShotSelection()) { changed = true; }

  return changed;
}

function isValidDateValue(value) {
  return !Number.isNaN(new Date(value).getTime());
}

function isValidTimeInputValue(value) {
  return /^\d{2}:\d{2}$/.test(value);
}

function persistState() {
  try {
    // Don't persist transient undo — clone-and-strip
    const toSave = { ...state, lastUndo: null };
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(toSave));
  } catch (error) {
    console.warn("Unable to persist MARTINI state", error);
  }
}

function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;

  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch((error) => {
      console.warn("Service worker registration failed", error);
    });
  });
}

function syncLayoutChrome() {
  const headerHeight = dom.topShell ? dom.topShell.offsetHeight : 0;
  const footerHeight = dom.actionBar ? dom.actionBar.offsetHeight : 0;

  document.documentElement.style.setProperty("--header-offset", `${headerHeight}px`);
  document.documentElement.style.setProperty("--footer-space", `${footerHeight + 18}px`);
}
