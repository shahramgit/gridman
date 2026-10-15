import { variableNameRegex } from 'utils/common/regex';

let pickerId = 0;

export const getVariableSuggestions = (variables, currentName, query = '') => {
  const names = Object.keys(variables || {}).filter((name) => !['pathParams', 'maskedEnvVariables', 'process'].includes(name));
  Object.keys(variables?.process?.env || {}).forEach((name) => names.push(`process.env.${name}`));
  const search = query.trim().toLowerCase();
  const current = currentName.toLowerCase();
  const commonPrefix = (name) => {
    let length = 0;
    while (length < current.length && name[length]?.toLowerCase() === current[length]) length++;
    return length;
  };
  return [...new Set(names)]
    .filter((name) => name !== currentName && variableNameRegex.test(name) && name.toLowerCase().includes(search))
    .sort((a, b) => {
      const rank = search
        ? Number(b.toLowerCase().startsWith(search)) - Number(a.toLowerCase().startsWith(search))
        : commonPrefix(b) - commonPrefix(a);
      return rank || a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
    });
};

// Uses the existing editor so replacement emits the usual draft change and is
// one undoable edit. The mark follows this occurrence if surrounding text moves.
export const trackVariableReference = (editor, token, line) => {
  const mark = editor.markText({ line, ch: token.start }, { line, ch: token.end });
  return {
    clear: () => mark.clear(),
    replace: (name) => {
      const range = mark.find();
      if (editor.getOption('readOnly') || !variableNameRegex.test(name) || !range || editor.getRange(range.from, range.to) !== token.string) {
        return false;
      }
      const replacement = `{{${name}}}`;
      editor.replaceRange(replacement, range.from, range.to, 'change-variable');
      editor.setCursor({ line: range.from.line, ch: range.from.ch + replacement.length });
      return true;
    }
  };
};

export const createVariableReferencePicker = ({ variables, variableName, getDetails, onSelect }) => {
  const container = document.createElement('div');
  container.className = 'var-reference-picker';
  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'change-variable-button';
  trigger.textContent = 'Change variable...';
  trigger.title = 'Replace this reference (Alt+Down while the cursor is inside a variable)';
  trigger.setAttribute('aria-expanded', 'false');
  const panel = document.createElement('div');
  panel.hidden = true;
  panel.id = `variable-reference-picker-${++pickerId}`;
  trigger.setAttribute('aria-controls', panel.id);
  const search = document.createElement('input');
  search.type = 'text';
  search.placeholder = 'Search variables';
  search.setAttribute('aria-label', 'Search variables');
  search.setAttribute('role', 'combobox');
  search.setAttribute('aria-autocomplete', 'list');
  search.setAttribute('aria-expanded', 'false');
  search.autocomplete = 'off';
  const list = document.createElement('div');
  list.id = `variable-reference-options-${++pickerId}`;
  list.className = 'var-reference-options';
  list.setAttribute('role', 'listbox');
  list.setAttribute('aria-label', 'Available variables');
  search.setAttribute('aria-controls', list.id);
  const note = document.createElement('div');
  note.className = 'var-reference-note';
  note.setAttribute('role', 'status');
  let names = [];
  let active = 0;
  const select = (name) => onSelect(name);
  const setActive = (index) => {
    active = index;
    Array.from(list.children).forEach((option, i) => option.setAttribute('aria-selected', String(i === active)));
    if (names[active]) search.setAttribute('aria-activedescendant', `${list.id}-${active}`);
    else search.removeAttribute('aria-activedescendant');
  };
  const renderOptions = () => {
    const matches = getVariableSuggestions(variables, variableName, search.value);
    names = matches.slice(0, 10);
    list.replaceChildren();
    names.forEach((name, index) => {
      const option = document.createElement('div');
      option.id = `${list.id}-${index}`;
      option.className = 'var-reference-option';
      option.setAttribute('role', 'option');
      const label = document.createElement('div');
      label.className = 'var-reference-name';
      label.textContent = name;
      const details = document.createElement('div');
      details.className = 'var-reference-details';
      details.textContent = getDetails(name);
      option.append(label, details);
      option.addEventListener('mousemove', () => setActive(index));
      option.addEventListener('mousedown', (event) => event.preventDefault());
      option.addEventListener('click', () => select(name));
      list.appendChild(option);
    });
    note.textContent = matches.length > names.length
      ? `Showing ${names.length} of ${matches.length}. Type to narrow the list.`
      : names.length ? 'Replaces only this reference. Variable values stay unchanged.' : 'No matching variables';
    setActive(0);
  };
  const close = () => {
    panel.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
    search.setAttribute('aria-expanded', 'false');
    trigger.focus();
  };
  trigger.addEventListener('click', () => {
    if (!panel.hidden) return close();
    panel.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
    search.setAttribute('aria-expanded', 'true');
    search.value = '';
    renderOptions();
    search.focus();
  });
  search.addEventListener('input', renderOptions);
  search.addEventListener('keydown', (event) => {
    if (['ArrowDown', 'ArrowUp', 'Enter', 'Escape'].includes(event.key)) {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === 'Escape') close();
      else if (event.key === 'Enter' && names[active]) select(names[active]);
      else if (names.length && ['ArrowDown', 'ArrowUp'].includes(event.key)) {
        setActive((active + (event.key === 'ArrowDown' ? 1 : -1) + names.length) % names.length);
        list.children[active]?.scrollIntoView?.({ block: 'nearest' });
      }
    }
  });
  panel.append(search, list, note);
  container.append(trigger, panel);
  return container;
};
