'use strict';
// Bridge protocol remains positional; the detector and its fixed rules are now
// shipped as a backend npm dependency. Never install rules during a scan.
const path = require('node:path');
const [homecheck, projectConfig, ruleConfig, summaryPath] = process.argv.slice(2);
require(path.join(homecheck, 'scan.cjs')).scan(projectConfig, ruleConfig, summaryPath)
  .catch(error => { console.error(error.message); process.exitCode = 1; });
