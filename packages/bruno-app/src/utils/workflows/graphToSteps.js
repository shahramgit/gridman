/**
 * Linearise a workflow node graph back into the ordered step list the AI
 * authors in.
 *
 * The forward direction lives in the main process
 * (packages/bruno-electron/src/workflows/index.js `migrateStepsToGraph`) and is
 * what the v1 -> v2 document migration uses; this is its inverse, and the two
 * have to agree on the same shapes:
 *
 *   - a chain follows 'main' from Start
 *   - a condition does NOT nest: the FOLLOWING steps hang off its 'true' port,
 *     and 'false' wired to the same target is `onFalse: 'continue'`
 *   - a loop's 'loop' port opens the body, whose exit wires back into the loop
 *     node, and 'done' continues the outer chain
 *
 * NOT EVERY GRAPH IS A STEP LIST. A user can wire things the forward direction
 * never produces: a request's 'error' port going somewhere, two nodes joining
 * into one, a jump backwards across the chain. Those carry real intent, and
 * flattening them would quietly throw it away the moment the assistant wrote
 * the flow back.
 *
 * So this reports `exact`. When it is false the caller must NOT let a write
 * replace the graph — the assistant is shown a read-only description and told
 * to say so, rather than being handed a lossy round-trip it cannot see is
 * lossy.
 */

// A loop nests: its body hangs off 'loop' and the chain resumes at 'done'.
//
// A condition does NOT nest, and this is the app's semantics rather than a
// simplification: migrateStepsToGraph wires the FOLLOWING steps to the
// condition's 'true' port and ignores any nested body outright. So the chain
// continues from 'true', and 'false' being wired to the same place is what
// `onFalse: 'continue'` means.
const CONTINUE_PORT = { loop: 'done', condition: 'true' };

const stepFromNode = (node) => {
  const step = { type: node.type };
  if (node.name) step.name = node.name;

  switch (node.type) {
    case 'request':
      step.ref = { collection: node.ref?.collection || '', request: node.ref?.request || '' };
      break;
    case 'map':
      step.mappings = (node.mappings || []).map((m) => ({ from: m.from, path: m.path, target: m.target }));
      break;
    case 'setvars':
      step.assignments = (node.assignments || []).map((a) => ({ name: a.name, value: a.value }));
      break;
    case 'condition':
      step.expression = node.expression || '';
      break;
    case 'delay':
      step.durationMs = node.durationMs ?? 1000;
      break;
    case 'loop':
      step.mode = node.mode || 'list';
      if (step.mode === 'list') step.source = node.source || '';
      else step.count = node.count || '3';
      step.itemVar = node.itemVar || 'item';
      if (node.breakExpr) step.breakExpr = node.breakExpr;
      break;
    case 'script':
      step.code = node.code || '';
      if (node.assignTo) step.assignTo = node.assignTo;
      break;
    default:
      break;
  }
  return step;
};

export const graphToSteps = (doc) => {
  const nodes = Array.isArray(doc?.nodes) ? doc.nodes : [];
  const connections = Array.isArray(doc?.connections) ? doc.connections : [];

  // A document that still has v1 steps and no graph is already what we want.
  if (!nodes.length && Array.isArray(doc?.steps)) {
    return { steps: doc.steps, exact: true, reason: null };
  }

  const byId = new Map(nodes.map((n) => [n.id, n]));
  const out = new Map(); // `${source}:${port}` -> target id
  const inboundCount = new Map();
  let reason = null;

  for (const conn of connections) {
    out.set(`${conn.source}:${conn.sourcePort}`, conn.target);
    inboundCount.set(conn.target, (inboundCount.get(conn.target) || 0) + 1);
    // The forward direction never wires 'error'; if a user did, a step list
    // cannot say so.
    if (conn.sourcePort === 'error') reason = 'a request\'s error port is wired';
  }

  const start = nodes.find((n) => n.type === 'start');
  if (!start) return { steps: [], exact: false, reason: 'the workflow has no Start node' };

  const visited = new Set();
  const notes = nodes.filter((n) => n.type === 'note').length;

  const walk = (fromId, fromPort, stopAt) => {
    const steps = [];
    let targetId = out.get(`${fromId}:${fromPort}`);

    while (targetId && targetId !== stopAt) {
      if (visited.has(targetId)) {
        reason = reason || 'the graph loops back in a way a step list cannot express';
        break;
      }
      const node = byId.get(targetId);
      if (!node) break;
      visited.add(targetId);

      // Two chains merging into one node is a join; a step list only nests.
      if ((inboundCount.get(targetId) || 0) > 1 && node.type !== 'loop') {
        reason = reason || 'two branches join back together';
      }

      const step = stepFromNode(node);

      if (node.type === 'loop') {
        const body = walk(targetId, 'loop', targetId);
        if (body.length) step.steps = body;
      } else if (node.type === 'condition') {
        step.onFalse = out.get(`${targetId}:false`) === out.get(`${targetId}:true`) && out.has(`${targetId}:false`)
          ? 'continue'
          : 'stop';
      }

      steps.push(step);
      targetId = out.get(`${targetId}:${CONTINUE_PORT[node.type] || 'main'}`);
    }

    return steps;
  };

  const steps = walk(start.id, 'main');

  // Anything reachable-but-unwalked (or wired in from nowhere) means the graph
  // held more than the chain we just described.
  const reachable = visited.size + 1 + notes;
  if (reachable < nodes.length) {
    reason = reason || 'some nodes are not on the main chain';
  }

  return { steps, exact: !reason, reason };
};

export default graphToSteps;
