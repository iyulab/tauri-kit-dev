// This repository's own guard (`npm run guard`): the default rules, plus the traces a consumer's
// private workspace tends to leave in code it hands upstream. It deliberately names no consumer —
// a list of consumer names committed here would publish them. Each consumer checks its own names
// with its own config before contributing (see CONTRIBUTING.md).
export default {
  forbidden: [
    { why: 'workspace record id', re: /\b(?:cycle|run)-\d+\b|\b[A-Z]{1,2}-\d{2,3}\b(?!-)/ },
    { why: 'process notes', re: /\bclaudedocs\b|\bHANDOFF\.md\b|\bROADMAP\.md\b/ },
    { why: 'consumer reference', re: /\bour app\b|\bthe consumer app\b|\bumbrella\b/i },
  ],
  allowed: [
    // Names the convention it keeps out, the same way every repository's ignore file does.
    '.gitignore:claudedocs/',
    // The rule above, as written.
    'scripts/public-text.config.js:',
  ],
}
