'use strict';
/*
 * modules.js - map cited code locations to the modules of config.modules.
 * Shared by build-recommendations (the page) and workflow-args (which
 * module planners the recommend phase starts), so both place a finding in
 * the same module.
 *
 *   compileModules(config) -> rules with a compiled `re`
 *   moduleOf(loc, rules) -> { id, label, repo, layer, doc } | null
 *       the first rule whose repo is loc.repo and whose pattern matches
 *       loc.path; $1, $2 ... in id and label are the pattern's groups.
 *   modulesOfCandidate(cand, rules) -> modules of every cited location,
 *       first-seen order, no repeats; the first one is the primary module.
 *   groupFindings(config, ids, candidatesById) -> { modules, unmapped }
 *       modules: [{ id, label, repo, layer, doc, finding_ids }] with the
 *       ids whose PRIMARY module it is, ordered by repo (config order),
 *       layer (rule order), then id; unmapped: ids no rule places.
 */

function compileModules(config) {
  return (config.modules || []).map((m) => ({ ...m, re: new RegExp(m.pattern) }));
}

function substitute(template, match) {
  return template.replace(/\$(\d)/g, (_, n) => (match[Number(n)] === undefined ? '' : match[Number(n)]));
}

function moduleOf(loc, rules) {
  for (const r of rules) {
    if (r.repo !== loc.repo) continue;
    const m = r.re.exec(loc.path);
    if (m) return { id: substitute(r.id, m), label: substitute(r.label, m), repo: r.repo, layer: r.layer || '', doc: r.doc || '' };
  }
  return null;
}

function modulesOfCandidate(cand, rules) {
  const mods = [];
  for (const loc of cand && Array.isArray(cand.locations) ? cand.locations : []) {
    const m = moduleOf(loc, rules);
    if (m && !mods.some((x) => x.id === m.id)) mods.push(m);
  }
  return mods;
}

function groupFindings(config, ids, candidatesById) {
  const rules = compileModules(config);
  const modules = new Map();
  const unmapped = [];
  for (const id of ids) {
    const primary = modulesOfCandidate(candidatesById.get(id), rules)[0];
    if (!primary) { unmapped.push(id); continue; }
    if (!modules.has(primary.id)) modules.set(primary.id, { ...primary, finding_ids: [] });
    modules.get(primary.id).finding_ids.push(id);
  }
  const repoOrder = (config.repos || []).map((r) => r.name);
  const layerOrder = [...new Set(rules.map((r) => r.layer || ''))];
  const byStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  const list = [...modules.values()].sort((a, b) => repoOrder.indexOf(a.repo) - repoOrder.indexOf(b.repo)
    || layerOrder.indexOf(a.layer) - layerOrder.indexOf(b.layer) || byStr(a.id, b.id));
  return { modules: list, unmapped };
}

module.exports = { compileModules, moduleOf, modulesOfCandidate, groupFindings, substitute };
