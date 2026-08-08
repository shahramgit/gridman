import React, { useState } from 'react';
import { IconPlus, IconTrash } from '@tabler/icons';
import ToggleSwitch from 'components/ToggleSwitch';

const BUILT_IN_HEADER_EXAMPLES = [
  'Authorization',
  'Proxy-Authorization',
  'Cookie',
  'Set-Cookie',
  'X-API-Key',
  'X-Auth-Token',
  'X-Access-Token',
  'X-CSRF-Token'
];

const normalize = (raw) => String(raw || '').trim();

const CHIP_MAX_LENGTH = 200;
const CHIP_MAX_COUNT = 200;

/**
 * Compact editor for a case-insensitive name list. Used for both custom header
 * names and custom variable names — the shape is identical.
 */
const ChipListEditor = ({ list, placeholder, onChange, addTestId, inputTestId, removeTestIdPrefix }) => {
  const [draft, setDraft] = useState('');
  const values = Array.isArray(list) ? list : [];
  const atCapacity = values.length >= CHIP_MAX_COUNT;

  const handleAdd = () => {
    const value = normalize(draft);
    if (!value || value.length > CHIP_MAX_LENGTH || atCapacity) return;
    if (values.some((v) => v.toLowerCase() === value.toLowerCase())) {
      setDraft('');
      return;
    }
    onChange([...values, value]);
    setDraft('');
  };

  const handleRemove = (name) => {
    onChange(values.filter((v) => v !== name));
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleAdd();
    }
  };

  const trimmedDraft = normalize(draft);
  const draftTooLong = trimmedDraft.length > CHIP_MAX_LENGTH;
  const addDisabled = !trimmedDraft || draftTooLong || atCapacity;

  return (
    <>
      <div className="security-add-row flex items-center gap-2">
        <input
          type="text"
          className="security-input flex-1"
          placeholder={placeholder}
          value={draft}
          maxLength={CHIP_MAX_LENGTH}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={atCapacity}
          data-testid={inputTestId}
        />
        <button
          type="button"
          className="security-add-btn inline-flex items-center gap-1 text-[11px] font-medium"
          onClick={handleAdd}
          disabled={addDisabled}
          data-testid={addTestId}
        >
          <IconPlus size={13} strokeWidth={1.75} />
          Add
        </button>
      </div>

      {atCapacity && (
        <span className="security-sub text-[10.5px]">
          Reached the {CHIP_MAX_COUNT}-entry limit. Remove one to add another.
        </span>
      )}

      {values.length > 0 && (
        <ul className="security-chip-list flex flex-wrap gap-1.5">
          {values.map((name) => (
            <li key={name} className="security-chip inline-flex items-center gap-1">
              <span className="security-chip-text">{name}</span>
              <button
                type="button"
                className="security-chip-remove"
                onClick={() => handleRemove(name)}
                aria-label={`Remove ${name}`}
                data-testid={removeTestIdPrefix ? `${removeTestIdPrefix}-${name}` : undefined}
              >
                <IconTrash size={11} strokeWidth={1.75} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </>
  );
};

/**
 * Redaction controls. Every switch here is ON by default and every change is
 * persisted immediately (not debounced) — a user who turns a protection off
 * and closes preferences straight away must not have the old value survive.
 */
const SecurityPane = ({
  aiEnabled,
  redactHeaders,
  redactBody,
  redactVariables,
  redactResponse,
  customRedactedHeaders,
  customRedactedVariables,
  onToggleRedactHeaders,
  onToggleRedactBody,
  onToggleRedactVariables,
  onToggleRedactResponse,
  onChangeCustomRedactedHeaders,
  onChangeCustomRedactedVariables
}) => {
  if (!aiEnabled) {
    return (
      <div className="security-tab flex flex-col gap-3">
        <div className="ai-empty-notice px-3.5 py-3 text-xs">
          Turn on AI in the Configuration tab to configure redaction.
        </div>
      </div>
    );
  }

  return (
    <div className="security-tab flex flex-col gap-3">
      <div className="ai-empty-notice px-3.5 py-3 text-xs">
        Sensitive data is redacted before any context leaves this machine. Turn protections off only if you have to, or
        add custom headers and variables to redact.
      </div>

      {/*
        Says out loud what the redaction does NOT cover, so nobody has to infer
        it from a toggle label. Two of these were live surprises: the content
        the assistant edits is sent word for word, and no heuristic can see an
        ordinary-looking secret under an ordinary-looking key.

        THE VERBATIM LIST IS COMPLETE, AND IT HAS TO STAY COMPLETE. It used to
        name only Docs, while `allContent` in the chat payload ships Tests,
        Pre-Request and Post-Response scripts by exactly the same route — a
        customer deciding whether to point this at a cloud provider was reading
        a subset and calling it the list. The keys sent verbatim are pinned in
        OUTBOUND_VERBATIM_KEYS (providers/ReduxStore/slices/ai.js); if that set
        grows, this paragraph is what has to grow with it.
      */}
      <div className="security-card" data-testid="ai-security-disclosure">
        <div className="security-row flex flex-col gap-2 px-3.5 py-3">
          <span className="text-[12.5px] font-semibold">What is sent, and what redaction cannot catch</span>
          <ul className="security-sub text-[11px] flex flex-col gap-1 list-disc pl-4">
            <li>
              <strong>Four things are sent word for word, with no redaction at all:</strong> the{' '}
              <strong>Docs</strong>, <strong>Tests</strong>, <strong>Pre-Request script</strong> and{' '}
              <strong>Post-Response script</strong> of the request, folder or collection you have open. That is the
              content the assistant edits and diffs its reply against, so it goes as written. Keep credentials out of
              all four.
            </li>
            <li>
              The request URL, headers, query and path parameters, body fields, variables and the response shape are
              redacted by name and by value shape (<code>sk-…</code>, JWTs, long opaque tokens, UUIDs in a URL path).
            </li>
            <li>
              A body that cannot be parsed into fields — <code>text</code>, <code>xml</code>, <code>sparql</code>, or
              malformed JSON — is <strong>not sent at all</strong>.
            </li>
            <li>
              <strong>A short, ordinary-looking secret under an ordinary-looking key is not detectable</strong> — a
              body of <code>{'{"a": "hunter2"}'}</code> is sent as-is. Add the key name below to mask it.
            </li>
            <li>Chat messages you type are sent as you wrote them, also without redaction.</li>
          </ul>
        </div>
      </div>

      <div className="security-card">
        <div className="security-row flex items-center justify-between gap-3 px-3.5 py-3">
          <div className="flex flex-col gap-0.5 min-w-0">
            <span className="text-[12.5px] font-semibold">Redact sensitive header values</span>
            <span className="security-sub text-[11px]">
              Masks Authorization, cookies, API keys and other credential-bearing headers in the request context.
            </span>
          </div>
          <ToggleSwitch
            size="xs"
            isOn={redactHeaders}
            handleToggle={() => onToggleRedactHeaders(!redactHeaders)}
            data-testid="ai-security-headers-toggle"
          />
        </div>

        <div className="security-row flex items-center justify-between gap-3 px-3.5 py-3">
          <div className="flex flex-col gap-0.5 min-w-0">
            <span className="text-[12.5px] font-semibold">Redact sensitive body keys</span>
            <span className="security-sub text-[11px]">
              Masks values under keys like <code>password</code>, <code>*_token</code>, <code>secret</code> in JSON and
              GraphQL variables. Structure and non-sensitive fields still pass through.
            </span>
          </div>
          <ToggleSwitch
            size="xs"
            isOn={redactBody}
            handleToggle={() => onToggleRedactBody(!redactBody)}
            data-testid="ai-security-body-toggle"
          />
        </div>

        <div className="security-row flex items-center justify-between gap-3 px-3.5 py-3">
          <div className="flex flex-col gap-0.5 min-w-0">
            <span className="text-[12.5px] font-semibold">Redact response values</span>
            <span className="security-sub text-[11px]">
              Sends the response as a shape only — real values replaced with type placeholders (<code>&lt;string&gt;</code>,{' '}
              <code>&lt;number&gt;</code>). Turn off to send the actual response body.
            </span>
          </div>
          <ToggleSwitch
            size="xs"
            isOn={redactResponse}
            handleToggle={() => onToggleRedactResponse(!redactResponse)}
            data-testid="ai-security-response-toggle"
          />
        </div>

        <div className="security-row flex items-center justify-between gap-3 px-3.5 py-3">
          <div className="flex flex-col gap-0.5 min-w-0">
            <span className="text-[12.5px] font-semibold">Redact secret variable values</span>
            <span className="security-sub text-[11px]">
              Masks values whose names look like secrets. Turning this off no longer exposes them: variables marked{' '}
              <em>secret</em>, names matching the credential patterns, and credential-shaped values are redacted in
              every configuration. This switch can widen redaction, never remove it.
            </span>
          </div>
          <ToggleSwitch
            size="xs"
            isOn={redactVariables}
            handleToggle={() => onToggleRedactVariables(!redactVariables)}
            data-testid="ai-security-variables-toggle"
          />
        </div>
      </div>

      <div className="security-card">
        <div className="security-row flex flex-col gap-2 px-3.5 py-3">
          <div className="flex flex-col gap-0.5">
            <span className="text-[12.5px] font-semibold">Custom redacted headers</span>
            <span className="security-sub text-[11px]">
              Exact, case-insensitive header names to always mask on top of the built-in list.
            </span>
          </div>
          <ChipListEditor
            list={customRedactedHeaders}
            placeholder="X-Custom-Token"
            onChange={onChangeCustomRedactedHeaders}
            inputTestId="ai-security-custom-header-input"
            addTestId="ai-security-custom-header-add"
            removeTestIdPrefix="ai-security-custom-header-remove"
          />
        </div>

        <div className="security-row flex flex-col gap-2 px-3.5 py-3">
          <div className="flex flex-col gap-0.5">
            <span className="text-[12.5px] font-semibold">Custom redacted variables</span>
            <span className="security-sub text-[11px]">
              Variable names whose values should always be masked when Gridman lists them for the model — for anything
              you want redacted besides values already flagged as <em>secret</em>.
            </span>
          </div>
          <ChipListEditor
            list={customRedactedVariables}
            placeholder="MY_SESSION_TOKEN"
            onChange={onChangeCustomRedactedVariables}
            inputTestId="ai-security-custom-var-input"
            addTestId="ai-security-custom-var-add"
            removeTestIdPrefix="ai-security-custom-var-remove"
          />
        </div>

        <div className="security-row flex flex-col gap-1 px-3.5 py-3">
          <span className="text-[11px] font-medium security-sub">Already covered by default</span>
          <div className="security-builtin flex flex-wrap gap-1.5">
            {BUILT_IN_HEADER_EXAMPLES.map((name) => (
              <span key={name} className="security-builtin-chip">
                {name}
              </span>
            ))}
            <span className="security-builtin-more text-[10.5px]">
              plus any name matching <code>token</code>, <code>secret</code>, <code>password</code> or{' '}
              <code>api_key</code>.
            </span>
          </div>
        </div>
      </div>
    </div>
  );
};

export default SecurityPane;
