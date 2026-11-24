#!/usr/bin/env node
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(import.meta.url);
const verdicts = new Set(["PASS", "FAIL", "BLOCKED", "INCOMPLETE"]);
const rules = new Set(["feature-envy", "long-method", "switch-statement", "code-clone-fragment"]
  .map(name => "@extrulesproject/" + name + "-check"));
// Keep the same source/config/resource boundary as Skill's frozen project snapshot.
const ignored = new Set([".git", ".idea", ".hvigor", ".homegraph", ".cache", ".test",
  "build", "coverage", "oh_modules", "node_modules", "report", "reports", ".preview", ".gradle"]);
const uuid = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
const existsFile = name => fs.statSync(name, { throwIfNoEntry: false })?.isFile();
const readJson = file => JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
const slash = name => name.split(path.sep).join("/");
const samePath = (left, right) => typeof left === "string" && typeof right === "string" &&
  path.relative(left, right) === "";

function writeJson(file, value) {
  const temporary = file + "." + randomUUID() + ".tmp";
  try {
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", { mode: 0o600, flag: "wx", flush: true });
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function options(argv) {
  const values = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (!["--list", "--recover", "--dataset", "--workspace", "--skill-dir", "--output", "--config", "--start", "--end"].includes(flag)
        || Object.hasOwn(values, flag)) throw new Error("未知或重复的参数 " + flag);
    if (flag === "--list" || flag === "--recover") values[flag] = true;
    else {
      const value = argv[++i];
      if (!value || value.startsWith("--")) throw new Error(flag + " 缺少参数");
      values[flag] = value;
    }
  }
  if (values["--recover"] && Object.keys(values).length > 1) throw new Error("--recover 单独使用，按中断日志恢复原任务");
  return values;
}

function relativeName(value) {
  if (typeof value !== "string" || /[:\0]/.test(value) ||
      value.split(/[\\/]/).some(part => !part || part === "." || part === ".."))
    throw new Error("清单路径必须是安全的相对路径：" + value);
  return value.replaceAll("\\", "/");
}

function select(records, args) {
  if (!Array.isArray(records) || !records.length) throw new Error("样例清单必须是非空 JSON 数组");
  const cases = records.map((item, index) => {
    const filePath = relativeName(item?.filePath), source = relativeName(item.sourceProject);
    if (source.includes("/") || !filePath.startsWith(source + "/") ||
        !["local-test", "instrument-test"].includes(item.testKind) || item.messages?.length !== 1 ||
        typeof item.messages[0]?.message !== "string" || !rules.has(item.messages[0]?.rule) ||
        (item.messages[0].testKind && item.messages[0].testKind !== item.testKind))
      throw new Error("样例路径、异味或测试类型无效，序号 " + (index + 1));
    return { ...item, filePath, ordinal: index + 1 };
  });
  const first = Number(args["--start"] ?? 1), last = Number(args["--end"] ?? 0) || cases.length;
  if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last) || first < 1 || last < first ||
      last > cases.length || (args["--end"] && !/^\d+$/.test(args["--end"])))
    throw new Error(`序号范围无效；清单有 ${cases.length} 条，区间两端均包含在内`);
  return cases.slice(first - 1, last);
}

function inside(base, name) {
  const rel = path.relative(base, name);
  return !path.isAbsolute(rel) && rel !== ".." && !rel.startsWith(".." + path.sep);
}

function targetUnder(workspace, name) {
  const target = path.resolve(workspace, relativeName(name));
  // Resolve every component; never silently rebind a dataset record via a junction.
  if (!samePath(fs.realpathSync(target), target) || !inside(workspace, target) || !existsFile(target))
    throw new Error("样例指向链接、越界路径或非文件：" + target);
  return target;
}

function locate(item, workspace) {
  const target = targetUnder(workspace, item.filePath), repo = path.join(workspace, item.sourceProject);
  let project = path.dirname(target);
  while (!(existsFile(path.join(project, "build-profile.json5")) &&
           existsFile(path.join(project, "hvigor/hvigor-config.json5")))) {
    if (samePath(project, repo)) throw new Error("找不到样例对应的 Harmony 工程：" + target);
    project = path.dirname(project);
  }
  const msg = item.messages[0];
  const message = msg.message.replace(/(similar to\s+)(.+?\.(?:ets|ts))(?=(?:\s*>\s*[^:]+)?:\d+-\d+)/gi,
    (_, prefix, other) => {
      const related = targetUnder(workspace, other);
      if (!inside(project, related)) throw new Error("克隆关联片段跨 Harmony 工程：" + other);
      return prefix + slash(path.relative(project, related));
    });
  return { item, project, repo, target, report: [{
    filePath: slash(path.relative(project, target)), sourceProject: path.basename(project),
    commitHash: item.commitHash, testKind: item.testKind, messages: [{ ...msg, message, testKind: item.testKind }],
  }] };
}

function fileHash(file, buffer) {
  const hash = createHash("sha256"), fd = fs.openSync(file, "r");
  try {
    let size;
    while ((size = fs.readSync(fd, buffer, 0, buffer.length)) > 0) hash.update(buffer.subarray(0, size));
  } finally { fs.closeSync(fd); }
  return hash.digest("hex");
}

function baseline(root) {
  const hash = createHash("sha256"), buffer = Buffer.allocUnsafe(256 * 1024);
  function visit(dir) {
    for (const name of fs.readdirSync(dir).sort()) {
      if (ignored.has(name)) continue;
      const child = path.join(dir, name), stat = fs.lstatSync(child);
      if (stat.isSymbolicLink()) throw new Error("工程基线包含链接：" + child);
      if (stat.isDirectory()) visit(child);
      else if (stat.isFile()) hash.update(JSON.stringify([slash(path.relative(root, child)), fileHash(child, buffer)]) + "\n");
    }
  }
  visit(root);
  return hash.digest("hex");
}

function launcher(explicit) {
  const dir = path.dirname(script);
  const config = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  const locations = explicit ? [explicit] : [path.dirname(dir), dir, path.join(dir, "arkts-smell-refactor"),
    path.join(config, "deveco/skills/arkts-smell-refactor")];
  for (const root of locations) {
    const entry = path.resolve(root, "scripts/run.mjs");
    if (existsFile(entry)) return fs.realpathSync(entry);
  }
  throw new Error("找不到 Skill 的 scripts/run.mjs。请安装完整发行包或用 --skill-dir 指定解压后的 Skill 目录。");
}

async function lockDevice(endpoint) {
  const server = net.createServer(socket => socket.destroy());
  await new Promise((resolve, reject) => {
    server.once("error", err => reject(new Error("无法独占批量实验设备锁：" + err.message)));
    server.listen(endpoint, resolve);
  });
  return () => new Promise(resolve => server.close(resolve));
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; }
  catch (err) { return err.code !== "ESRCH"; }
}

async function invoke(state, journal, command, flags = []) {
  const prefix = path.join(state.dir, `${++state.sequence}-${command}`);
  state.pending = { command, prefix };
  writeJson(journal, state);
  console.log(`[${state.ordinal}] ${command}`);
  const argv = [state.launcher, command, "--project", state.project, "--runs", state.runs,
    ...(state.config ? ["--config", state.config] : []), ...flags];
  const out = fs.openSync(prefix + ".json", "wx"), err = fs.openSync(prefix + ".log", "wx");
  let code;
  try {
    const child = spawn(process.execPath, argv, { cwd: state.dir, windowsHide: true, stdio: ["ignore", out, err],
      env: { ...process.env, ARKTS_BATCH_RECOVERY_TOKEN: state.recoveryToken ?? "" } });
    const closed = new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
    state.pending.pid = child.pid;
    writeJson(journal, state);
    code = await closed;
  } finally { fs.closeSync(out); fs.closeSync(err); }
  const receipt = readJson(prefix + ".json");
  if (receipt.command !== command || (receipt.projectRoot && !samePath(receipt.projectRoot, state.project)))
    throw new Error(command + " 返回了其他命令或工程的回执：" + prefix);
  if (receipt.result?.cleanup?.deferred) state.deferred = command;
  if (["execute", "validate-applied"].includes(command) && !receipt.ok && !receipt.result?.stop)
    state.deferred = command;
  state.pending = null;
  writeJson(journal, state);
  if (!receipt.ok || ![0, 3].includes(code)) {
    const detail = receipt.result?.missing?.map(x => [x.name, x.reason, x.action].join(" — ")).join("\n");
    throw new Error(command + " 失败：" + (detail || receipt.error?.message || prefix));
  }
  const failed = (receipt.result.result?.verdict && receipt.result.result.verdict !== "PASS") ||
    receipt.result.transaction?.state === "CONFLICT";
  if (code !== (failed ? 3 : 0)) throw new Error(command + " 退出码与回执不一致：" + prefix);
  return receipt;
}

function assertVerdict(result) {
  if (!verdicts.has(result?.verdict)) throw new Error("流水线回执缺少有效 verdict");
  return result.verdict;
}

async function finish(state, journal) {
  if (!state.task || state.finished) return;
  const { result } = await invoke(state, journal, "finish", ["--task", state.task]);
  if (result.state !== "FINISHED" || result.taskHandle !== state.task) throw new Error("任务收尾回执不匹配");
  for (const warning of result.warnings ?? []) console.warn(warning);
  state.finished = true;
  writeJson(journal, state);
}

async function restore(state, journal) {
  if (state.deferred || state.pending) throw new Error("子进程状态未确认；请确认编辑、构建及设备进程均已结束后运行 --recover");
  // Only apply can mutate the user's project. An intent is durable before spawning it.
  if (state.applyIntent) {
    const id = state.applyIntent, flags = ["--candidate", id];
    const saved = (await invoke(state, journal, "restore", flags)).result;
    if (saved.candidate?.candidateId !== id || !samePath(saved.candidate.originalRoot, state.project))
      throw new Error("恢复回执与待回滚候选不符");
    if (saved.transaction && saved.transaction.state !== "ROLLED_BACK") {
      const { result } = await invoke(state, journal, "rollback", [...flags, "--confirm", id]);
      if (result.transaction?.state !== "ROLLED_BACK" || result.transaction.candidateId !== id)
        throw new Error("回滚未完成：" + JSON.stringify(result.transaction?.conflicts ?? []));
    }
  }
  await finish(state, journal);
  if (baseline(state.project) !== state.baseline)
    throw new Error("工程文件与实验前基线不一致；保留现场与日志，请检查可能的并发修改");
}

async function recover(journal) {
  if (!existsFile(journal)) throw new Error("当前用户没有待恢复的批量实验");
  const state = readJson(journal);
  if (state.version !== 1 || !path.isAbsolute(state.project) || !path.isAbsolute(state.dir))
    throw new Error("无法识别恢复日志：" + journal);
  if (processAlive(state.pending?.pid)) throw new Error("命令进程仍在运行，PID " + state.pending.pid);
  // A runner may die between prepare returning and recording its handle. The runs directory
  // belongs to this single case, so only this invocation's prepared task can be recovered.
  if (!state.task && fs.existsSync(state.runs)) {
    const prepared = fs.readdirSync(state.runs).filter(id =>
      uuid.test(id) && existsFile(path.join(state.runs, id, "prepared.json")));
    if (prepared.length > 1) throw new Error("同一样例下存在多个准备任务，需人工核对：" + state.runs);
    if (prepared.length) state.task = prepared[0];
  }
  state.pending = null;
  state.deferred = null;
  writeJson(journal, state);
  await restore(state, journal);
  writeJson(path.join(state.dir, "recovery.json"), { ordinal: state.ordinal, rollbackVerified: true });
  fs.unlinkSync(journal);
  console.log("中断样例已完成恢复与基线核验：" + state.dir);
}

async function runCase(selected, setup, interrupted) {
  const { item, project, target, repo, report } = selected;
  const dir = path.join(setup.output, String(item.ordinal).padStart(3, "0"));
  fs.mkdirSync(dir);
  const state = { version: 1, ordinal: item.ordinal, recoveryToken: randomUUID(), dir, runs: path.join(dir, "runs"),
    project, launcher: setup.launcher, config: setup.config, sequence: 0, baseline: baseline(project) };
  const head = spawnSync("git", ["-C", repo, "rev-parse", "--verify", "HEAD"], { windowsHide: true, encoding: "utf8" });
  const info = { ordinal: item.ordinal, filePath: item.filePath, rule: item.messages[0].rule, testKind: item.testKind,
    commitHash: item.commitHash, gitHead: head.status === 0 ? head.stdout.trim() : null,
    sourceSha256: fileHash(target, Buffer.allocUnsafe(65536)), project, startedAt: new Date().toISOString() };
  const journal = setup.journal;
  const checkStop = () => { if (interrupted()) throw new Error("已收到中断请求"); };
  const call = async (...args) => { checkStop(); return invoke(state, journal, ...args); };
  writeJson(path.join(dir, "input.json"), report);
  writeJson(path.join(dir, "sample.json"), info);
  writeJson(journal, state);
  try {
    const doctor = await call("doctor");
    if (doctor.result.verdict !== "PASS" || doctor.result.stop !== false) throw new Error("预检未通过");
    const imported = await call("import", ["--file", path.join(dir, "input.json")]);
    const issues = imported.result.issues, issue = issues?.[0];
    if (issues?.length !== 1 || !issue.supported || !uuid.test(issue.issueId) || !samePath(issue.absolutePath, target) ||
        issue.rule !== info.rule || issue.sourceSha256 !== info.sourceSha256 || !imported.responseFile)
      throw new Error("导入回执与指定异味不符");
    const prepared = (await call("prepare", ["--from", imported.responseFile, "--issue", issue.issueId])).result;
    if (!uuid.test(prepared.taskHandle) || !samePath(prepared.originalRoot, project) || prepared.issue?.issueId !== issue.issueId)
      throw new Error("准备任务与选定样例不符");
    state.task = prepared.taskHandle;
    info.taskHandle = state.task;
    writeJson(journal, state);
    const execution = (await call("execute", ["--task", state.task])).result;
    const candidate = execution.candidate;
    info.candidateVerdict = assertVerdict(execution.result);
    info.reason = execution.result.failureReason || execution.result.reason;
    if (candidate?.taskHandle !== state.task || candidate.verdict !== info.candidateVerdict ||
        !uuid.test(candidate.candidateId) || !samePath(candidate.originalRoot, project)) throw new Error("候选与任务身份不一致");
    info.candidateId = candidate.candidateId;
    if (state.deferred) throw new Error("流水线要求延后清理，请确认相关进程结束后运行 --recover");
    await finish(state, journal);
    info.verdict = info.candidateVerdict;
    if (info.candidateVerdict === "PASS") {
      checkStop();
      state.applyIntent = info.candidateId;
      writeJson(journal, state);
      const flags = ["--candidate", info.candidateId];
      const applied = (await call("apply", [...flags, "--confirm", info.candidateId])).result;
      if (applied.transaction?.state !== "APPLIED" || applied.transaction.candidateId !== info.candidateId)
        throw new Error("未取得候选应用事务的成功回执");
      const validation = (await call("validate-applied", flags)).result;
      info.verdict = info.appliedVerdict = assertVerdict(validation.result);
      info.reason = validation.result.failureReason || validation.result.reason;
    }
  } catch (err) {
    info.verdict = "BLOCKED";
    info.reason = err.message;
    info.stopReason = err.message;
  } finally {
    try {
      await restore(state, journal);
      info.rollbackVerified = true;
    } catch (err) {
      info.rollbackVerified = false;
      info.recoveryError = err.message;
    }
    info.completedAt = new Date().toISOString();
    writeJson(path.join(dir, "result.json"), info);
    if (info.rollbackVerified) fs.unlinkSync(journal);
  }
  return info;
}

export async function runBatch(argv, testHost = {}) {
  const args = options(argv);
  const base = testHost.stateRoot ?? path.join(process.env.LOCALAPPDATA || process.env.XDG_STATE_HOME ||
    path.join(os.homedir(), ".local", "state"), "arkts-smell-refactor", "batch");
  const journal = path.join(base, "active-case.json");
  let cases, dataset, datasetDigest, workspacePath;
  if (!args["--recover"]) {
    if (!args["--dataset"]) throw new Error("请用 --dataset 指定 JSON 清单");
    dataset = fs.realpathSync(args["--dataset"]);
    const data = fs.readFileSync(dataset);
    datasetDigest = createHash("sha256").update(data).digest("hex");
    const manifest = JSON.parse(data.toString("utf8").replace(/^\uFEFF/, ""));
    cases = select(Array.isArray(manifest) ? manifest : manifest?.samples, args);
    if (args["--list"]) {
      for (const item of cases) console.log(`${item.ordinal}\t${item.testKind}\t${item.messages[0].rule}\t${item.filePath}`);
      return 0;
    }
    workspacePath = args["--workspace"];
    if (!workspacePath && typeof manifest.workspaceRoot === "string" && manifest.workspaceRoot.trim())
      workspacePath = path.resolve(path.dirname(dataset), manifest.workspaceRoot);
    if (!workspacePath) throw new Error("请在清单中填写 workspaceRoot，或用 --workspace 指定包含各 sourceProject 检出目录的父目录");
  }
  // A single loopback listener serializes independent runners, regardless of cwd or user.
  const endpoint = testHost.endpoint ?? { host: "127.0.0.1", port: 49731, exclusive: true };
  const unlock = await lockDevice(endpoint);
  let stopping = false;
  const stop = () => { stopping = true; console.warn("等待当前命令结束并回滚，随后停止批量实验。"); };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  try {
    if (args["--recover"]) { await recover(journal); return 0; }
    if (existsFile(journal)) throw new Error("上一条实验未完成。确认相关进程已停止后运行 --recover：" + journal);
    const workspace = fs.realpathSync(workspacePath);
    const selected = cases.map(item => locate(item, workspace));
    const entry = launcher(args["--skill-dir"]);
    const config = args["--config"] ? fs.realpathSync(args["--config"]) : undefined;
    const outputParent = path.resolve(args["--output"] || path.join(base, "results"));
    const canonical = name => fs.existsSync(name) ? fs.realpathSync(name) : path.join(canonical(path.dirname(name)), path.basename(name));
    const actualParent = canonical(outputParent);
    if (selected.some(({ project }) => inside(project, actualParent) || inside(project, canonical(base))))
      throw new Error("日志和运行证据目录必须位于被测 Harmony 工程外");
    fs.mkdirSync(base, { recursive: true });
    fs.mkdirSync(actualParent, { recursive: true });
    const output = fs.mkdtempSync(path.join(actualParent, "batch-"));
    console.log("批量实验目录：" + output);
    const pkg = path.resolve(path.dirname(entry), "../package-manifest.json");
    const bundle = existsFile(pkg) ? readJson(pkg) : {};
    const results = [];
    const summary = { dataset, datasetSha256: datasetDigest, workspace,
      first: cases[0].ordinal, last: cases.at(-1).ordinal, skillDirectory: path.dirname(path.dirname(entry)),
      skillVersion: bundle.version ?? null, skillSourceDigest: bundle.sourceDigest ?? null,
      completedRange: false, stopReason: null, results };
    writeJson(path.join(output, "summary.json"), summary);
    for (const sample of selected) {
      if (stopping) break;
      const result = await runCase(sample, { launcher: entry, output, config, journal }, () => stopping);
      results.push(result);
      summary.stopReason = result.recoveryError || result.stopReason || (stopping ? "操作中断" : null);
      summary.completedRange = !summary.stopReason && results.length === selected.length;
      writeJson(path.join(output, "summary.json"), summary);
      console.log(`[${result.ordinal}] ${result.verdict} rollbackVerified=${result.rollbackVerified} ${result.reason || ""}`);
      if (!result.rollbackVerified) throw new Error(result.recoveryError + "。恢复日志：" + journal);
      if (summary.stopReason) break;
    }
    return !stopping && results.length === selected.length && results.every(r => r.verdict === "PASS") ? 0 : 3;
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    await unlock();
  }
}

if (process.argv[1] && samePath(script, process.argv[1])) {
  try { process.exitCode = await runBatch(process.argv.slice(2)); }
  catch (err) { console.error(err.message); process.exitCode = 2; }
}
