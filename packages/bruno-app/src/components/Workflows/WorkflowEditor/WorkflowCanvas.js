import { useEffect, useMemo, useCallback, useRef, useState } from 'react';
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
  NodeResizer,
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
  IconCode,
  IconCopy,
  IconLayoutGridAdd,
  IconNote,
  IconPinned,
  IconPlayerPause,
  IconPlayerPlay,
  IconPlus,
  IconRepeat,
  IconSearch,
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

// Failed-but-handled (routed out a request's error port): warning yellow, not
// danger red — the run continued.
const HANDLED_COLOR = '#eab308';

const DRIFT_COLORS = {
  drifted: '#eab308',
  detached: '#ef4444'
};

// Sticky-note background tints (same pattern as STATUS_COLORS: a small fixed
// map that reads on both light and dark themes via low-alpha rgba).
const NOTE_TINTS = {
  yellow: { bg: 'rgba(234, 179, 8, 0.14)', border: 'rgba(234, 179, 8, 0.55)' },
  green: { bg: 'rgba(34, 197, 94, 0.14)', border: 'rgba(34, 197, 94, 0.55)' },
  blue: { bg: 'rgba(59, 130, 246, 0.14)', border: 'rgba(59, 130, 246, 0.55)' },
  pink: { bg: 'rgba(236, 72, 153, 0.14)', border: 'rgba(236, 72, 153, 0.55)' }
};

const TYPE_ICONS = {
  start: IconPlayerPlay,
  request: IconWorld,
  map: IconWand,
  condition: IconArrowsSplit,
  delay: IconClock,
  loop: IconRepeat,
  script: IconCode,
  note: IconNote
};

// Output ports rendered per node type (mirror of NODE_OUTPUT_PORTS in the
// workflows slice; notes render separately and never reach this map).
const OUTPUT_PORTS = {
  start: ['main'],
  request: ['main', 'error'],
  condition: ['true', 'false'],
  loop: ['loop', 'done']
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
      return node.mode === 'count' ? `Repeat ${node.count || '?'}x` : `For each ${node.itemVar || 'item'}`;
    case 'script':
      return node.name || 'Script';
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
      return node.mode === 'count' ? `${node.count || '?'} times` : `in vars.${node.source || '?'}`;
    case 'map':
      return (node.mappings || []).map((m) => m.target).filter(Boolean).join(', ');
    case 'script':
      return node.assignTo ? `→ vars.${node.assignTo}` : '';
    default:
      return '';
  }
};

// Sticky note: a colored panel rendered BEHIND flow nodes (low zIndex, set on
// the React Flow node). No ports, never executed. Double-click edits the text
// in place (it does NOT open the NDV).
const NoteNode = ({ data, selected }) => {
  const { node } = data;
  const [editing, setEditing] = useState(false);
  const tint = NOTE_TINTS[node.tint] || NOTE_TINTS.yellow;
  const width = node.size?.width || 200;
  const height = node.size?.height || 120;

  return (
    <div
      className={`wf-note ${selected ? 'wf-note-selected' : ''}`}
      style={{ width, height, background: tint.bg, borderColor: tint.border }}
      onDoubleClick={(event) => {
        event.stopPropagation(); // keep the canvas from opening the NDV
        setEditing(true);
      }}
      data-testid="workflow-note"
    >
      <NodeResizer
        isVisible={selected}
        minWidth={120}
        minHeight={80}
        onResizeEnd={(event, params) => data.onPatchNode(node.id, {
          size: { width: Math.round(params.width), height: Math.round(params.height) },
          position: { x: Math.round(params.x), y: Math.round(params.y) }
        })}
      />
      <NodeToolbar isVisible={selected} position={Position.Top} className="wf-node-toolbar">
        {Object.keys(NOTE_TINTS).map((tintName) => (
          <button
            key={tintName}
            type="button"
            className={`wf-note-swatch ${node.tint === tintName ? 'active' : ''}`}
            style={{ background: NOTE_TINTS[tintName].border }}
            title={`${tintName} note`}
            onClick={() => data.onPatchNode(node.id, { tint: tintName })}
          />
        ))}
        <button type="button" title="Duplicate note (Ctrl/Cmd+D)" onClick={() => data.onDuplicate(node.id)}>
          <IconCopy size={14} stroke={1.6} />
        </button>
        <button type="button" title="Delete note" onClick={() => data.onDelete(node.id)}>
          <IconTrash size={14} stroke={1.6} />
        </button>
      </NodeToolbar>
      {editing ? (
        <textarea
          className="wf-note-text nodrag nowheel"
          autoFocus
          defaultValue={node.content}
          placeholder="Write a note..."
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.stopPropagation();
              event.currentTarget.blur();
            }
          }}
          onBlur={(event) => {
            setEditing(false);
            if (event.target.value !== node.content) {
              data.onPatchNode(node.id, { content: event.target.value });
            }
          }}
        />
      ) : (
        <div className={`wf-note-content ${node.content ? '' : 'wf-note-placeholder'}`}>
          {node.content || 'Double-click to edit'}
        </div>
      )}
    </div>
  );
};

const GridmanNode = ({ data, selected }) => {
  const { node, drift, result } = data;
  const Icon = TYPE_ICONS[node.type] || IconWorld;

  if (node.type === 'note') {
    return <NoteNode data={data} selected={selected} />;
  }

  // Handled failures (request error port fired) render as warnings, not
  // run-stopping errors.
  const isHandledFailure = result?.status === 'failed' && result?.handled;
  const borderColor = result && STATUS_COLORS[result.status]
    ? (isHandledFailure ? HANDLED_COLOR : STATUS_COLORS[result.status])
    : (drift && DRIFT_COLORS[drift] ? DRIFT_COLORS[drift] : 'var(--wf-node-border, #8886)');

  // Surface a failed node's error on hover without opening the panel.
  const errorTitle = result?.status === 'failed' && result.error
    ? String(result.error).slice(0, 200)
    : undefined;

  const outputs = OUTPUT_PORTS[node.type] || ['main'];

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
        {node.pinnedOutput !== undefined && (
          <span className="wf-node-pin" title="Output pinned — runs reuse this output instead of executing">
            <IconPinned size={12} stroke={1.8} />
          </span>
        )}
      </div>
      {nodeSubtitle(node) ? <div className="wf-node-sub">{nodeSubtitle(node)}</div> : null}
      {result && (
        <div className={`wf-node-result result-${result.status}${isHandledFailure ? ' result-handled' : ''}`}>
          {result.httpStatus ? `${result.httpStatus} ` : ''}
          {typeof result.iterations === 'number' ? `${result.iterations}x ` : ''}
          {result.status}
          {isHandledFailure ? ' (handled)' : ''}
          {result.pinned ? ' (pinned)' : ''}
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

// Fold-insensitive contains-match over a node's name, type and request ref.
const nodeMatchesQuery = (node, query) => {
  const haystack = `${node.name || ''} ${node.type || ''} ${node.ref ? `${node.ref.collection}/${node.ref.request}` : ''}`.toLowerCase();
  return haystack.includes(query);
};

const CanvasInner = ({ doc, drift, stepResults, handlers, onSelectNodes, canUndo, canRedo, shortcutsDisabled }) => {
  const { screenToFlowPosition, fitView, setCenter, getZoom } = useReactFlow();
  const wrapperRef = useRef(null);
  // Node ids to select once they appear in the doc (set after paste/duplicate,
  // consumed by the layout sync effect below).
  const pendingSelectionRef = useRef(null);
  // Node search (Ctrl/Cmd+F): matches live-filter as the query changes;
  // Enter/arrows cycle; Escape closes the box before it deselects anything.
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchIndex, setSearchIndex] = useState(0);
  const [searchHitId, setSearchHitId] = useState(null);

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
    // Sticky notes sit behind the flow nodes.
    zIndex: node.type === 'note' ? -10 : undefined,
    className: node.id === searchHitId ? 'wf-search-hit' : undefined,
    data: {
      node,
      drift: drift?.[node.id]?.status,
      result: stepResults?.[node.id],
      onDelete: handlers.onDeleteNode,
      onReveal: handlers.onRevealNode,
      onToggleDisabled: handlers.onToggleDisabled,
      onQuickAddOutput: handlers.onQuickAddOutput,
      onPatchNode: handlers.onPatchNode,
      onDuplicate: (id) => duplicateNodes([id])
    }
  })), [doc.nodes, drift, stepResults, handlers, duplicateNodes, searchHitId]);

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

  // Double-click opens the fullscreen Node Detail View for the node (it also
  // becomes the single selection, so the side panel matches once the NDV
  // closes). Sticky notes are edited in place instead — no NDV.
  const onNodeDoubleClick = useCallback((event, node) => {
    setNodes((prev) => prev.map((n) => (n.selected === (n.id === node.id) ? n : { ...n, selected: n.id === node.id })));
    onSelectNodes([node.id]);
    if (node.data?.node?.type !== 'note') {
      handlers.onOpenNodeDetail?.(node.id);
    }
  }, [setNodes, onSelectNodes, handlers]);

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

  // ---- Node search (Ctrl/Cmd+F) ----

  const searchMatches = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!searchOpen || !query) {
      return [];
    }
    return doc.nodes.filter((node) => nodeMatchesQuery(node, query)).map((node) => node.id);
  }, [doc.nodes, searchOpen, searchQuery]);

  // Select + center + ring a match.
  const focusSearchMatch = useCallback((index) => {
    const id = searchMatches[index];
    if (!id) {
      return;
    }
    setSearchIndex(index);
    setSearchHitId(id);
    setNodes((prev) => prev.map((n) => (n.selected === (n.id === id) ? n : { ...n, selected: n.id === id })));
    onSelectNodes([id]);
    const node = doc.nodes.find((n) => n.id === id);
    if (node?.position) {
      // Center on the node's approximate middle at the current zoom.
      const width = node.type === 'note' ? (node.size?.width || 200) : 210;
      const height = node.type === 'note' ? (node.size?.height || 120) : 70;
      setCenter(node.position.x + width / 2, node.position.y + height / 2, { duration: 250, zoom: getZoom() });
    }
  }, [searchMatches, setNodes, onSelectNodes, doc.nodes, setCenter, getZoom]);

  const closeSearch = useCallback(() => {
    setSearchOpen(false);
    setSearchQuery('');
    setSearchIndex(0);
    setSearchHitId(null);
  }, []);

  // Live filter: whenever the query (or the doc under it) changes, jump to the
  // first match.
  useEffect(() => {
    if (!searchOpen) {
      return;
    }
    if (!searchMatches.length) {
      setSearchIndex(0);
      setSearchHitId(null);
      return;
    }
    focusSearchMatch(0);
    // (deliberately keyed on the match LIST, not focusSearchMatch, so cycling
    // through matches doesn't snap back to the first one)
  }, [searchOpen, searchMatches.join('|')]);

  const cycleSearch = useCallback((step) => {
    if (!searchMatches.length) {
      return;
    }
    focusSearchMatch((searchIndex + step + searchMatches.length) % searchMatches.length);
  }, [searchMatches, searchIndex, focusSearchMatch]);

  const onSearchInputKeyDown = useCallback((event) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      closeSearch();
    } else if (event.key === 'Enter') {
      event.preventDefault();
      cycleSearch(event.shiftKey ? -1 : 1);
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      cycleSearch(1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      cycleSearch(-1);
    }
  }, [closeSearch, cycleSearch]);

  // Canvas shortcuts: Escape close-search/deselect, Ctrl/Cmd C/V/D
  // copy/paste/duplicate, Ctrl/Cmd+F search, Ctrl/Cmd+Z undo,
  // Ctrl/Cmd+Shift+Z / Ctrl/Cmd+Y redo. Guarded so they never fire while
  // typing, only while this canvas is visible. While the Node Detail View is
  // open it owns the keyboard — EXCEPT undo/redo, which stay available (the
  // NDV re-renders from the doc and closes itself if its node vanishes).
  useEffect(() => {
    const onKeyDown = (event) => {
      if (!wrapperRef.current || !wrapperRef.current.offsetParent) {
        return; // canvas hidden (e.g. another view) — don't hijack keys
      }
      if (isEditableTarget(event.target) || isEditableTarget(document.activeElement)) {
        return;
      }
      const meta = event.metaKey || event.ctrlKey;
      const key = String(event.key).toLowerCase();
      const isUndoRedo = meta && (key === 'z' || key === 'y');
      if (shortcutsDisabled && !isUndoRedo) {
        return; // the NDV owns the keyboard while it's open (except undo/redo)
      }
      if (event.key === 'Escape') {
        // First Escape closes the search box; the next one deselects.
        if (searchOpen) {
          closeSearch();
        } else {
          clearSelection();
        }
        return;
      }
      if (!meta) {
        return;
      }
      if (key === 'c') {
        copySelection();
      } else if (key === 'v') {
        event.preventDefault();
        pasteClipboard();
      } else if (key === 'd') {
        event.preventDefault();
        duplicateSelection();
      } else if (key === 'f') {
        event.preventDefault();
        setSearchOpen(true);
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
  }, [clearSelection, copySelection, pasteClipboard, duplicateSelection, handlers, shortcutsDisabled, searchOpen, closeSearch]);

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
        // Left-drag pans the canvas (what users expect from a map-like
        // surface); hold Shift and drag for box selection.
        panOnDrag
        selectionOnDrag={false}
        selectionKeyCode="Shift"
        selectionMode={SelectionMode.Partial}
        multiSelectionKeyCode={['Meta', 'Control']}
        deleteKeyCode={shortcutsDisabled ? null : ['Backspace', 'Delete']}
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
      {searchOpen && (
        <div className="wf-search" data-testid="workflow-search">
          <IconSearch size={13} stroke={1.8} />
          <input
            type="text"
            autoFocus
            placeholder="Search nodes..."
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            onKeyDown={onSearchInputKeyDown}
          />
          <span className="wf-search-count">
            {searchQuery.trim() ? `${searchMatches.length ? searchIndex + 1 : 0}/${searchMatches.length}` : ''}
          </span>
        </div>
      )}
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
