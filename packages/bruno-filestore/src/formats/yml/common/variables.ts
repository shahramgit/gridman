import { Variable, VariableTypedValue } from '@opencollection/types/common/variables';
import { FolderRequest as BrunoFolderRequest } from '@usebruno/schema-types/collection/folder';
import { Variable as BrunoVariable, Variables as BrunoVariables } from '@usebruno/schema-types/common/variables';
import { uuid, ensureString, isNonEmptyString } from '../../../utils';

export const isTypedValue = (value: unknown): value is VariableTypedValue => {
  return (
    typeof value === 'object'
    && value !== null
    && !Array.isArray(value)
    && 'type' in value
    && 'data' in value
  );
};

/**
 * Variable values are not always strings - scripts set numbers, booleans, arrays and
 * objects via bru.setEnvVar()/bru.setVar(). The yml value field is text, so serialize
 * whatever we are handed instead of dropping it.
 * Upstream: `serializeVariableValue` in 942f99571 (#8046).
 *
 * A value we cannot encode throws, which aborts the save and leaves the previous value on
 * disk untouched. Writing a '[object Object]' placeholder instead would silently replace
 * the real value with something unrecoverable and indistinguishable from a genuine string.
 */
export const serializeVariableValue = (value: unknown, name?: string | null): string => {
  if (value === null || typeof value !== 'object') {
    return ensureString(value);
  }

  const label = isNonEmptyString(name) ? name : '<unnamed>';
  let serialized: string | undefined;

  try {
    serialized = JSON.stringify(value, null, 2);
  } catch (error) {
    // circular references and BigInt payloads land here
    throw new Error(`Unable to save variable "${label}": its value could not be serialized (${(error as Error)?.message}).`);
  }

  if (serialized === undefined) {
    // a toJSON() returning undefined leaves us with nothing to write
    throw new Error(`Unable to save variable "${label}": its value could not be serialized.`);
  }

  return serialized;
};

/**
 * Convert Bruno pre-request variables to OpenCollection variables format.
 * Note: Post-response variables are now converted to actions (see actions.ts).
 */
export const toOpenCollectionVariables = (variables: BrunoFolderRequest['vars'] | BrunoVariables | null | undefined): Variable[] | undefined => {
  // Handle folder variables (has req/res structure) - only use req vars
  const hasReqRes = variables && 'req' in variables;
  const reqVars = hasReqRes ? variables.req : variables as BrunoVariables;

  const reqVarsArray = Array.isArray(reqVars) ? reqVars : [];

  if (!reqVarsArray.length) {
    return undefined;
  }

  const ocVariables: Variable[] = reqVarsArray.map((v: BrunoVariable): Variable => {
    // collection / folder / request variables carry script written values just like
    // environment variables do. `v.value || ''` wrote '' for 0 and false, and
    // ensureString() wrote '[object Object]' for objects - the value was gone on the next
    // save. Upstream: 942f99571 (#8046).
    const valueStr = serializeVariableValue(v.value, v.name);

    const variable: Variable = {
      name: v.name || '',
      value:
        v.datatype && v.datatype !== 'string'
          ? { type: v.datatype, data: valueStr }
          : valueStr
    };

    if (v?.description?.trim().length) {
      variable.description = v.description;
    }

    if (v.enabled === false) {
      variable.disabled = true;
    }
    return variable;
  });

  return ocVariables.length > 0 ? ocVariables : undefined;
};

/**
 * Convert OpenCollection variables to Bruno pre-request variables format.
 * Note: Post-response variables come from actions (see actions.ts).
 */
export const toBrunoVariables = (variables: Variable[] | null | undefined): { req: BrunoVariables; res: BrunoVariables } => {
  if (!variables?.length) {
    return { req: [], res: [] };
  }

  const reqVars: BrunoVariables = [];

  variables.forEach((v: Variable) => {
    const variable: BrunoVariable = {
      uid: uuid(),
      name: ensureString(v.name),
      value: '',
      enabled: v.disabled !== true,
      local: false
    };

    if (isTypedValue(v.value)) {
      variable.value = ensureString(v.value.data);
      if (v.value.type !== 'string' && v.value.type !== 'null') {
        variable.datatype = v.value.type;
      }
    } else {
      variable.value = ensureString(v.value);
    }

    if (v.description) {
      variable.description = typeof v.description === 'string' ? v.description : (v.description as any)?.content || '';
    }

    reqVars.push(variable);
  });

  return { req: reqVars, res: [] };
};
