// Self-contained test tooling for the ingest Lambda: this config, and the
// devDependencies it relies on, live entirely inside lambda/ingest/ and are
// intentionally NOT shared with the CDK app's own root jest.config.js (see
// package.json's description). Run from within this directory (`npm test`).
module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>'],
  testMatch: ['**/*.test.ts'],
  transform: {
    '^.+\\.tsx?$': ['@swc/jest'],
  },
};
