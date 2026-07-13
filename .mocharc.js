// Mocha config for level-3 UI tests (ExTester). UI tests are slow by nature —
// generous timeouts are expected, not a smell.
module.exports = {
  timeout: 120000,
  slow: 30000,
  reporter: "spec"
};
