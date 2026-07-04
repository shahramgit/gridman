import { useEffect, useMemo, useCallback, useRef } from 'react';
import { useDrop } from 'react-dnd';
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  BaseEdge,
  Controls,
  ControlButton,
  EdgeLabelRenderer,
  MiniMap,
  Handle,
  NodeToolbar,
  Position,
  SelectionMode,
  getBezierPath,
  useNodesState,
  useEdgesState,
  useReactFlow
} from '@xyflow/react';
import {
  IconArrowBackUp,
  IconArrowForwardUp,
  IconArrowsSplit,
  IconClock,
  IconCopy,
  IconLayoutGridAdd,
  IconPlayerPause,
  IconPlayerPlay,
  IconPlus,
  IconRepeat,
  IconTarget,
  IconTrash,
  IconWand,
  IconWorld
} from '@tabler/icons';
import { collectClipboardPayload } from 'providers/ReduxStore/slices/workflows-canvas-helpers';
import '@xyflow/react/dist/style.css';

const STATUS_COLORS = {
  passed: '#22c55e',
  failed: '#ef4444',
  running: '#3b82f6'
};

const DRIFT_COLORS = {
  drifted: '#eab308',
  detached: '#ef4444'
};

const TYPE_ICONS = {
  start: IconPlayerPlay,
  request: IconWorld,
  map: IconWand,
  condition: IconArrowsSplit,
  delay: IconClock,
  loop: IconRepeat
};

// Renderer-local clipboard shared by all workflow canvases (NOT the OS
// clipboard). pasteCount grows with each paste so repeats don't stack.
let workflowClipboard = null; // { nodes, connections, pasteCount }

// Keyboard shortcuts must never fire while the user is typing.
const isEditableTarget = (element) => {
  if (!element || element === document.body) {
    return false;
  }
  const tag = element.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
    return true;
  }
  if (element.isContentEditable) {
    return true;
  }
  return Boolean(element.closest?.('.CodeMirror'));
};

const nodeTitle = (node) => {
  switch (node.type) {
    case 'request':
      return `${node.snapshot?.request?.method || ''} ${node.name}`.trim();
    case 'map':
      return node.name || 'Map response';
    case 'setvars':
      return node.name || 'Set variables';
    case 'condition':
      return node.name || 'Condition';
    case 'delay':
      return `Delay ${node.durationMs}ms`;
    case 'loop':
      return `For each ${node.itemVar || 'item'}`;
    case 'start':
      return 'Start';
    default:
      return node.name;
  }
};

const nodeSubtitle = (node) => {
  switch (node.type) {
    case 'request':
      return `${node.ref?.collection || ''}/${node.ref?.request || ''}`;
    case 'condition':
      return node.expression || '';
    case 'loop':
      return `in vars.${node.source || '?'}`;
    case 'map':
      return (node.mappings || []).map((m) => m.target).filter(Boolean).join(', ');
    default:
      return '';
  }
};

const GridmanNode = ({ data, selected }) => {
  const { node, drift, result } = data;
  const Icon = TYPE_ICONS[node.type] || IconWorld;

  const borderColor = result && STATUS_COLORS[result.status]
    ? STATUS_COLORS[result.status]
    : (drift && DRIFT_COLORS[drift] ? DRIFT_COLORS[drift] : 'var(--wf-node-border, #8886)');

  // Surface a failed node's error on hover without opening the panel.
  const errorTitle = result?.status === 'failed' && result.error
    ? String(result.error).slice(0, 200)
    : undefined;

  const outputs = node.type === 'condition'
    ? ['true', 'false']
    : node.type === 'loop'
      ? ['loop', 'done']
      : node.type === 'start'
        ? ['main']
        : ['main'];

  return (
    <div
      className={`wf-node wf-node-${node.type} ${selected ? 'wf-node-selected' : ''} ${node.disabled ? 'wf-node-disabled' : ''}`}
      style={{ borderColor }}
      title={errorTitle}
    >
      <NodeToolbar isVisible={selected} position={Position.Top} className="wf-node-toolbar">
        {node.type === 'request' && (
          <button type="button" title="Show request in sidebar" onClick={() => data.onReveal(node.id)}>
            <IconTarget size={14} stroke={1.6} />
          </button>
        )}
        {node.type !== 'start' && (
          <button
            type="button"
            title={node.disabled ? 'Enable node' : 'Disable node (skip during run)'}
            onClick={() => data.onToggleDisabled(node.id, !node.disabled)}
          >
            {node.disabled ? <IconPlayerPlay size={14} stroke={1.6} /> : <IconPlayerPause size={14} stroke={1.6} />}
          </button>
        )}
        {node.type !== 'start' && (
          <button type="button" title="Duplicate node (Ctrl/Cmd+D)" onClick={() => data.onDuplicate(node.id)}>
            <IconCopy size={14} stroke={1.6} />
          </button>
        )}
        {node.type !== 'start' && (
          <button type="button" title="Delete node" onClick={() => data.onDelete(node.id)}>
            <IconTrash size={14} stroke={1.6} />
          </button>
        )}
      </NodeToolbar>

      {node.type !== 'start' && <Handle type="target" position={Position.Left} id="in" />}

      <div className="wf-node-head">
        <Icon size={14} stroke={1.7} className="wf-node-icon" />
        <span className="wf-node-title">{nodeTitle(node)}</span>
      </div>
      {nodeSubtitle(node) ? <div className="wf-node-sub">{nodeSubtitle(node)}</div> : null}
      {result && (
        <div className={`wf-node-result result-${result.status}`}>
          {result.httpStatus ? `${result.httpStatus} ` : ''}
          {typeof result.iterations === 'number' ? `${result.iterations}x ` : ''}
          {result.status}
        </div>
      )}

      {outputs.map((port, i) => (
        <Handle
          key={port}
          type="source"
          position={Position.Right}
          id={port}
          style={outputs.length > 1
            ? { top: `${30 + i * 22}px` }
            : undefined}
        >
        </Handle>
      ))}
      {outputs.map((port, i) => (
        <button
          key={`add-${port}`}
          type="button"
          className="wf-quick-add"
          title={`Add a node after ${outputs.length > 1 ? `${port} ` : ''}this`}
          style={outputs.length > 1 ? { top: `${30 + i * 22}px` } : undefined}
          onClick={(event) => {
            event.stopPropagation();
            data.onQuickAddOutput({
              source: node.id,
              sourcePort: port,
              position: { x: (node.position?.x || 0) + 240, y: (node.position?.y || 0) + i * 90 },
              screen: { x: event.clientX, y: event.clientY }
            });
          }}
        >
          <IconPlus size={11} stroke={2.4} />
        </button>
      ))}
      {outputs.length > 1 && (
        <div className="wf-port-labels">
          {outputs.map((port, i) => (
            <span key={port} className="wf-port-label" style={{ top: `${24 + i * 22}px` }}>{port}</span>
          ))}
        </div>
      )}
    </div>
  );
};

const nodeTypes = { gridman: GridmanNode };

// Connection with a "+" at its midpoint to insert a node between two nodes.
const QuickAddEdge = ({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, markerEnd, data, ...rest }) => {
  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition
  });

  return (
    <>
      <BaseEdge id={id} path={edgePath} markerEnd={markerEnd} style={rest.style} />
      <EdgeLabelRenderer>
        <button
          type="button"
          className="wf-edge-add nodrag nopan"
          title="Insert a node here"
          style={{
            position: 'absolute',
            transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
            pointerEvents: 'all'
          }}
          onClick={(event) => {
            event.stopPropagation();
            data?.onInsert?.({
              connectionId: data.connectionId,
              position: { x: labelX - 90, y: labelY },
              screen: { x: event.clientX, y: event.clientY }
            });
          }}
        >
          <IconPlus size={11} stroke={2.4} />
        </button>
      </EdgeLabelRenderer>
    </>
  );
};

const edgeTypes = { quickadd: QuickAddEdge };

const CanvasInner = ({ doc, drift, stepResults, handlers, onSelectNodes, canUndo, canRedo }) => {
  const { screenToFlowPosition, fitView } = useReactFlow();
  const wrapperRef = useRef(null);
  // Node ids to select once they appear in the doc (set after paste/duplicate,
  // consumed by the layout sync effect below).
  const pendingSelectionRef = useRef(null);

  const onTidy = useCallback(async () => {
    await handlers.onTidy();
    // Re-fit once the relaid-out nodes have rendered.
    setTimeout(() => fitView({ duration: 300, padding: 0.2 }), 50);
  }, [handlers, fitView]);

  // Duplicate nodes and select the copies once the refreshed doc lands.
  const duplicateNodes = useCallback(async (nodeIds) => {
    const newIds = await handlers.onDuplicateNodes(nodeIds);
    if (newIds?.length) {
      pendingSelectionRef.current = newIds;
    }
  }, [handlers]);

  const layoutNodes = useMemo(() => doc.nodes.map((node) => ({
    id: node.id,
    type: 'gridman',
    position: node.position || { x: 0, y: 0 },
    deletable: node.type !== 'start', // the Start node is permanent
    data: {
      node,
      drift: drift?.[node.id]?.status,
      result: stepResults?.[node.id],
      onDelete: handlers.onDeleteNode,
      onReveal: handlers.onRevealNode,
      onToggleDisabled: handlers.onToggleDisabled,
      onQuickAddOutput: handlers.onQuickAddOutput,
      onDuplicate: (id) => duplicateNodes([id])
    }
  })), [doc.nodes, drift, stepResults, handlers, duplicateNodes]);

  const layoutEdges = useMemo(() => (doc.connections || []).map((conn) => ({
    id: conn.id,
    source: conn.source,
    target: conn.target,
    sourceHandle: conn.sourcePort,
    targetHandle: 'in',
    type: 'quickadd',
    reconnectable: true,
    animated: Boolean(stepResults && stepResults[conn.source]),
    data: { connectionId: conn.id, onInsert: handlers.onInsertOnEdge }
  })), [doc.connections, stepResults, handlers]);

  const [nodes, setNodes, onNodesChange] = useNodesState(layoutNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(layoutEdges);

  // Sync nodes from the doc while preserving the current multi-selection
  // (React Flow owns selection state). A pending selection (from paste or
  // duplicate) wins once all of its nodes exist.
  useEffect(() => {
    const pending = pendingSelectionRef.current;
    if (pending?.length && pending.every((id) => layoutNodes.some((n) => n.id === id))) {
      pendingSelectionRef.current = null;
      setNodes(layoutNodes.map((n) => ({ ...n, selected: pending.includes(n.id) })));
      onSelectNodes(pending);
      return;
    }
    setNodes((prev) => {
      const selectedIds = new Set(prev.filter((n) => n.selected).map((n) => n.id));
      return layoutNodes.map((n) => ({ ...n, selected: selectedIds.has(n.id) }));
    });
  }, [layoutNodes, setNodes, onSelectNodes]);
  useEffect(() => setEdges(layoutEdges), [layoutEdges, setEdges]);

  const onConnect = useCallback((connection) => {
    handlers.onConnect({
      source: connection.source,
      sourcePort: connection.sourceHandle || 'main',
      target: connection.target
    });
  }, [handlers]);

  const onReconnect = useCallback((oldEdge, connection) => {
    handlers.onReconnect(oldEdge.id, {
      source: connection.source,
      sourcePort: connection.sourceHandle || 'main',
      target: connection.target
    });
  }, [handlers]);

  // A group drag reports every dragged node — persist all their positions in
  // one write.
  const onNodeDragStop = useCallback((event, node, draggedNodes) => {
    const moved = (draggedNodes?.length ? draggedNodes : [node])
      .map((n) => ({ id: n.id, position: n.position }));
    handlers.onMoveNodes(moved);
  }, [handlers]);

  // Delete/Backspace removes the whole selection (nodes minus Start, plus any
  // selected edges) in one doc write. Edges attached to removed nodes are
  // dropped by the same write, so they're filtered out here.
  const onDelete = useCallback(({ nodes: deletedNodes = [], edges: deletedEdges = [] }) => {
    const nodeIds = deletedNodes
      .filter((n) => n.data?.node?.type !== 'start')
      .map((n) => n.id);
    const removedSet = new Set(nodeIds);
    const edgeIds = deletedEdges
      .filter((e) => !removedSet.has(e.source) && !removedSet.has(e.target))
      .map((e) => e.id);
    if (!nodeIds.length && !edgeIds.length) {
      return;
    }
    handlers.onDeleteSelection(nodeIds, edgeIds);
  }, [handlers]);

  const handleSelectionChange = useCallback(({ nodes: selectedNodes }) => {
    onSelectNodes((selectedNodes || []).map((n) => n.id));
  }, [onSelectNodes]);

  // Double-click focuses a node: it becomes the single selection, which opens
  // the right panel.
  const onNodeDoubleClick = useCallback((event, node) => {
    setNodes((prev) => prev.map((n) => (n.selected === (n.id === node.id) ? n : { ...n, selected: n.id === node.id })));
    onSelectNodes([node.id]);
  }, [setNodes, onSelectNodes]);

  const clearSelection = useCallback(() => {
    setNodes((prev) => prev.map((n) => (n.selected ? { ...n, selected: false } : n)));
    setEdges((prev) => prev.map((e) => (e.selected ? { ...e, selected: false } : e)));
    onSelectNodes([]);
  }, [setNodes, setEdges, onSelectNodes]);

  const copySelection = useCallback(() => {
    const selectedIds = nodes.filter((n) => n.selected).map((n) => n.id);
    const payload = collectClipboardPayload(doc, selectedIds);
    if (!payload.nodes.length) {
      return;
    }
    workflowClipboard = { ...payload, pasteCount: 0 };
  }, [nodes, doc]);

  const pasteClipboard = useCallback(async () => {
    if (!workflowClipboard?.nodes?.length) {
      return;
    }
    workflowClipboard.pasteCount += 1;
    const newIds = await handlers.onPasteNodes(
      { nodes: workflowClipboard.nodes, connections: workflowClipboard.connections },
      workflowClipboard.pasteCount
    );
    if (newIds?.length) {
      pendingSelectionRef.current = newIds;
    }
  }, [handlers]);

  const duplicateSelection = useCallback(() => {
    const selectedIds = nodes.filter((n) => n.selected).map((n) => n.id);
    if (selectedIds.length) {
      duplicateNodes(selectedIds);
    }
  }, [nodes, duplicateNodes]);

  // Canvas shortcuts: Escape deselect, Ctrl/Cmd C/V/D copy/paste/duplicate,
  // Ctrl/Cmd+Z undo, Ctrl/Cmd+Shift+Z / Ctrl/Cmd+Y redo. Guarded so they
  // never fire while typing, and only while this canvas is visible.
  useEffect(() => {
    const onKeyDown = (event) => {
      if (!wrapperRef.current || !wrapperRef.current.offsetParent) {
        return; // canvas hidden (e.g. another view) — don't hijack keys
      }
      if (isEditableTarget(event.target) || isEditableTarget(document.activeElement)) {
        return;
      }
      if (event.key === 'Escape') {
        clearSelection();
        return;
      }
      if (!(event.metaKey || event.ctrlKey)) {
        return;
      }
      const key = String(event.key).toLowerCase();
      if (key === 'c') {
        copySelection();
      } else if (key === 'v') {
        event.preventDefault();
        pasteClipboard();
      } else if (key === 'd') {
        event.preventDefault();
        duplicateSelection();
      } else if (key === 'z') {
        event.preventDefault();
        if (event.shiftKey) {
          handlers.onRedo();
        } else {
          handlers.onUndo();
        }
      } else if (key === 'y') {
        event.preventDefault();
        handlers.onRedo();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [clearSelection, copySelection, pasteClipboard, duplicateSelection, handlers]);

  const [{ isOver }, dropRef] = useDrop({
    accept: ['collection-item', 'workflow-node-template'],
    drop: (draggedItem, monitor) => {
      const clientOffset = monitor.getClientOffset();
      if (!clientOffset) {
        return;
      }
      const flow = screenToFlowPosition({ x: clientOffset.x, y: clientOffset.y });
      const position = { x: Math.round(flow.x), y: Math.round(flow.y) };

      if (monitor.getItemType() === 'workflow-node-template') {
        handlers.onDropNode(draggedItem.nodeType, position);
        return;
      }
      if (draggedItem.type === 'folder') {
        return;
      }
      handlers.onDropRequest(draggedItem, position);
    },
    collect: (monitor) => ({ isOver: monitor.isOver() })
  });

  const setWrapperRef = useCallback((element) => {
    wrapperRef.current = element;
    dropRef(element);
  }, [dropRef]);

  // Only the permanent Start node -> nudge the user toward the palette.
  const isEmpty = doc.nodes.length <= 1;

  return (
    <div
      ref={setWrapperRef}
      className={`wf-canvas ${isOver ? 'wf-canvas-drop-active' : ''}`}
      data-testid="workflow-canvas"
    >
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onReconnect={onReconnect}
        onDelete={onDelete}
        onNodeDragStop={onNodeDragStop}
        onNodeDoubleClick={onNodeDoubleClick}
        onSelectionChange={handleSelectionChange}
        selectionOnDrag
        panOnDrag={[1, 2]}
        selectionMode={SelectionMode.Partial}
        multiSelectionKeyCode={['Meta', 'Control', 'Shift']}
        deleteKeyCode={['Backspace', 'Delete']}
        fitView
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={18} size={1} />
        <Controls showInteractive={false}>
          <ControlButton onClick={onTidy} title="Tidy up (auto-layout)">
            <IconLayoutGridAdd size={14} stroke={1.6} />
          </ControlButton>
          <ControlButton onClick={handlers.onUndo} disabled={!canUndo} title="Undo (Ctrl/Cmd+Z)">
            <IconArrowBackUp size={14} stroke={1.6} />
          </ControlButton>
          <ControlButton onClick={handlers.onRedo} disabled={!canRedo} title="Redo (Ctrl/Cmd+Shift+Z)">
            <IconArrowForwardUp size={14} stroke={1.6} />
          </ControlButton>
        </Controls>
        <MiniMap pannable zoomable nodeStrokeWidth={2} />
      </ReactFlow>
      {isEmpty && (
        <div className="wf-canvas-empty-hint">
          Drag a request from the sidebar, or drag a node from the palette
        </div>
      )}
    </div>
  );
};

const WorkflowCanvas = (props) => (
  <ReactFlowProvider>
    <CanvasInner {...props} />
  </ReactFlowProvider>
);

export default WorkflowCanvas;
