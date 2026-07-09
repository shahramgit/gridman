import React, { useState } from 'react';
import StyledWrapper from './StyledWrapper';

/**
 * Click-to-rename name shown at the top of the collection / folder settings
 * tabs (Postman-style). Click turns the name into an input; Enter or blur
 * commits via onRename(newName); Escape cancels.
 *
 * Mirrors the interaction added to RequestTabs/CollectionHeader.
 */
const SettingsHeaderName = ({ name, onRename, testId = 'settings-header-name' }) => {
  const [isRenaming, setIsRenaming] = useState(false);
  const [nameInput, setNameInput] = useState('');

  const startRename = () => {
    setNameInput(name || '');
    setIsRenaming(true);
  };

  const cancelRename = () => {
    setIsRenaming(false);
    setNameInput('');
  };

  const commitRename = () => {
    if (!isRenaming) {
      return;
    }
    const newName = (nameInput || '').trim();
    setIsRenaming(false);
    setNameInput('');
    if (!newName || newName === name) {
      return;
    }
    onRename(newName);
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      commitRename();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancelRename();
    }
  };

  return (
    <StyledWrapper>
      {isRenaming ? (
        <input
          type="text"
          className="settings-name-input"
          value={nameInput}
          autoFocus
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck="false"
          data-testid={`${testId}-input`}
          onFocus={(e) => e.target.select()}
          onChange={(e) => setNameInput(e.target.value)}
          onBlur={commitRename}
          onKeyDown={handleKeyDown}
        />
      ) : (
        <span
          className="settings-name-editable"
          title="Click to rename"
          data-testid={testId}
          onClick={startRename}
        >
          {name}
        </span>
      )}
    </StyledWrapper>
  );
};

export default SettingsHeaderName;
