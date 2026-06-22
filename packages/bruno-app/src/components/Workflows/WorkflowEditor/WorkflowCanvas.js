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
  useEdgesState,
  useReactFlow
} from '@xyflow/react';
import {
  IconArrowsSplit,
  IconClock,
  IconPlayerPause,
  IconPlayerPlay,
  IconRepeat,
  IconTarget,
  IconTrash,
  IconWand,
  IconWorld
} from '@tabler/icons';
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

const CanvasInner = ({ doc, drift, stepResults, handlers, selectedNodeId, onSelectNode }) => {
  const { screenToFlowPosition } = useReactFlow();

  const layoutNodes = useMemo(() => doc.nodes.map((node) => ({
    id: node.id,
    type: 'gridman',
    position: node.position || { x: 0, y: 0 },
    selected: node.id === selectedNodeId,
    data: {
      node,
      drift: drift?.[node.id]?.status,
      result: stepResults?.[node.id],
      onDelete: handlers.onDeleteNode,
      onReveal: handlers.onRevealNode,
      onToggleDisabled: handlers.onToggleDisabled
    }
  })), [doc.nodes, drift, stepResults, handlers, selectedNodeId]);

  const layoutEdges = useMemo(() => (doc.connections || []).map((conn) => ({
    id: conn.id,
    source: conn.source,
    target: conn.target,
    sourceHandle: conn.sourcePort,
    targetHandle: 'in',
    reconnectable: true,
    animated: Boolean(stepResults && stepResults[conn.source])
  })), [doc.connections, stepResults]);

  const [nodes, setNodes, onNodesChange] = useNodesState(layoutNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(layoutEdges);
  useEffect(() => setNodes(layoutNodes), [layoutNodes, setNodes]);
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

  const onEdgesDelete = useCallback((deleted) => {
    for (const edge of deleted) {
      handlers.onDeleteConnection(edge.id);
    }
  }, [handlers]);

  const onNodeDragStop = useCallback((event, node) => {
    handlers.onMoveNode(node.id, node.position);
  }, [handlers]);

  const onNodesDelete = useCallback((deleted) => {
    for (const node of deleted) {
      if (node.id !== doc.nodes.find((n) => n.type === 'start')?.id) {
        handlers.onDeleteNode(node.id);
      }
    }
  }, [handlers, doc.nodes]);

  const handleSelectionChange = useCallback(({ nodes: selectedNodes }) => {
    onSelectNode(selectedNodes?.[0]?.id || null);
  }, [onSelectNode]);

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
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onReconnect={onReconnect}
        onEdgesDelete={onEdgesDelete}
        onNodesDelete={onNodesDelete}
        onNodeDragStop={onNodeDragStop}
        onSelectionChange={handleSelectionChange}
        fitView
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
