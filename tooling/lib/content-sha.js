'use strict';
/*
 * content-sha.js - content hashes that tie later audit steps to the exact
 * data an earlier step worked on.
 *
 * canonicalJson(value)  JSON text with object keys sorted at every level
 *                       (array order kept), so two equal objects give the
 *                       same text whatever order their keys were written in.
 * contentSha(value)     sha256 (64 hex characters) of canonicalJson(value).
 *                       The sha of a candidate is the contentSha of the whole
 *                       candidate object as it stands in work/candidates.json.
 * fileSha(file)         sha256 of a file's bytes, or null when it is missing.
 */

const crypto = require('crypto');
const fs = require('fs');

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map((v) => (v === undefined ? 'null' : canonicalJson(v))).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  }
  const text = JSON.stringify(value);
  return text === undefined ? 'null' : text;
}

function contentSha(value) {
  return crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function fileSha(file) {
  let bytes;
  try {
    bytes = fs.readFileSync(file);
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

module.exports = { canonicalJson, contentSha, fileSha };
