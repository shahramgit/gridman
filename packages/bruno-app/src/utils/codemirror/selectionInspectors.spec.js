const { describe, it, expect, beforeAll } = require('@jest/globals');

import {
  bytesToHex,
  escapeJsonString,
  getEpochDateDetails,
  getJsonStringLiteral,
  getSelectionDigests,
  getUnicodeReport,
  getUrlBreakdown,
  md5Hex,
  shaDigestHex
} from './selectionInspectors';

describe('selectionInspectors', () => {
  describe('epoch/date converter', () => {
    it('converts 10 digit epoch seconds to a datetime', () => {
      const details = getEpochDateDetails('1700000000');

      expect(details.kind).toBe('epoch');
      expect(details.interpretations[0].label).toBe('As epoch seconds');
      expect(details.interpretations[0].iso).toBe('2023-11-14T22:13:20.000Z');
      expect(details.interpretations[0].epochMillis).toBe(1700000000000);
      // millis interpretation lands in 1970 and is not plausible, so only one direction is shown
      expect(details.interpretations).toHaveLength(1);
    });

    it('converts 13 digit epoch milliseconds to a datetime', () => {
      const details = getEpochDateDetails('1700000000000');

      expect(details.kind).toBe('epoch');
      expect(details.interpretations[0].label).toBe('As epoch milliseconds');
      expect(details.interpretations[0].iso).toBe('2023-11-14T22:13:20.000Z');
      expect(details.interpretations[0].epochSeconds).toBe(1700000000);
      expect(details.interpretations).toHaveLength(1);
    });

    it('converts quoted epochs copied from JSON', () => {
      expect(getEpochDateDetails('"1700000000"').interpretations[0].iso).toBe('2023-11-14T22:13:20.000Z');
    });

    it('converts ISO-8601 dates to epoch seconds and millis', () => {
      const details = getEpochDateDetails('2023-11-14T22:13:20Z');

      expect(details.kind).toBe('date');
      expect(details.interpretations[0].epochSeconds).toBe(1700000000);
      expect(details.interpretations[0].epochMillis).toBe(1700000000000);
      expect(details.interpretations[0].utc).toContain('14 Nov 2023');
    });

    it('accepts date-only and offset ISO forms', () => {
      expect(getEpochDateDetails('2023-11-14').kind).toBe('date');
      expect(getEpochDateDetails('2023-11-14T22:13:20+03:30').interpretations[0].epochSeconds).toBe(
        1700000000 - 3.5 * 3600
      );
    });

    it('is not applicable to other selections', () => {
      expect(getEpochDateDetails('hello')).toBe(null);
      expect(getEpochDateDetails('12345')).toBe(null);
      expect(getEpochDateDetails('123456789012')).toBe(null);
      expect(getEpochDateDetails('2023-13-99')).toBe(null);
    });
  });

  describe('hash digests', () => {
    beforeAll(() => {
      if (typeof globalThis.TextEncoder === 'undefined') {
        // jsdom does not expose TextEncoder; use node's implementation
        globalThis.TextEncoder = require('util').TextEncoder;
      }
      if (!globalThis.crypto?.subtle) {
        // jsdom does not expose Web Crypto; use node's implementation
        Object.defineProperty(globalThis, 'crypto', {
          value: require('crypto').webcrypto,
          configurable: true
        });
      }
    });

    it('hex encodes bytes', () => {
      expect(bytesToHex(new Uint8Array([0, 1, 171, 255]))).toBe('0001abff');
    });

    it('computes md5 against known vectors', () => {
      expect(md5Hex('')).toBe('d41d8cd98f00b204e9800998ecf8427e');
      expect(md5Hex('abc')).toBe('900150983cd24fb0d6963f7d28e17f72');
      expect(md5Hex('The quick brown fox jumps over the lazy dog')).toBe('9e107d9d372bb6826bd81d3542a419d6');
      // utf-8 multibyte input and block-boundary length
      expect(md5Hex('a'.repeat(56))).toBe('3b0c8ac703f828b04c6c197006d17218');
    });

    it('computes sha1 and sha256 against known vectors', async () => {
      expect(await shaDigestHex('SHA-1', 'abc')).toBe('a9993e364706816aba3e25717850c26c9cd0d89d');
      expect(await shaDigestHex('SHA-256', 'abc')).toBe(
        'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
      );
    });

    it('computes all selection digests', async () => {
      const digests = await getSelectionDigests('abc');

      expect(digests.md5).toBe('900150983cd24fb0d6963f7d28e17f72');
      expect(digests.sha1).toBe('a9993e364706816aba3e25717850c26c9cd0d89d');
      expect(digests.sha256).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    });
  });

  describe('json string escape/unescape', () => {
    it('escapes a selection as a JSON string literal', () => {
      expect(escapeJsonString('he said "hi"\nline')).toBe('"he said \\"hi\\"\\nline"');
    });

    it('unescapes selections that parse as JSON string literals', () => {
      expect(getJsonStringLiteral('"a\\nb"')).toBe('a\nb');
      expect(getJsonStringLiteral('  "quoted \\"x\\""  ')).toBe('quoted "x"');
      expect(getJsonStringLiteral('""')).toBe('');
    });

    it('is not applicable to non string-literal selections', () => {
      expect(getJsonStringLiteral('plain')).toBe(null);
      expect(getJsonStringLiteral('"unterminated')).toBe(null);
      expect(getJsonStringLiteral('{"a":1}')).toBe(null);
      expect(getJsonStringLiteral('123')).toBe(null);
    });
  });

  describe('url breakdown', () => {
    it('breaks a URL into scheme/host/port/path and decoded params', () => {
      const breakdown = getUrlBreakdown('https://api.example.com:8443/v1/users?name=%DA%AF%D8%B1%DB%8C%D8%AF&q=a%20b#frag');

      expect(breakdown.scheme).toBe('https');
      expect(breakdown.host).toBe('api.example.com');
      expect(breakdown.port).toBe('8443');
      expect(breakdown.isDefaultPort).toBe(false);
      expect(breakdown.path).toBe('/v1/users');
      expect(breakdown.hash).toBe('frag');
      expect(breakdown.params).toEqual([
        { key: 'name', value: 'گرید' },
        { key: 'q', value: 'a b' }
      ]);
    });

    it('fills in default ports for known schemes', () => {
      expect(getUrlBreakdown('https://example.com/x')).toMatchObject({ port: '443', isDefaultPort: true });
      expect(getUrlBreakdown('http://example.com')).toMatchObject({ port: '80', path: '/' });
    });

    it('is not applicable to selections without an explicit scheme', () => {
      expect(getUrlBreakdown('example.com/path?a=1')).toBe(null);
      expect(getUrlBreakdown('hello world')).toBe(null);
      expect(getUrlBreakdown('mailto:user@example.com')).toBe(null);
    });
  });

  describe('unicode inspector', () => {
    it('counts code points vs utf-16 units', () => {
      const report = getUnicodeReport('😀a');

      expect(report.codePointCount).toBe(2);
      expect(report.utf16Length).toBe(3);
    });

    it('flags ZWNJ in Persian text with counts', () => {
      const report = getUnicodeReport('می\u200cروم و می\u200cآیم');

      expect(report.hasInvisibles).toBe(true);
      expect(report.invisibles).toEqual([
        expect.objectContaining({ name: expect.stringContaining('ZWNJ'), count: 2 })
      ]);
      expect(report.interesting).toBe(true);
    });

    it('flags bidi marks and NBSP', () => {
      const report = getUnicodeReport('a\u200e\u200fb\u00a0c');
      const names = report.invisibles.map(({ name }) => name).join(' ');

      expect(names).toContain('LRM');
      expect(names).toContain('RLM');
      expect(names).toContain('NBSP');
    });

    it('detects NFD strings and exposes the NFC form', () => {
      const nfd = 'café'.normalize('NFD');
      const report = getUnicodeReport(nfd);

      expect(report.isNFC).toBe(false);
      expect(report.isNFD).toBe(true);
      expect(report.normalizationForm).toBe('NFD (decomposed)');
      expect(report.differsUnderNormalization).toBe(true);
      expect(report.nfc).toBe('café');
      expect(report.interesting).toBe(true);
    });

    it('marks plain ascii as not interesting', () => {
      const report = getUnicodeReport('hello world');

      expect(report.isNFC).toBe(true);
      expect(report.normalizationForm).toBe('NFC = NFD (no combining marks)');
      expect(report.hasInvisibles).toBe(false);
      expect(report.interesting).toBe(false);
    });

    it('is not applicable to empty selections', () => {
      expect(getUnicodeReport('')).toBe(null);
    });
  });
});
