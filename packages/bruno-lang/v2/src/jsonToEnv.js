const _ = require('lodash');
const { getValueString, indentString, serializeAnnotations } = require('./utils');

const envToJson = (json) => {
  const variables = _.get(json, 'variables', []);
  const externalSecrets = _.get(json, 'externalSecrets', null);
  const color = _.get(json, 'color', null);
  const extendsFrom = _.get(json, 'extends');

  const vars = variables
    .filter((variable) => !variable.secret)
    .map((variable) => {
      const { name, value, enabled, annotations } = variable;
      const prefix = enabled ? '' : '~';

      return indentString(`${serializeAnnotations(annotations)}${prefix}${name}: ${getValueString(value)}`);
    });

  const secretVars = variables
    .filter((variable) => variable.secret)
    .map((variable) => {
      const { name, enabled, annotations } = variable;
      const prefix = enabled ? '' : '~';
      return indentString(`${serializeAnnotations(annotations)}${prefix}${name}`);
    });

  let output = '';

  if (typeof extendsFrom === 'string') {
    output += `extends: ${extendsFrom}\n`;
  } else if (Array.isArray(extendsFrom) && extendsFrom.length) {
    // Quote delimiters, quotes, backslashes and edge whitespace so shared Bruno
    // environment names survive a save in Gridman without enabling inheritance.
    const references = extendsFrom.map((name) => {
      const needsQuotes = /[\[\],"\\]/.test(name) || name.trim() !== name;
      return indentString(needsQuotes ? JSON.stringify(name) : name);
    });
    output += `extends [\n${references.join(',\n')}\n]\n`;
  }

  if (!variables || !variables.length) {
    output += `vars {
}
`;
  }

  if (vars.length) {
    output += `vars {
${vars.join('\n')}
}
`;
  }

  if (secretVars.length) {
    output += `vars:secret [
${secretVars.join(',\n')}
]
`;
  }

  if (externalSecrets && externalSecrets.type) {
    const serializedVariables = (externalSecrets.variables || []).map(({ name, value }) =>
      indentString(`${name}: ${getValueString(value)}`)
    );

    output += `vars:externalsecrets:${externalSecrets.type} {
${serializedVariables.join('\n')}
}
`;
  }

  if (color) {
    output += `color: ${color}
`;
  }

  return output;
};

module.exports = envToJson;
