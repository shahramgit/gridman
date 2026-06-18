const { forEach } = require('lodash');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');

const formatMultipartData = (multipartData, boundary) => {
  if (!Array.isArray(multipartData) || multipartData.length === 0) {
    return '';
  }

  const normalizeBoundary = (b) => {
    const value = b || 'boundary';
    return value.replace(/^--+/, '').replace(/--+$/, '');
  };

  const getFileName = (filePath) => {
    if (typeof filePath === 'string' && filePath.trim()) {
      return path.basename(filePath) || 'file';
    }
    return 'file';
  };

  const formatValue = (value) => {
    if (Array.isArray(value)) {
      return value.map((v) => String(v ?? '')).join(', ');
    }
    return String(value ?? '');
  };

  const boundaryValue = normalizeBoundary(boundary);
  const parts = [];

  multipartData.forEach((field) => {
    if (!field || !field.name) return;

    parts.push(`----${boundaryValue}`);
    parts.push('Content-Disposition: form-data');

    if (field.type === 'file') {
      const filePaths = Array.isArray(field.value) ? field.value : (field.value ? [field.value] : ['']);
      filePaths.forEach((filePath) => {
        parts.push(`----${boundaryValue}`);
        parts.push('Content-Disposition: form-data');
        const fileName = getFileName(filePath);
        parts.push(`name: ${field.name}`);
        parts.push(`value: [File: ${fileName}]`);
        parts.push('');
      });
    } else {
      const value = formatValue(field.value);
      parts.push(`name: ${field.name}`);
      parts.push(`value: ${value}`);
      parts.push('');
    }
  });

  parts.push(`----${boundaryValue}--`);
  return parts.join('\n');
};

const createFormData = (data, collectionPath) => {
  // make axios work in node using form data
  // reference: https://github.com/axios/axios/issues/1006#issuecomment-320165427
  const form = new FormData();
  forEach(data, (datum) => {
    const { name, type, value, contentType } = datum;
    let options = {};
    if (contentType) {
      options.contentType = contentType;
    }
    if (type === 'text') {
      if (Array.isArray(value)) {
        value.forEach((val) => form.append(name, val, options));
      } else {
        form.append(name, value, options);
      }
      return;
    }

    if (type === 'file') {
      // value may be an array of paths, a single path string, or empty (e.g.
      // imported requests where the file reference was never filled in).
      const filePaths = (Array.isArray(value) ? value : (value ? [value] : []))
        .map((filePath) => String(filePath ?? '').trim())
        .filter(Boolean);

      filePaths.forEach((filePath) => {
        let resolvedFilePath = filePath;
        if (!path.isAbsolute(resolvedFilePath)) {
          resolvedFilePath = path.join(collectionPath, resolvedFilePath);
        }
        if (!fs.existsSync(resolvedFilePath)) {
          throw new Error(`File not found for multipart form field "${name}": ${filePath}`);
        }
        options.filename = path.basename(resolvedFilePath);
        form.append(name, fs.createReadStream(resolvedFilePath), options);
      });
    }
  });
  return form;
};

module.exports = {
  createFormData,
  formatMultipartData
};
