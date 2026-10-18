'use strict';

// Run the detector without the benchmark script's CLOC, Git or dashboard steps.
const fs = require('node:fs');
const path = require('node:path');
const [homecheck, projectConfig, ruleConfig, summaryPath] = process.argv.slice(2);
const summary = { runner: 'direct-homecheck', success: false, requestedRules: [], loadedRules: [] };

async function run() {
  try {
    process.env.EXTRULES_PERF = '0';
    const config = JSON.parse(fs.readFileSync(ruleConfig, 'utf8'));
    summary.requestedRules = config.extRuleSet.flatMap(set => Object.keys(set.extRules));
    const limiter = path.join(homecheck, 'scripts/fsConcurrencyLimit.js');
    if (fs.existsSync(limiter)) require(limiter);
    const lib = path.join(homecheck, 'node_modules/homecheck/lib');
    process.argv = [process.execPath, path.join(lib, 'run.js'),
      `--projectConfigPath=${projectConfig}`, `--configPath=${ruleConfig}`];
    const ok = await require(path.join(lib, 'Main.js')).main();
    const registry = require(path.join(lib, 'utils/common/CheckerIndex.js'));
    summary.loadedRules = summary.requestedRules.filter(rule =>
      registry.file2CheckRuleMap.has(rule) || registry.project2CheckRuleMap.has(rule));
    if (ok !== true) throw new Error('HomeCheck did not complete successfully');
    const missing = summary.requestedRules.filter(rule => !summary.loadedRules.includes(rule));
    if (missing.length) throw new Error('HomeCheck did not load selected rules: ' + missing.join(', '));
    summary.success = true;
  } catch (error) {
    summary.error = error.stack || String(error);
    console.error(summary.error);
    process.exitCode = 1;
  } finally {
    fs.mkdirSync(path.dirname(summaryPath), { recursive: true });
    fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2), 'utf8');
  }
}

run().catch(error => { console.error(error); process.exitCode = 1; });
