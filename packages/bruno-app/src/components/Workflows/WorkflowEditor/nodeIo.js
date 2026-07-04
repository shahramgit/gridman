import { useDrag, useDrop } from 'react-dnd';

// Shared node input/output helpers used by BOTH the editor's right-hand side
// panel (index.js) and the fullscreen Node Detail View (NodeDetailView.js).
// Kept in one module so the drag-a-field-onto-a-parameter behavior can't fork.

export const WORKFLOW_FIELD_DND = 'workflow-field';
const MAX_INPUT_FIELDS = 250;

// Commit text inputs on Enter (they save on blur).
export const blurOnEnter = (event) => {
  if (event.key === 'Enter') {
    event.currentTarget.blur();
  }
};

export const formatDuration = (ms) => {
  if (typeof ms !== 'number' || Number.isNaN(ms)) {
    return '';
  }
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`;
};

// Pretty-print a value as JSON for the Input/Output viewers, capped so a huge
// response body can't freeze the renderer.
export const prettyJson = (value, limit = 4000) => {
  try {
    return JSON.stringify(value, null, 2).slice(0, limit);
  } catch (error) {
    return String(value);
  }
};

// Flatten a node's input snapshot ({ response, vars }) into leaf fields the user
// can drag onto parameter inputs. Each field carries every reference form so the
// drop target can pick the right one (JSONPath for Map, expression for
// Condition, {{template}} for Set Vars, bare var name for Loop).
export const flattenInputFields = (input) => {
  const fields = [];
  if (!input) {
    return fields;
  }

  const sampleOf = (value) => {
    if (value === null || value === undefined) return String(value);
    if (typeof value === 'object') return Array.isArray(value) ? `[${value.length}]` : '{…}';
    return String(value).slice(0, 40);
  };

  const res = input.response;
  if (res) {
    if (res.status !== undefined) {
      fields.push({ label: 'status', expr: 'res.status', kind: 'status', sample: sampleOf(res.status) });
    }
    const headers = res.headers || {};
    for (const key of Object.keys(headers)) {
      fields.push({ label: `header: ${key}`, expr: `res.headers['${key}']`, headerName: key, kind: 'header', sample: sampleOf(headers[key]) });
    }
    const walk = (value, jsonPath, exprPath) => {
      if (fields.length > MAX_INPUT_FIELDS) return;
      if (value === null || typeof value !== 'object') {
        fields.push({ label: jsonPath, expr: exprPath, jsonPath, kind: 'body', sample: sampleOf(value) });
        return;
      }
      if (Array.isArray(value)) {
        if (!value.length) {
          fields.push({ label: jsonPath, expr: exprPath, jsonPath, kind: 'body', sample: '[]' });
        }
        value.slice(0, 3).forEach((item, i) => walk(item, `${jsonPath}[${i}]`, `${exprPath}[${i}]`));
        return;
      }
      for (const key of Object.keys(value)) {
        walk(value[key], `${jsonPath}.${key}`, `${exprPath}.${key}`);
      }
    };
    if (res.body !== undefined) {
      walk(res.body, '$', 'res.body');
    }
  }

  const vars = input.vars || {};
  for (const key of Object.keys(vars)) {
    fields.push({ label: `vars.${key}`, expr: `vars.${key}`, template: `{{${key}}}`, varName: key, kind: 'var', sample: sampleOf(vars[key]) });
  }
  return fields;
};

const InputFieldChip = ({ field }) => {
  const [{ isDragging }, drag] = useDrag({
    type: WORKFLOW_FIELD_DND,
    item: field,
    collect: (monitor) => ({ isDragging: monitor.isDragging() })
  });
  return (
    <div ref={drag} className={`io-field io-field-${field.kind}`} style={{ opacity: isDragging ? 0.4 : 1 }} title={`Drag onto a field — ${field.expr}`}>
      <span className="io-field-label">{field.label}</span>
      <span className="io-field-sample">{field.sample}</span>
    </div>
  );
};

export const InputFieldTree = ({ input }) => {
  const fields = flattenInputFields(input);
  if (!fields.length) {
    return <div className="io-empty">Run the flow to see the previous node's data here, then drag fields onto the parameters above.</div>;
  }
  return (
    <div className="io-field-list" data-testid="workflow-input-fields">
      {fields.map((field, index) => <InputFieldChip key={`${field.kind}-${field.label}-${index}`} field={field} />)}
    </div>
  );
};

// Text input that also accepts a dragged input field. `getRef` maps the dropped
// field to the reference string appropriate for this parameter. Keyed by value
// so a drop re-seeds the uncommitted (uncontrolled) input.
export const DroppableInput = ({ value, placeholder, onCommit, getRef, type = 'text', style, className = '' }) => {
  const [{ isOver, canDrop }, drop] = useDrop({
    accept: WORKFLOW_FIELD_DND,
    drop: (field) => onCommit(getRef(field)),
    collect: (monitor) => ({ isOver: monitor.isOver(), canDrop: monitor.canDrop() })
  });
  return (
    <input
      ref={drop}
      key={value}
      type={type}
      style={style}
      className={`${className} ${isOver && canDrop ? 'wf-drop-over' : ''}`.trim()}
      placeholder={placeholder}
      defaultValue={value}
      onBlur={(e) => onCommit(e.target.value)}
    />
  );
};
