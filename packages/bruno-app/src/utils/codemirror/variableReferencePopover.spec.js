import CodeMirror from 'codemirror';
import { fireEvent, screen, within } from '@testing-library/dom';
import store from 'providers/ReduxStore';
import { renderVarInfo } from './brunoVarInfo';

jest.mock('providers/ReduxStore', () => ({ __esModule: true, default: { dispatch: jest.fn(), getState: jest.fn() } }));
jest.mock('providers/ReduxStore/slices/collections/actions', () => ({ updateVariableInScope: jest.fn() }));
jest.mock('utils/collections', () => ({
  getVariableScope: jest.fn((name) => ({ type: 'runtime', value: name })),
  isVariableSecret: jest.fn(() => false),
  getAllVariables: jest.fn(() => ({}))
}));

beforeAll(() => {
  jest.spyOn(window, 'focus').mockImplementation(() => {});
  Range.prototype.getBoundingClientRect = () => ({ left: 0, right: 0, top: 0, bottom: 0 });
  Range.prototype.getClientRects = () => [];
  global.ResizeObserver = class {
    observe() {}
    disconnect() {}
  };
});

afterAll(() => jest.restoreAllMocks());

afterEach(() => document.body.replaceChildren());

it('masks secret previews including references to secrets, and leaves values unchanged on selection', () => {
  const variables = {
    test1: 'one', test2: 'do-not-display', alias: '{{test2}}', nested: '{{alias}}', zero: 0, off: false,
    host: 'example', repeated: '{{host}}/{{host}}', cycleA: '{{cycleB}}', cycleB: '{{cycleA}}', maskedEnvVariables: ['test2']
  };
  const onReplaceVariable = jest.fn();
  const popup = renderVarInfo({ string: '{{test1}}' }, { variables, onReplaceVariable });
  document.body.append(popup);
  fireEvent.click(within(popup).getByRole('button', { name: 'Change variable...' }));
  expect(popup.textContent).not.toContain('do-not-display');
  expect(within(popup).getAllByRole('option').filter((node) => node.textContent.includes('[masked]'))).toHaveLength(5);
  expect(within(popup).getByText('Runtime - example/example')).toBeVisible();
  expect(within(popup).getByText('Runtime - 0')).toBeVisible();
  expect(within(popup).getByText('Runtime - false')).toBeVisible();
  const option = within(popup).getAllByRole('option').find((node) => node.textContent.startsWith('test2'));
  fireEvent.click(option);
  expect(onReplaceVariable).toHaveBeenCalledWith('test2');
  expect(variables.test2).toBe('do-not-display');
  expect(store.dispatch).not.toHaveBeenCalled();
});

it('opens from the editor keyboard, replaces one occurrence, closes, and preserves Undo', () => {
  const host = document.createElement('div');
  document.body.append(host);
  const variables = { test1: 'one', test2: 'two' };
  const editor = CodeMirror(host, { value: '{{test1}}/{{test1}}', brunoVarInfo: { variables } });
  editor.setCursor({ line: 0, ch: 13 });
  CodeMirror.signal(editor, 'keydown', editor, { key: 'ArrowDown', altKey: true, preventDefault: jest.fn() });
  const popup = screen.getByRole('dialog', { name: 'Variable details' });
  const trigger = within(popup).getByRole('button', { name: 'Change variable...' });
  expect(trigger).toHaveFocus();
  fireEvent.click(trigger);
  fireEvent.keyDown(within(popup).getByRole('combobox'), { key: 'Enter' });
  expect(editor.getValue()).toBe('{{test1}}/{{test2}}');
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(editor.getAllMarks()).toHaveLength(0);
  editor.undo();
  expect(editor.getValue()).toBe('{{test1}}/{{test1}}');
  expect(store.dispatch).not.toHaveBeenCalled();
  editor.setOption('brunoVarInfo', false);
});

it('does not offer reference replacement in a read-only editor and dismisses on Escape', () => {
  const host = document.createElement('div');
  document.body.append(host);
  const editor = CodeMirror(host, { value: '{{test1}}', readOnly: true, brunoVarInfo: { variables: { test1: 'one' } } });
  editor.setCursor({ line: 0, ch: 4 });
  CodeMirror.signal(editor, 'keydown', editor, { key: 'ArrowDown', altKey: true, preventDefault: jest.fn() });
  expect(screen.getByRole('dialog')).toBeVisible();
  expect(screen.queryByRole('button', { name: 'Change variable...' })).toBeNull();
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(screen.queryByRole('dialog')).toBeNull();
  editor.setOption('brunoVarInfo', false);
});

it('cleans up the open picker and tracked range when its editor is disposed', () => {
  const host = document.createElement('div');
  document.body.append(host);
  const editor = CodeMirror(host, { value: '{{test1}}', brunoVarInfo: { variables: { test1: 'one', test2: 'two' } } });
  editor.setCursor({ line: 0, ch: 4 });
  CodeMirror.signal(editor, 'keydown', editor, { key: 'ArrowDown', altKey: true, preventDefault: jest.fn() });
  fireEvent.click(screen.getByRole('button', { name: 'Change variable...' }));
  expect(editor.getAllMarks()).toHaveLength(1);
  editor.setOption('brunoVarInfo', false);
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(editor.getAllMarks()).toHaveLength(0);
});
