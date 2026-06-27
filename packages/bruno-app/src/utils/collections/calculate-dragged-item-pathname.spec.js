import { calculateDraggedItemNewPathname } from 'utils/collections/index';

const COLLECTION = '/ws/collections/Stage';

describe('calculateDraggedItemNewPathname', () => {
  it('drops inside a folder', () => {
    const result = calculateDraggedItemNewPathname({
      draggedItem: { filename: 'login.bru' },
      targetItem: { type: 'folder', pathname: `${COLLECTION}/Api` },
      dropType: 'inside',
      collectionPathname: COLLECTION
    });
    expect(result).toBe(`${COLLECTION}/Api/login.bru`);
  });

  it('drops adjacent to a request as a sibling in the same folder', () => {
    const result = calculateDraggedItemNewPathname({
      draggedItem: { filename: 'login.bru' },
      targetItem: { type: 'http-request', pathname: `${COLLECTION}/Api/health.bru` },
      dropType: 'adjacent',
      collectionPathname: COLLECTION
    });
    expect(result).toBe(`${COLLECTION}/Api/login.bru`);
  });

  it('does NOT escape the collection when dropped adjacent to the collection root', () => {
    // Regression: this used to resolve to the workspace collections/ dir,
    // creating a stray top-level folder (e.g. collections/2).
    const result = calculateDraggedItemNewPathname({
      draggedItem: { filename: '2' },
      targetItem: { type: 'folder', pathname: COLLECTION },
      dropType: 'adjacent',
      collectionPathname: COLLECTION
    });
    expect(result).toBe(`${COLLECTION}/2`);
  });

  it('drops inside the collection root', () => {
    const result = calculateDraggedItemNewPathname({
      draggedItem: { filename: 'thing.bru' },
      targetItem: { type: 'folder', pathname: COLLECTION },
      dropType: 'inside',
      collectionPathname: COLLECTION
    });
    expect(result).toBe(`${COLLECTION}/thing.bru`);
  });

  it('returns null for incomplete drag payloads', () => {
    expect(calculateDraggedItemNewPathname({
      draggedItem: {},
      targetItem: { pathname: `${COLLECTION}/Api` },
      dropType: 'inside',
      collectionPathname: COLLECTION
    })).toBeNull();
  });
});
