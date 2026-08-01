import { describe, it, expect } from '@jest/globals';
import { isItemARequest } from '../../src/common/index.js';

describe('isItemARequest', () => {
  const makeRequest = (type, extra = {}) => ({
    type,
    name: 'Get Users',
    request: { method: 'GET', url: 'https://example.com' },
    ...extra
  });

  it('should treat a yml-format request (items: []) as a request', () => {
    expect(isItemARequest(makeRequest('http-request', { items: [] }))).toBe(true);
    expect(isItemARequest(makeRequest('graphql-request', { items: [] }))).toBe(true);
    expect(isItemARequest(makeRequest('grpc-request', { items: [] }))).toBe(true);
    expect(isItemARequest(makeRequest('ws-request', { items: [] }))).toBe(true);
  });

  it('should treat a bru-format request (no items key) as a request', () => {
    expect(isItemARequest(makeRequest('http-request'))).toBe(true);
    expect(isItemARequest(makeRequest('graphql-request'))).toBe(true);
  });

  it('should not treat an item with a non-empty items array as a request', () => {
    const item = makeRequest('http-request', { items: [makeRequest('http-request', { items: [] })] });

    expect(isItemARequest(item)).toBe(false);
  });

  it('should not treat a folder as a request', () => {
    expect(isItemARequest({ type: 'folder', name: 'Users', items: [] })).toBe(false);
  });

  it('should not treat an unknown item type as a request', () => {
    expect(isItemARequest(makeRequest('js', { items: [] }))).toBe(false);
  });
});
