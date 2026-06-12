import { useMemo } from 'react';
import { ReactFlow, Background, Controls } from '@xyflow/react';
import '@xyflow/react/dist/style.css';

const NODE_WIDTH = 230;
const NODE_HEIGHT = 44;
const V_GAP = 28;
const LOOP_PADDING = 16;

const STATUS_COLORS = {
  passed: '#22c55e',
  failed: '#ef4444',
  stopped: '#eab308',
  running: '#3b82f6'
};

const stepLabel = (step) => {
  switch (step.type) {
    case 'request':
      return `${step.snapshot?.request?.method || ''} ${step.name}`.trim();
    case 'map':
      return `Map: ${(step.mappings || []).map((m) => m.target).filter(Boolean).join(', ') || step.name}`;
    case 'condition':
      return `If ${step.expression || ''}`.slice(0, 60);
    case 'delay':
      return `Delay ${step.durationMs}ms`;
    case 'loop':
      return `For each ${step.itemVar || 'item'} in ${step.source || '?'}`;
    default:
      return step.name;
  }
};

const nodeStyle = (step, result) => {
  const statusColor = result ? STATUS_COLORS[result.status] : null;
  return {
    width: NODE_WIDTH,
    fontSize: 12,
    borderRadius: 6,
    padding: '8px 10px',
    border: `1.5px solid ${statusColor || 'var(--color-border, #8884)'}`,
    background: 'var(--color-bg, transparent)'
  };
};

// Lay the document out as a vertical chain; loop bodies become group nodes
// containing their own vertical chain.
const buildGraph = (doc, stepResults) => {
  const nodes = [];
  const edges = [];

  const chain = (steps, parentId, originX, startY) => {
    let y = startY;
    let previousNodeId = null;

    for (const step of steps) {
      const result = stepResults?.[step.id];

      if (step.type === 'loop') {
        const bodyHeight = Math.max(step.steps?.length || 0, 1) * (NODE_HEIGHT + V_GAP) + LOOP_PADDING * 2 + 28;
        nodes.push({
          id: step.id,
          position: { x: originX - LOOP_PADDING, y },
          data: { label: stepLabel(step) },
          style: {
            width: NODE_WIDTH + LOOP_PADDING * 2,
            height: bodyHeight,
            borderRadius: 8,
            border: `1.5px dashed ${result ? STATUS_COLORS[result.status] : '#8886'}`,
            background: '#8881',
            fontSize: 12,
            padding: '6px 10px'
          },
          ...(parentId ? { parentId, extent: 'parent' } : {})
        });

        chain(step.steps || [], step.id, LOOP_PADDING, 34);

        if (previousNodeId) {
          edges.push({ id: `${previousNodeId}->${step.id}`, source: previousNodeId, target: step.id });
        }
        previousNodeId = step.id;
        y += bodyHeight + V_GAP;
        continue;
      }

      nodes.push({
        id: step.id,
        position: { x: originX, y },
        data: { label: stepLabel(step) },
        style: nodeStyle(step, result),
        ...(parentId ? { parentId, extent: 'parent' } : {})
      });

      if (previousNodeId) {
        edges.push({
          id: `${previousNodeId}->${step.id}`,
          source: previousNodeId,
          target: step.id,
          ...(step.type === 'condition' ? {} : {})
        });
      }
      previousNodeId = step.id;
      y += NODE_HEIGHT + V_GAP;
    }
  };

  chain(doc.steps || [], null, 40, 20);
  return { nodes, edges };
};

const WorkflowCanvas = ({ doc, stepResults }) => {
  const { nodes, edges } = useMemo(() => buildGraph(doc, stepResults), [doc, stepResults]);

  return (
    <div style={{ height: 480, border: '1px solid #8884', borderRadius: 6 }} data-testid="workflow-canvas">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        fitView
        nodesConnectable={false}
        elementsSelectable
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={18} size={1} />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
};

export default WorkflowCanvas;
