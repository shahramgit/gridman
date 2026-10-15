import { fireEvent, within } from '@testing-library/dom';
import CodeMirror from 'codemirror';
import { createVariableReferencePicker, getVariableSuggestions, trackVariableReference } from './variableReferencePicker';

const variables = { test1: 'one', test2: 'two', test3: 'three', test11: 'eleven', test12: 'twelve', unrelated: 'other' };

afterEach(() => document.body.replaceChildren());

it('offers real related names, supports numeric search ordering, and excludes internal fields', () => {
  const names = getVariableSuggestions({ ...variables, maskedEnvVariables: ['test2'], pathParams: {}, process: { env: { HOST: 'host' } } }, 'test1');
  expect(names.slice(0, 4)).toEqual(['test11', 'test12', 'test2', 'test3']);
  expect(names).toContain('process.env.HOST');
  expect(names).not.toEqual(expect.arrayContaining(['test1', 'maskedEnvVariables', 'pathParams', 'process']));
  expect(getVariableSuggestions(variables, 'test1', 'TEST')).toEqual(['test2', 'test3', 'test11', 'test12']);
});

it('requires explicit selection, supports mouse/search/keyboard, and cancels without changes', () => {
  const onSelect = jest.fn();
  const picker = createVariableReferencePicker({ variables, variableName: 'test1', getDetails: () => 'Environment - masked', onSelect });
  document.body.append(picker);
  const ui = within(picker);
  expect(ui.queryByRole('combobox')).toBeNull();
  fireEvent.click(ui.getByRole('button', { name: 'Change variable...' }));
  const search = ui.getByRole('combobox');
  expect(search).toHaveFocus();
  fireEvent.keyDown(search, { key: 'ArrowDown' });
  expect(onSelect).not.toHaveBeenCalled();
  fireEvent.keyDown(search, { key: 'Escape' });
  expect(onSelect).not.toHaveBeenCalled();
  fireEvent.click(ui.getByRole('button'));
  fireEvent.input(search, { target: { value: 'test3' } });
  expect(ui.getAllByRole('option')).toHaveLength(1);
  fireEvent.keyDown(search, { key: 'Enter' });
  expect(onSelect).toHaveBeenLastCalledWith('test3');
  fireEvent.input(search, { target: { value: 'test2' } });
  fireEvent.click(ui.getByRole('option'));
  expect(onSelect).toHaveBeenLastCalledWith('test2');
});

it('limits the visible list while allowing search outside the first ten', () => {
  const many = Object.fromEntries(Array.from({ length: 50 }, (_, n) => [`test${n}`, n]));
  const picker = createVariableReferencePicker({ variables: many, variableName: 'test1', getDetails: () => '', onSelect: jest.fn() });
  document.body.append(picker);
  fireEvent.click(within(picker).getByRole('button'));
  expect(within(picker).getAllByRole('option')).toHaveLength(10);
  fireEvent.input(within(picker).getByRole('combobox'), { target: { value: 'test49' } });
  expect(within(picker).getByRole('option')).toHaveTextContent('test49');
});

const makeEditor = (value) => {
  // jsdom has no layout; CodeMirror still uses its real document/history/marks.
  Range.prototype.getBoundingClientRect = () => ({ left: 0, right: 0, top: 0, bottom: 0 });
  Range.prototype.getClientRects = () => [];
  const host = document.createElement('div');
  document.body.append(host);
  return CodeMirror(host, { value });
};

it('replaces only the tracked occurrence, emits a normal editor change, and undoes in one step', () => {
  const editor = makeEditor('{{test1}}/{{test1}}');
  const change = jest.fn();
  editor.on('change', change);
  const reference = trackVariableReference(editor, { string: '{{test1}}', start: 10, end: 19 }, 0);
  expect(reference.replace('test2')).toBe(true);
  expect(editor.getValue()).toBe('{{test1}}/{{test2}}');
  expect(change).toHaveBeenCalledTimes(1);
  editor.undo();
  expect(editor.getValue()).toBe('{{test1}}/{{test1}}');
  reference.clear();
});

it('follows surrounding edits and refuses a stale reference or a read-only editor', () => {
  const editor = makeEditor('{{test1}}');
  const reference = trackVariableReference(editor, { string: '{{test1}}', start: 0, end: 9 }, 0);
  editor.replaceRange('prefix ', { line: 0, ch: 0 });
  expect(reference.replace('test2')).toBe(true);
  expect(editor.getValue()).toBe('prefix {{test2}}');
  expect(reference.replace('test3')).toBe(false);
  reference.clear();
  const readonly = trackVariableReference(editor, { string: '{{test2}}', start: 7, end: 16 }, 0);
  editor.setOption('readOnly', true);
  expect(readonly.replace('test3')).toBe(false);
  expect(editor.getValue()).toBe('prefix {{test2}}');
  readonly.clear();
});
