const { configureRequest } = require('../../src/ipc/network/index');

// Integration tests: full configureRequest (URL must survive cookie-jar parse)
describe('index: configureRequest — URL normalization', () => {
  it('prepends http:// to localhost:port', async () => {
    const request = { method: 'GET', url: 'localhost:8080', body: {} };
    await configureRequest(null, {}, request, null, null, null, null);
    expect(request.url).toEqual('http://localhost:8080');
  });

  it('prepends http:// to localhost', async () => {
    const request = { method: 'GET', url: 'localhost', body: {} };
    await configureRequest(null, {}, request, null, null, null, null);
    expect(request.url).toEqual('http://localhost');
  });

  it('prepends http:// to 127.0.0.1:port', async () => {
    const request = { method: 'GET', url: '127.0.0.1:3000', body: {} };
    await configureRequest(null, {}, request, null, null, null, null);
    expect(request.url).toEqual('http://127.0.0.1:3000');
  });

  it('prepends http:// to example.com/api/v1', async () => {
    const request = { method: 'GET', url: 'example.com/api/v1', body: {} };
    await configureRequest(null, {}, request, null, null, null, null);
    expect(request.url).toEqual('http://example.com/api/v1');
  });

  it('does not prepend http:// to http://example.com', async () => {
    const request = { method: 'GET', url: 'http://example.com', body: {} };
    await configureRequest(null, {}, request, null, null, null, null);
    expect(request.url).toEqual('http://example.com');
  });

  it('does not prepend http:// to https://example.com', async () => {
    const request = { method: 'GET', url: 'https://example.com', body: {} };
    await configureRequest(null, {}, request, null, null, null, null);
    expect(request.url).toEqual('https://example.com');
  });

  it('does not prepend http:// to ftp://test-domain', async () => {
    const request = { method: 'GET', url: 'ftp://test-domain', body: {} };
    await configureRequest(null, {}, request, null, null, null, null);
    expect(request.url).toEqual('ftp://test-domain');
  });

  it('does not prepend http:// to ws://example.com/socket', async () => {
    const request = { method: 'GET', url: 'ws://example.com/socket', body: {} };
    await configureRequest(null, {}, request, null, null, null, null);
    expect(request.url).toEqual('ws://example.com/socket');
  });

  describe('with variables in the url and no interpolation values', () => {
    it('does not prepend http:// to {{baseUrl}}/api/v1 (template variable)', async () => {
      const url = '{{baseUrl}}/api/v1';
      const request = { method: 'GET', url, body: {} };
      expect.assertions(2);
      try {
        await configureRequest(null, {}, request, null, null, null, null);
      } catch (err) {
        expect(err.message).toBe('Invalid URL');
      } finally {
        expect(request.url).toEqual(url);
      }
    });

    it('does not prepend http:// to {{baseUrl}} alone (template variable)', async () => {
      const url = '{{baseUrl}}';
      const request = { method: 'GET', url, body: {} };
      expect.assertions(2);
      try {
        await configureRequest(null, {}, request, null, null, null, null);
      } catch (err) {
        expect(err.message).toBe('Invalid URL');
      } finally {
        expect(request.url).toEqual(url);
      }
    });
  });
});

// SSE responses used to hand post-response scripts and tests an empty res.getBody(): the
// text/event-stream branch hard-coded `{ data: '', dataBuffer: Buffer.alloc(0) }`. Upstream now
// retains the chunks and rebuilds the body on stream close — usebruno/bruno#8212 (79504ed72).
// Upstream's collector is unbounded; ours stops at MAX_SSE_BODY_BYTES / MAX_SSE_BODY_CHUNKS and
// flags the body as truncated rather than growing until the process OOMs.
describe('index: SSE response body collection (GitHub #8212)', () => {
  const {
    createStreamChunkCollector,
    collectStreamChunk,
    buildResponseBodyFromStreamChunks,
    MAX_SSE_BODY_BYTES,
    MAX_SSE_BODY_CHUNKS
  } = require('../../src/ipc/network/index');

  const sseHeaders = { 'content-type': 'text/event-stream' };

  it('rebuilds the full body from the collected chunks, in order', () => {
    const collector = createStreamChunkCollector();

    collectStreamChunk(collector, Buffer.from('data: Hello\n\n'));
    collectStreamChunk(collector, Buffer.from('data: from\n\n'));
    collectStreamChunk(collector, Buffer.from('data: SSE\n\n'));

    const { data, dataBuffer } = buildResponseBodyFromStreamChunks(collector, sseHeaders, true);

    expect(data).toBe('data: Hello\n\ndata: from\n\ndata: SSE\n\n');
    expect(dataBuffer.toString()).toBe(data);
    expect(collector.truncated).toBe(false);
  });

  it('returns an empty body when the stream produced nothing', () => {
    const collector = createStreamChunkCollector();

    const { data, dataBuffer } = buildResponseBodyFromStreamChunks(collector, sseHeaders, true);

    expect(data).toBe('');
    expect(dataBuffer.length).toBe(0);
  });

  it('accepts string chunks as well as buffers', () => {
    const collector = createStreamChunkCollector();

    collectStreamChunk(collector, 'data: a\n\n');
    collectStreamChunk(collector, Buffer.from('data: b\n\n'));

    const { data } = buildResponseBodyFromStreamChunks(collector, sseHeaders, true);
    expect(data).toBe('data: a\n\ndata: b\n\n');
  });

  it('stops collecting at the byte cap and keeps the prefix that fits', () => {
    const collector = createStreamChunkCollector();
    const oneMb = Buffer.alloc(1024 * 1024, 0x61);

    // 11 MB offered against a 10 MB cap.
    for (let i = 0; i < 11; i++) {
      collectStreamChunk(collector, oneMb);
    }

    expect(collector.truncated).toBe(true);
    expect(collector.bytes).toBe(MAX_SSE_BODY_BYTES);

    const { dataBuffer } = buildResponseBodyFromStreamChunks(collector, sseHeaders, true);
    expect(dataBuffer.length).toBe(MAX_SSE_BODY_BYTES);
  });

  it('splits the chunk that straddles the byte cap instead of dropping it whole', () => {
    const collector = createStreamChunkCollector();

    collectStreamChunk(collector, Buffer.alloc(MAX_SSE_BODY_BYTES - 4, 0x61));
    collectStreamChunk(collector, Buffer.from('abcdefgh'));

    expect(collector.truncated).toBe(true);
    expect(collector.bytes).toBe(MAX_SSE_BODY_BYTES);

    const { dataBuffer } = buildResponseBodyFromStreamChunks(collector, sseHeaders, true);
    expect(dataBuffer.subarray(-4).toString()).toBe('abcd');
  });

  it('stops collecting at the chunk-count cap even when the bytes are tiny', () => {
    const collector = createStreamChunkCollector();
    const tiny = Buffer.from('x');

    for (let i = 0; i < MAX_SSE_BODY_CHUNKS + 50; i++) {
      collectStreamChunk(collector, tiny);
    }

    expect(collector.truncated).toBe(true);
    expect(collector.chunks.length).toBe(MAX_SSE_BODY_CHUNKS);
    expect(collector.bytes).toBeLessThan(MAX_SSE_BODY_BYTES);
  });

  it('ignores further chunks once truncated, so the array never grows again', () => {
    const collector = createStreamChunkCollector();
    collector.truncated = true;

    collectStreamChunk(collector, Buffer.from('ignored'));

    expect(collector.chunks).toHaveLength(0);
    expect(collector.bytes).toBe(0);
  });

  it('tolerates a null collector (non-stream responses)', () => {
    expect(() => collectStreamChunk(null, Buffer.from('x'))).not.toThrow();
  });

  it('parses JSON bodies unless parsing is disabled', () => {
    const makeCollector = () => {
      const collector = createStreamChunkCollector();
      collectStreamChunk(collector, Buffer.from('{"ok":true}'));
      return collector;
    };

    expect(buildResponseBodyFromStreamChunks(makeCollector(), sseHeaders, false).data).toEqual({ ok: true });
    expect(buildResponseBodyFromStreamChunks(makeCollector(), sseHeaders, true).data).toBe('{"ok":true}');
  });

  // Peak memory used to be ~3x the advertised cap: the chunk array, the concatenated buffer and
  // the decoded string were all alive at once in the main process — the process this cap exists
  // to keep alive in the first place.
  it('releases the chunk array once it has been concatenated', () => {
    const collector = createStreamChunkCollector();
    collectStreamChunk(collector, Buffer.from('data: a\n\n'));
    collectStreamChunk(collector, Buffer.from('data: b\n\n'));

    const { dataBuffer } = buildResponseBodyFromStreamChunks(collector, sseHeaders, true);

    expect(dataBuffer.toString()).toBe('data: a\n\ndata: b\n\n');
    expect(collector.chunks).toHaveLength(0);
    expect(collector.released).toBe(true);
  });

  it('ignores chunks that arrive after the body has been rebuilt', () => {
    const collector = createStreamChunkCollector();
    collectStreamChunk(collector, Buffer.from('data: a\n\n'));
    buildResponseBodyFromStreamChunks(collector, sseHeaders, true);

    collectStreamChunk(collector, Buffer.from('data: late\n\n'));

    expect(collector.chunks).toHaveLength(0);
  });

  describe('truncation is announced, not silent', () => {
    it('calls onTruncate once, the moment the byte cap is hit', () => {
      const onTruncate = jest.fn();
      const collector = createStreamChunkCollector({ onTruncate });

      collectStreamChunk(collector, Buffer.alloc(MAX_SSE_BODY_BYTES - 1, 0x61));
      expect(onTruncate).not.toHaveBeenCalled();

      collectStreamChunk(collector, Buffer.from('overflow'));
      expect(onTruncate).toHaveBeenCalledTimes(1);
      expect(onTruncate).toHaveBeenCalledWith(collector);

      // Further chunks must not re-announce it — a 28h stream would spam the console.
      collectStreamChunk(collector, Buffer.from('more'));
      expect(onTruncate).toHaveBeenCalledTimes(1);
    });

    it('calls onTruncate when the chunk-count cap is hit', () => {
      const onTruncate = jest.fn();
      const collector = createStreamChunkCollector({ onTruncate });
      const tiny = Buffer.from('x');

      for (let i = 0; i < MAX_SSE_BODY_CHUNKS; i++) {
        collectStreamChunk(collector, tiny);
      }
      expect(onTruncate).not.toHaveBeenCalled();

      collectStreamChunk(collector, tiny);
      expect(onTruncate).toHaveBeenCalledTimes(1);
    });

    it('does not call onTruncate for a stream that stays under both caps', () => {
      const onTruncate = jest.fn();
      const collector = createStreamChunkCollector({ onTruncate });

      collectStreamChunk(collector, Buffer.from('data: small\n\n'));

      expect(collector.truncated).toBe(false);
      expect(onTruncate).not.toHaveBeenCalled();
    });
  });
});
