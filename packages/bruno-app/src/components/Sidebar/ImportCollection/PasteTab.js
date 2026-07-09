import React, { useState } from 'react';
import Button from 'ui/Button';
import { detectCollectionFormat, parseRawCollectionText } from 'utils/importers/detect';

const PasteTab = ({
  setIsLoading,
  handleSubmit,
  setErrorMessage
}) => {
  const [content, setContent] = useState('');

  const handlePasteImport = async (event) => {
    event.preventDefault();
    setErrorMessage('');

    setIsLoading(true);
    try {
      const data = parseRawCollectionText(content);
      const type = detectCollectionFormat(data);

      if (!type) {
        throw new Error('Unsupported collection format');
      }

      if (type === 'openapi') {
        // rawContent keeps the original spec text available for OpenAPI sync
        await handleSubmit({ rawData: data, type, rawContent: content });
      } else {
        await handleSubmit({ rawData: data, type });
      }
    } catch (err) {
      console.error(err);
      setErrorMessage(err?.message || 'Import failed. Please check the pasted content and try again.');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <form onSubmit={handlePasteImport} className="flex flex-col gap-2 mb-4">
      <textarea
        data-testid="paste-input"
        value={content}
        autoFocus
        rows={10}
        spellCheck={false}
        onChange={(e) => {
          setContent(e.target.value);
          setErrorMessage('');
        }}
        placeholder="Paste a Gridman, Bruno, OpenCollection, Postman, Insomnia, OpenAPI / Swagger, or WSDL collection here (JSON or YAML)"
        className="w-full px-3 py-2 textbox font-mono text-xs resize-y"
        style={{ minHeight: 180 }}
      />
      <div className="flex justify-end">
        <Button
          type="submit"
          id="import-paste-button"
          data-testid="import-paste-button"
          disabled={!content.trim()}
          variant="filled"
          color="primary"
        >
          Import
        </Button>
      </div>
    </form>
  );
};

export default PasteTab;
