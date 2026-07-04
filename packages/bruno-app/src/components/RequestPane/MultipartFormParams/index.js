import React, { useCallback, useMemo, useRef, useState } from 'react';
import get from 'lodash/get';
import toast from 'react-hot-toast';
import { useDispatch, useSelector } from 'react-redux';
import { useTheme } from 'providers/Theme';
import { IconUpload } from '@tabler/icons';
import {
  moveMultipartFormParam,
  setMultipartFormParams
} from 'providers/ReduxStore/slices/collections';
import { browseFiles } from 'providers/ReduxStore/slices/collections/actions';
import MultiLineEditor from 'components/MultiLineEditor';
import SingleLineEditor from 'components/SingleLineEditor';
import MultipartFileChipsCell from 'components/MultipartFileChipsCell';
import { sendRequest, saveRequest } from 'providers/ReduxStore/slices/collections/actions';
import { updateTableColumnWidths } from 'providers/ReduxStore/slices/tabs';
import EditableTable from 'components/EditableTable';
import BulkEditor from 'components/BulkEditor';
import StyledWrapper from './StyledWrapper';
import path, { getRelativePathWithinBasePath, normalizePath } from 'utils/common/path';
import { getMultipartAutoContentType } from 'utils/common/multipartContentType';
import { usePersistedState } from 'hooks/usePersistedState';
import { useTrackScroll } from 'hooks/useTrackScroll';

const fileBasename = (filePath) =>
  filePath ? path.basename(normalizePath(String(filePath))) : '';

const MultipartFormParams = ({ item, collection }) => {
  const dispatch = useDispatch();
  const { storedTheme } = useTheme();
  const wrapperRef = useRef(null);
  const [scroll, setScroll] = usePersistedState({ key: `request-body-multipartForm-scroll-${item.uid}`, default: 0 });
  useTrackScroll({ ref: wrapperRef, selector: '.flex-boundary', onChange: setScroll, initialValue: scroll });
  const tabs = useSelector((state) => state.tabs.tabs);
  const activeTabUid = useSelector((state) => state.tabs.activeTabUid);
  const params = item.draft ? get(item, 'draft.request.body.multipartForm') : get(item, 'request.body.multipartForm');
  const [isBulkEditMode, setIsBulkEditMode] = useState(false);

  // Get column widths from Redux
  const focusedTab = tabs?.find((t) => t.uid === activeTabUid);
  const multipartFormWidths = focusedTab?.tableColumnWidths?.['multipart-form'] || {};

  const handleColumnWidthsChange = (tableId, widths) => {
    dispatch(updateTableColumnWidths({ uid: activeTabUid, tableId, widths }));
  };

  const onSave = () => dispatch(saveRequest(item.uid, collection.uid));
  const handleRun = () => dispatch(sendRequest(item, collection.uid));

  // Flag form field names used by more than one row (case-sensitive).
  const duplicateNames = useMemo(() => {
    const counts = {};
    (params || []).forEach((p) => {
      const name = (p.name || '').trim();
      if (name) counts[name] = (counts[name] || 0) + 1;
    });
    return new Set(Object.keys(counts).filter((n) => counts[n] > 1));
  }, [params]);

  const getRowError = useCallback((row, index, key) => {
    if (key === 'name' && row.name && duplicateNames.has(row.name.trim())) {
      return 'Duplicate field name';
    }
    return null;
  }, [duplicateNames]);

  const handleParamsChange = useCallback((updatedParams) => {
    dispatch(setMultipartFormParams({
      collectionUid: collection.uid,
      itemUid: item.uid,
      params: updatedParams
    }));
  }, [dispatch, collection.uid, item.uid]);

  const textParams = useMemo(() => {
    return (params || []).filter((param) => param.type !== 'file');
  }, [params]);

  const handleBulkParamsChange = useCallback((updatedParams) => {
    const currentParams = params || [];
    const mergedTextParams = updatedParams.map((param, index) => ({
      ...textParams[index],
      ...param,
      type: 'text'
    }));
    let textIndex = 0;
    const nextParams = currentParams.reduce((acc, param) => {
      if (param.type === 'file') {
        acc.push(param);
        return acc;
      }

      if (textIndex < mergedTextParams.length) {
        acc.push(mergedTextParams[textIndex]);
      }
      textIndex += 1;
      return acc;
    }, []);

    nextParams.push(...mergedTextParams.slice(textIndex));

    handleParamsChange(nextParams);
  }, [handleParamsChange, params, textParams]);

  const handleParamDrag = useCallback(({ updateReorderedItem }) => {
    dispatch(moveMultipartFormParam({
      collectionUid: collection.uid,
      itemUid: item.uid,
      updateReorderedItem
    }));
  }, [dispatch, collection.uid, item.uid]);

  const handleBrowseFiles = useCallback((row, onChange) => {
    dispatch(browseFiles([], ['multiSelections']))
      .then((filePaths) => {
        if (!Array.isArray(filePaths) || filePaths.length === 0) return;

        const processedPaths = filePaths.map((filePath) => {
          return getRelativePathWithinBasePath(collection.pathname, filePath);
        });

        const currentParams = item.draft
          ? get(item, 'draft.request.body.multipartForm')
          : get(item, 'request.body.multipartForm');
        const existingParam = (currentParams || []).find((p) => p.uid === row.uid);
        const existingValue = existingParam && existingParam.type === 'file' && Array.isArray(existingParam.value)
          ? existingParam.value
          : [];
        const seen = new Set(existingValue);
        const merged = [...existingValue];
        const skipped = [];
        for (const p of processedPaths) {
          if (!seen.has(p)) {
            seen.add(p);
            merged.push(p);
          } else {
            skipped.push(p);
          }
        }

        if (skipped.length === 1) {
          toast(`"${fileBasename(skipped[0])}" is already added`);
        } else if (skipped.length > 1) {
          toast(`${skipped.length} files are already added — skipped`);
        }

        const autoContentType = getMultipartAutoContentType(merged);

        let updatedParams;
        if (existingParam) {
          updatedParams = currentParams.map((p) => {
            if (p.uid === row.uid) {
              return { ...p, type: 'file', value: merged, contentType: autoContentType };
            }
            return p;
          });
        } else {
          updatedParams = [
            ...(currentParams || []),
            { uid: row.uid, name: row.name || '', enabled: true, type: 'file', value: merged, contentType: autoContentType, description: '' }
          ];
        }
        handleParamsChange(updatedParams);
      })
      .catch((error) => {
        console.error(error);
      });
  }, [dispatch, collection.pathname, item, handleParamsChange]);

  const handleRemoveFile = useCallback((row, filePathToRemove) => {
    const currentParams = params || [];
    const target = currentParams.find((p) => p.uid === row.uid);
    if (!target || target.type !== 'file') return;
    const currentValue = Array.isArray(target.value)
      ? target.value
      : (target.value ? [target.value] : []);
    const nextValue = currentValue.filter((p) => p !== filePathToRemove);

    const updatedParams = currentParams.map((p) => {
      if (p.uid !== row.uid) return p;
      if (nextValue.length === 0) {
        return { ...p, type: 'text', value: '', contentType: '' };
      }
      return { ...p, type: 'file', value: nextValue, contentType: getMultipartAutoContentType(nextValue) };
    });
    handleParamsChange(updatedParams);
  }, [params, handleParamsChange]);

  const handleValueChange = useCallback((row, newValue, onChange) => {
    const currentParams = params || [];
    const existingParam = currentParams.find((p) => p.uid === row.uid);
    if (existingParam) {
      const updatedParams = currentParams.map((p) => {
        if (p.uid === row.uid) {
          return { ...p, type: 'text', value: newValue };
        }
        return p;
      });
      handleParamsChange(updatedParams);
    } else {
      onChange(newValue);
    }
  }, [params, handleParamsChange]);

  const getFileList = (filePaths) => {
    if (!filePaths || (Array.isArray(filePaths) && filePaths.length === 0)) {
      return [];
    }
    const paths = Array.isArray(filePaths) ? filePaths : [filePaths];
    return paths.filter((v) => v != null && v !== '');
  };

  const columns = [
    {
      key: 'name',
      name: 'Key',
      isKeyField: true,
      placeholder: 'Key',
      width: '30%'
    },
    {
      key: 'value',
      name: 'Value',
      placeholder: 'Value',
      width: '35%',
      render: ({ row, value, onChange }) => {
        const files = row.type === 'file' ? getFileList(value) : [];
        if (files.length > 0) {
          return (
            <MultipartFileChipsCell
              files={files}
              onRemove={(filePath) => handleRemoveFile(row, filePath)}
              onAdd={() => handleBrowseFiles(row, onChange)}
            />
          );
        }

        return (
          <div className="flex items-center value-cell">
            <div className="flex-1">
              <MultiLineEditor
                onSave={onSave}
                theme={storedTheme}
                value={value || ''}
                onChange={(newValue) => handleValueChange(row, newValue, onChange)}
                onRun={handleRun}
                allowNewlines={true}
                collection={collection}
                item={item}
                placeholder={!value ? 'Value' : ''}
              />
            </div>
            <button
              data-testid="multipart-file-upload"
              className="upload-btn ml-1"
              onClick={() => handleBrowseFiles(row, onChange)}
              title="Select File"
            >
              <IconUpload size={16} />
            </button>
          </div>
        );
      }
    },
    {
      key: 'contentType',
      name: 'Content-Type',
      placeholder: 'Auto',
      width: '15%',
      render: ({ value, onChange }) => (
        <SingleLineEditor
          onSave={onSave}
          theme={storedTheme}
          placeholder={!value ? 'Auto' : ''}
          value={value || ''}
          onChange={onChange}
          onRun={handleRun}
          collection={collection}
        />
      )
    },
    {
      key: 'description',
      name: 'Description',
      placeholder: 'Description',
      width: '20%',
      render: ({ value, onChange }) => (
        <SingleLineEditor
          onSave={onSave}
          theme={storedTheme}
          placeholder={!value ? 'Description' : ''}
          value={value || ''}
          onChange={onChange}
          onRun={handleRun}
          collection={collection}
          item={item}
        />
      )
    }
  ];

  const defaultRow = {
    name: '',
    value: '',
    contentType: '',
    description: '',
    type: 'text'
  };

  const toggleBulkEditMode = () => {
    setIsBulkEditMode(!isBulkEditMode);
  };

  if (isBulkEditMode) {
    return (
      <StyledWrapper className="w-full mt-3">
        <BulkEditor
          params={textParams}
          onChange={handleBulkParamsChange}
          onToggle={toggleBulkEditMode}
          onSave={onSave}
          onRun={handleRun}
        />
        {(params || []).some((param) => param.type === 'file') && (
          <div className="text-muted text-xs mt-2">
            File rows are kept unchanged and are not shown in Bulk Edit.
          </div>
        )}
      </StyledWrapper>
    );
  }

  return (
    <StyledWrapper className="w-full" ref={wrapperRef}>
      <EditableTable
        tableId="multipart-form"
        columns={columns}
        rows={params || []}
        onChange={handleParamsChange}
        defaultRow={defaultRow}
        getRowError={getRowError}
        reorderable={true}
        onReorder={handleParamDrag}
        columnWidths={multipartFormWidths}
        onColumnWidthsChange={(widths) => handleColumnWidthsChange('multipart-form', widths)}
        initialScroll={scroll}
      />
      <div className="bulk-edit-bar flex justify-end mt-2">
        <button className="btn-action text-link select-none" onClick={toggleBulkEditMode}>
          Bulk Edit
        </button>
      </div>
    </StyledWrapper>
  );
};

export default MultipartFormParams;
