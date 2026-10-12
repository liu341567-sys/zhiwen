'use strict';
const { packedReport, EXPANDED_BUDGET } = require('./codec');
const REPORT_BUDGET = 22 * 1024 * 1024;

function referencedSnapshots(report) {
  const ids = new Set();
  for (const row of [
    ...(report.steps || []), ...(report.scripts || []),
    ...(report.screenshots || []), ...(report.assistance?.segments || []),
  ]) {
    for (const key of ['beforeId', 'afterId', 'snapshotId'])
      if (row[key]) ids.add(row[key]);
  }
  const latest = report.snapshots.at(-1);
  if (latest) ids.add(latest.id);
  return ids;
}

// Only background samples may be evicted. In particular, neither the oldest
// action nor a module marker loses its evidence just because the user waits.
function retainEvidence(report, budget = REPORT_BUDGET) {
  const protectedIds = referencedSnapshots(report);
  const ambient = report.snapshots.filter((s) => !protectedIds.has(s.id));
  let packed = packedReport(report, true), removed = 0;
  while (ambient.length && (ambient.length > 16 || packed.bytes > budget || packed.expandedBytes > EXPANDED_BUDGET)) {
    const obsolete = ambient.shift();
    report.snapshots = report.snapshots.filter((s) => s.id !== obsolete.id);
    for (const s of report.snapshots) {
      if (s.diff?.beforeId === obsolete.id) {
        delete s.diff.beforeId;
        s.diff.baselineUnavailable = true;
      }
    }
    removed++;
    packed = packedReport(report, true);
  }
  return { ...packed, removed, full: packed.bytes > budget || packed.expandedBytes > EXPANDED_BUDGET };
}

function sampleSignature(frames) {
  return JSON.stringify(frames.map((f) => ({
    key: f.key, url: f.url, title: f.title, readyState: f.readyState,
    unavailable: f.unavailable, viewport: f.viewport, truncated: f.truncated,
    // Runtime IDs, small layout movements, dirty flags and event queues don't
    // imply a new control state. Explicit actions still force an after sample.
    nodes: (f.nodes || []).map((n) => ({
      tag: n.tag, selector: n.selector, roots: n.roots,
      attributes: n.attributes, text: n.text, semantic: n.semantic,
      controlState: n.controlState, visible: n.visible, enabled: n.enabled,
      clickable: n.clickable, file: n.file, shadow: n.shadow, iframe: n.iframe,
    })),
  })));
}

function evidenceHealth(report) {
  const ids = new Set(report.snapshots.map((s) => s.id));
  const missing = [];
  for (const step of report.steps) {
    for (const key of ['beforeId', 'afterId'])
      if (step[key] && !ids.has(step[key])) missing.push({ stepId: step.id, reference: key });
  }
  return {
    missingStepSnapshots: missing,
    incompleteSteps: report.steps.filter((s) => s.captureIncomplete).map((s) => s.id),
    truncatedFrames: report.snapshots.flatMap((s) =>
      (s.frames || []).filter((f) => f.truncated).map((f) => ({ snapshotId: s.id, frame: f.key }))),
    capacityPaused: report.capacityPaused === true,
  };
}
module.exports = { REPORT_BUDGET, retainEvidence, sampleSignature, evidenceHealth };
