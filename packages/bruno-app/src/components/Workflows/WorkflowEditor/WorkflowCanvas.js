import { useEffect, useMemo, useCallback } from 'react';
import { useDrop } from 'react-dnd';
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  Handle,
  NodeToolbar,
  Position,
  useNodesState,
  useReactFlow
} from '@xyflow/react';
import { IconTarget, IconTrash } from '@tabler/icons';
import '@xyflow/react/dist/style.css';

const NODE_WIDTH = 230;
const NODE_HEIGHT = 44;
const V_GAP = 28;
const LOOP_PADDING = 16;
const LOOP_HEADER = 34;

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
      return `For each ${step.itemVar || 'item'} in vars.${step.source || '?'}`;
    default:
      return step.name;
  }
};

const StepNode = ({ data, selected }) => (
  <>
    <NodeToolbar isVisible={selected} position={Position.Right} className="wf-node-toolbar">
      {data.isRequest && (
        <button type="button" title="Show request in sidebar" onClick={data.onReveal}>
          <IconTarget size={14} stroke={1.6} />
        </button>
      )}
      <button type="button" title="Delete step" onClick={data.onDelete}>
        <IconTrash size={14} stroke={1.6} />
      </button>
    </NodeToolbar>
    <Handle type="target" position={Position.Top} style={{ opacity: 0 }} />
    <div className="wf-node-label">{data.label}</div>
    <Handle type="source" position={Position.Bottom} style={{ opacity: 0 }} />
  </>
);

const LoopNode = ({ data, selected }) => (
  <>
    <NodeToolbar isVisible={selected} position={Position.Right} className="wf-node-toolbar">
      <button type="button" title="Delete loop (and its steps)" onClick={data.onDelete}>
        <IconTrash size={14} stroke={1.6} />
      </button>
    </NodeToolbar>
    <Handle type="target" position={Position.Top} style={{ opacity: 0 }} />
    <div className="wf-node-label wf-loop-label">{data.label}</div>
    <Handle type="source" position={Position.Bottom} style={{ opacity: 0 }} />
  </>
);

const nodeTypes = { step: StepNode, loopGroup: LoopNode };

// Vertical-chain auto layout. Returns nodes/edges plus an absolute-rect map
// used for drag hit-testing.
const buildGraph = (doc, stepResults, handlers) => {
  const nodes = [];
  const edges = [];
  const rects = {}; // stepId -> { x, y, width, height, parentId }

  const chain = (steps, parentId, originX, startY, parentAbs) => {
    let y = startY;
    let previousNodeId = null;

    for (const step of steps) {
      const result = stepResults?.[step.id];
      const statusColor = result ? STATUS_COLORS[result.status] : null;
      const absX = parentAbs.x + originX;
      const absY = parentAbs.y + y;

      if (step.type === 'loop') {
        const bodyCount = Math.max(step.steps?.length || 0, 1);
        const height = bodyCount * (NODE_HEIGHT + V_GAP) + LOOP_PADDING + LOOP_HEADER;
        const width = NODE_WIDTH + LOOP_PADDING * 2;

        nodes.push({
          id: step.id,
          type: 'loopGroup',
          position: { x: originX - LOOP_PADDING, y },
          data: {
            label: stepLabel(step),
            onDelete: () => handlers.onDeleteStep(step.id, parentId)
          },
          style: {
            width,
            height,
            borderRadius: 8,
            border: `1.5px dashed ${statusColor || '#8886'}`,
            background: '#8881',
            fontSize: 12,
            padding: '6px 10px'
          },
          ...(parentId ? { parentId } : {})
        });
        rects[step.id] = { x: absX - LOOP_PADDING, y: absY, width, height, parentId };

        chain(step.steps || [], step.id, LOOP_PADDING, LOOP_HEADER, { x: absX - LOOP_PADDING, y: absY });

        if (previousNodeId) {
          edges.push({ id: `${previousNodeId}->${step.id}`, source: previousNodeId, target: step.id });
        }
        previousNodeId = step.id;
        y += height + V_GAP;
        continue;
      }

      nodes.push({
        id: step.id,
        type: 'step',
        position: { x: originX, y },
        data: {
          label: stepLabel(step),
          isRequest: step.type === 'request',
          onDelete: () => handlers.onDeleteStep(step.id, parentId),
          onReveal: () => handlers.onRevealStep(step.id)
        },
        style: {
          width: NODE_WIDTH,
          fontSize: 12,
          borderRadius: 6,
          padding: '8px 10px',
          border: `1.5px solid ${statusColor || '#8884'}`,
          background: 'var(--color-bg, #1e1e1e08)'
        },
        ...(parentId ? { parentId } : {})
      });
      rects[step.id] = { x: absX, y: absY, width: NODE_WIDTH, height: NODE_HEIGHT, parentId };

      if (previousNodeId) {
        edges.push({ id: `${previousNodeId}->${step.id}`, source: previousNodeId, target: step.id });
      }
      previousNodeId = step.id;
      y += NODE_HEIGHT + V_GAP;
    }
  };

  chain(doc.steps || [], null, 40, 20, { x: 0, y: 0 });
  return { nodes, edges, rects };
};

// Insertion index inside a container: count steps (excluding the dragged
// one) whose layout center sits above the dropped point.
const computeInsertIndex = (containerSteps, rects, droppedCenterY, excludeStepId) => {
  let index = 0;
  for (const step of containerSteps) {
    if (step.id === excludeStepId) {
      continue;
    }
    const rect = rects[step.id];
    if (rect && rect.y + rect.height / 2 < droppedCenterY) {
      index += 1;
    }
  }
  return index;
};

const findContainerOfStep = (doc, stepId) => {
  if (doc.steps.some((step) => step.id === stepId)) {
    return { parentStepId: null, steps: doc.steps };
  }
  for (const step of doc.steps) {
    if (step.type === 'loop' && (step.steps || []).some((child) => child.id === stepId)) {
      return { parentStepId: step.id, steps: step.steps };
    }
  }
  return null;
};

const CanvasInner = ({ doc, stepResults, handlers, onSelectStep }) => {
  const { screenToFlowPosition } = useReactFlow();
  const { nodes: layoutNodes, edges, rects } = useMemo(
    () => buildGraph(doc, stepResults, handlers),
    [doc, stepResults, handlers]
  );

  // React Flow needs to own node state (selection, drag positions); we
  // re-impose the computed layout whenever the document changes.
  const [nodes, setNodes, onNodesChange] = useNodesState(layoutNodes);
  useEffect(() => {
    setNodes(layoutNodes);
  }, [layoutNodes, setNodes]);

  // Resolve the loop container (if any) for an absolute point on the canvas.
  const containerAt = useCallback((point, excludeStepId) => {
    for (const [stepId, rect] of Object.entries(rects)) {
      if (stepId === excludeStepId) {
        continue;
      }
      const step = doc.steps.find((candidate) => candidate.id === stepId);
      if (!step || step.type !== 'loop') {
        continue;
      }
      if (point.x >= rect.x && point.x <= rect.x + rect.width
        && point.y >= rect.y && point.y <= rect.y + rect.height) {
        return step;
      }
    }
    return null;
  }, [rects, doc]);

  const handleNodeDragStop = useCallback((event, node) => {
    const dragged = rects[node.id];
    if (!dragged) {
      return;
    }

    // node.position of children is relative to the parent group
    const parentRect = node.parentId ? rects[node.parentId] : null;
    const absX = (parentRect ? parentRect.x : 0) + node.position.x;
    const absY = (parentRect ? parentRect.y : 0) + node.position.y;
    const center = { x: absX + dragged.width / 2, y: absY + dragged.height / 2 };

    const draggedContainer = findContainerOfStep(doc, node.id);
    if (!draggedContainer) {
      return;
    }

    const draggedStep = [...doc.steps, ...doc.steps.flatMap((s) => s.steps || [])]
      .find((candidate) => candidate.id === node.id);
    const targetLoop = draggedStep?.type === 'loop' ? null : containerAt(center, node.id);
    const targetParentId = targetLoop ? targetLoop.id : null;
    const targetSteps = targetLoop ? (targetLoop.steps || []) : doc.steps;
    const insertIndex = computeInsertIndex(targetSteps, rects, center.y, node.id);

    // no-op when nothing changes (covers accidental micro-drags)
    if (targetParentId === draggedContainer.parentStepId) {
      const currentIndex = draggedContainer.steps.findIndex((step) => step.id === node.id);
      const effectiveIndex = insertIndex > currentIndex ? insertIndex : insertIndex;
      if (currentIndex === effectiveIndex || (insertIndex === currentIndex)) {
        return;
      }
    }

    handlers.onRestructureStep(node.id, { parentStepId: targetParentId, index: insertIndex });
  }, [rects, doc, containerAt, handlers]);

  const handleSelectionChange = useCallback(({ nodes: selectedNodes }) => {
    onSelectStep(selectedNodes?.[0]?.id || null);
  }, [onSelectStep]);

  // Drop target for requests dragged from the sidebar.
  const [{ isOver }, dropRef] = useDrop({
    accept: 'collection-item',
    drop: (draggedItem, monitor) => {
      if (draggedItem.type === 'folder') {
        return;
      }
      const clientOffset = monitor.getClientOffset();
      if (!clientOffset) {
        return;
      }
      const point = screenToFlowPosition({ x: clientOffset.x, y: clientOffset.y });
      const targetLoop = containerAt(point, null);
      const targetSteps = targetLoop ? (targetLoop.steps || []) : doc.steps;
      const insertIndex = computeInsertIndex(targetSteps, rects, point.y, null);
      handlers.onDropRequest(draggedItem, {
        parentStepId: targetLoop ? targetLoop.id : null,
        index: insertIndex
      });
    },
    collect: (monitor) => ({ isOver: monitor.isOver() })
  });

  return (
    <div
      ref={dropRef}
      className={`wf-canvas ${isOver ? 'wf-canvas-drop-active' : ''}`}
      data-testid="workflow-canvas"
    >
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        fitView
        nodesConnectable={false}
        elementsSelectable
        onNodeDragStop={handleNodeDragStop}
        onSelectionChange={handleSelectionChange}
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={18} size={1} />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
};

const WorkflowCanvas = (props) => (
  <ReactFlowProvider>
    <CanvasInner {...props} />
  </ReactFlowProvider>
);

export default WorkflowCanvas;
