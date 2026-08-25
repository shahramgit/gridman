const BrunoResponse = require('../src/bruno-response');

/**
 * HEADER NAMES ARE CASE-INSENSITIVE.
 *
 * axios lowercases response header names, so `res.getHeader('Content-Type')` returned
 * undefined while `'content-type'` worked. A script author should not have to know which
 * casing the transport happened to store. usebruno/bruno#8461.
 */
describe('res.getHeader', () => {
  const res = { headers: { 'content-type': 'application/json', 'x-request-id': 'abc' } };
  const bruno = new BrunoResponse(res);

  it.each([
    ['Content-Type'],
    ['content-type'],
    ['CONTENT-TYPE'],
    ['CoNtEnT-tYpE']
  ])('resolves %s', (name) => {
    expect(bruno.getHeader(name)).toBe('application/json');
  });

  it('still resolves a header stored with unusual casing', () => {
    // A hand-built or mocked response need not be normalised; exact match first
    // keeps those working.
    const odd = new BrunoResponse({ headers: { 'X-Odd-Case': 'yes' } });
    expect(odd.getHeader('X-Odd-Case')).toBe('yes');
  });

  it('returns null rather than throwing for a missing or invalid name', () => {
    expect(bruno.getHeader('nope')).toBeUndefined();
    expect(bruno.getHeader(undefined)).toBeNull();
    expect(bruno.getHeader(123)).toBeNull();
    expect(new BrunoResponse(null).getHeader('content-type')).toBeNull();
  });
});
