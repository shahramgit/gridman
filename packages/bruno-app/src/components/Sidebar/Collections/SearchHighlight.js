import React from 'react';

const SearchHighlight = ({ text = '', searchText = '' }) => {
  const normalizedSearchText = searchText.trim();
  if (!normalizedSearchText) {
    return text;
  }

  const sourceText = String(text || '');
  const lowerSourceText = sourceText.toLowerCase();
  const lowerSearchText = normalizedSearchText.toLowerCase();
  const index = lowerSourceText.indexOf(lowerSearchText);

  if (index === -1) {
    return sourceText;
  }

  return (
    <>
      {sourceText.slice(0, index)}
      <strong>{sourceText.slice(index, index + normalizedSearchText.length)}</strong>
      {sourceText.slice(index + normalizedSearchText.length)}
    </>
  );
};

export default SearchHighlight;
