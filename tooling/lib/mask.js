'use strict';
/*
 * mask.js - find and hide secrets and private paths in text that leaves
 * the kit's control: receipts, and every page or data file a builder
 * writes from agent-written text.
 *
 *   const { buildMasks, mask, detect } = require('./lib/mask');
 *   const masks = buildMasks(config);
 *   mask(text, masks)    -> text with each match replaced by
 *                           "[masked: <label>]"
 *   detect(text, masks)  -> label of the first pattern that matches, or null
 *
 * Patterns: the must-zero class D built-ins of check-clean.js (home paths,
 * credentialed URLs, keys and tokens ...) and the config's
 * evidence.secret_patterns. For masking, each built-in match is widened to
 * the rest of its word, so no tail of the secret is left behind.
 */

const { BUILTINS } = require('../check-clean');

function buildMasks(config) {
  const out = BUILTINS.filter((b) => b.sev === 'must' && b.cls === 'D').map((b) => ({
    label: b.label,
    detect: new RegExp(b.re.source, b.re.flags.replace('g', '')),
    re: new RegExp('(?:' + b.re.source + ')[^\\s"\'<>]*', b.re.flags.replace('g', '') + 'g'),
  }));
  config.evidence.secret_patterns.forEach((p, i) => out.push({ label: `secret_patterns[${i}]`, detect: new RegExp(p, 'i'), re: new RegExp(p, 'gi') }));
  return out;
}

function mask(text, masks) {
  let t = text;
  for (const m of masks) t = t.replace(m.re, `[masked: ${m.label}]`);
  return t;
}

function detect(text, masks) {
  const hit = masks.find((m) => m.detect.test(text));
  return hit ? hit.label : null;
}

module.exports = { buildMasks, mask, detect };
