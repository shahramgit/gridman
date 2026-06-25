import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import ReactDOM from 'react-dom';
import styled from 'styled-components';

// Postman-style floating value editor: a popover anchored under the field that
// shows the full (long) value in a resizable box, overlaying the rows below
// instead of growing/clipping inside the table cell. Rendered in a portal so
// table overflow can't clip it.
const Overlay = styled.div`
  position: fixed;
  z-index: 1000;

  textarea {
    width: 100%;
    min-height: 64px;
    max-height: 260px;
    resize: vertical;
    padding: 6px 8px;
    font-family: monospace;
    font-size: ${(props) => props.theme.font?.size?.base || '0.8125rem'};
    line-height: 1.4;
    color: ${(props) => props.theme.text};
    background: ${(props) => props.theme.input?.bg || props.theme.bg};
    border: 1px solid ${(props) => props.theme.input?.focusBorder || props.theme.input?.border || '#8884'};
    border-radius: 4px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.3);
    outline: none;
    white-space: pre-wrap;
    word-break: break-all;
  }
`;

const ExpandableValueOverlay = ({ anchorRef, value, onChange, onClose, placeholder }) => {
  const ref = useRef(null);
  const [pos, setPos] = useState(null);

  useLayoutEffect(() => {
    const el = anchorRef?.current;
    if (!el) {
      onClose();
      return;
    }
    const rect = el.getBoundingClientRect();
    const width = Math.min(Math.max(rect.width, 360), 560);
    let left = rect.left;
    if (left + width > window.innerWidth - 8) {
      left = Math.max(8, window.innerWidth - width - 8);
    }
    setPos({ top: rect.top, left, width });
  }, []);

  useEffect(() => {
    if (!pos || !ref.current) {
      return;
    }
    const textarea = ref.current.querySelector('textarea');
    if (textarea) {
      textarea.focus();
      textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    }
  }, [pos]);

  useEffect(() => {
    const onKey = (event) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };
    const onDocMouseDown = (event) => {
      if (
        ref.current
        && !ref.current.contains(event.target)
        && !anchorRef?.current?.contains(event.target)
      ) {
        onClose();
      }
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDocMouseDown, true);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDocMouseDown, true);
    };
  }, []);

  if (!pos) {
    return null;
  }

  return ReactDOM.createPortal(
    <Overlay ref={ref} style={{ top: pos.top, left: pos.left, width: pos.width }}>
      <textarea
        value={value || ''}
        placeholder={placeholder}
        spellCheck={false}
        onChange={(event) => onChange?.(event.target.value)}
      />
    </Overlay>,
    document.body
  );
};

export default ExpandableValueOverlay;
