import type { Environment as BrunoEnvironment, EnvironmentVariable as BrunoEnvironmentVariable } from '@usebruno/schema-types/collection/environment';
import type { Environment } from '@opencollection/types/config/environments';
import type { Variable, SecretVariable } from '@opencollection/types/common/variables';
import { stringifyYml } from './utils';
import { serializeVariableValue } from './common/variables';

const toOpenCollectionEnvironmentVariables = (variables: BrunoEnvironmentVariable[]): (Variable | SecretVariable)[] | undefined => {
  if (!variables?.length) {
    return undefined;
  }

  // Non-string values (numbers, booleans, objects set from scripts) used to be filtered
  // out here, which removed the variable from the environment file entirely on the next
  // save. Serialize them instead - upstream 942f99571 (#8046).
  const ocVariables: (Variable | SecretVariable)[] = variables
    .map((v: BrunoEnvironmentVariable): Variable | SecretVariable => {
      if (v.secret === true) {
        const secretVar: SecretVariable = {
          secret: true,
          name: v.name || ''
        };
        if (v.datatype && v.datatype !== 'string') {
          secretVar.type = v.datatype;
        }
        if (v.enabled === false) {
          secretVar.disabled = true;
        }
        return secretVar;
      }

      const valueStr = serializeVariableValue(v.value, v.name);

      const variable: Variable = {
        name: v.name || '',
        value:
          v.datatype && v.datatype !== 'string'
            ? { type: v.datatype, data: valueStr }
            : valueStr
      };

      if (v.enabled === false) {
        variable.disabled = true;
      }

      return variable;
    });

  return ocVariables.length > 0 ? ocVariables : undefined;
};

const stringifyEnvironment = (environment: BrunoEnvironment): string => {
  try {
    const ocEnvironment: Environment = {
      name: environment.name
    };

    if (environment.color) {
      ocEnvironment.color = environment.color;
    }

    if (environment.variables?.length) {
      const ocVariables = toOpenCollectionEnvironmentVariables(environment.variables);
      if (ocVariables) {
        ocEnvironment.variables = ocVariables;
      }
    }

    if (environment.externalSecrets) {
      (ocEnvironment as any).externalSecrets = {
        type: environment.externalSecrets.type,
        variables: (environment.externalSecrets.variables || []).map((variable) => ({ ...variable }))
      };
    }

    return stringifyYml(ocEnvironment);
  } catch (error) {
    console.error('Error stringifying environment:', error);
    throw error;
  }
};
export default stringifyEnvironment;
