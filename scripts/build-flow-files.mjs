import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import vm from "node:vm";

const [period, checkpointArg, manifestArg, usageArg, outputArg, auditArg, stageArg] = process.argv.slice(2);
if (!period || !checkpointArg || !manifestArg || !usageArg || !outputArg || !auditArg || !stageArg) {
  throw new Error(
    "Usage: node build-flow-files.mjs <YYYY-MM> <month-od-dir> <manifest.js> <month-usage.json> <flow-dir> <audit.json> <stage-dir>",
  );
}
if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) throw new Error(`Invalid period: ${period}`);

const checkpointDir = path.resolve(checkpointArg);
const manifestPath = path.resolve(manifestArg);
const usagePath = path.resolve(usageArg);
const outputDir = path.resolve(outputArg);
const auditPath = path.resolve(auditArg);
const stageDir = path.resolve(stageArg);
const projectDir = path.dirname(path.dirname(manifestPath));
const expectedOutput = path.join(projectDir, "public", "months", period, "flows");
const expectedStage = path.join(projectDir, "work", "months", period, "flow-stage");
if (outputDir !== expectedOutput) throw new Error(`Refusing unexpected flow output target: ${outputDir}`);
if (stageDir !== expectedStage) throw new Error(`Refusing unexpected flow stage target: ${stageDir}`);

function recursiveFiles(root, predicate) {
  if (!fs.existsSync(root)) return [];
  const files = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) visit(fullPath);
      else if (entry.isFile() && predicate(fullPath)) files.push(fullPath);
    }
  };
  visit(root);
  return files.sort((a, b) => a.localeCompare(b));
}

const context = { window: {} };
vm.runInNewContext(fs.readFileSync(manifestPath, "utf8"), context, { filename: manifestPath });
const manifest = context.window.SUBSIDY_HEATMAP_DATA;
if (!manifest?.stations?.length) throw new Error("SUBSIDY_HEATMAP_DATA stations are missing");
if (!(manifest.months ?? []).some((month) => (typeof month === "string" ? month : month?.period) === period)) {
  throw new Error(`Manifest does not contain period ${period}`);
}
const usage = JSON.parse(fs.readFileSync(usagePath, "utf8"));
if (usage.period !== period || !Array.isArray(usage.dates) || !usage.valuesByDate) {
  throw new Error(`Invalid monthly usage dataset for ${period}: ${usagePath}`);
}

const stations = manifest.stations;
const stationById = new Map(stations.map((station, index) => [String(station[5]), index]));
const dates = usage.dates;
const dateIndexByDate = new Map(dates.map((date, index) => [date, index]));

fs.rmSync(stageDir, { recursive: true, force: true });
fs.rmSync(outputDir, { recursive: true, force: true });
fs.mkdirSync(stageDir, { recursive: true });
fs.mkdirSync(outputDir, { recursive: true });

const buffers = new Map();
let bufferedCharacters = 0;
const FLUSH_AT = 64 * 1024 * 1024;
let groupedRows = 0;
let inputClaims = 0;
let matchedClaims = 0;
let unmatchedClaims = 0;
let outsidePeriodClaims = 0;
let selfTripClaims = 0;
const unmatchedEndpoints = new Map();

function stagePath(direction, stationIndex) {
  return path.join(stageDir, `${stationIndex}.${direction}.tsv`);
}
function addBuffer(direction, stationIndex, line) {
  const key = `${direction}|${stationIndex}`;
  buffers.set(key, (buffers.get(key) ?? "") + line);
  bufferedCharacters += line.length;
}
function flushBuffers() {
  for (const [key, value] of buffers) {
    const [direction, stationIndex] = key.split("|");
    fs.appendFileSync(stagePath(direction, stationIndex), value, "utf8");
  }
  buffers.clear();
  bufferedCharacters = 0;
}

const tsvFiles = recursiveFiles(checkpointDir, (file) => file.endsWith(".tsv"));
if (!tsvFiles.length) throw new Error(`No OD checkpoints found under ${checkpointDir}`);
for (let fileIndex = 0; fileIndex < tsvFiles.length; fileIndex++) {
  const file = tsvFiles[fileIndex];
  const stream = fs.createReadStream(file, { encoding: "utf8" });
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line) continue;
    const [date, hourText, originId, destinationId, countText] = line.split("\t");
    const count = Number(countText) || 0;
    groupedRows++;
    inputClaims += count;
    const dateIndex = dateIndexByDate.get(date);
    if (dateIndex === undefined) {
      outsidePeriodClaims += count;
      continue;
    }
    const originIndex = stationById.get(originId);
    const destinationIndex = stationById.get(destinationId);
    if (originIndex === undefined || destinationIndex === undefined) {
      unmatchedClaims += count;
      for (const [kind, id] of [["origin", originId], ["destination", destinationId]]) {
        if (stationById.has(id)) continue;
        const key = `${kind}|${id}`;
        unmatchedEndpoints.set(key, (unmatchedEndpoints.get(key) ?? 0) + count);
      }
      continue;
    }
    matchedClaims += count;
    if (originIndex === destinationIndex) selfTripClaims += count;
    const hour = Number(hourText);
    if (!Number.isInteger(hour) || hour < 0 || hour > 23) continue;
    addBuffer("out", originIndex, `${dateIndex}\t${hour}\t${destinationIndex}\t${count}\n`);
    addBuffer("in", destinationIndex, `${dateIndex}\t${hour}\t${originIndex}\t${count}\n`);
    if (bufferedCharacters >= FLUSH_AT) flushBuffers();
  }
  console.log(`STAGED ${fileIndex + 1}/${tsvFiles.length} ${path.relative(checkpointDir, file)}`);
}
if (buffers.size) flushBuffers();

function readDirection(direction, stationIndex) {
  const file = stagePath(direction, stationIndex);
  if (!fs.existsSync(file)) return {};
  const totals = new Map();
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    if (!line) continue;
    const [dateIndex, hour, other, count] = line.split("\t").map(Number);
    const key = `${dateIndex}|${hour}|${other}`;
    totals.set(key, (totals.get(key) ?? 0) + count);
  }
  const byDate = {};
  for (const [key, count] of totals) {
    const [dateIndex, hour, other] = key.split("|").map(Number);
    const date = dates[dateIndex];
    byDate[date] ??= Array.from({ length: 24 }, () => []);
    byDate[date][hour].push([other, count]);
  }
  for (const hours of Object.values(byDate)) {
    for (const rows of hours) rows.sort((a, b) => b[1] - a[1] || a[0] - b[0]);
  }
  return byDate;
}

let generatedStationFiles = 0;
let relationCells = 0;
for (let stationIndex = 0; stationIndex < stations.length; stationIndex++) {
  const outByDate = readDirection("out", stationIndex);
  const inByDate = readDirection("in", stationIndex);
  if (!Object.keys(outByDate).length && !Object.keys(inByDate).length) continue;
  for (const direction of [outByDate, inByDate]) {
    for (const hours of Object.values(direction)) {
      for (const rows of hours) relationCells += rows.length;
    }
  }
  const stationId = String(stations[stationIndex][5]);
  fs.writeFileSync(
    path.join(outputDir, `${stationId}.json`),
    JSON.stringify({ period, stationId, stationIndex, outByDate, inByDate }),
    "utf8",
  );
  generatedStationFiles++;
  if (generatedStationFiles % 250 === 0) console.log(`BUILT ${generatedStationFiles} station flow files`);
}

const auditFiles = recursiveFiles(checkpointDir, (file) => file.endsWith(".audit.json"));
const sourceAudits = auditFiles.map((file) => JSON.parse(fs.readFileSync(file, "utf8")));
for (const sourceAudit of sourceAudits) {
  if (sourceAudit.period !== period) throw new Error(`OD audit period mismatch: ${sourceAudit.source ?? "unknown source"}`);
}
const audit = {
  generatedAt: new Date().toISOString(),
  period,
  checkpointCount: tsvFiles.length,
  groupedRows,
  inputClaims,
  matchedClaims,
  unmatchedClaims,
  outsidePeriodClaims,
  selfTripClaims,
  generatedStationFiles,
  relationCells,
  unmatchedEndpoints: [...unmatchedEndpoints.entries()]
    .map(([key, count]) => {
      const [kind, stationId] = key.split("|");
      return { kind, stationId, count };
    })
    .sort((a, b) => b.count - a.count),
  sources: sourceAudits,
};
fs.mkdirSync(path.dirname(auditPath), { recursive: true });
fs.writeFileSync(auditPath, `${JSON.stringify(audit, null, 2)}\n`, "utf8");
console.log(`WROTE ${generatedStationFiles} flow files for ${period} with ${relationCells} directional relation cells`);
console.log(`AUDIT ${auditPath}: matched ${matchedClaims}/${inputClaims} claims`);
