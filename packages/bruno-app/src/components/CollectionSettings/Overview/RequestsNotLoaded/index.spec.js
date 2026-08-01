import { toRelativePathname } from './index';

// The Pathname column used to split on the literal `${collection.pathname}/`,
// which never matches a Windows backslash path - every "not loaded" row rendered
// an empty cell. upstream bruno #8545 (81f9a4092)
describe('toRelativePathname', () => {
  it('strips the collection prefix on posix paths', () => {
    expect(toRelativePathname('/ws/collections/api/users/get-user.bru', '/ws/collections/api'))
      .toBe('users/get-user.bru');
  });

  it('strips the collection prefix on Windows backslash paths', () => {
    expect(toRelativePathname('C:\\ws\\collections\\api\\users\\get-user.bru', 'C:\\ws\\collections\\api'))
      .toBe('users/get-user.bru');
  });

  it('strips the prefix when the two sides use different separators', () => {
    expect(toRelativePathname('C:\\ws\\collections\\api\\users\\get-user.bru', 'C:/ws/collections/api'))
      .toBe('users/get-user.bru');
  });

  it('ignores drive-letter case differences on Windows', () => {
    expect(toRelativePathname('c:\\ws\\api\\get-user.bru', 'C:\\ws\\api')).toBe('get-user.bru');
  });

  it('strips the prefix from Persian paths regardless of NFC/NFD', () => {
    const collection = '/ws/\u0633\u0631\u0648\u06cc\u0633'.normalize('NFC');
    const pathname = `${collection}/\u0628\u06cc\u0645\u0647.bru`.normalize('NFD');
    expect(toRelativePathname(pathname, collection)).toBe('\u0628\u06cc\u0645\u0647.bru'.normalize('NFC'));
  });

  it('returns the original pathname when it is not under the collection', () => {
    expect(toRelativePathname('/elsewhere/get-user.bru', '/ws/collections/api'))
      .toBe('/elsewhere/get-user.bru');
  });

  it('passes through falsy inputs', () => {
    expect(toRelativePathname(undefined, '/ws/collections/api')).toBeUndefined();
    expect(toRelativePathname('/ws/collections/api/a.bru', undefined)).toBe('/ws/collections/api/a.bru');
  });
});
