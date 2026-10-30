#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { parseArgs } = require('node:util');
const RULES = ['feature-envy', 'long-method', 'switch-statement', 'code-clone-fragment'].map(name => '@extrulesproject/' + name + '-check');
const within = (file, root) => { const rel = path.relative(root, file); return !rel || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel)); };
const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n'); };

async function scan(projectFile, ruleFile, summaryFile) {
  projectFile = path.resolve(projectFile); ruleFile = path.resolve(ruleFile); summaryFile = path.resolve(summaryFile);
  let root = '', rules = [], loaded = [], report = '', ok = false, failure;
  const output = path.dirname(path.resolve(summaryFile));
  const summary = { runner: 'direct-homecheck', scanner: '@arkts-refactor/homecheck-runtime', version: require('./package.json').version, success: false, requestedRules: [], loadedRules: [], repositories: [] };
  try {
    const input = read(projectFile), ruleConfig = read(ruleFile);
    root = fs.realpathSync(input.projectPath);
    rules = [...new Set((ruleConfig.extRuleSet || []).flatMap(set => Object.keys(set.extRules || {})))];
    summary.requestedRules = rules;
    if (!rules.length || rules.some(rule => !RULES.includes(rule))) throw Error('Unsupported or empty selected rule list');
    if (ruleConfig.extRuleSet?.length !== 1 || ruleConfig.extRuleSet[0].ruleSetName !== 'extrulesproject') throw Error('Only bundled extrulesproject is permitted');
    const requested = input.checkFiles || (input.checkPath ? read(input.checkPath).checkPath.map(p => p.filePath) : []);
    if (!Array.isArray(requested) || !requested.length) throw Error('Explicit non-empty checkFiles required');
    const files = [...new Set(requested.map(file => {
      const absolute = path.resolve(root, file), resolved = fs.realpathSync(absolute);
      if (!within(resolved, root) || !/\.(ets|ts)$/i.test(resolved) || !fs.statSync(resolved).isFile()) throw Error('Scan file missing or outside project: ' + file);
      return resolved;
    }))];
    fs.mkdirSync(output, { recursive: true });
    // Default logger/cache paths must never write into the installed package.
    process.chdir(output);
    const checkPath = path.join(output, 'check-paths.json'), configPath = path.join(output, 'project-config.json'), rulesPath = path.join(output, 'rule-config.json');
    report = path.join(output, 'issuesReport.json');
    fs.rmSync(report, { force: true });
    write(checkPath, { checkPath: files.map(filePath => ({ filePath, fixKey: [] })) });
    const homecheckRoot = path.dirname(require.resolve('homecheck/package.json'));
    const projectConfig = { ...input, projectPath: root + path.sep, projectName: input.projectName || path.basename(root), checkPath, reportDir: output, logPath: path.join(output, 'HomeCheck.log'), arkCheckPath: homecheckRoot, fix: 'false', fixSelected: false, npmInstallDir: output, homecheck_log_level: 'info', arkanalyzer_log_level: 'error' };
    // Absolute ignore patterns must be scoped to the source root, not its parents.
    const scope = value => Array.isArray(value) ? value.map(p => typeof p === 'string' && p.startsWith('**/') ? path.join(root, p).replaceAll('\\', '/') : p) : value;
    const scoped = { ...ruleConfig, ignore: scope(ruleConfig.ignore), excluded: scope(ruleConfig.excluded), rules: {}, ruleSet: [], extRuleSet: [{ ruleSetName: 'extrulesproject', packagePath: path.join(__dirname, 'rules'), extRules: Object.fromEntries(rules.map(rule => [rule, 2])) }] };
    write(configPath, projectConfig); write(rulesPath, scoped);
    process.env.EXTRULES_PERF = '0';
    process.env.HOMECHECK_FILE_CONCURRENCY = '1';
    require('./fsConcurrencyLimit.cjs');
    const { ConfigUtils } = require('homecheck/lib/utils/common/ConfigUtils.js');
    const extension = require('./rules/lib/index.js');
    // Preserve HomeCheck's rule construction/registration, but never run npm or
    // load a package path provided by an input project. Dependencies are installed once.
    ConfigUtils.parseExtRuleConfig = function(config, _project, message, allRules, ruleMap) {
      for (const set of config.extRuleSet) {
        if (set.ruleSetName !== 'extrulesproject') throw Error('External packages are disabled');
        this.processExternalRules(set, allRules, extension, message, ruleMap);
      }
    };
    process.argv = [process.execPath, require.resolve('homecheck/lib/run.js'), '--projectConfigPath=' + configPath, '--configPath=' + rulesPath];
    ok = (await require('homecheck/lib/Main.js').main()) === true;
    await new Promise(resolve => require('log4js').shutdown(resolve));
    const registry = require('homecheck/lib/utils/common/CheckerIndex.js');
    loaded = rules.filter(rule => registry.file2CheckRuleMap.has(rule) || registry.project2CheckRuleMap.has(rule));
    summary.loadedRules = loaded;
    if (!ok || loaded.length !== rules.length) throw Error('HomeCheck did not complete/load all selected rules');
    const log = fs.readFileSync(projectConfig.logPath, 'utf8');
    const count = [...log.matchAll(/\[CheckEntry\] File count: (\d+)/g)].at(-1);
    if (!count || Number(count[1]) !== files.length || /\[ERROR\].*\[HomeCheck\]/.test(log) || !log.includes('[Main] Checking completed.')) throw Error('Incomplete scan, checker error or selected file count mismatch');
    if (!fs.existsSync(report)) throw Error('Missing fresh issuesReport.json');
    const issues = read(report);
    if (!Array.isArray(issues)) throw Error('Malformed issues report');
    const { filterOutOfScopeIssues } = require('./outOfScopeIssueFilter.cjs');
    const filtered = filterOutOfScopeIssues(issues, { repositoryRoot: root });
    write(path.join(output, 'issuesReport.raw.json'), issues);
    write(report, filtered.issues);
    write(path.join(output, 'outOfScopeFilterReport.json'), { stats: filtered.stats, removedIssues: filtered.removedIssues });
    summary.success = true;
    summary.scannedFiles = files;
  } catch (error) { failure = error; ok = false; summary.error = error.stack || String(error); }
  finally {
    summary.repositories = [{ path: root, runs: rules.map(ruleName => ({ ruleName, success: summary.success, exitCode: summary.success ? 0 : 1, issuesReportPath: report })) }];
    write(summaryFile, summary);
    // ArkAnalyzer's patched async log stream must flush before a short-lived scan exits.
    try { await new Promise(resolve => require('log4js').shutdown(resolve)); } catch { /* absent on configuration failure */ }
  }
  if (failure) throw failure;
  return summary;
}
module.exports = { scan, RULES };
if (require.main === module) {
  const { values } = parseArgs({ options: { 'project-config': { type: 'string' }, 'rule-config': { type: 'string' }, summary: { type: 'string' } } });
  if (!values['project-config'] || !values['rule-config'] || !values.summary) {
    console.error('Usage: node scan.cjs --project-config <json> --rule-config <json> --summary <json>'); process.exitCode = 1;
  } else scan(values['project-config'], values['rule-config'], values.summary).catch(error => { console.error(error.message); process.exitCode = 1; });
}
