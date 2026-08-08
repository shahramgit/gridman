export const PROCESSING_STAGES = [
  { id: 'sending', label: 'Sending request', icon: 'send' },
  { id: 'thinking', label: 'AI is thinking', icon: 'sparkles' },
  { id: 'generating', label: 'Generating response', icon: 'wand' },
  { id: 'applying', label: 'Preparing changes', icon: 'code' }
];

// Upstream also carries an 'app' content type for its App feature. Gridman has
// no equivalent surface and no `updateAppCode` action, so it is omitted here
// rather than shipped as a diff target that can never be applied.
export const CONTENT_TYPE_LABELS = {
  'tests': 'Tests',
  'pre-request': 'Script',
  'post-response': 'Script',
  'docs': 'Docs'
};

export const SUGGESTIONS_BY_TYPE = {
  'tests': [
    { label: 'Generate basic tests', prompt: 'Generate tests for status code, response body, and headers' },
    {
      label: 'Test response structure',
      prompt: 'Write tests to validate the response body structure and data types'
    },
    { label: 'Test error cases', prompt: 'Write tests for common error scenarios' },
    { label: 'Test response time', prompt: 'Add a test to verify response time is acceptable' }
  ],
  'pre-request': [
    { label: 'Add authentication', prompt: 'Add authorization header from environment variable' },
    { label: 'Set dynamic variables', prompt: 'Set dynamic request variables like timestamp or unique ID' },
    {
      label: 'Conditional logic',
      prompt: 'Add conditional logic to modify the request based on environment'
    }
  ],
  'post-response': [
    { label: 'Extract to variables', prompt: 'Extract data from response and save to environment variables' },
    { label: 'Store auth token', prompt: 'Extract auth token from response and save for future requests' },
    { label: 'Log response', prompt: 'Log response status and body for debugging' },
    { label: 'Transform response', prompt: 'Transform and process the response data' }
  ],
  'docs': [
    { label: 'Generate full docs', prompt: 'Generate comprehensive API documentation for this endpoint' },
    { label: 'Document parameters', prompt: 'Document all request parameters, headers, and body' },
    { label: 'Add examples', prompt: 'Add request and response examples' },
    { label: 'Document errors', prompt: 'Document common error responses and status codes' }
  ]
};

export const PLACEHOLDER_BY_TYPE = {
  'tests': { empty: 'Describe the tests you want…', filled: 'Ask to modify or add tests…' },
  'pre-request': { empty: 'Describe the script you want…', filled: 'Ask to modify the script…' },
  'post-response': { empty: 'Describe the script you want…', filled: 'Ask to modify the script…' },
  'docs': { empty: 'Describe the documentation…', filled: 'Ask to update the docs…' }
};

/** What the chat targets when the active pane has no code surface of its own. */
export const DEFAULT_CONTENT_TYPE = 'docs';
