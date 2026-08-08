/**
 * THE FEATURE HAS TO BE WIRED IN.
 *
 * src/ipc/index.js is an aggregator; if nothing calls it, every AI channel is
 * unregistered and each renderer invoke rejects with "No handler registered".
 * The port shipped in exactly that state — the whole feature was inert.
 *
 * Two things are pinned here:
 *   1. src/index.js requires the aggregator and calls it with the main window
 *      inside the ipc registration block.
 *   2. Registration ITSELF constructs no provider and makes no network call.
 *      That is what makes unconditional registration safe: nothing happens at
 *      startup, and the per-call gates do the rest.
 *
 * (1) is asserted against the source text rather than by loading src/index.js:
 * that module builds a BrowserWindow, installs menus and starts watchers on
 * require, none of which can run under jest.
 */

const fs = require('fs');
const path = require('path');

const MAIN_PATH = path.join(__dirname, '..', '..', 'src', 'index.js');

describe('src/index.js registers the AI IPC', () => {
  const source = fs.readFileSync(MAIN_PATH, 'utf8');

  it('requires the AI IPC aggregator', () => {
    expect(source).toMatch(/require\(['"]\.\/ipc['"]\)/);
  });

  it('calls the aggregator with the main window, alongside the other registrations', () => {
    // Find whatever local name the require was bound to, so the test survives
    // a rename but fails if the call disappears.
    const bindingMatch = source.match(/const\s+(\w+)\s*=\s*require\(['"]\.\/ipc['"]\)\s*;/);
    expect(bindingMatch).not.toBeNull();

    const alias = bindingMatch[1];
    const callPattern = new RegExp(`\\b${alias}\\s*\\(\\s*mainWindow\\s*\\)`);
    expect(source).toMatch(callPattern);

    // It must sit with the other `register*Ipc(mainWindow)` calls, i.e. after
    // the window exists — not at module scope where mainWindow is undefined.
    const callIndex = source.search(callPattern);
    const blockIndex = source.indexOf('// register all ipc handlers');
    expect(blockIndex).toBeGreaterThan(-1);
    expect(callIndex).toBeGreaterThan(blockIndex);
  });

  it('resolves that require to the aggregator that registers every AI channel', () => {
    const aggregator = require.resolve('../../src/ipc');
    expect(aggregator).toBe(path.join(__dirname, '..', '..', 'src', 'ipc', 'index.js'));
  });
});

describe('registering the AI IPC does no network work and builds no provider', () => {
  const mockHandlers = new Map();
  const mockListeners = new Map();
  const mockOpenaiFactory = jest.fn();
  const mockAnthropicFactory = jest.fn();

  let fetchSpy;
  let registerAllAiIpc;

  beforeAll(() => {
    jest.resetModules();

    jest.doMock('electron', () => ({
      ipcMain: {
        handle: (channel, fn) => mockHandlers.set(channel, fn),
        on: (channel, fn) => mockListeners.set(channel, fn),
        removeHandler: (channel) => mockHandlers.delete(channel)
      },
      safeStorage: { isEncryptionAvailable: () => false }
    }));
    jest.doMock('electron-store', () => jest.fn().mockImplementation(() => ({
      get: (_key, fallback) => fallback,
      set: () => {}
    })));
    jest.doMock('@ai-sdk/openai', () => ({
      createOpenAI: (...args) => {
        mockOpenaiFactory(...args);
        const model = () => ({});
        model.chat = () => ({});
        return model;
      }
    }));
    jest.doMock('@ai-sdk/anthropic', () => ({
      createAnthropic: (...args) => {
        mockAnthropicFactory(...args);
        return () => ({});
      }
    }));

    // Spy BEFORE the module is loaded, so even a require-time call is caught.
    fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({ ok: true, status: 200 });

    registerAllAiIpc = require('../../src/ipc');
    registerAllAiIpc({ webContents: { isDestroyed: () => true, send: jest.fn() } });
  });

  afterAll(() => {
    fetchSpy.mockRestore();
    jest.dontMock('electron');
    jest.dontMock('electron-store');
    jest.dontMock('@ai-sdk/openai');
    jest.dontMock('@ai-sdk/anthropic');
    jest.resetModules();
  });

  it('registers the AI channels', () => {
    expect(mockHandlers.has('renderer:get-ai-status')).toBe(true);
    expect(mockHandlers.has('renderer:ai-test-provider')).toBe(true);
    expect(mockListeners.has('renderer:ai-chat-stream')).toBe(true);
  });

  it('made no fetch and constructed no model client', () => {
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(mockOpenaiFactory).not.toHaveBeenCalled();
    expect(mockAnthropicFactory).not.toHaveBeenCalled();
  });
});
