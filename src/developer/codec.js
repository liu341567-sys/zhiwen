'use strict';
// Versioned, lossless DOM sharing. Only sampled/scrubbed node data enters this
// pool. No compression, credential access or browser API is involved.
const ENCODING = 'node-pool-v1';
const EXPANDED_BUDGET = 128 * 1024 * 1024;
const EXPANDED_STORAGE_LIMIT = 132 * 1024 * 1024;
const signatures = new WeakMap();
const frozen = new WeakSet();
function freeze(value) {
  if (!value || typeof value !== 'object' || frozen.has(value)) return value;
  for (const child of Object.values(value)) freeze(child);
  frozen.add(value);
  return Object.freeze(value);
}
function packedReport(report, share = false) {
  const domNodes = [], lookup = new Map(), shared = new Map();
  let expandedNodeBytes = 0;
  const snapshots = (report.snapshots || []).map((snapshot) => ({
    ...snapshot,
    frames: (snapshot.frames || []).map((frame) => {
      const { nodes = [], ...metadata } = frame, nodeStates = [];
      const nodeRefs = nodes.map((node, i) => {
        let parts = signatures.get(node);
        if (!parts) {
          const { id, rect, ...body } = node, state = {};
          if (Object.hasOwn(node, 'id')) state.id = id;
          if (Object.hasOwn(node, 'rect')) state.rect = rect;
          parts = { body, state, signature: JSON.stringify(body), stateSignature: JSON.stringify(state),
            bytes: Buffer.byteLength(JSON.stringify(node)) };
        }
        expandedNodeBytes += parts.bytes;
        let index = lookup.get(parts.signature);
        if (index === undefined) {
          index = domNodes.length;
          lookup.set(parts.signature, index);
          domNodes.push(parts.body);
        }
        nodeStates.push(parts.state);
        if (share) {
          const identity = index + ':' + parts.stateSignature;
          let canonical = shared.get(identity);
          if (!canonical) {
            canonical = signatures.has(node) && parts.body === domNodes[index]
              ? node : freeze({ ...domNodes[index], ...parts.state });
            shared.set(identity, canonical);
            signatures.set(canonical, { ...parts, body: domNodes[index] });
          }
          frame.nodes[i] = canonical;
        }
        return index;
      });
      // Geometry and document-local IDs can change independently of the DOM.
      // Keep them per snapshot rather than duplicating each long locator path.
      return { ...metadata, nodeRefs, nodeStates };
    }),
  }));
  const data = { ...report, schemaVersion: 2, domEncoding: ENCODING, domNodes, snapshots };
  const serialized = JSON.stringify(data), bytes = Buffer.byteLength(serialized);
  // Conservative upper bound for readable expansion, independent of sharing.
  return { data, serialized, bytes, expandedBytes: bytes + expandedNodeBytes };
}
function unpackReport(data) {
  if (data.domEncoding === undefined) return data; // Existing version 1 rows.
  if (data.domEncoding !== ENCODING || data.schemaVersion !== 2 ||
      !Array.isArray(data.domNodes) || !Array.isArray(data.snapshots))
    throw new Error('报告结构编码无效');
  const sizes = data.domNodes.map((node) => {
    if (!node || typeof node !== 'object' || Array.isArray(node)) throw new Error('报告元素无效');
    freeze(node);
    return Buffer.byteLength(JSON.stringify(node));
  });
  let expandedBytes = Buffer.byteLength(JSON.stringify(data));
  const snapshots = data.snapshots.map((snapshot) => ({
    ...snapshot,
    frames: (snapshot.frames || []).map((frame) => {
      const { nodeRefs, nodeStates, ...metadata } = frame;
      if (!Array.isArray(nodeRefs) || (nodeStates && (!Array.isArray(nodeStates) || nodeStates.length !== nodeRefs.length)))
        throw new Error('报告元素索引无效');
      const nodes = nodeRefs.map((ref, i) => {
        if (!Number.isSafeInteger(ref) || ref < 0 || ref >= sizes.length)
          throw new Error('报告元素索引无效');
        const state = nodeStates?.[i] || {};
        if (typeof state !== 'object' || Array.isArray(state) || Object.keys(state).some((k) => !['id', 'rect'].includes(k)))
          throw new Error('报告元素状态无效');
        expandedBytes += sizes[ref] + Buffer.byteLength(JSON.stringify(state));
        if (expandedBytes > EXPANDED_STORAGE_LIMIT) throw new Error('报告展开超出安全容量');
        const body = data.domNodes[ref];
        const node = freeze({ ...body, ...state });
        const { id, rect, ...definition } = node;
        signatures.set(node, { body: definition, state, signature: JSON.stringify(definition),
          stateSignature: JSON.stringify(state), bytes: Buffer.byteLength(JSON.stringify(node)) });
        return node;
      });
      return { ...metadata, nodes };
    }),
  }));
  const { domEncoding, domNodes, ...metadata } = data;
  return { ...metadata, schemaVersion: 1, snapshots };
}
// The window renders the latest DOM; historical comparisons run in the main
// service. Do not clone the entire recording across IPC on every keystroke.
function displayState(state) {
  if (!state?.report) return state;
  const report = state.report, latest = report.snapshots.at(-1);
  return { ...state, report: { ...report, snapshots: report.snapshots.map((s) =>
    s === latest ? s : { ...s, frames: (s.frames || []).map(({ nodes, ...f }) =>
      ({ ...f, nodeCount: nodes?.length || 0, nodesDeferred: true })) }) } };
}
module.exports = { ENCODING, EXPANDED_BUDGET, EXPANDED_STORAGE_LIMIT, packedReport, unpackReport, displayState };
