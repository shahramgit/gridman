/**
 * AN AI FAILURE MUST NOT PRINT THE PROMPT.
 *
 * The AI SDK's APICallError carries `requestBodyValues` — the entire assembled
 * outbound body: request context, variables, response shape, docs, and
 * anything the redaction layer let through. `console.error('...', err)` dumps
 * all of it into the terminal and into whatever collects the app's stdout.
 * `err.message` is not safe either: providers fold their response body (which
 * echoes the request) into it.
 */

const mockHandlers = new Map();
const mockListeners = new Map();

jest.mock('electron', () => ({
  ipcMain: {
    handle: (channel, fn) => mockHandlers.set(channel, fn),
    on: (channel, fn) => mockListeners.set(channel, fn),
    removeHandler: (channel) => mockHandlers.delete(channel)
  },
  safeStorage: { isEncryptionAvailable: () => false }
}));

const mockGenerateText = jest.fn();
const mockStreamText = jest.fn();
jest.mock('ai', () => ({
  generateText: (...args) => mockGenerateText(...args),
  streamText: (...args) => mockStreamText(...args),
  stepCountIs: (n) => n
}));

jest.mock('../../src/ipc/ai/providers', () => {
  const actual = jest.requireActual('../../src/ipc/ai/providers');
  return { ...actual, getModel: () => ({ __sdk: 'stub' }) };
});

let mockStoreData = {};
jest.mock('electron-store', () => {
  return jest.fn().mockImplementation(() => ({
    get: (key, fallback) => (key in mockStoreData ? mockStoreData[key] : fallback),
    set: (key, value) => {
      mockStoreData[key] = value;
    }
  }));
});

const registerAllAiIpc = require('../../src/ipc');
const { describeAiError } = require('../../src/ipc/ai/errors');
const { invalidateAiPreferencesCache } = require('../../src/store/preferences');

const PROMPT_SECRET = 'INTERNAL-PROMPT-CONTENTS-sk-live-9999';

// Shaped like @ai-sdk's APICallError: the outbound body hangs off the error.
const apiCallError = () => {
  const err = new Error(`Bad request: {"error":"invalid value ${PROMPT_SECRET}"}`);
  err.name = 'AI_APICallError';
  err.statusCode = 400;
  err.url = 'https://llm.corp.internal/v1/chat/completions';
  err.requestBodyValues = {
    messages: [{ role: 'user', content: `HTTP Request Context: ${PROMPT_SECRET}` }]
  };
  err.requestBodyText = JSON.stringify(err.requestBodyValues);
  err.responseBody = `{"error":"${PROMPT_SECRET}"}`;
  return err;
};

const mainWindow = { webContents: { isDestroyed: () => false, send: jest.fn() } };

// Everything any console.* call was handed, flattened to text the way a
// terminal would render it. An error object passed as an argument shows up
// here with all of its own enumerable properties.
const loggedText = (spies) =>
  spies
    .flatMap((spy) => spy.mock.calls)
    .flat()
    .map((arg) => {
      if (arg instanceof Error) {
        return [arg.stack, JSON.stringify(Object.entries(arg))].join(' ');
      }
      return typeof arg === 'string' ? arg : JSON.stringify(arg);
    })
    .join('\n');

let errorSpy;
let warnSpy;

beforeAll(() => {
  registerAllAiIpc(mainWindow);
});

beforeEach(() => {
  mockStoreData = {
    preferences: {
      ai: {
        enabled: true,
        providers: { openai: { enabled: true } },
        openaiCompatibleEndpoints: [{
          id: 'corp',
          name: 'Corp',
          baseURL: 'https://llm.corp.internal/v1',
          enabled: true,
          models: [{ id: 'm', label: 'M', modelId: 'corp-model' }]
        }]
      }
    }
  };
  invalidateAiPreferencesCache();
  mockGenerateText.mockReset();
  mockStreamText.mockReset();
  mainWindow.webContents.send.mockClear();
  errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  errorSpy.mockRestore();
  warnSpy.mockRestore();
});

describe('describeAiError', () => {
  it('reduces an APICallError to a name and a status', () => {
    expect(describeAiError(apiCallError())).toBe('AI_APICallError (HTTP 400)');
  });

  it('carries no request or response content', () => {
    expect(describeAiError(apiCallError())).not.toContain(PROMPT_SECRET);
  });

  it('survives a non-error', () => {
    expect(describeAiError(null)).toBe('unknown error');
    expect(describeAiError({})).toBe('Error');
  });
});

describe('handlers log a description, never the error', () => {
  it('chat stream', async () => {
    mockStreamText.mockImplementation(() => {
      throw apiCallError();
    });

    mockListeners.get('renderer:ai-chat-stream')(null, {
      requestId: 'r1',
      messages: [{ role: 'user', content: 'hi' }],
      model: 'openai-compatible:corp::m'
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(errorSpy).toHaveBeenCalled();
    expect(loggedText([errorSpy, warnSpy])).not.toContain(PROMPT_SECRET);
    expect(loggedText([errorSpy, warnSpy])).toContain('AI_APICallError (HTTP 400)');
  });

  it('still tells the user (in their own window) what went wrong', async () => {
    // Withholding the detail from the LOG is the point; the person who typed
    // the prompt still needs to see why it failed.
    mockStreamText.mockImplementation(() => {
      throw apiCallError();
    });

    mockListeners.get('renderer:ai-chat-stream')(null, {
      requestId: 'r2',
      messages: [{ role: 'user', content: 'hi' }],
      model: 'openai-compatible:corp::m'
    });
    await new Promise((resolve) => setImmediate(resolve));

    const sent = mainWindow.webContents.send.mock.calls
      .filter(([channel]) => channel === 'main:ai-chat-error')
      .map(([, payload]) => payload);
    expect(sent.length).toBeGreaterThan(0);
    expect(typeof sent[0].error).toBe('string');
    expect(sent[0].error.length).toBeGreaterThan(0);
  });
});
