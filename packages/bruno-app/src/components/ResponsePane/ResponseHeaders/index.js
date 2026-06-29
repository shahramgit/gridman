import React, { useRef } from 'react';
import StyledWrapper from './StyledWrapper';
import { usePersistedState } from 'hooks/usePersistedState';
import { useTrackScroll } from 'hooks/useTrackScroll';

const ResponseHeaders = ({ headers, item }) => {
  const headersArray = typeof headers === 'object' ? Object.entries(headers) : [];
  const duplicateNames = (() => {
    const counts = {};
    headersArray.forEach(([name]) => {
      const key = String(name || '').trim().toLowerCase();
      if (key) counts[key] = (counts[key] || 0) + 1;
    });
    return new Set(Object.keys(counts).filter((n) => counts[n] > 1));
  })();
  const wrapperRef = useRef(null);
  const [scroll, setScroll] = usePersistedState({ key: `response-headers-scroll-${item?.uid}`, default: 0 });
  useTrackScroll({ ref: wrapperRef, selector: '.response-tab-content', onChange: setScroll, initialValue: scroll });

  return (
    <StyledWrapper className="w-full" ref={wrapperRef}>
      <div className="table-wrapper">
        <table>
          <thead>
            <tr>
              <td>Name</td>
              <td>Value</td>
            </tr>
          </thead>
          <tbody>
            {headersArray && headersArray.length
              ? headersArray.map((header, index) => {
                  const isDuplicate = duplicateNames.has(String(header[0] || '').trim().toLowerCase());
                  return (
                    <tr key={index}>
                      <td className={isDuplicate ? 'key duplicate' : 'key'} title={isDuplicate ? 'Duplicate header name' : undefined}>
                        {header[0]}
                      </td>
                      <td className="value">{header[1]}</td>
                    </tr>
                  );
                })
              : null}
          </tbody>
        </table>
      </div>
    </StyledWrapper>
  );
};
export default ResponseHeaders;
