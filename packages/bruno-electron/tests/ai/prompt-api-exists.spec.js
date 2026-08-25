const fs = require('fs');
const path = require('path');
const Bru = require('@usebruno/js/src/bru');
const { bindRunRequest } = require('@usebruno/js/src/runtime/scripted-entries');
const { GRIDMAN_API_REFERENCE, buildSystemPrompt } = require('../../src/ipc/ai/chat-prompts');

/**
 * THE ASSISTANT MUST NOT BE TAUGHT AN API THAT DOES NOT EXIST.
 *
 * The prompt is where the model learns what it may write, and nothing checks
 * it against the runtime — so it drifted. It told the model to chain requests
 * with `bru.ctx.runRequest(pathname)`; `bru.ctx` is undefined on both sandboxes
 * and the real entry point is `bru.runRequest`. Every script the model produced
 * for that task threw at the first line, and the prompt's own API reference
 * contradicted it four lines earlier.
 *
 * This resolves each `bru.<path>` the prompt mentions against a REAL Bru
 * instance rather than against a list written next to it, so a rename in
 * bruno-js fails here instead of shipping as advice.
 */

const buildBru = () => {
  const bru = new Bru({ runtime: 'nodevm', collectionPath: path.join('/', 'w', 'c') });
  // Bound per run, not on the class, and it is the very member that drifted.
  bindRunRequest(bru, async () => ({}));
  return bru;
};

const resolve = (root, dottedPath) =>
  dottedPath.split('.').reduce((acc, key) => (acc == null ? acc : acc[key]), root);

// Every `bru.a.b(` call the model is shown, from the API reference and from the
// tool descriptions that reach it through the system prompt.
const mentionedPaths = (text) => {
  const found = new Set();
  for (const match of text.matchAll(/\bbru\.([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*\(/g)) {
    found.add(match[1]);
  }
  return [...found].sort();
};

// chat.js's tool descriptions go to the model in the same request as the
// system prompt, and the first version of this suite read only chat-prompts.js
// — which is exactly how one `bru.getSecretVar` survived the first pass.
const CHAT_SOURCE = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'ipc', 'ai', 'chat.js'), 'utf8');

const PROMPT_TEXT = [
  GRIDMAN_API_REFERENCE,
  ...['tests', 'pre-request', 'post-response', 'docs'].map((t) => buildSystemPrompt(t, true)),
  CHAT_SOURCE
].join('\n');

describe('every bru API the prompt advertises exists on the runtime', () => {
  const paths = mentionedPaths(PROMPT_TEXT);

  it('finds APIs to check at all, so this cannot pass by matching nothing', () => {
    expect(paths.length).toBeGreaterThan(15);
    expect(paths).toContain('runRequest');
    expect(paths).toContain('getEnvVar');
  });

  it.each(paths)('bru.%s is a function', (dottedPath) => {
    expect(typeof resolve(buildBru(), dottedPath)).toBe('function');
  });
});
