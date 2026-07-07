import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useDrag, useDrop } from 'react-dnd';
import { useTheme } from 'styled-components';
import { caretIndexFromOffset } from 'providers/ReduxStore/slices/workflows-canvas-helpers';

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

// Shared canvas context for measuring substring widths when mapping a drop
// position to a caret index (created lazily, reused across drops).
let measureCanvasContext = null;
const getMeasureContext = () => {
  if (!measureCanvasContext) {
    measureCanvasContext = document.createElement('canvas').getContext('2d');
  }
  return measureCanvasContext;
};

// Translate a drop's clientX into a caret index inside `input`, accounting for
// the input's border, padding and horizontal scroll. The index math itself is
// the pure caretIndexFromOffset helper (unit-tested with a mocked measureText).
export const caretIndexFromDropPoint = (input, clientX) => {
  const text = input.value ?? '';
  if (typeof clientX !== 'number' || !Number.isFinite(clientX)) {
    return text.length;
  }
  try {
    const style = window.getComputedStyle(input);
    const context = getMeasureContext();
    context.font = style.font
      || `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`.trim();
    const rect = input.getBoundingClientRect();
    const contentLeft = rect.left
      + (parseFloat(style.borderLeftWidth) || 0)
      + (parseFloat(style.paddingLeft) || 0)
      - (input.scrollLeft || 0);
    return caretIndexFromOffset(text, clientX - contentLeft, (s) => context.measureText(s).width);
  } catch (error) {
    return text.length; // measuring failed — append rather than replace
  }
};

// Map a caret index back to a viewport pixel — the inverse of
// caretIndexFromDropPoint, used to draw the insertion indicator while a field
// hovers over the input. Clamped to the input's visible content box.
export const caretPixelFromIndex = (input, index) => {
  const text = input.value ?? '';
  const clamped = Math.max(0, Math.min(index, text.length));
  const rect = input.getBoundingClientRect();
  try {
    const style = window.getComputedStyle(input);
    const context = getMeasureContext();
    context.font = style.font
      || `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`.trim();
    const borderLeft = parseFloat(style.borderLeftWidth) || 0;
    const contentLeft = rect.left + borderLeft + (parseFloat(style.paddingLeft) || 0) - (input.scrollLeft || 0);
    const x = contentLeft + context.measureText(text.slice(0, clamped)).width;
    const visibleLeft = rect.left + borderLeft + 1;
    const visibleRight = rect.right - (parseFloat(style.borderRightWidth) || 0) - 1;
    return Math.max(visibleLeft, Math.min(x, visibleRight));
  } catch (error) {
    return rect.left;
  }
};

// Textarea variant of DroppableInput for multiline parameters (script code).
// A dropped field inserts its reference at the textarea's caret when it is
// focused, otherwise appends at the end. No per-pixel drop indicator: mapping
// a point to a caret in wrapped multiline text isn't worth the complexity
// here — the single-line caret math in DroppableInput doesn't transfer.
export const DroppableTextarea = ({ value, placeholder, onCommit, getRef, rows = 10, style, className = '' }) => {
  const inputRef = useRef(null);
  const dropCommittedValueRef = useRef(null);

  const [{ isOver, canDrop }, drop] = useDrop({
    accept: WORKFLOW_FIELD_DND,
    drop: (field) => {
      const refText = getRef(field);
      const input = inputRef.current;
      if (!input) {
        onCommit(refText);
        return;
      }
      const current = input.value ?? '';
      // While dragging the textarea is not focused, so selectionStart is
      // usually stale/0 — only honor it when the textarea has focus.
      const index = document.activeElement === input && Number.isInteger(input.selectionStart)
        ? input.selectionStart
        : current.length;
      const combined = `${current.slice(0, index)}${refText}${current.slice(index)}`;
      input.value = combined;
      try {
        input.setSelectionRange(index + refText.length, index + refText.length);
      } catch (error) {
        // non-critical
      }
      dropCommittedValueRef.current = combined;
      onCommit(combined);
      input.blur();
    },
    collect: (monitor) => ({ isOver: monitor.isOver(), canDrop: monitor.canDrop() })
  });

  const setRefs = useCallback((element) => {
    inputRef.current = element;
    drop(element);
  }, [drop]);

  return (
    <textarea
      ref={setRefs}
      key={value}
      rows={rows}
      style={style}
      spellCheck={false}
      className={`${className} ${isOver && canDrop ? 'wf-drop-over' : ''}`.trim()}
      placeholder={placeholder}
      defaultValue={value}
      onBlur={(e) => {
        if (dropCommittedValueRef.current !== null && e.target.value === dropCommittedValueRef.current) {
          dropCommittedValueRef.current = null;
          return; // the drop handler already committed this exact value
        }
        dropCommittedValueRef.current = null;
        onCommit(e.target.value);
      }}
    />
  );
};

// Text input that also accepts a dragged input field. `getRef` maps the dropped
// field to the reference string appropriate for this parameter. Keyed by value
// so a commit re-seeds the uncommitted (uncontrolled) input. A drop INSERTS the
// reference at the drop position within the live (possibly uncommitted) text —
// it never replaces the whole value. While a field hovers over the input, a
// caret-style indicator marks exactly where the reference will land.
export const DroppableInput = ({ value, placeholder, onCommit, getRef, type = 'text', style, className = '' }) => {
  const theme = useTheme();
  const inputRef = useRef(null);
  // Value committed by the drop handler; lets the blur triggered right after a
  // drop skip its (duplicate) commit so a drop is exactly one doc write.
  const dropCommittedValueRef = useRef(null);
  // { x, top, height } in viewport coords for the drop-position indicator.
  const [dropIndicator, setDropIndicator] = useState(null);

  const [{ isOver, canDrop }, drop] = useDrop({
    accept: WORKFLOW_FIELD_DND,
    hover: (field, monitor) => {
      const input = inputRef.current;
      const clientX = monitor.getClientOffset()?.x;
      if (!input || typeof clientX !== 'number') {
        return;
      }
      const index = caretIndexFromDropPoint(input, clientX);
      const x = caretPixelFromIndex(input, index);
      const rect = input.getBoundingClientRect();
      setDropIndicator((previous) => (
        previous && Math.abs(previous.x - x) < 0.5
          ? previous
          : { x, top: rect.top + 3, height: Math.max(8, rect.height - 6) }
      ));
    },
    drop: (field, monitor) => {
      const refText = getRef(field);
      const input = inputRef.current;
      if (!input) {
        onCommit(refText);
        return;
      }
      const current = input.value ?? '';
      const index = caretIndexFromDropPoint(input, monitor.getClientOffset()?.x);
      const combined = `${current.slice(0, index)}${refText}${current.slice(index)}`;
      // Reflect the insert immediately in the uncontrolled input and park the
      // caret right after the inserted reference.
      input.value = combined;
      try {
        input.setSelectionRange(index + refText.length, index + refText.length);
      } catch (error) {
        // some input types don't support selection — non-critical
      }
      dropCommittedValueRef.current = combined;
      onCommit(combined);
      // Blur so an immediate Ctrl/Cmd+Z on the canvas isn't swallowed by the
      // editable-target shortcut guard (the drop is one undoable doc write).
      input.blur();
    },
    collect: (monitor) => ({ isOver: monitor.isOver(), canDrop: monitor.canDrop() })
  });

  const setRefs = useCallback((element) => {
    inputRef.current = element;
    drop(element);
  }, [drop]);

  // Drop the stale indicator once the drag leaves (the render gate already
  // hides it; this just clears the state).
  useEffect(() => {
    if (!isOver && dropIndicator) {
      setDropIndicator(null);
    }
  }, [isOver, dropIndicator]);

  return (
    <>
      <input
        ref={setRefs}
        key={value}
        type={type}
        style={style}
        className={`${className} ${isOver && canDrop ? 'wf-drop-over' : ''}`.trim()}
        placeholder={placeholder}
        defaultValue={value}
        onBlur={(e) => {
          if (dropCommittedValueRef.current !== null && e.target.value === dropCommittedValueRef.current) {
            dropCommittedValueRef.current = null;
            return; // the drop handler already committed this exact value
          }
          dropCommittedValueRef.current = null;
          onCommit(e.target.value);
        }}
      />
      {isOver && canDrop && dropIndicator
        ? createPortal(
            <div
              style={{
                position: 'fixed',
                left: dropIndicator.x - 1,
                top: dropIndicator.top,
                width: 2,
                height: dropIndicator.height,
                background: theme?.textLink || theme?.colors?.text?.yellow || 'currentColor',
                borderRadius: 1,
                pointerEvents: 'none',
                zIndex: 60
              }}
            />,
            document.body
          )
        : null}
    </>
  );
};
