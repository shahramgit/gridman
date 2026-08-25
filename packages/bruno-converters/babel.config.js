module.exports = {
  // TypeScript added so the opencollection modules (all .ts) can be unit tested at
  // all — bruno-filestore, also TS, has carried the same pair for a while.
  presets: [
    ['@babel/preset-env', { targets: { node: 'current' } }],
    '@babel/preset-typescript'
  ]
};
