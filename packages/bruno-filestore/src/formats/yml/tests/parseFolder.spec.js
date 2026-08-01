import parseFolder from '../parseFolder';
import stringifyFolder from '../stringifyFolder';

const FOLDER_WITHOUT_REQUEST = `info:
  name: My Folder
  type: folder
  seq: 2
`;

const FOLDER_WITH_AUTH = `info:
  name: My Folder
  type: folder
  seq: 1

request:
  auth:
    type: bearer
    token: abc123
`;

describe('yml parseFolder - request defaults', () => {
  it('always returns a request block so folder level auth can be read', () => {
    const folderRoot = parseFolder(FOLDER_WITHOUT_REQUEST);

    expect(folderRoot.request).not.toBeNull();
    expect(folderRoot.request.auth).toMatchObject({ mode: 'none' });
    expect(folderRoot.request.headers).toEqual([]);
    expect(folderRoot.request.vars).toEqual({ req: [], res: [] });
    expect(folderRoot.meta).toEqual({ name: 'My Folder', seq: 2 });
  });

  it('does not start writing an empty request block back to the file', () => {
    const folderRoot = parseFolder(FOLDER_WITHOUT_REQUEST);

    expect(stringifyFolder(folderRoot)).not.toContain('request:');
  });

  it('still reads the auth defined on the folder', () => {
    const folderRoot = parseFolder(FOLDER_WITH_AUTH);

    expect(folderRoot.request.auth).toMatchObject({
      mode: 'bearer',
      bearer: { token: 'abc123' }
    });
  });
});
