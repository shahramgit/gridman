import { useState } from 'react';
import { useDispatch } from 'react-redux';
import toast from 'react-hot-toast';
import { IconPin, IconPinned, IconRefresh, IconTarget, IconTrash } from '@tabler/icons';

import {
  revealWorkflowNode,
  syncWorkflowNodes,
  togglePinWorkflowNode
} from 'providers/ReduxStore/slices/workflows';
import ActionIcon from 'ui/ActionIcon';
import DriftDiffModal from './DriftDiffModal';
import { DroppableInput, DroppableTextarea } from './nodeIo';

// The per-node-type parameter editors, shared by the editor's right-hand side
// panel, the list view and the fullscreen Node Detail View — one
// implementation, no forks.

export const STATUS_LABELS = { linked: 'linked', drifted: 'changed', detached: 'detached' };

const MapNodeEditor = ({ node, onChange }) => {
  const mappings = node.mappings || [];
  const updateMapping = (index, patch) => {
    onChange({ mappings: mappings.map((m, i) => (i === index ? { ...m, ...patch } : m)) });
  };
  return (
    <div className="step-editor">
      {mappings.map((mapping, index) => (
        <div key={index} className="editor-row">
          <select value={mapping.from} onChange={(e) => updateMapping(index, { from: e.target.value })}>
            <option value="body">Body (JSONPath)</option>
            <option value="header">Header</option>
            <option value="status">Status</option>
          </select>
          {mapping.from !== 'status' && (
            <DroppableInput
              placeholder={mapping.from === 'header' ? 'header name' : '$.data.token'}
              value={mapping.path}
              onCommit={(val) => updateMapping(index, { path: val })}
              getRef={(field) => (mapping.from === 'header' ? (field.headerName || field.label) : (field.jsonPath || field.expr))}
            />
          )}
          <span className="editor-arrow">to</span>
          <input
            type="text"
            placeholder="variable name"
            defaultValue={mapping.target}
            onBlur={(e) => updateMapping(index, { target: e.target.value })}
          />
          <ActionIcon label="Remove mapping" onClick={() => onChange({ mappings: mappings.filter((_, i) => i !== index) })}>
            <IconTrash size={13} stroke={1.5} />
          </ActionIcon>
        </div>
      ))}
      <button type="button" className="editor-add" onClick={() => onChange({ mappings: [...mappings, { from: 'body', path: '$.', target: '' }] })}>
        + mapping
      </button>
    </div>
  );
};

const SetVarsNodeEditor = ({ node, onChange }) => {
  const assignments = node.assignments || [];
  const update = (index, patch) => {
    onChange({ assignments: assignments.map((a, i) => (i === index ? { ...a, ...patch } : a)) });
  };
  return (
    <div className="step-editor">
      {assignments.map((assignment, index) => (
        <div key={index} className="editor-row">
          <input
            type="text"
            placeholder="variable name"
            defaultValue={assignment.name}
            onBlur={(e) => update(index, { name: e.target.value })}
          />
          <span className="editor-arrow">=</span>
          <DroppableInput
            placeholder="value or {{otherVar}}"
            value={assignment.value}
            onCommit={(val) => update(index, { value: val })}
            getRef={(field) => field.template || field.expr}
          />
          <ActionIcon label="Remove" onClick={() => onChange({ assignments: assignments.filter((_, i) => i !== index) })}>
            <IconTrash size={13} stroke={1.5} />
          </ActionIcon>
        </div>
      ))}
      <button type="button" className="editor-add" onClick={() => onChange({ assignments: [...assignments, { name: '', value: '' }] })}>
        + variable
      </button>
      <div className="editor-hint">Values resolve {'{{var}}'} placeholders against the current flow variables.</div>
    </div>
  );
};

const ConditionNodeEditor = ({ node, onChange }) => (
  <div className="step-editor">
    <div className="editor-row">
      <DroppableInput
        className="expression-input"
        placeholder="res.status === 200 && vars.token"
        value={node.expression}
        onCommit={(val) => onChange({ expression: val })}
        getRef={(field) => field.expr}
      />
    </div>
    <div className="editor-hint">Wire the <strong>true</strong> and <strong>false</strong> outputs on the canvas. Expression sees res and vars.</div>
  </div>
);

const DelayNodeEditor = ({ node, onChange }) => (
  <div className="step-editor">
    <div className="editor-row">
      <input type="number" min="0" step="100" defaultValue={node.durationMs} onBlur={(e) => onChange({ durationMs: Number(e.target.value) || 0 })} />
      <span className="editor-arrow">ms</span>
    </div>
  </div>
);

const LoopNodeEditor = ({ node, onChange }) => {
  const mode = node.mode === 'count' ? 'count' : 'list';
  const itemVar = node.itemVar || 'item';
  return (
    <div className="step-editor">
      <div className="editor-row">
        <select value={mode} onChange={(e) => onChange({ mode: e.target.value })} data-testid="workflow-loop-mode">
          <option value="list">For each item</option>
          <option value="count">Repeat N times</option>
        </select>
        <span className="editor-arrow">as</span>
        <input type="text" placeholder="item" style={{ width: 80 }} defaultValue={node.itemVar} onBlur={(e) => onChange({ itemVar: e.target.value || 'item' })} />
        {mode === 'list' ? (
          <>
            <span className="editor-arrow">in vars.</span>
            <DroppableInput
              placeholder="arrayVariable"
              value={node.source}
              onCommit={(val) => onChange({ source: val })}
              getRef={(field) => field.varName || field.expr}
            />
          </>
        ) : (
          <>
            <span className="editor-arrow">count</span>
            <DroppableInput
              placeholder="3 or {{n}}"
              style={{ width: 100 }}
              value={node.count}
              onCommit={(val) => onChange({ count: val })}
              getRef={(field) => field.template || field.expr}
            />
          </>
        )}
        <span className="editor-arrow">max</span>
        <input type="number" min="1" style={{ width: 80 }} defaultValue={node.maxIterations} onBlur={(e) => onChange({ maxIterations: Number(e.target.value) || 100 })} />
      </div>
      <div className="editor-row">
        <span className="editor-arrow">break if</span>
        <DroppableInput
          className="expression-input"
          placeholder="optional — e.g. vars.done === true"
          value={node.breakExpr}
          onCommit={(val) => onChange({ breakExpr: val })}
          getRef={(field) => field.expr}
        />
      </div>
      <div className="editor-hint">
        Wire the <strong>loop</strong> output through the body and back into this node; <strong>done</strong> continues after the loop.
        {mode === 'count'
          ? <> Runs the body N times (count resolves {'{{var}}'} templates); vars.{itemVar} is the iteration index.</>
          : <> Exposes vars.{itemVar} and vars.{itemVar}Index.</>}
        {' '}The break expression (res/vars in scope) is checked after each iteration and exits to <strong>done</strong> when true.
      </div>
    </div>
  );
};

// Script node: plain JS with `res` (previous response) and `vars` in scope.
// A returned plain object merges into flow vars; anything else lands in
// vars[assignTo] when set. Plain textarea, not CodeMirror — the app's
// CodeMirror wrapper is a heavyweight controlled component tuned for request
// bodies; a monospace textarea matches the rest of these editors.
const ScriptNodeEditor = ({ node, onChange }) => (
  <div className="step-editor">
    <DroppableTextarea
      className="script-code-input"
      rows={10}
      placeholder={'// res and vars are in scope\n// return { token: res.body.token }'}
      value={node.code}
      onCommit={(val) => onChange({ code: val })}
      getRef={(field) => field.expr}
    />
    <div className="editor-row">
      <span className="editor-arrow">assign result to vars.</span>
      <input
        type="text"
        placeholder="(optional)"
        style={{ width: 140 }}
        defaultValue={node.assignTo}
        onBlur={(e) => onChange({ assignTo: e.target.value.trim() })}
      />
    </div>
    <div className="editor-hint">
      Runs JavaScript with <strong>res</strong> and <strong>vars</strong> in scope (5s limit).
      Return a plain object to merge it into the flow variables; any other value is stored in
      vars.{node.assignTo || '…'} when set. Errors fail the node.
    </div>
  </div>
);

// Request nodes have no editable parameters — show the linked request info and
// its snapshot actions (reveal / sync / pin) instead.
const RequestNodeSection = ({ pathname, node, drift }) => {
  const dispatch = useDispatch();
  const [diffOpen, setDiffOpen] = useState(false);
  const showDiffChip = drift?.status === 'drifted' && !node.pinned;
  return (
    <div className="panel-section">
      {diffOpen && <DriftDiffModal pathname={pathname} node={node} onClose={() => setDiffOpen(false)} />}
      <div className="step-ref">{node.ref.collection}/{node.ref.request}</div>
      {drift && (showDiffChip ? (
        // Drifted: the chip is clickable and opens the field-level diff.
        <button
          type="button"
          className="step-status status-drifted step-status-button"
          style={{ alignSelf: 'flex-start' }}
          title="View changes"
          data-testid="workflow-drift-chip"
          onClick={() => setDiffOpen(true)}
        >
          {STATUS_LABELS.drifted} · view changes
        </button>
      ) : (
        <div className={`step-status status-${drift.status}`} style={{ alignSelf: 'flex-start' }}>
          {node.pinned ? 'pinned' : STATUS_LABELS[drift.status] || drift.status}
        </div>
      ))}
      <div className="panel-actions">
        <button
          type="button"
          className="add-button"
          onClick={() => dispatch(revealWorkflowNode(pathname, node.id)).catch((e) => toast.error(e?.message || 'Unable to locate request'))}
        >
          <IconTarget size={14} /> <span>Show in sidebar</span>
        </button>
        {drift?.status === 'drifted' && !node.pinned && (
          <button
            type="button"
            className="add-button"
            onClick={() => dispatch(syncWorkflowNodes(pathname, [node.id])).catch((e) => toast.error(e?.message || 'Unable to sync'))}
          >
            <IconRefresh size={14} /> <span>Sync</span>
          </button>
        )}
        <button type="button" className="add-button" onClick={() => dispatch(togglePinWorkflowNode(pathname, node.id))}>
          {node.pinned ? <IconPinned size={14} /> : <IconPin size={14} />}
          <span>{node.pinned ? 'Unpin' : 'Pin'}</span>
        </button>
      </div>
      <div className="editor-hint">
        Wire the <strong>error</strong> output to handle non-2xx/3xx responses (or network errors) without failing
        the run; when unwired, a failure stops the run.
      </div>
    </div>
  );
};

// Sticky note: plain-text content (also editable in place on the canvas via
// double-click). Notes never run.
const NoteNodeEditor = ({ node, onChange }) => (
  <div className="step-editor">
    <textarea
      className="note-content-input"
      rows={5}
      placeholder="Write a note..."
      key={node.content}
      defaultValue={node.content}
      onBlur={(e) => onChange({ content: e.target.value })}
    />
    <div className="editor-hint">Sticky notes are documentation only — they have no ports and never run.</div>
  </div>
);

const NodeParamsEditor = ({ pathname, node, drift, onChange }) => {
  if (node.type === 'request') return <RequestNodeSection pathname={pathname} node={node} drift={drift} />;
  if (node.type === 'map') return <MapNodeEditor node={node} onChange={onChange} />;
  if (node.type === 'setvars') return <SetVarsNodeEditor node={node} onChange={onChange} />;
  if (node.type === 'condition') return <ConditionNodeEditor node={node} onChange={onChange} />;
  if (node.type === 'delay') return <DelayNodeEditor node={node} onChange={onChange} />;
  if (node.type === 'loop') return <LoopNodeEditor node={node} onChange={onChange} />;
  if (node.type === 'script') return <ScriptNodeEditor node={node} onChange={onChange} />;
  if (node.type === 'note') return <NoteNodeEditor node={node} onChange={onChange} />;
  return null;
};

export default NodeParamsEditor;
