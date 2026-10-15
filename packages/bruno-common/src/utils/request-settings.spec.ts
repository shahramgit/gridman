import { assertSupportedEnvironment, DEFAULT_MAX_REDIRECTS, parseMaxRedirects, toMaxRedirects, isSameOrigin } from './index';

describe('redirect limits', () => {
  it('allows large finite ceilings and truncates fractions without a 50-redirect cap', () => {
    for (const value of [0, 51, 1000, Number.MAX_SAFE_INTEGER, 1e21]) expect(parseMaxRedirects(value)).toBe(value);
    expect(parseMaxRedirects(3.5)).toBe(3);
    expect(parseMaxRedirects(0.9)).toBe(0);
  });
  it('rejects invalid limits and uses one default', () => {
    for (const value of [-1, -0.5, Infinity, -Infinity, NaN, null, undefined, '10', true, {}, []]) {
      expect(parseMaxRedirects(value)).toBeUndefined();
      expect(toMaxRedirects(value)).toBe(DEFAULT_MAX_REDIRECTS);
    }
  });
});

describe('unsupported environment inheritance', () => {
  it.each([{ extends: 'base' }, { extends: ['base', 'team'] }])('blocks execution with %j', (environment) => {
    expect(() => assertSupportedEnvironment(environment)).toThrow('Environment inheritance is not supported');
  });
  it('allows ordinary environments and empty parent lists', () => {
    for (const environment of [null, undefined, {}, { extends: [] }, { extends: '' }]) expect(() => assertSupportedEnvironment(environment)).not.toThrow();
  });
});

it('compares complete origins and fails closed on unparseable redirect URLs', () => {
  expect(isSameOrigin('https://api.test/start', 'https://api.test/target')).toBe(true);
  expect(isSameOrigin('https://api.test/start', 'http://api.test/target')).toBe(false);
  expect(isSameOrigin('https://api.test/start', 'https://api.test:444/target')).toBe(false);
  expect(isSameOrigin('invalid', 'invalid')).toBe(false);
});
