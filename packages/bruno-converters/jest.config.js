module.exports = {
  transform: {
    // TypeScript included so the opencollection modules (all .ts) can be unit
    // tested — bruno-filestore, also TS, has carried the same pair for a while.
    '^.+\\.(js|ts)$': 'babel-jest'
  },
  setupFiles: ['<rootDir>/jest.setup.js'],
  transformIgnorePatterns: [
    'node_modules/(?!(nanoid)/)'
  ],
  moduleFileExtensions: ['js', 'ts', 'json'],
  testEnvironment: 'node',
  moduleNameMapper: {
    '^nanoid(/(.*)|$)': 'nanoid$1'
  }
};
