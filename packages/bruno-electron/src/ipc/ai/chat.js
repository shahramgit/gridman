const { ipcMain } = require('electron');
const { streamText, stepCountIs } = require('ai');
const { z } = require('zod');
const { TOOL_LABELS, buildSystemPrompt, resolveContentType } = require('./chat-prompts');
const {
  formatRequestContext,
  formatResponseShape,
  formatVariablesList,
  searchVariables,
  formatSearchVariablesResult,
  formatRequestsList,
  searchRequests,
  formatSearchRequestsResult
} = require('./context');
const { preferencesUtil } = require('../../store/preferences');
const { isBuiltInModelId } = require('./providers');
const { logAiError, logAiWarning, tlsTrustGuidance } = require('./errors');

// Read fresh on every stream — the user can tighten redaction in Preferences
// mid-conversation and the next message must honor it.
const getSecurityPrefs = () => preferencesUtil.getAiSecurityPreferences();

const activeStreams = new Map();

const CONTENT_LABELS = {
  'app': 'App Code',
  'tests': 'Test Code',
  'pre-request': 'Pre-Request Script',
  'post-response': 'Post-Response Script',
  'docs': 'Documentation'
};

const APP_DISABLED_NOTICE = 'App mode is currently DISABLED for this request. The App tab is hidden and any code written to \'app\' will not be visible or runnable. Do NOT call write_content(\'app\'); instead, tell the user to open the request\'s Settings tab and turn on "Enable App" first, then ask them to run the request again.';

const buildContextMessage = (contentType, allContent, requestContext, variables, security, appEnabled, requests) => {
  const parts = [];
  if (appEnabled === false) {
    parts.push(`Note: ${APP_DISABLED_NOTICE}`);
  }
  const ctx = formatRequestContext(requestContext, { includeResponse: true, security });
  if (ctx) {
    parts.push(`HTTP Request Context:\n${ctx}`);
  }

  const varsStr = formatVariablesList(variables, { security });
  if (varsStr) {
    parts.push(`Available Variables (names only — call search_variables(query) for a value):\n${varsStr}`);
  }

  const requestsStr = formatRequestsList(requests, { security });
  if (requestsStr) {
    parts.push(`Requests in this collection (preview — call list_requests / search_requests for full details, use \`pathname\` with bru.ctx.runRequest):\n${requestsStr}`);
  }

  const activeLabel = CONTENT_LABELS[contentType] || 'Code';
  const activeContent = allContent[contentType] || '';
  if (activeContent.trim()) {
    parts.push(`Current ${activeLabel} (active tab — snapshot only; use read_content('${contentType}') to get the latest version before writing):\n\`\`\`\n${activeContent}\n\`\`\``);
  } else {
    parts.push(`The ${activeLabel} (active tab) is currently empty. Use read_content('${contentType}') before writing new content.`);
  }

  const others = Object.entries(allContent)
    .filter(([type, content]) => type !== contentType && content && content.trim());
  if (others.length > 0) {
    const summary = others
      .map(([type, content]) => `${CONTENT_LABELS[type] || type}:\n\`\`\`\n${content}\n\`\`\``)
      .join('\n\n');
    parts.push(`Other content in this request:\n${summary}`);
  }

  return parts.join('\n\n');
};

// Defensive fallback: if the model returns a markdown code block instead of
// calling write_content, extract the fenced code so the UI still has something
// to diff against. The tool path is the primary route.
const extractFencedCode = (text) => {
  if (!text) return null;
  const fenced = text.match(/```(?:[\w-]+)?\s*\n([\s\S]*?)```/);
  return fenced ? fenced[1].trim() : null;
};

const READ_PARAMS = z.object({
  type: z.string().describe('Section to read. One of: \'app\', \'tests\', \'pre-request\', \'post-response\', \'docs\'.')
});
const WRITE_PARAMS = z.object({
  type: z.string().describe('Section to write. One of: \'app\', \'tests\', \'pre-request\', \'post-response\', \'docs\'.'),
  content: z.string().describe('The complete new content for the section.')
});
const READ_RESPONSE_PARAMS = z.object({});
const SEARCH_VARS_PARAMS = z.object({
  query: z
    .string()
    .optional()
    .describe('Substring to match against variable names (case-insensitive). Omit to list the first 50 variables.')
});
const LIST_REQUESTS_PARAMS = z.object({});
const SEARCH_REQUESTS_PARAMS = z.object({
  query: z
    .string()
    .describe('Substring to match against request name, URL, pathname, folder path (case-insensitive), or an exact HTTP method like GET/POST.')
});

/**
 * Structured request edits.
 *
 * Until these existed the assistant could write a request's tests, scripts and
 * docs but not the request — so "create a request for X", the most obvious
 * thing to ask an API client's assistant, came back as a paragraph telling the
 * user what to type.
 *
 * The contract is the one write_content already follows and is the reason this
 * is safe: NOTHING here touches disk. The tool records a proposal, the renderer
 * shows it, and the user accepts it. On accept a create becomes a TRANSIENT
 * request (the same unsaved-request concept the sidebar's + button uses) and an
 * update becomes an unsaved draft — so even an accepted proposal still needs
 * the user's own save before anything is written into their collection.
 *
 * Credential-shaped fields are deliberately absent. `auth.mode` is settable
 * because "inherit from the collection" is a genuine, valueless choice; auth
 * VALUES are not, because the model cannot see a real credential (redaction) so
 * anything it produced would be a guess, and a wrong guess here sends the
 * user's request somewhere with the wrong identity.
 */
const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

const HEADER_SCHEMA = z.object({
  name: z.string().max(200),
  value: z.string().max(4096),
  enabled: z.boolean().optional().describe('Defaults to true.')
});

const BODY_SCHEMA = z.object({
  mode: z
    .enum(['none', 'json', 'text', 'xml', 'sparql', 'formUrlEncoded', 'multipartForm', 'graphql'])
    .describe('Body mode. Use \'none\' for GET-style requests.'),
  content: z
    .string()
    .max(100000)
    .optional()
    .describe('Raw body text for the json/text/xml/sparql modes. Omit for \'none\'.')
});

const AUTH_SCHEMA = z.object({
  mode: z
    .enum(['none', 'inherit'])
    .describe('Only \'none\' or \'inherit\' (inherit the collection/folder auth). Credentials cannot be set from here — tell the user to fill those in the Auth tab.')
});

const CREATE_REQUEST_PARAMS = z.object({
  name: z.string().max(200).describe('Display name for the request, e.g. "Tehran Weather".'),
  method: z.enum(HTTP_METHODS).describe('HTTP method.'),
  url: z.string().max(4096).describe('Full URL. Query parameters written here are parsed into the params table automatically — do not send them separately.'),
  folderPathname: z
    .string()
    .max(4096)
    .optional()
    .describe('Absolute pathname of an existing folder in this collection to create it in, exactly as returned by list_requests / search_requests. Omit for the collection root.'),
  headers: z.array(HEADER_SCHEMA).max(50).optional(),
  body: BODY_SCHEMA.optional(),
  auth: AUTH_SCHEMA.optional(),
  docs: z.string().max(50000).optional().describe('Optional markdown documentation to create alongside the request.')
});

const UPDATE_REQUEST_PARAMS = z.object({
  method: z.enum(HTTP_METHODS).optional(),
  url: z.string().max(4096).optional().describe('Full replacement URL. Query parameters are re-parsed into the params table.'),
  headers: z
    .array(HEADER_SCHEMA)
    .max(50)
    .optional()
    .describe('COMPLETE replacement header list, not a patch — omit the field entirely to leave headers alone.'),
  body: BODY_SCHEMA.optional(),
  auth: AUTH_SCHEMA.optional()
});

/**
 * Workflow authoring.
 *
 * A workflow is stored as a node GRAPH — ids, ports, x/y coordinates, explicit
 * connection records including a loop body's edge back into its own loop node.
 * Asking a model to emit that is asking it to be a layout engine, and every
 * mistake is an unrunnable flow.
 *
 * So the model writes an ordered STEP LIST instead, and Gridman converts it.
 * That conversion is not new code written for the AI: it is the same
 * `migrateStepsToGraph` normalisation that reads v1 workflow documents, which
 * runs on save whenever a document has `steps` and no `nodes`. The assistant
 * gets correct layout and wiring for free, and shares a code path that already
 * had to be right.
 */
const WORKFLOW_STEP_TYPES = ['request', 'map', 'setvars', 'condition', 'delay', 'loop', 'script'];

// The step schema is recursive (condition/loop nest a body), and depth is
// bounded so a model that nests forever produces a validation error rather than
// a document that blows the stack on normalisation.
const workflowStepSchema = (depth) => {
  const base = {
    type: z.enum(WORKFLOW_STEP_TYPES),
    name: z.string().max(200).optional(),
    ref: z
      .object({
        collection: z.string().max(4096).describe('Collection pathname, verbatim from list_requests.'),
        request: z.string().max(4096).describe('Request pathname, verbatim from list_requests.')
      })
      .optional()
      .describe('request steps only.'),
    mappings: z
      .array(
        z.object({
          from: z.enum(['body', 'header', 'status']),
          path: z.string().max(500),
          target: z.string().max(200).describe('Flow variable to write, referenced later as {{target}}.')
        })
      )
      .max(50)
      .optional()
      .describe('map steps only.'),
    assignments: z
      .array(z.object({ name: z.string().max(200), value: z.string().max(4096) }))
      .max(50)
      .optional()
      .describe('setvars steps only.'),
    expression: z.string().max(2000).optional().describe('condition steps only.'),
    onFalse: z.enum(['stop', 'continue']).optional().describe('condition steps only.'),
    mode: z.enum(['list', 'count']).optional().describe('loop steps only.'),
    source: z.string().max(200).optional().describe('loop steps, list mode: the array flow variable to iterate.'),
    itemVar: z.string().max(200).optional().describe('loop steps only. Defaults to "item".'),
    count: z.string().max(200).optional().describe('loop steps, count mode. May be a {{template}}.'),
    breakExpr: z.string().max(2000).optional().describe('loop steps only: truthy exits the loop early.'),
    durationMs: z.number().int().min(0).max(300000).optional().describe('delay steps only.'),
    code: z.string().max(50000).optional().describe('script steps only.'),
    assignTo: z.string().max(200).optional().describe('script steps only: flow variable for the result.')
  };
  if (depth > 0) {
    base.steps = z
      .array(z.lazy(() => workflowStepSchema(depth - 1)))
      .max(50)
      .optional()
      .describe('Nested body for LOOP steps only. A condition does not nest — it gates the steps that follow it.');
  }
  return z.object(base);
};

const READ_WORKFLOW_PARAMS = z.object({});
const WRITE_WORKFLOW_PARAMS = z.object({
  steps: z
    .array(workflowStepSchema(4))
    .max(100)
    .describe('The COMPLETE ordered step list. A replacement, not a patch. Do not include a start step.')
});

const registerChatIpc = ({ mainWindow, resolveModel, pickDefaultModelId, isAiEnabled }) => {
  ipcMain.on('renderer:ai-chat-stop', (_event, { requestId } = {}) => {
    const controller = activeStreams.get(requestId);
    if (controller) {
      controller.abort();
      activeStreams.delete(requestId);
    }
  });

  ipcMain.on('renderer:ai-chat-stream', async (_event, payload) => {
    const { messages, allContent, contentType, requestContext, variables, requests, requestId, model: modelId, appEnabled, workflow } = payload || {};

    const send = (channel, data) => {
      if (mainWindow?.webContents && !mainWindow.webContents.isDestroyed()) {
        mainWindow.webContents.send(channel, data);
      }
    };

    // Validate payload shape upfront. Without this, a missing or wrong-typed
    // `messages` would throw out of the handler at `messages.map(...)` below,
    // bypassing the try/catch and never emitting `main:ai-chat-error` — the
    // renderer would then sit waiting on a stream that will never arrive.
    if (!requestId || typeof requestId !== 'string') {
      console.error('[AI] ai-chat-stream missing/invalid requestId, dropping payload');
      return;
    }
    if (!Array.isArray(messages)) {
      send('main:ai-chat-error', { requestId, error: 'Invalid request: messages must be an array' });
      return;
    }

    if (!isAiEnabled()) {
      send('main:ai-chat-error', { requestId, error: 'AI features are disabled. Enable them in Preferences > AI.' });
      return;
    }

    // Empty / 'auto' signals "let the backend pick" — resolves to the user's
    // configured default model, falling back to the first available.
    let effectiveModelId = modelId;
    if (!effectiveModelId || effectiveModelId === 'auto') {
      effectiveModelId = pickDefaultModelId();
      if (!effectiveModelId) {
        send('main:ai-chat-error', { requestId, error: 'No AI model available. Configure a provider in Preferences > AI.' });
        return;
      }
    }

    let model;
    try {
      model = resolveModel(effectiveModelId);
    } catch (err) {
      send('main:ai-chat-error', { requestId, error: err.message });
      return;
    }

    const normalizedContent = allContent || {};
    const effectiveType = contentType || 'app';
    const hasMultiple = Object.values(normalizedContent).filter((c) => c && c.trim()).length > 1;
    const security = getSecurityPrefs();

    const readState = {};
    let workflowWasRead = false;
    const writeResults = [];
    const requestChanges = [];
    const workflowChanges = [];

    const tools = {
      read_content: {
        description: 'Read the current content of a section. MUST be called before write_content for the same type.',
        inputSchema: READ_PARAMS,
        execute: async ({ type }) => {
          const resolved = resolveContentType(type, effectiveType);
          const content = normalizedContent[resolved] || '';
          readState[resolved] = content;
          return content || `(empty — no existing content for '${resolved}')`;
        }
      },
      write_content: {
        description: 'Write complete updated content to a section. MUST call read_content for the same type first. The content parameter must be the COMPLETE file content, not a diff.',
        inputSchema: WRITE_PARAMS,
        execute: async ({ type, content }) => {
          const resolved = resolveContentType(type, effectiveType);
          if (resolved === 'app' && appEnabled === false) {
            return APP_DISABLED_NOTICE;
          }
          if (!(resolved in readState)) {
            // Tolerate models that skip read_content. We still record the
            // original snapshot so the diff renders correctly, but the UI
            // surfaces a warning when wasRead === false.
            readState[resolved] = normalizedContent[resolved] || '';
            writeResults.push({
              type: resolved,
              content,
              originalContent: readState[resolved],
              wasRead: false
            });
          } else {
            writeResults.push({
              type: resolved,
              content,
              originalContent: readState[resolved],
              wasRead: true
            });
          }
          return 'Success: Changes prepared for user review. The user will see a diff and can accept or reject your changes.';
        }
      },
      read_response: {
        description: 'Read the redacted shape of the response body from the last API request execution. Returns keys, array structure, and value types (as `<string>`, `<number>`, etc.) — actual values are stripped for user privacy. Use it to learn property paths and types when writing tests, scripts, or assertions; do not treat the placeholders as real values.',
        inputSchema: READ_RESPONSE_PARAMS,
        execute: async () => {
          const status = requestContext?.responseStatus;
          const data = requestContext?.responseData;
          if (!status && data == null) {
            return '(No response available — the request has not been executed yet. The user needs to run the request first.)';
          }
          const formatted = formatResponseShape(status, data, { security });
          return formatted || '(empty response)';
        }
      },
      search_variables: {
        description: 'Search environment / collection / global / runtime variables by name (case-insensitive substring match). Use this when the user has many variables or you need to confirm a name before referencing it in code. Values are returned, but variables marked `secret` (or whose names match patterns like `*_token`, `*_secret`, `password`, etc.) come back as `<redacted>`. Each result has a `scope` field — use it to pick the right runtime accessor: `bru.getEnvVar` for `env`, `bru.getGlobalEnvVar` for `global`, `bru.getCollectionVar` / `bru.getFolderVar` / `bru.getRequestVar` for `collection`, `bru.getVar` for `runtime`, and `bru.getSecretVar` for any value that came back redacted. Never hard-code a returned value.',
        inputSchema: SEARCH_VARS_PARAMS,
        execute: async ({ query }) => {
          if (!Array.isArray(variables) || variables.length === 0) {
            return '(No variables available — the collection has no environment, runtime, or collection variables defined.)';
          }
          const result = searchVariables(variables, query);
          return formatSearchVariablesResult(result, query, { security });
        }
      },
      list_requests: {
        description: 'List every HTTP / GraphQL / gRPC / WebSocket request in this collection. Returns each request\'s name, method, url, folder path, and `pathname`. Use `pathname` — never the name — when generating code that calls `bru.ctx.runRequest(pathname)` (collection/folder-level apps) or when telling the user which file to open. Prefer search_requests when the collection is large or you already know a keyword.',
        inputSchema: LIST_REQUESTS_PARAMS,
        execute: async () => {
          if (!Array.isArray(requests) || requests.length === 0) {
            return '(No requests in this collection.)';
          }
          return formatSearchRequestsResult(searchRequests(requests, ''), '', { security });
        }
      },
      search_requests: {
        description: 'Search this collection\'s requests by a case-insensitive substring matched against name / url / pathname / folder path (or an exact HTTP method like GET/POST). Returns each match\'s name, method, url, folder path, and `pathname`. Use `pathname` verbatim when generating `bru.ctx.runRequest(pathname)` calls for a collection/folder-level app.',
        inputSchema: SEARCH_REQUESTS_PARAMS,
        execute: async ({ query }) => {
          if (!Array.isArray(requests) || requests.length === 0) {
            return '(No requests in this collection.)';
          }
          const result = searchRequests(requests, query);
          return formatSearchRequestsResult(result, query, { security });
        }
      },
      create_request: {
        description: 'Propose a NEW request in this collection. Does not create anything by itself — the user sees a preview and accepts it, and an accepted request is created UNSAVED so they still choose where it lands. Put query parameters in the url; they are parsed into the params table. Use this instead of telling the user what to type by hand.',
        inputSchema: CREATE_REQUEST_PARAMS,
        execute: async (input) => {
          requestChanges.push({ op: 'create', ...input });
          return 'Success: the new request is prepared for user review. The user will see a preview and can accept or reject it. Do not repeat the URL in your reply — describe what the request does.';
        }
      },
      update_request: {
        description: 'Propose changes to the request the user currently has open — url, method, headers, body, or auth mode. Does not change anything by itself: the user sees a preview and accepts, and an accepted change becomes an unsaved draft they still have to save. Only the ACTIVE request can be changed; to change a different one, ask the user to open it.',
        inputSchema: UPDATE_REQUEST_PARAMS,
        execute: async (input) => {
          // `requestContext` is null unless a request is open — the renderer
          // builds it only for `aiContext.kind === 'request'` (see
          // buildAiRequestContext). Do NOT test a `kind` field on it: it has
          // none, so that check would silently never fire and this tool would
          // happily propose edits against a folder or collection chat.
          if (!requestContext) {
            return 'No request is open. update_request only edits the request the user currently has open — ask them to open one, or use create_request to propose a new one.';
          }
          const fields = Object.keys(input || {}).filter((k) => input[k] !== undefined);
          if (fields.length === 0) {
            return 'No fields given. Pass at least one of url, method, headers, body, auth.';
          }
          requestChanges.push({ op: 'update', ...input });
          return 'Success: the change is prepared for user review. The user will see a before/after preview and can accept or reject it.';
        }
      },
      read_workflow: {
        description: 'Read the workflow the user has open, as an ordered step list. MUST be called before write_workflow.',
        inputSchema: READ_WORKFLOW_PARAMS,
        execute: async () => {
          if (!workflow) {
            return 'No workflow is open. These tools only apply on a workflow tab.';
          }
          workflowWasRead = true;
          const steps = Array.isArray(workflow.steps) ? workflow.steps : [];
          if (steps.length === 0) {
            return '(empty workflow — it has no steps yet)';
          }
          return JSON.stringify(steps, null, 2);
        }
      },
      write_workflow: {
        description: 'Propose a COMPLETE new step list for the open workflow. A replacement, not a patch. Does not save anything: the user sees what the flow becomes and accepts or rejects it. MUST call read_workflow first.',
        inputSchema: WRITE_WORKFLOW_PARAMS,
        execute: async ({ steps }) => {
          if (!workflow) {
            return 'No workflow is open. These tools only apply on a workflow tab.';
          }
          workflowChanges.push({
            steps,
            originalSteps: Array.isArray(workflow.steps) ? workflow.steps : [],
            // Same warning the text writes carry: a replacement written without
            // reading first can silently drop steps the model never saw.
            wasRead: workflowWasRead
          });
          return 'Success: the workflow change is prepared for user review. The user will see the new flow and can accept or reject it.';
        }
      }
    };

    const allMessages = [
      { role: 'user', content: buildContextMessage(effectiveType, normalizedContent, requestContext, variables, security, appEnabled, requests) },
      ...messages.map((m) => ({ role: m.role, content: m.content }))
    ];

    const controller = new AbortController();
    activeStreams.set(requestId, controller);
    let fullText = '';

    // One completion payload for every kind of proposal, so a turn that both
    // creates a request and writes its tests arrives as a single message with
    // both cards rather than racing two completions for the same requestId.
    const finishWithProposals = () => {
      const primary = writeResults[writeResults.length - 1];
      send('main:ai-chat-complete', {
        requestId,
        message: fullText || 'Here are the proposed changes:',
        code: primary ? primary.content : null,
        contentType: primary ? primary.type : effectiveType,
        writes: writeResults.length
          ? writeResults.map((w) => ({
              type: w.type,
              content: w.content,
              originalContent: w.originalContent,
              wasRead: w.wasRead
            }))
          : undefined,
        requestChanges: requestChanges.length ? requestChanges : undefined,
        workflowChanges: workflowChanges.length ? workflowChanges : undefined
      });
    };

    try {
      const result = streamText({
        model,
        system: buildSystemPrompt(effectiveType, hasMultiple),
        messages: allMessages,
        tools,
        stopWhen: stepCountIs(8),
        toolChoice: 'auto',
        maxOutputTokens: isBuiltInModelId(effectiveModelId) ? 16000 : undefined,
        abortSignal: controller.signal
      });

      let streamError = null;
      for await (const part of result.fullStream) {
        if (controller.signal.aborted) break;
        switch (part.type) {
          case 'text-delta': {
            fullText += part.text;
            send('main:ai-chat-chunk', { requestId, chunk: part.text, fullText });
            break;
          }
          case 'tool-call': {
            const input = part.input || {};
            const toolType = input.type || effectiveType;
            const label = TOOL_LABELS[part.toolName]?.[toolType]
              || TOOL_LABELS[part.toolName]?.default
              || `Running ${part.toolName}`;
            send('main:ai-chat-tool-activity', {
              requestId,
              toolName: part.toolName,
              toolArgs: input,
              label
            });
            break;
          }
          case 'tool-result': {
            send('main:ai-chat-tool-done', { requestId, toolName: part.toolName });
            break;
          }
          case 'error': {
            streamError = part.error;
            break;
          }
          default:
            break;
        }
      }

      if (streamError) throw streamError;

      activeStreams.delete(requestId);

      if (controller.signal.aborted) {
        send('main:ai-chat-stopped', { requestId, message: fullText });
        return;
      }

      if (writeResults.length > 0 || requestChanges.length > 0 || workflowChanges.length > 0) {
        finishWithProposals();
        return;
      }

      if (fullText.trim()) {
        const fallback = extractFencedCode(fullText);
        send('main:ai-chat-complete', {
          requestId,
          message: fullText,
          code: fallback,
          contentType: effectiveType
        });
        return;
      }

      send('main:ai-chat-complete', {
        requestId,
        message: 'I wasn\'t able to generate a response. Could you try rephrasing your request?',
        code: null,
        contentType: effectiveType
      });
    } catch (error) {
      activeStreams.delete(requestId);

      if (error?.name === 'AbortError' || controller.signal.aborted) {
        send('main:ai-chat-stopped', { requestId, message: fullText });
        return;
      }

      // The AI SDK may surface a stream error after the model successfully
      // emitted tool calls. Treat partial writes as the result so the user
      // doesn't lose them.
      if (writeResults.length > 0 || requestChanges.length > 0 || workflowChanges.length > 0) {
        // `error.message` folded the provider's response body — which echoes
        // the request — into the log line. See ./errors.js.
        logAiWarning('chat stream error after successful writes, surfacing writes', error);
        finishWithProposals();
        return;
      }

      logAiError('chat stream failed', error);
      // A certificate failure is a configuration problem with a specific fix,
      // so say what it is instead of leaving the SDK's "Cannot connect to API"
      // as the user's only clue.
      const tlsHint = tlsTrustGuidance(error);
      send('main:ai-chat-error', {
        requestId,
        error: tlsHint || error?.message || 'Failed to get AI response'
      });
    }
  });
};

module.exports = registerChatIpc;
// Exported so the leak tests can assert on the message that is prepended to
// EVERY chat conversation, rather than only on the formatters it composes.
module.exports.buildContextMessage = buildContextMessage;
