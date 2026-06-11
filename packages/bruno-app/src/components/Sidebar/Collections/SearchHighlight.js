import React from 'react';
import { findFoldedMatchRange } from '@usebruno/common';

const SearchHighlight = ({ text = '', searchText = '' }) => {
  const normalizedSearchText = searchText.trim();
  if (!normalizedSearchText) {
    return text;
  }

  const sourceText = String(text || '');
  // Folded matching so highlights work across Persian/Arabic character
  // variants (e.g. a query typed with ی highlights text written with ي).
  const range = findFoldedMatchRange(sourceText, normalizedSearchText);

  if (!range) {
    return sourceText;
  }

  return (
    <>
      {sourceText.slice(0, range.start)}
      <strong>{sourceText.slice(range.start, range.end)}</strong>
      {sourceText.slice(range.end)}
    </>
  );
};

export default SearchHighlight;
