const fs = require('fs');
const os = require('os');
const path = require('path');
const { formatMultipartData, createFormData } = require('../../src/utils/form-data');

describe('utils: formatMultipartData', () => {
  test('should format text field', () => {
    const data = [{ name: 'description', type: 'text', value: 'dfv' }];
    const result = formatMultipartData(data, 'boundary');

    expect(result).toContain('----boundary');
    expect(result).toContain('Content-Disposition: form-data');
    expect(result).toContain('name: description');
    expect(result).toContain('value: dfv');
    expect(result).toContain('----boundary--');
  });

  test('should format file field', () => {
    const data = [{ name: 'file', type: 'file', value: ['Dumy.xml'] }];
    const result = formatMultipartData(data, 'boundary');

    expect(result).toContain('name: file');
    expect(result).toContain('value: [File: Dumy.xml]');
  });

  test('should format multiple fields', () => {
    const data = [
      { name: 'description', type: 'text', value: 'dfv' },
      { name: 'file', type: 'file', value: ['Dumy.xml'] }
    ];
    const result = formatMultipartData(data, 'boundary');

    expect(result).toContain('name: description');
    expect(result).toContain('value: dfv');
    expect(result).toContain('name: file');
    expect(result).toContain('value: [File: Dumy.xml]');
  });

  test('should return empty string for invalid input', () => {
    expect(formatMultipartData([], 'boundary')).toBe('');
    expect(formatMultipartData(null, 'boundary')).toBe('');
  });

  test('should normalize boundary', () => {
    const data = [{ name: 'field', type: 'text', value: 'value' }];
    expect(formatMultipartData(data, '--boundary')).toContain('----boundary');
    expect(formatMultipartData(data, 'boundary--')).toContain('----boundary');
  });
});

describe('utils: createFormData', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gridman-formdata-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('throws a clear error when a referenced file does not exist', () => {
    const data = [{ name: 'email', type: 'file', value: ['missing/file.pdf'] }];
    expect(() => createFormData(data, tmpDir)).toThrow(
      'File not found for multipart form field "email": missing/file.pdf'
    );
  });

  test('handles a single file path string (not just arrays)', () => {
    const filePath = path.join(tmpDir, 'doc.txt');
    fs.writeFileSync(filePath, 'hello');
    const data = [{ name: 'attachment', type: 'file', value: filePath }];

    expect(() => createFormData(data, tmpDir)).not.toThrow();
  });

  test('ignores empty file references instead of crashing', () => {
    const data = [{ name: 'picture', type: 'file', value: '' }];
    expect(() => createFormData(data, tmpDir)).not.toThrow();
  });
});
