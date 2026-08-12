import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const [period, checkpointDirArg, stationDataArg, monthOutputArg, manifestOutputArg, auditArg, extraStationArg] =
  process.argv.slice(2);
if (!period || !checkpointDirArg || !stationDataArg || !monthOutputArg || !manifestOutputArg || !auditArg) {
  throw new Error(
    "Usage: node merge-data.mjs <YYYY-MM> <usage-checkpoints> <station-data.js> <month-usage.json> <manifest.js> <audit.json> [extra-stations.json]",
  );
}

const PERIOD_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;
if (!PERIOD_PATTERN.test(period)) throw new Error(`Invalid period: ${period}`);

const checkpointDir = path.resolve(checkpointDirArg);
const stationDataPath = path.resolve(stationDataArg);
const monthOutputPath = path.resolve(monthOutputArg);
const manifestOutputPath = path.resolve(manifestOutputArg);
const auditPath = path.resolve(auditArg);

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

function datesInPeriod(value) {
  const [year, month] = value.split("-").map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const monthLengths = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return Array.from({ length: monthLengths[month - 1] }, (_, index) =>
    `${value}-${String(index + 1).padStart(2, "0")}`,
  );
}

function readWindowDataset(file) {
  if (!fs.existsSync(file)) return null;
  const context = { window: {} };
  vm.runInNewContext(fs.readFileSync(file, "utf8"), context, { filename: file });
  return context.window.SUBSIDY_HEATMAP_DATA ?? context.window.YOUBIKE_HEATMAP_DATA ?? null;
}

const stationSource = readWindowDataset(stationDataPath);
if (!stationSource?.stations?.length) throw new Error("Station master was not found in the supplied data.js");
const existingManifest = readWindowDataset(manifestOutputPath);

// Existing station order is authoritative. New stations are append-only so old monthly
// usage and flow files keep their station indexes after a later update.
const stations = (existingManifest?.stations ?? []).map((station) => station.slice(0, 6));
const knownIds = new Set(stations.map((station) => String(station[5] ?? "")).filter(Boolean));
const appendStations = (sourceStations) => {
  for (const station of sourceStations) {
    const id = String(station?.[5] ?? "");
    if (!id || knownIds.has(id)) continue;
    stations.push(station.slice(0, 6));
    knownIds.add(id);
  }
};
appendStations(stationSource.stations);
if (extraStationArg) appendStations(JSON.parse(fs.readFileSync(path.resolve(extraStationArg), "utf8")));
if (!stations.length) throw new Error("The merged station manifest is empty");

const byId = new Map();
const byCityName = new Map();
stations.forEach((station, index) => {
  if (station[5]) byId.set(String(station[5]), index);
  byCityName.set(`${station[1]}\u0000${station[0]}`, index);
});

const files = recursiveFiles(checkpointDir, (file) => file.endsWith(".json") && !file.endsWith(".audit.json"));
if (!files.length) throw new Error(`No usage checkpoints found under ${checkpointDir}`);
const checkpoints = files.map((file) => {
  const checkpoint = JSON.parse(fs.readFileSync(file, "utf8"));
  if (checkpoint.period !== period) {
    throw new Error(`Checkpoint period ${checkpoint.period ?? "<missing>"} does not match ${period}: ${file}`);
  }
  return { file, checkpoint };
});

const dates = datesInPeriod(period);
const dateSet = new Set(dates);
const valuesByDate = Object.fromEntries(dates.map((date) => [date, Array.from({ length: 24 }, () => [])]));
const holidayConfigPath = new URL("./holidays.json", import.meta.url);
let configuredHolidays = [];
if (fs.existsSync(holidayConfigPath)) {
  const holidayConfig = JSON.parse(fs.readFileSync(holidayConfigPath, "utf8"));
  configuredHolidays = Array.isArray(holidayConfig) ? holidayConfig : holidayConfig.dates;
  if (!Array.isArray(configuredHolidays)) throw new Error("holidays.json must be an array or contain a dates array");
}
const holidayDates = [...new Set(configuredHolidays.filter((date) => dateSet.has(date)))].sort();

const cells = new Map();
const unmatched = new Map();
const sourceAudit = [];
for (const { file, checkpoint } of checkpoints) {
  let rows = 0;
  for (const table of checkpoint.tables ?? []) rows += Number(table.rows) || 0;
  sourceAudit.push({
    checkpoint: path.relative(checkpointDir, file),
    file: path.basename(checkpoint.source),
    city: checkpoint.city,
    period: checkpoint.period,
    selectedTables: (checkpoint.tables ?? []).map((table) =>
      Object.fromEntries(Object.entries(table).filter(([key]) => key !== "explicitAmount" && key !== "amountFields")),
    ),
    excludedTables: checkpoint.excludedTables ?? [],
    claimRows: rows,
  });

  for (const group of checkpoint.groups ?? []) {
    if (!dateSet.has(group.date) || group.hour < 0 || group.hour > 23) continue;
    let stationIndex = byId.get(String(group.stationId));
    let matchMethod = "station-id";
    if (stationIndex === undefined) {
      stationIndex = byCityName.get(`${checkpoint.city}\u0000${group.stationName}`);
      matchMethod = "city-name";
    }
    if (stationIndex === undefined) {
      const key = `${checkpoint.city}|${group.stationId}|${group.stationName}`;
      const current = unmatched.get(key) ?? {
        city: checkpoint.city,
        stationId: group.stationId,
        stationName: group.stationName,
        count: 0,
      };
      current.count += Number(group.count) || 0;
      unmatched.set(key, current);
      continue;
    }
    const key = `${group.date}|${group.hour}|${stationIndex}`;
    const current = cells.get(key) ?? { date: group.date, hour: group.hour, stationIndex, count: 0, matchMethod };
    current.count += Number(group.count) || 0;
    cells.set(key, current);
  }
}

for (const cell of cells.values()) valuesByDate[cell.date][cell.hour].push([cell.stationIndex, 0, cell.count]);
for (const hours of Object.values(valuesByDate)) {
  for (const rows of hours) rows.sort((a, b) => a[0] - b[0]);
}

const monthDataset = {
  period,
  dates,
  metrics: [{ key: "count", label: "交易筆數", unit: "筆" }],
  valuesByDate,
  meta: {
    period,
    timezone: "Asia/Taipei",
    timeField: "借車時間",
    locationField: "借車站代號",
    missingPolicy: "omitted-station-date-hour-is-zero",
    aggregation: "arithmetic-mean-of-selected-dates",
    holidayDates,
    sourceScope: `${period} 請款報表中，借車時間落在該月份的交易`,
    completenessNote: "不包含該月借車但之後月份才入帳的交易。",
  },
};

const existingDescriptors = new Map();
for (const month of existingManifest?.months ?? []) {
  const value = typeof month === "string" ? { period: month } : month;
  if (PERIOD_PATTERN.test(value?.period ?? "")) existingDescriptors.set(value.period, value);
}
const monthsDirectory = path.dirname(path.dirname(monthOutputPath));
const diskMonths = fs.existsSync(monthsDirectory)
  ? fs.readdirSync(monthsDirectory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && PERIOD_PATTERN.test(entry.name))
    .filter((entry) => fs.existsSync(path.join(monthsDirectory, entry.name, "usage.json")))
    .map((entry) => entry.name)
  : [];
const manifestPeriods = [...new Set([...existingDescriptors.keys(), ...diskMonths, period])].sort();
const months = manifestPeriods.map((manifestPeriod) => {
  const existing = existingDescriptors.get(manifestPeriod);
  const diskUsagePath = path.join(monthsDirectory, manifestPeriod, "usage.json");
  let diskUsage = null;
  if (manifestPeriod !== period && fs.existsSync(diskUsagePath)) {
    diskUsage = JSON.parse(fs.readFileSync(diskUsagePath, "utf8"));
  }
  const descriptorDates = manifestPeriod === period
    ? dates
    : (diskUsage?.dates ?? existing?.dates ?? datesInPeriod(manifestPeriod));
  const descriptorHolidays = manifestPeriod === period
    ? holidayDates
    : (diskUsage?.meta?.holidayDates ?? existing?.holidayDates ??
      configuredHolidays.filter((date) => date.startsWith(`${manifestPeriod}-`)));
  return {
    period: manifestPeriod,
    dates: descriptorDates,
    usageUrl: `/months/${manifestPeriod}/usage.json`,
    flowBaseUrl: `/months/${manifestPeriod}/flows`,
    holidayDates: descriptorHolidays,
  };
});
const manifest = { stations, months };
const audit = {
  generatedAt: new Date().toISOString(),
  period,
  stationMaster: path.basename(stationDataPath),
  stationCount: stations.length,
  checkpointCount: files.length,
  matchedCellCount: cells.size,
  unmatchedStations: [...unmatched.values()].sort((a, b) => b.count - a.count),
  sources: sourceAudit,
};

fs.mkdirSync(path.dirname(monthOutputPath), { recursive: true });
fs.mkdirSync(path.dirname(manifestOutputPath), { recursive: true });
fs.mkdirSync(path.dirname(auditPath), { recursive: true });
fs.writeFileSync(monthOutputPath, `${JSON.stringify(monthDataset)}\n`, "utf8");
fs.writeFileSync(manifestOutputPath, `window.SUBSIDY_HEATMAP_DATA=${JSON.stringify(manifest)};\n`, "utf8");
fs.writeFileSync(auditPath, `${JSON.stringify(audit, null, 2)}\n`, "utf8");
console.log(`WROTE ${monthOutputPath} (${dates.length} dates, ${files.length} checkpoints, ${cells.size} cells)`);
console.log(`MANIFEST ${manifestOutputPath} (${stations.length} stations, ${months.length} months)`);
console.log(`AUDIT ${auditPath} (${audit.unmatchedStations.length} unmatched station keys)`);
