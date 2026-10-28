// Use the real ID generator; the global test mock omits customAlphabet.
jest.mock('nanoid', () => ({ ...jest.requireActual('nanoid') }));

import reducer, {
  updateRequestBodyMode,
  updateRequestBody,
  updateFormUrlEncodedParam,
  deleteFormUrlEncodedParam,
  moveFormUrlEncodedParam
} from './index';
import { getRequestFromCurlCommand } from 'utils/curl';

const target = { collectionUid: 'collection', itemUid: 'request' };
const curlCommand = `curl -X POST "https://api.example.test/v1/utils/oauth/token" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=client_credentials" \
  -d "client_id=sonda" \
  -d "client_secret=probe-secret"`;

const importBody = () => {
  const request = getRequestFromCurlCommand(curlCommand);
  const initial = {
    collections: [{ uid: target.collectionUid, items: [{
      uid: target.itemUid,
      type: 'http-request',
      request: { body: { mode: 'none' } }
    }] }]
  };
  // These are the actions dispatched when cURL is pasted into the URL bar.
  const state = reducer(initial, updateRequestBodyMode({ ...target, mode: request.body.mode }));
  return reducer(state, updateRequestBody({ ...target, content: request.body.formUrlEncoded }));
};

const rows = (state) => state.collections[0].items[0].draft.request.body.formUrlEncoded;

describe('editing form rows from cURL pasted into the URL bar', () => {
  it('assigns a distinct nonempty identity to every imported row before editing', () => {
    const params = rows(importBody());
    expect(params.map(({ name, value }) => ({ name, value }))).toEqual([
      { name: 'grant_type', value: 'client_credentials' },
      { name: 'client_id', value: 'sonda' },
      { name: 'client_secret', value: 'probe-secret' }
    ]);
    params.forEach((param) => expect(param.uid).toEqual(expect.any(String)));
    expect(params.every((param) => param.uid.length > 0)).toBe(true);
    expect(new Set(params.map((param) => param.uid)).size).toBe(3);
  });

  it.each([
    ['value', 'probe-secre'],
    ['name', 'renamed_secret'],
    ['enabled', false]
  ])('changes only the selected row when editing its %s', (key, value) => {
    const state = importBody();
    const before = rows(state);
    const changed = reducer(state, updateFormUrlEncodedParam({
      ...target, param: { ...before[2], [key]: value }
    }));
    expect(rows(changed)).toEqual([before[0], before[1], { ...before[2], [key]: value }]);
    expect(rows(state)).toEqual(before);
  });

  it('deletes only the selected imported row', () => {
    const state = importBody();
    const before = rows(state);
    const changed = reducer(state, deleteFormUrlEncodedParam({ ...target, paramUid: before[2].uid }));
    expect(rows(changed)).toEqual(before.slice(0, 2));
  });

  it('keeps each imported value attached to its field when reordered', () => {
    const state = importBody();
    const before = rows(state);
    const changed = reducer(state, moveFormUrlEncodedParam({
      ...target, updateReorderedItem: [before[2].uid, before[0].uid, before[1].uid]
    }));
    expect(rows(changed)).toEqual([before[2], before[0], before[1]]);
  });

  it('preserves existing identities and metadata when replacing the form body', () => {
    const state = importBody();
    const content = rows(state).map((param, index) => ({ ...param, description: `Field ${index}` }));
    const changed = reducer(state, updateRequestBody({ ...target, content }));
    expect(rows(changed)).toEqual(content);
    expect(state.collections[0].items[0].request.body).toEqual({ mode: 'none' });
  });
});
