import React, { useMemo, useState } from 'react';
import styled from 'styled-components';
import { useDispatch } from 'react-redux';
import { useTheme } from 'providers/Theme';
import { useSelector } from 'react-redux';
import get from 'lodash/get';
import { updateResponseExampleResponse } from 'providers/ReduxStore/slices/collections';
import CodeEditor from 'components/CodeEditor';
import LargeResponseWarning from 'components/ResponsePane/LargeResponseWarning';
import { getCodeMirrorModeBasedOnContentType } from 'utils/common/codemirror';
import StyledWrapper from './StyledWrapper';

// A saved example carries no dataBuffer and no requestSent, so the warning's
// Download button can only ever sit there disabled (and would throw if it were
// clickable). Hide the dead control; View and Copy are the real escapes.
const LargeExampleWrapper = styled.div`
  .warning-actions > *:has(> button[title='Download response to file']) {
    display: none;
  }
`;

// UTF-8 bytes, not UTF-16 code units: the live pane gates on response.size,
// which is a byte count, and str.length undercounts every non-latin script
// (Persian is 1 code unit but 2 bytes per character) by 2-3x. Counted in a
// single pass rather than via TextEncoder, which would allocate a second copy
// of a multi-MB body just to measure it — and isn't available under jsdom.
const utf8ByteLength = (str) => {
  let bytes = 0;
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (code < 0x80) {
      bytes += 1;
    } else if (code < 0x800) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff && i + 1 < str.length) {
      // surrogate pair — one astral character, 4 bytes
      bytes += 4;
      i++;
    } else {
      bytes += 3;
    }
  }
  return bytes;
};

const ResponseExampleResponseContent = ({ editMode, item, collection, exampleUid, onSave }) => {
  const dispatch = useDispatch();
  const { displayedTheme } = useTheme();
  const preferences = useSelector((state) => state.app.preferences);
  const [showLargeResponse, setShowLargeResponse] = useState(false);

  const response = useMemo(() => {
    return item.draft ? get(item, 'draft.examples', []).find((e) => e.uid === exampleUid)?.response || {} : get(item, 'examples', []).find((e) => e.uid === exampleUid)?.response || {};
  }, [item, exampleUid]);

  const getResponseContent = () => {
    if (!response) {
      return '';
    }

    if (!response.body) {
      return '';
    }

    return response.body.content;
  };

  const getCodeMirrorMode = () => {
    if (!response) {
      return null;
    }

    if (response.body && response.body.type) {
      const bodyType = response.body.type;
      if (bodyType === 'json') {
        return 'application/ld+json';
      } else if (bodyType === 'xml') {
        return 'application/xml';
      } else if (bodyType === 'html') {
        return 'application/html';
      } else if (bodyType === 'text') {
        return 'application/text';
      }
    }

    const contentType = response.headers?.find((h) => h.name?.toLowerCase() === 'content-type')?.value?.toLowerCase() || '';

    return getCodeMirrorModeBasedOnContentType(contentType);
  };

  const onResponseEdit = (value) => {
    if (editMode && item && collection && exampleUid) {
      const currentBody = response.body || {};
      dispatch(updateResponseExampleResponse({
        itemUid: item.uid,
        collectionUid: collection.uid,
        exampleUid: exampleUid,
        response: {
          body: {
            type: currentBody.type || 'text',
            content: value
          }
        }
      }));
    }
  };

  const onBodyTypeChange = (e) => {
    if (editMode && item && collection && exampleUid) {
      const currentBody = response.body || {};
      dispatch(updateResponseExampleResponse({
        itemUid: item.uid,
        collectionUid: collection.uid,
        exampleUid: exampleUid,
        response: {
          body: {
            type: e.target.value,
            content: currentBody.content || ''
          }
        }
      }));
    }
  };

  const bodyType = response.body?.type || 'text';

  // A yml example's body content is whatever the parser made of it — a number,
  // a map — so it is not always a string. CodeMirror needs one, and `.length`
  // on a non-string is undefined, which silently opted the size gate out.
  const responseContent = useMemo(() => {
    const content = getResponseContent();
    if (content === null || content === undefined) {
      return '';
    }
    return typeof content === 'string' ? content : JSON.stringify(content, null, 2);
  }, [response]);

  // Since fea6595ae raised the save-as-example cap from 5MB to 50MB, examples
  // this big exist on disk — opening one handed the whole body to CodeEditor
  // and froze the app. Same gate and same warning as the live response pane.
  // Nothing records an example's byte count, so measure the body's own bytes.
  const responseSize = useMemo(() => utf8ByteLength(responseContent), [responseContent]);
  const isLargeResponse = responseSize > 10 * 1024 * 1024; // 10 MB

  return (
    <StyledWrapper className="w-full px-4">
      {editMode && (
        <div className="body-type-selector flex items-center mb-2">
          <label className="mr-2 text-muted">Body</label>
          <select value={bodyType} onChange={onBodyTypeChange} className="textbox">
            <option value="json">JSON</option>
            <option value="xml">XML</option>
            <option value="html">HTML</option>
            <option value="text">Text</option>
          </select>
        </div>
      )}
      {isLargeResponse && !showLargeResponse ? (
        <LargeExampleWrapper>
          {/* The warning's Download/Copy read item.response — hand it the
              example so they never act on the request's unrelated live
              response. */}
          <LargeResponseWarning
            item={{ ...item, response: { data: responseContent } }}
            responseSize={responseSize}
            onRevealResponse={() => setShowLargeResponse(true)}
          />
        </LargeExampleWrapper>
      ) : (
        <div className="code-editor-container">
          <CodeEditor
            collection={collection}
            item={item}
            theme={displayedTheme}
            font={get(preferences, 'font.codeFont', 'default')}
            fontSize={get(preferences, 'font.codeFontSize')}
            value={responseContent}
            onEdit={onResponseEdit}
            onRun={() => {}}
            onSave={onSave}
            mode={getCodeMirrorMode()}
            enableVariableHighlighting={false}
            readOnly={!editMode}
          />
        </div>
      )}
    </StyledWrapper>
  );
};

export default ResponseExampleResponseContent;
