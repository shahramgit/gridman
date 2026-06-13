import { useState } from 'react';
import { IconAdjustmentsHorizontal, IconLetterCase, IconSearch, IconX } from '@tabler/icons';
import StyledWrapper from './StyledWrapper';

const SCOPE_OPTIONS = [
  { key: 'collections', label: 'Collection names' },
  { key: 'names', label: 'Folder & request names' },
  { key: 'url', label: 'URL' },
  { key: 'headers', label: 'Headers' },
  { key: 'body', label: 'Body' },
  { key: 'examples', label: 'Examples' }
];

const CollectionSearch = ({ searchText, setSearchText, searchOptions, setSearchOptions }) => {
  const [scopesOpen, setScopesOpen] = useState(false);

  const toggleMatchCase = () => {
    setSearchOptions({ ...searchOptions, matchCase: !searchOptions.matchCase });
  };

  const toggleScope = (key) => {
    setSearchOptions({
      ...searchOptions,
      scopes: { ...searchOptions.scopes, [key]: !searchOptions.scopes[key] }
    });
  };

  const enabledScopeCount = Object.values(searchOptions.scopes).filter(Boolean).length;
  const allScopesEnabled = enabledScopeCount === SCOPE_OPTIONS.length;

  return (
    <StyledWrapper>
      <div className="search-input-row">
        <IconSearch size={14} strokeWidth={1.5} className="search-icon" />
        <input
          type="text"
          name="search"
          data-testid="sidebar-search-input"
          placeholder="Search collections, folders, requests..."
          id="search"
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          autoFocus
          spellCheck="false"
          value={searchText}
          onChange={(e) => setSearchText(e.target.value)}
        />
        <div className="search-actions">
          {searchText !== '' && (
            <div className="action-icon" title="Clear" onClick={() => setSearchText('')}>
              <IconX size={14} strokeWidth={1.5} />
            </div>
          )}
          <div
            className={`action-icon ${searchOptions.matchCase ? 'active' : ''}`}
            title="Match case"
            data-testid="search-match-case"
            onClick={toggleMatchCase}
          >
            <IconLetterCase size={14} strokeWidth={1.5} />
          </div>
          <div
            className={`action-icon ${scopesOpen || !allScopesEnabled ? 'active' : ''}`}
            title="Search in..."
            data-testid="search-scopes-toggle"
            onClick={() => setScopesOpen((open) => !open)}
          >
            <IconAdjustmentsHorizontal size={14} strokeWidth={1.5} />
          </div>
        </div>
      </div>

      {scopesOpen && (
        <div className="search-scopes" data-testid="search-scopes">
          {SCOPE_OPTIONS.map((scope) => (
            <label key={scope.key} className="scope-option">
              <input
                type="checkbox"
                checked={Boolean(searchOptions.scopes[scope.key])}
                onChange={() => toggleScope(scope.key)}
              />
              <span>{scope.label}</span>
            </label>
          ))}
          {!enabledScopeCount && (
            <div className="scope-warning">Select at least one scope to search.</div>
          )}
        </div>
      )}
    </StyledWrapper>
  );
};

export default CollectionSearch;
