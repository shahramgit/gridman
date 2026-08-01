import React, { useMemo } from 'react';
import get from 'lodash/get';
import CodeEditor from 'components/CodeEditor';
import { useTheme } from 'providers/Theme';
import { useSelector } from 'react-redux';
import { parseBulkKeyValue, serializeBulkKeyValue } from 'utils/common/bulkKeyValueUtils';

const BulkEditor = ({ params, onChange, onToggle, onSave, onRun }) => {
  const preferences = useSelector((state) => state.app.preferences);
  const { displayedTheme } = useTheme();

  const parsedParams = useMemo(() => serializeBulkKeyValue(params), [params]);

  // The bulk text only carries name/value/enabled, so `params` is the only place
  // descriptions, uids and the other per-row metadata still exist - without
  // feeding them back in, every keystroke would wipe those fields off disk.
  //
  // Read live rather than pinned to the mount-time rows: `params` is whatever
  // the previous keystroke produced, so a row being typed keeps the uid it was
  // given, and rows changed from outside while the editor stays mounted (the URL
  // bar rewrites request.params, the watcher after an external edit or a
  // `git pull`) are matched against their current state instead of a stale
  // snapshot that could resurrect deleted rows. CodeEditor reads `onEdit` off
  // props at call time, so this closure is never stale.
  // Upstream: bruno #8595 (3c0483852).
  const handleEdit = (value) => {
    const parsed = parseBulkKeyValue(value, params);
    onChange(parsed);
  };

  return (
    <>
      <div className="h-[200px]">
        <CodeEditor
          mode="text/plain"
          theme={displayedTheme}
          font={get(preferences, 'font.codeFont', 'default')}
          fontSize={get(preferences, 'font.codeFontSize')}
          value={parsedParams}
          onEdit={handleEdit}
          onSave={onSave}
          onRun={onRun}
        />
      </div>
      <div className="flex btn-action justify-between items-center mt-3">
        <button className="text-link select-none ml-auto" data-testid="key-value-edit-toggle" onClick={onToggle}>
          Key/Value Edit
        </button>
      </div>
    </>
  );
};

export default BulkEditor;
