// Postman-style vertical indentation guides for CodeMirror 5.
//
// CM5 has no native indent guides, so on each line render we add one
// absolutely-positioned vertical segment per indent level inside the line's
// leading whitespace. Stacked across lines they read as continuous guides.
// Returns a cleanup function.
export const setupIndentGuides = (editor) => {
  const renderLine = (cm, line, elt) => {
    // Clear guides from a previous render of this line.
    const existing = elt.querySelectorAll('.cm-indent-guide');
    for (const node of existing) {
      node.remove();
    }

    const text = line.text || '';
    const leading = text.match(/^[ \t]*/);
    const indent = leading ? leading[0].length : 0;
    if (indent < 1) {
      return;
    }

    const unit = cm.getOption('indentUnit') || 2;
    const charWidth = cm.defaultCharWidth() || 0;
    if (!charWidth) {
      return;
    }
    // CodeMirror's default left padding on a line.
    const basePadding = 4;

    elt.classList.add('cm-has-indent-guides');
    for (let col = unit; col < indent; col += unit) {
      const guide = document.createElement('span');
      guide.className = 'cm-indent-guide';
      guide.style.left = `${basePadding + col * charWidth}px`;
      elt.appendChild(guide);
    }
  };

  editor.on('renderLine', renderLine);
  // Re-render visible lines so guides appear immediately on existing content.
  editor.refresh();

  return () => {
    editor.off('renderLine', renderLine);
  };
};
