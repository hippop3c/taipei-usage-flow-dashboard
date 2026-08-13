"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type CityId = "taipei" | "newtaipei";
type DayType = "weekday" | "holiday";
type StationTuple = [
  name: string,
  city: string,
  district: string,
  lat: number,
  lng: number,
  id?: string,
];
type UsageRow = [stationIndex: number, countOrLegacyAmount?: number, count?: number];
type HourRows = UsageRow[];
type DateHours = HourRows[] | Record<string, HourRows>;

interface DataMeta {
  holidayDates?: string[];
  holidayDatesByPeriod?: Record<string, string[]>;
  [key: string]: unknown;
}

interface MonthDescriptor {
  period: string;
  dates: string[];
  usageUrl: string;
  flowBaseUrl: string;
  holidayDates?: string[];
}

interface SubsidyManifest {
  stations: StationTuple[];
  months: MonthDescriptor[];
  meta?: DataMeta;
}

interface MonthUsageData {
  period: string;
  dates: string[];
  valuesByDate: Record<string, DateHours>;
  meta?: DataMeta;
}

interface ActiveData extends MonthUsageData {
  stations: StationTuple[];
}

type FlowDirection = "out" | "in";
type FlowRow = [otherStationIndex: number, count: number];
type FlowHourRows = FlowRow[];
type FlowDateHours = FlowHourRows[] | Record<string, FlowHourRows>;

interface StationFlowData {
  stationId: string;
  stationIndex: number;
  outByDate: Record<string, FlowDateHours>;
  inByDate: Record<string, FlowDateHours>;
}

interface FlowRelation {
  average: number;
  direction: FlowDirection;
  otherStationIndex: number;
}

type LeafletLayerContainer = object;

interface LeafletMap extends LeafletLayerContainer {
  closePopup(): void;
  flyTo(latlng: [number, number], zoom: number, options?: Record<string, unknown>): void;
  invalidateSize(): void;
  remove(): void;
  setView(latlng: [number, number], zoom: number): LeafletMap;
}

interface LeafletLayer {
  addTo(container: LeafletLayerContainer): LeafletLayer;
}

interface LeafletLayerGroup extends LeafletLayerContainer {
  addTo(container: LeafletLayerContainer): LeafletLayerGroup;
  clearLayers(): void;
}

interface LeafletHeatLayer {
  addTo(container: LeafletLayerContainer): LeafletHeatLayer;
  setLatLngs(points: Array<[number, number, number]>): void;
}

interface LeafletMarker extends LeafletLayer {
  addTo(container: LeafletLayerContainer): LeafletMarker;
  bindPopup(content: string, options?: Record<string, unknown>): LeafletMarker;
  on(type: string, handler: () => void): LeafletMarker;
  openPopup(): void;
}

interface LeafletPolyline extends LeafletLayer {
  addTo(container: LeafletLayerContainer): LeafletPolyline;
}

interface LeafletNamespace {
  circleMarker(
    latlng: [number, number],
    options?: Record<string, unknown>,
  ): LeafletMarker;
  control: {
    zoom(options?: Record<string, unknown>): LeafletLayer;
  };
  heatLayer(
    points: Array<[number, number, number]>,
    options?: Record<string, unknown>,
  ): LeafletHeatLayer;
  layerGroup(): LeafletLayerGroup;
  map(element: HTMLElement, options?: Record<string, unknown>): LeafletMap;
  polyline(
    latlngs: Array<[number, number]>,
    options?: Record<string, unknown>,
  ): LeafletPolyline;
  tileLayer(url: string, options?: Record<string, unknown>): LeafletLayer;
}

declare global {
  interface Window {
    L?: LeafletNamespace;
    SUBSIDY_HEATMAP_DATA?: unknown;
  }
}

interface DistrictOption {
  id: string;
  cityId: CityId;
  cityLabel: string;
  district: string;
}

interface StationView {
  index: number;
  station: StationTuple;
  value: number;
}

const CITY_OPTIONS: Array<{ id: CityId; label: string; short: string }> = [
  { id: "taipei", label: "台北市", short: "北市" },
  { id: "newtaipei", label: "新北市", short: "新北" },
];

const NUMBER_FORMAT = new Intl.NumberFormat("zh-TW", {
  maximumFractionDigits: 1,
});

function cityIdFor(city: string): CityId | null {
  if (city.includes("新北")) return "newtaipei";
  if (city.includes("台北") || city.includes("臺北")) return "taipei";
  return null;
}

function districtId(cityId: CityId, district: string) {
  return `${cityId}::${district}`;
}

function buildDistrictOptions(stations: StationTuple[]): DistrictOption[] {
  const seen = new Set<string>();
  const options: DistrictOption[] = [];

  for (const station of stations) {
    const cityId = cityIdFor(String(station[1] ?? ""));
    const district = String(station[2] ?? "").trim();
    if (!cityId || !district) continue;
    const id = districtId(cityId, district);
    if (seen.has(id)) continue;
    seen.add(id);
    options.push({
      id,
      cityId,
      cityLabel: CITY_OPTIONS.find((city) => city.id === cityId)?.short ?? "",
      district,
    });
  }

  return options.sort((a, b) => {
    if (a.cityId !== b.cityId) return a.cityId === "taipei" ? -1 : 1;
    return a.district.localeCompare(b.district, "zh-Hant");
  });
}

function isMonthDescriptor(value: unknown): value is MonthDescriptor {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<MonthDescriptor>;
  return (
    typeof candidate.period === "string" &&
    /^\d{4}-\d{2}$/.test(candidate.period) &&
    Array.isArray(candidate.dates) &&
    typeof candidate.usageUrl === "string" &&
    candidate.usageUrl.length > 0 &&
    typeof candidate.flowBaseUrl === "string" &&
    candidate.flowBaseUrl.length > 0 &&
    (candidate.holidayDates === undefined || Array.isArray(candidate.holidayDates))
  );
}

function isSubsidyManifest(value: unknown): value is SubsidyManifest {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<SubsidyManifest>;
  return (
    Array.isArray(candidate.stations) &&
    candidate.stations.length > 0 &&
    Array.isArray(candidate.months) &&
    candidate.months.length > 0 &&
    candidate.months.every(isMonthDescriptor)
  );
}

function isMonthUsageData(value: unknown): value is MonthUsageData {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<MonthUsageData>;
  return (
    typeof candidate.period === "string" &&
    Array.isArray(candidate.dates) &&
    Boolean(candidate.valuesByDate) &&
    typeof candidate.valuesByDate === "object"
  );
}

function isStationFlowData(value: unknown): value is StationFlowData {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<StationFlowData>;
  return (
    typeof candidate.stationId === "string" &&
    Number.isInteger(candidate.stationIndex) &&
    Boolean(candidate.outByDate) &&
    typeof candidate.outByDate === "object" &&
    Boolean(candidate.inByDate) &&
    typeof candidate.inByDate === "object"
  );
}

function flowRowsAtHour(
  valuesByDate: Record<string, FlowDateHours>,
  date: string,
  hour: number,
): FlowHourRows {
  const dateHours = valuesByDate[date];
  if (!dateHours) return [];
  const rows = Array.isArray(dateHours)
    ? dateHours[hour]
    : dateHours[String(hour)];
  return Array.isArray(rows) ? rows : [];
}

function loadScript(src: string, id: string) {
  return new Promise<void>((resolve, reject) => {
    const existing = document.getElementById(id) as HTMLScriptElement | null;
    const script = existing ?? document.createElement("script");

    if (existing?.dataset.loaded === "true") {
      resolve();
      return;
    }

    const handleLoad = () => {
      script.dataset.loaded = "true";
      cleanup();
      resolve();
    };
    const handleError = () => {
      cleanup();
      reject(new Error(`Unable to load ${src}`));
    };
    const cleanup = () => {
      script.removeEventListener("load", handleLoad);
      script.removeEventListener("error", handleError);
    };

    script.addEventListener("load", handleLoad);
    script.addEventListener("error", handleError);

    if (!existing) {
      script.id = id;
      script.src = src;
      script.async = true;
      document.head.appendChild(script);
    }
  });
}

function dateParts(date: string) {
  const iso = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/.exec(date);
  if (iso) {
    return { year: Number(iso[1]), month: Number(iso[2]), day: Number(iso[3]) };
  }
  const short = /^(\d{1,2})[/-](\d{1,2})$/.exec(date);
  if (short) {
    return { year: 2026, month: Number(short[1]), day: Number(short[2]) };
  }
  return null;
}

function monthLabel(month: string) {
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  return match ? `${match[1]} 年 ${Number(match[2])} 月` : month;
}

function weekdayIndex(date: string) {
  const parts = dateParts(date);
  if (!parts) return 1;
  return new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay();
}

function dayTypeFor(date: string, holidayDates: ReadonlySet<string>): DayType {
  if (holidayDates.has(date)) return "holiday";
  const day = weekdayIndex(date);
  return day === 0 || day === 6 ? "holiday" : "weekday";
}

function appendJsonPath(baseUrl: string, stationId: string) {
  return `${baseUrl.replace(/\/+$/, "")}/${encodeURIComponent(stationId)}.json`;
}

function shortDate(date: string) {
  const parts = dateParts(date);
  return parts ? `${parts.month}/${parts.day}` : date;
}

function weekdayLabel(date: string) {
  return ["日", "一", "二", "三", "四", "五", "六"][weekdayIndex(date)];
}

function hourLabel(hour: number) {
  return `${String(hour).padStart(2, "0")}:00–${String(hour).padStart(2, "0")}:59`;
}

function escapeHtml(value: string) {
  return value.replace(/[&<>'"]/g, (character) => {
    const entities: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      "'": "&#39;",
      '"': "&quot;",
    };
    return entities[character];
  });
}

function percentile95(values: number[]) {
  const positive = values.filter((value) => value > 0).sort((a, b) => a - b);
  if (positive.length === 0) return 0;
  return positive[Math.min(positive.length - 1, Math.floor(positive.length * 0.95))];
}

function markerColor(value: number, scaleMax: number) {
  if (value <= 0 || scaleMax <= 0) return "#7f96a2";
  const ratio = Math.min(1, value / scaleMax);
  if (ratio < 0.28) return "#1b9c95";
  if (ratio < 0.58) return "#e9aa35";
  return "#df5347";
}

function normalizedSearch(value: string) {
  return value.toLocaleLowerCase("zh-TW").replace(/[\s()（）台臺]/g, "");
}

function popupMarkup(
  record: StationView,
  effectiveDateCount: number,
  hour: number,
) {
  const [name, city, district, , , id] = record.station;
  const value = `${NUMBER_FORMAT.format(record.value)} 次`;
  const dateText = effectiveDateCount > 0 ? `${effectiveDateCount} 日等權平均` : "目前沒有生效日期";
  return `
    <div class="station-popup">
      <strong>${escapeHtml(String(name))}</strong>
      <div class="station-popup__meta">${escapeHtml(String(city))} · ${escapeHtml(String(district))}${id ? ` · ${escapeHtml(String(id))}` : ""}</div>
      <div class="station-popup__value"><span>使用次數</span><b>${escapeHtml(value)}</b></div>
      <div class="station-popup__note">${hourLabel(hour)} · ${dateText} · 點擊查看起訖關係</div>
    </div>`;
}

export default function Home() {
  const [manifest, setManifest] = useState<SubsidyManifest | null>(null);
  const [monthUsage, setMonthUsage] = useState<MonthUsageData | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [usageLoading, setUsageLoading] = useState(false);
  const [usageError, setUsageError] = useState<string | null>(null);
  const [leafletReady, setLeafletReady] = useState(false);
  const [mapReady, setMapReady] = useState(false);
  const [selectedCities, setSelectedCities] = useState<CityId[]>([
    "taipei",
    "newtaipei",
  ]);
  const [selectedDayTypes, setSelectedDayTypes] = useState<DayType[]>([
    "weekday",
    "holiday",
  ]);
  const [selectedDates, setSelectedDates] = useState<string[]>([]);
  const [selectedMonth, setSelectedMonth] = useState("");
  const [selectedDistricts, setSelectedDistricts] = useState<string[]>([]);
  const [hour, setHour] = useState(8);
  const [playing, setPlaying] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [selectedStationIndex, setSelectedStationIndex] = useState<number | null>(null);
  const [flowData, setFlowData] = useState<StationFlowData | null>(null);
  const [flowLoading, setFlowLoading] = useState(false);
  const [flowMessage, setFlowMessage] = useState<string | null>(null);
  const [showOutgoing, setShowOutgoing] = useState(true);
  const [showIncoming, setShowIncoming] = useState(true);

  const mapElementRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<LeafletMap | null>(null);
  const heatLayerRef = useRef<LeafletHeatLayer | null>(null);
  const flowLayerRef = useRef<LeafletLayerGroup | null>(null);
  const stationLayerRef = useRef<LeafletLayerGroup | null>(null);
  const searchLayerRef = useRef<LeafletLayerGroup | null>(null);
  const flowRequestRef = useRef<AbortController | null>(null);
  const usageRequestRef = useRef<AbortController | null>(null);

  const months = useMemo(
    () => [...(manifest?.months ?? [])].sort((a, b) => a.period.localeCompare(b.period)),
    [manifest],
  );
  const selectedMonthDescriptor = useMemo(
    () => months.find((month) => month.period === selectedMonth) ?? null,
    [months, selectedMonth],
  );
  const data = useMemo<ActiveData | null>(
    () =>
      manifest && monthUsage?.period === selectedMonth
        ? { ...monthUsage, stations: manifest.stations }
        : null,
    [manifest, monthUsage, selectedMonth],
  );

  const resetStationSelection = useCallback(() => {
    flowRequestRef.current?.abort();
    flowRequestRef.current = null;
    setSelectedStationIndex(null);
    setFlowLoading(false);
    setFlowData(null);
    setFlowMessage(null);
    searchLayerRef.current?.clearLayers();
    flowLayerRef.current?.clearLayers();
    mapRef.current?.closePopup();
  }, []);

  const loadMonthUsage = useCallback(
    (descriptor: MonthDescriptor) => {
      usageRequestRef.current?.abort();
      resetStationSelection();

      const controller = new AbortController();
      usageRequestRef.current = controller;
      setSelectedMonth(descriptor.period);
      setMonthUsage(null);
      setSelectedDates([]);
      setUsageError(null);
      setUsageLoading(true);

      const load = async () => {
        try {
          const response = await fetch(descriptor.usageUrl, {
            signal: controller.signal,
          });
          if (!response.ok) {
            if (response.status === 404) throw new Error("missing");
            throw new Error("request");
          }

          const candidate: unknown = await response.json();
          if (!isMonthUsageData(candidate) || candidate.period !== descriptor.period) {
            throw new Error("invalid");
          }
          if (controller.signal.aborted || usageRequestRef.current !== controller) return;

          setMonthUsage(candidate);
          setSelectedDates([...candidate.dates]);
        } catch (error) {
          if (controller.signal.aborted || usageRequestRef.current !== controller) return;
          const code = error instanceof Error ? error.message : "request";
          setUsageError(
            code === "missing"
              ? `${monthLabel(descriptor.period)}的使用資料尚未產生。`
              : code === "invalid"
                ? `${monthLabel(descriptor.period)}的使用資料格式不完整。`
                : `${monthLabel(descriptor.period)}的使用資料暫時無法載入，請稍後再試。`,
          );
        } finally {
          if (!controller.signal.aborted && usageRequestRef.current === controller) {
            setUsageLoading(false);
          }
        }
      };

      void load();
    },
    [resetStationSelection],
  );

  const selectStation = useCallback((record: StationView) => {
    const stationId = String(record.station[5] ?? "").trim();
    flowRequestRef.current?.abort();
    setSelectedStationIndex(record.index);
    setFlowData(null);
    setFlowMessage(null);

    if (!stationId) {
      setFlowLoading(false);
      setFlowMessage("這個場站沒有可用的站點代碼，因此無法載入起訖關係。");
      return;
    }

    if (!selectedMonthDescriptor) {
      setFlowLoading(false);
      setFlowMessage("目前月份尚未就緒，無法載入起訖關係。");
      return;
    }

    const controller = new AbortController();
    flowRequestRef.current = controller;
    setFlowLoading(true);

    const loadFlows = async () => {
      try {
        const response = await fetch(
          appendJsonPath(selectedMonthDescriptor.flowBaseUrl, stationId),
          { signal: controller.signal },
        );
        if (!response.ok) {
          if (response.status === 404) throw new Error("missing");
          throw new Error("request");
        }
        const candidate: unknown = await response.json();
        if (
          !isStationFlowData(candidate) ||
          candidate.stationId !== stationId ||
          candidate.stationIndex !== record.index
        ) {
          throw new Error("invalid");
        }
        if (
          controller.signal.aborted ||
          flowRequestRef.current !== controller ||
          selectedMonthDescriptor.period !== selectedMonth
        ) return;
        setFlowData(candidate);
      } catch (error) {
        if (controller.signal.aborted || flowRequestRef.current !== controller) return;
        const code = error instanceof Error ? error.message : "request";
        setFlowMessage(
          code === "missing"
            ? "這個場站目前沒有起訖關係資料，熱力圖仍可正常使用。"
            : code === "invalid"
              ? "這個場站的起訖資料格式不完整，請稍後再試。"
              : "起訖關係暫時無法載入，請稍後再試。",
        );
      } finally {
        if (!controller.signal.aborted && flowRequestRef.current === controller) {
          setFlowLoading(false);
        }
      }
    };

    void loadFlows();
  }, [selectedMonth, selectedMonthDescriptor]);

  useEffect(() => {
    let cancelled = false;

    const prepare = async () => {
      try {
        if (!window.SUBSIDY_HEATMAP_DATA) {
          await loadScript("subsidy-data.js", "subsidy-heatmap-data");
        }
      } catch {
        if (!cancelled) {
          setLoadError("尚未找到使用次數資料檔，請確認資料檔已放入網站的 public 資料夾。");
        }
        return;
      }

      const candidate = window.SUBSIDY_HEATMAP_DATA;
      if (!isSubsidyManifest(candidate)) {
        if (!cancelled) {
          setLoadError("月份資料目錄格式不完整，請重新產生資料檔後再載入。");
        }
        return;
      }

      if (!cancelled) {
        const districts = buildDistrictOptions(candidate.stations);
        const availableMonths = [...candidate.months].sort((a, b) =>
          a.period.localeCompare(b.period),
        );
        const initialMonth = availableMonths[availableMonths.length - 1];
        setSelectedDistricts(districts.map((district) => district.id));
        setManifest(candidate);
        if (initialMonth) loadMonthUsage(initialMonth);
      }

      try {
        if (!window.L) {
          await loadScript(
            "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js",
            "leaflet-script",
          );
        }
        if (!window.L?.heatLayer) {
          await loadScript(
            "https://unpkg.com/leaflet.heat@0.2.0/dist/leaflet-heat.js",
            "leaflet-heat-script",
          );
        }
        if (!cancelled) setLeafletReady(Boolean(window.L?.heatLayer));
      } catch {
        if (!cancelled) {
          setLoadError("地圖元件暫時無法載入，請檢查網路連線後重新整理。");
        }
      }
    };

    void prepare();
    return () => {
      cancelled = true;
    };
  }, [loadMonthUsage]);

  useEffect(
    () => () => {
      flowRequestRef.current?.abort();
      usageRequestRef.current?.abort();
    },
    [],
  );

  useEffect(() => {
    if (!playing) return;
    const timer = window.setInterval(() => {
      setHour((current) => (current + 1) % 24);
    }, 950);
    return () => window.clearInterval(timer);
  }, [playing]);

  const allDistricts = useMemo(
    () => (manifest ? buildDistrictOptions(manifest.stations) : []),
    [manifest],
  );
  const currentMonthDates = useMemo(
    () => (monthUsage?.period === selectedMonth ? monthUsage.dates : []),
    [monthUsage, selectedMonth],
  );
  const holidayDates = useMemo(() => {
    const manifestDates = Array.isArray(manifest?.meta?.holidayDates)
      ? manifest.meta.holidayDates
      : [];
    const periodDates = manifest?.meta?.holidayDatesByPeriod?.[selectedMonth];
    const usageDates = Array.isArray(monthUsage?.meta?.holidayDates)
      ? monthUsage.meta.holidayDates
      : [];
    return new Set([
      ...(selectedMonthDescriptor?.holidayDates ?? []),
      ...manifestDates,
      ...(Array.isArray(periodDates) ? periodDates : []),
      ...usageDates,
    ]);
  }, [manifest, monthUsage, selectedMonth, selectedMonthDescriptor]);
  const visibleDistricts = useMemo(
    () => allDistricts.filter((district) => selectedCities.includes(district.cityId)),
    [allDistricts, selectedCities],
  );

  const effectiveDates = useMemo(() => {
    if (!data) return [];
    const selectedDateSet = new Set(selectedDates);
    const selectedDayTypeSet = new Set(selectedDayTypes);
    return currentMonthDates.filter(
      (date) =>
        selectedDateSet.has(date) &&
        selectedDayTypeSet.has(dayTypeFor(date, holidayDates)),
    );
  }, [currentMonthDates, data, holidayDates, selectedDates, selectedDayTypes]);

  const stationAverages = useMemo(() => {
    const totals = new Float64Array(data?.stations.length ?? 0);
    if (!data || effectiveDates.length === 0) return totals;

    for (const date of effectiveDates) {
      const dateHours = data.valuesByDate[date];
      if (!dateHours) continue;
      const rows = Array.isArray(dateHours)
        ? dateHours[hour]
        : dateHours[String(hour)];
      if (!Array.isArray(rows)) continue;

      for (const row of rows) {
        if (!Array.isArray(row)) continue;
        const stationIndex = Number(row[0]);
        const value = Number(row.length >= 3 ? row[2] : row[1]);
        if (
          Number.isInteger(stationIndex) &&
          stationIndex >= 0 &&
          stationIndex < totals.length &&
          Number.isFinite(value)
        ) {
          totals[stationIndex] += value;
        }
      }
    }

    for (let index = 0; index < totals.length; index += 1) {
      totals[index] /= effectiveDates.length;
    }
    return totals;
  }, [data, effectiveDates, hour]);

  const visibleStations = useMemo<StationView[]>(() => {
    if (!data) return [];
    const citySet = new Set(selectedCities);
    const districtSet = new Set(selectedDistricts);
    return data.stations.flatMap((station, index) => {
      const cityId = cityIdFor(String(station[1] ?? ""));
      const district = String(station[2] ?? "");
      if (!cityId || !citySet.has(cityId) || !districtSet.has(districtId(cityId, district))) {
        return [];
      }
      return [{ index, station, value: stationAverages[index] ?? 0 }];
    });
  }, [data, selectedCities, selectedDistricts, stationAverages]);

  const summary = useMemo(() => {
    const values = visibleStations.map((station) => station.value);
    const total = values.reduce((sum, value) => sum + value, 0);
    const activeCount = values.filter((value) => value > 0).length;
    const scaleMax = percentile95(values);
    const topStation = visibleStations.reduce<StationView | null>(
      (top, station) => (!top || station.value > top.value ? station : top),
      null,
    );
    return {
      activeCount,
      scaleMax,
      stationAverage: visibleStations.length ? total / visibleStations.length : 0,
      topStation,
      total,
    };
  }, [visibleStations]);

  const selectedStation = useMemo(
    () =>
      selectedStationIndex === null
        ? null
        : visibleStations.find((record) => record.index === selectedStationIndex)?.station ?? null,
    [selectedStationIndex, visibleStations],
  );

  const flowSummary = useMemo(() => {
    const outgoing = new Map<number, number>();
    const incoming = new Map<number, number>();
    const visibleStationIndices = new Set(visibleStations.map((record) => record.index));
    if (!data || !flowData || effectiveDates.length === 0 || selectedStationIndex === null) {
      return {
        incomingTotal: 0,
        outgoingTotal: 0,
        relations: [] as FlowRelation[],
      };
    }

    const accumulate = (
      target: Map<number, number>,
      valuesByDate: Record<string, FlowDateHours>,
    ) => {
      for (const date of effectiveDates) {
        for (const row of flowRowsAtHour(valuesByDate, date, hour)) {
          if (!Array.isArray(row)) continue;
          const otherStationIndex = Number(row[0]);
          const count = Number(row[1]);
          if (
            Number.isInteger(otherStationIndex) &&
            otherStationIndex >= 0 &&
            otherStationIndex < data.stations.length &&
            Number.isFinite(count) &&
            count > 0
          ) {
            target.set(otherStationIndex, (target.get(otherStationIndex) ?? 0) + count);
          }
        }
      }
    };

    accumulate(outgoing, flowData.outByDate);
    accumulate(incoming, flowData.inByDate);

    const divisor = effectiveDates.length;
    const isVisibleRelationEndpoint = (otherStationIndex: number) =>
      otherStationIndex !== selectedStationIndex &&
      visibleStationIndices.has(otherStationIndex);
    const totalFor = (values: Map<number, number>) =>
      [...values.entries()]
        .filter(([otherStationIndex]) => isVisibleRelationEndpoint(otherStationIndex))
        .reduce((sum, [, count]) => sum + count, 0) / divisor;
    const relationsFor = (
      direction: FlowDirection,
      values: Map<number, number>,
    ): FlowRelation[] =>
      [...values.entries()]
        .filter(([otherStationIndex]) => isVisibleRelationEndpoint(otherStationIndex))
        .map(([otherStationIndex, count]) => ({
          average: count / divisor,
          direction,
          otherStationIndex,
        }))
        .filter((relation) => relation.average > 0)
        .sort((a, b) => b.average - a.average)
        .slice(0, 60);

    return {
      incomingTotal: totalFor(incoming),
      outgoingTotal: totalFor(outgoing),
      relations: [
        ...(showOutgoing ? relationsFor("out", outgoing) : []),
        ...(showIncoming ? relationsFor("in", incoming) : []),
      ],
    };
  }, [
    data,
    effectiveDates,
    flowData,
    hour,
    selectedStationIndex,
    showIncoming,
    showOutgoing,
    visibleStations,
  ]);

  useEffect(() => {
    if (!leafletReady || !manifest || !mapElementRef.current || !window.L) return;
    const L = window.L;
    const map = L.map(mapElementRef.current, {
      attributionControl: true,
      preferCanvas: true,
      zoomControl: false,
    }).setView([25.055, 121.545], 11);

    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      maxZoom: 19,
    }).addTo(map);
    L.control.zoom({ position: "topright" }).addTo(map);

    const heatLayer = L.heatLayer([], {
      blur: 23,
      gradient: {
        0.12: "#b7e8e4",
        0.34: "#23a69c",
        0.62: "#f2bd51",
        0.82: "#ee7a47",
        1: "#d8393f",
      },
      maxZoom: 15,
      minOpacity: 0.34,
      radius: 27,
    }).addTo(map);

    const flowLayer = L.layerGroup().addTo(map);
    const stationLayer = L.layerGroup().addTo(map);
    const searchLayer = L.layerGroup().addTo(map);
    mapRef.current = map;
    heatLayerRef.current = heatLayer;
    flowLayerRef.current = flowLayer;
    stationLayerRef.current = stationLayer;
    searchLayerRef.current = searchLayer;
    setMapReady(true);

    const resize = () => map.invalidateSize();
    window.addEventListener("resize", resize);
    window.setTimeout(resize, 0);

    return () => {
      window.removeEventListener("resize", resize);
      setMapReady(false);
      map.remove();
      mapRef.current = null;
      heatLayerRef.current = null;
      flowLayerRef.current = null;
      stationLayerRef.current = null;
      searchLayerRef.current = null;
    };
  }, [leafletReady, manifest]);

  useEffect(() => {
    const L = window.L;
    const heatLayer = heatLayerRef.current;
    const stationLayer = stationLayerRef.current;
    if (!mapReady || !L || !heatLayer || !stationLayer) return;

    const points: Array<[number, number, number]> = [];
    stationLayer.clearLayers();
    searchLayerRef.current?.clearLayers();

    for (const record of visibleStations) {
      const lat = Number(record.station[3]);
      const lng = Number(record.station[4]);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;

      const strength = summary.scaleMax
        ? Math.sqrt(Math.min(1, record.value / summary.scaleMax))
        : 0;
      if (record.value > 0) points.push([lat, lng, strength]);

      const color = markerColor(record.value, summary.scaleMax);
      const isSelected = record.index === selectedStationIndex;
      L.circleMarker([lat, lng], {
        color: isSelected ? "#062c43" : record.value > 0 ? "#ffffff" : color,
        fillColor: color,
        fillOpacity: isSelected ? 1 : record.value > 0 ? 0.72 : 0.25,
        pane: "markerPane",
        radius: isSelected ? 7 : record.value > 0 ? 4.2 : 2.5,
        weight: isSelected ? 3 : record.value > 0 ? 1.1 : 0.8,
      })
        .bindPopup(popupMarkup(record, effectiveDates.length, hour), {
          className: "subsidy-popup",
          maxWidth: 300,
        })
        .on("click", () => selectStation(record))
        .addTo(stationLayer);
    }

    heatLayer.setLatLngs(points);
  }, [
    effectiveDates.length,
    hour,
    mapReady,
    selectedStationIndex,
    selectStation,
    summary.scaleMax,
    visibleStations,
  ]);

  useEffect(() => {
    const L = window.L;
    const flowLayer = flowLayerRef.current;
    if (!mapReady || !L || !flowLayer) return;

    flowLayer.clearLayers();
    if (!data || !selectedStation || flowSummary.relations.length === 0) return;

    const selectedLat = Number(selectedStation[3]);
    const selectedLng = Number(selectedStation[4]);
    if (!Number.isFinite(selectedLat) || !Number.isFinite(selectedLng)) return;

    const scaleMax = Math.max(...flowSummary.relations.map((relation) => relation.average));
    for (const relation of flowSummary.relations) {
      const otherStation = data.stations[relation.otherStationIndex];
      const otherLat = Number(otherStation?.[3]);
      const otherLng = Number(otherStation?.[4]);
      if (!Number.isFinite(otherLat) || !Number.isFinite(otherLng)) continue;

      const strength = scaleMax > 0 ? Math.sqrt(relation.average / scaleMax) : 0;
      const selectedPoint: [number, number] = [selectedLat, selectedLng];
      const otherPoint: [number, number] = [otherLat, otherLng];
      const latlngs =
        relation.direction === "out"
          ? [selectedPoint, otherPoint]
          : [otherPoint, selectedPoint];

      L.polyline(latlngs, {
        color: relation.direction === "out" ? "#1976b9" : "#e8832f",
        dashArray: relation.direction === "in" ? "8 5" : undefined,
        interactive: false,
        lineCap: "round",
        lineJoin: "round",
        opacity: 0.2 + strength * 0.74,
        pane: "overlayPane",
        weight: 1.1 + strength * 6.2,
      }).addTo(flowLayer);
    }
  }, [data, flowSummary.relations, mapReady, selectedStation]);

  const activeDistrictCount = visibleDistricts.filter((district) =>
    selectedDistricts.includes(district.id),
  ).length;

  const searchResults = useMemo(() => {
    const query = normalizedSearch(searchQuery.trim());
    if (!query) return [];
    return visibleStations
      .filter((record) => {
        const [name, city, district, , , id] = record.station;
        return normalizedSearch(`${name} ${city} ${district} ${id ?? ""}`).includes(query);
      })
      .slice(0, 10);
  }, [searchQuery, visibleStations]);

  const toggleCity = (city: CityId) => {
    setSelectedCities((current) =>
      current.includes(city) ? current.filter((item) => item !== city) : [...current, city],
    );
  };

  const toggleDayType = (dayType: DayType) => {
    setSelectedDayTypes((current) =>
      current.includes(dayType)
        ? current.filter((item) => item !== dayType)
        : [...current, dayType],
    );
  };

  const toggleDate = (date: string) => {
    setSelectedDates((current) =>
      current.includes(date) ? current.filter((item) => item !== date) : [...current, date],
    );
  };

  const toggleDistrict = (id: string) => {
    setSelectedDistricts((current) =>
      current.includes(id) ? current.filter((item) => item !== id) : [...current, id],
    );
  };

  const selectAllVisibleDistricts = () => {
    setSelectedDistricts((current) => [
      ...new Set([...current, ...visibleDistricts.map((district) => district.id)]),
    ]);
  };

  const clearVisibleDistricts = () => {
    const visibleIds = new Set(visibleDistricts.map((district) => district.id));
    setSelectedDistricts((current) => current.filter((id) => !visibleIds.has(id)));
  };

  const locateStation = (record: StationView) => {
    const L = window.L;
    const map = mapRef.current;
    const searchLayer = searchLayerRef.current;
    const lat = Number(record.station[3]);
    const lng = Number(record.station[4]);
    if (!L || !map || !searchLayer || !Number.isFinite(lat) || !Number.isFinite(lng)) return;

    searchLayer.clearLayers();
    const marker = L.circleMarker([lat, lng], {
      color: "#ffd166",
      dashArray: "5 3",
      fillOpacity: 0,
      radius: 15,
      weight: 4,
    })
      .bindPopup(popupMarkup(record, effectiveDates.length, hour), {
        className: "subsidy-popup",
        maxWidth: 300,
      })
      .addTo(searchLayer);
    selectStation(record);
    map.flyTo([lat, lng], 16, { duration: 0.55 });
    marker.openPopup();
    setSearchOpen(false);
  };

  const selectedCityText = CITY_OPTIONS.filter((city) => selectedCities.includes(city.id))
    .map((city) => city.short)
    .join("＋");
  const scopeText = selectedCityText || "未選城市";
  const topStationName = summary.topStation?.value
    ? String(summary.topStation.station[0])
    : "—";

  const clearFlows = resetStationSelection;

  const selectMonth = (month: string) => {
    const descriptor = months.find((candidate) => candidate.period === month);
    if (descriptor) loadMonthUsage(descriptor);
  };

  return (
    <main className="app-shell">
      <header className="toolbar">
        <div className="title-row">
          <div className="brand-block">
            <span className="brand-mark" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
            <div>
              <h1>雙北使用熱力圖</h1>
              <p>每日篩選 · 每小時變化 · 多日期等權平均 · 點位起訖關係</p>
            </div>
          </div>

          <div className="title-actions">
            {manifest && (
              <span className="data-status">
                <i aria-hidden="true" />
                {manifest.stations.length.toLocaleString("zh-TW")} 站 · {currentMonthDates.length || selectedMonthDescriptor?.dates.length || 0} 日 · {months.length} 個月份
              </span>
            )}
            <div className="search-box">
              <label className="sr-only" htmlFor="station-search">
                搜尋站點
              </label>
              <span aria-hidden="true" className="search-icon">⌕</span>
              <input
                id="station-search"
                type="search"
                value={searchQuery}
                placeholder="搜尋站點、行政區"
                autoComplete="off"
                onChange={(event) => {
                  setSearchQuery(event.target.value);
                  setSearchOpen(Boolean(event.target.value.trim()));
                }}
                onFocus={() => setSearchOpen(Boolean(searchQuery.trim()))}
                onKeyDown={(event) => {
                  if (event.key === "Escape") setSearchOpen(false);
                  if (event.key === "Enter" && searchResults[0]) locateStation(searchResults[0]);
                }}
                aria-controls="station-search-results"
              />
              {searchQuery && (
                <button
                  type="button"
                  className="search-clear"
                  aria-label="清除搜尋"
                  onClick={() => {
                    setSearchQuery("");
                    setSearchOpen(false);
                    searchLayerRef.current?.clearLayers();
                  }}
                >
                  ×
                </button>
              )}
              {searchOpen && (
                <div className="search-results" id="station-search-results" role="listbox">
                  {searchResults.length > 0 ? (
                    searchResults.map((record) => (
                      <button
                        key={`${record.station[5] ?? record.index}`}
                        type="button"
                        role="option"
                        aria-selected="false"
                        onClick={() => locateStation(record)}
                      >
                        <span>{record.station[0]}</span>
                        <small>
                          {record.station[1]} · {record.station[2]}
                        </small>
                      </button>
                    ))
                  ) : (
                    <p>目前篩選範圍內找不到相符站點</p>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="control-row">
          <div className="control-group month-control">
            <label className="control-label" htmlFor="month-select">
              月份
            </label>
            <div className="month-select-wrap">
              <select
                id="month-select"
                value={selectedMonth}
                onChange={(event) => selectMonth(event.target.value)}
                disabled={months.length === 0}
              >
                {months.map((month) => (
                  <option key={month.period} value={month.period}>
                    {monthLabel(month.period)}
                  </option>
                ))}
              </select>
              <span>{months.length} 個月份</span>
            </div>
          </div>

          <fieldset className="control-group compact-group">
            <legend>城市</legend>
            <div className="chip-row">
              {CITY_OPTIONS.map((city) => (
                <label className="check-chip" key={city.id}>
                  <input
                    type="checkbox"
                    checked={selectedCities.includes(city.id)}
                    onChange={() => toggleCity(city.id)}
                  />
                  <span>{city.label}</span>
                </label>
              ))}
            </div>
          </fieldset>

          <fieldset className="control-group compact-group">
            <legend>日別</legend>
            <div className="chip-row">
              <label className="check-chip">
                <input
                  type="checkbox"
                  checked={selectedDayTypes.includes("weekday")}
                  onChange={() => toggleDayType("weekday")}
                />
                <span>平日</span>
              </label>
              <label className="check-chip holiday-chip">
                <input
                  type="checkbox"
                  checked={selectedDayTypes.includes("holiday")}
                  onChange={() => toggleDayType("holiday")}
                />
                <span>假日</span>
              </label>
            </div>
          </fieldset>

          <div className="control-group dropdown-control">
            <span className="control-label">逐日</span>
            <details>
              <summary className="dropdown-trigger">
                <span>{monthLabel(selectedMonth)}日期</span>
                <b>{effectiveDates.length} 日生效</b>
              </summary>
              <div className="picker-panel date-panel">
                <div className="picker-head">
                  <div>
                    <strong>選擇日期</strong>
                    <small>日期與平／假日篩選取交集</small>
                  </div>
                  <div className="picker-actions">
                    <button
                      type="button"
                      onClick={() => setSelectedDates([...currentMonthDates])}
                    >
                      全選
                    </button>
                    <button type="button" onClick={() => setSelectedDates([])}>
                      清除
                    </button>
                  </div>
                </div>
                <div className="date-grid">
                  {currentMonthDates.map((date) => {
                    const holiday = dayTypeFor(date, holidayDates) === "holiday";
                    const inScope = selectedDayTypes.includes(
                      dayTypeFor(date, holidayDates),
                    );
                    return (
                      <label
                        aria-label={`${shortDate(date)}，週${weekdayLabel(date)}，${holiday ? "假日" : "平日"}`}
                        className={`date-option${holiday ? " is-holiday" : ""}${inScope ? "" : " is-out-of-scope"}`}
                        key={date}
                      >
                        <input
                          type="checkbox"
                          checked={selectedDates.includes(date)}
                          onChange={() => toggleDate(date)}
                        />
                        <span>
                          <b>{shortDate(date)}</b>
                          <small>週{weekdayLabel(date)}</small>
                        </span>
                      </label>
                    );
                  })}
                </div>
                <p className="picker-foot">
                  已勾 {selectedDates.length} 日，交集後 {effectiveDates.length} 日納入平均。
                </p>
              </div>
            </details>
          </div>

          <div className="control-group dropdown-control district-control">
            <span className="control-label">行政區</span>
            <details>
              <summary className="dropdown-trigger">
                <span>行政區</span>
                <b>
                  {activeDistrictCount === visibleDistricts.length
                    ? "全部"
                    : `${activeDistrictCount}/${visibleDistricts.length}`}
                </b>
              </summary>
              <div className="picker-panel district-panel">
                <div className="picker-head">
                  <div>
                    <strong>選擇行政區</strong>
                    <small>僅列出已勾選城市</small>
                  </div>
                  <div className="picker-actions">
                    <button type="button" onClick={selectAllVisibleDistricts}>
                      全選
                    </button>
                    <button type="button" onClick={clearVisibleDistricts}>
                      清除
                    </button>
                  </div>
                </div>
                <div className="district-grid">
                  {visibleDistricts.length > 0 ? (
                    visibleDistricts.map((district) => (
                      <label className="district-option" key={district.id}>
                        <input
                          type="checkbox"
                          checked={selectedDistricts.includes(district.id)}
                          onChange={() => toggleDistrict(district.id)}
                        />
                        <span>{district.district}</span>
                        <small>{district.cityLabel}</small>
                      </label>
                    ))
                  ) : (
                    <p className="empty-options">請先勾選台北市或新北市</p>
                  )}
                </div>
              </div>
            </details>
          </div>

          <div className="control-group hour-control">
            <label className="control-label" htmlFor="hour-slider">
              小時 <b>{hourLabel(hour)}</b>
            </label>
            <div className="hour-slider-row">
              <span>00</span>
              <input
                id="hour-slider"
                type="range"
                min="0"
                max="23"
                step="1"
                value={hour}
                onChange={(event) => setHour(Number(event.target.value))}
              />
              <span>23</span>
              <button
                type="button"
                className={`play-button${playing ? " is-playing" : ""}`}
                onClick={() => setPlaying((current) => !current)}
                aria-label={playing ? "暫停每小時播放" : "播放每小時變化"}
              >
                {playing ? "Ⅱ" : "▶"}
              </button>
            </div>
          </div>
        </div>
      </header>

      <section className="map-stage">
        <div
          ref={mapElementRef}
          id="subsidy-map"
          role="application"
          aria-label="雙北使用次數熱力地圖"
        />

        {!manifest && !loadError && (
          <div className="map-message" aria-live="polite">
            <span className="loading-orbit" aria-hidden="true" />
            <strong>正在載入月份目錄</strong>
            <p>月份與站點清單就緒後，會自動載入最新月份。</p>
          </div>
        )}

        {manifest && usageLoading && (
          <div className="map-message month-message" aria-live="polite">
            <span className="loading-orbit" aria-hidden="true" />
            <strong>正在載入{monthLabel(selectedMonth)}使用資料</strong>
            <p>切換完成後，日期、熱力與起訖關係會同步更新。</p>
          </div>
        )}

        {loadError && (
          <div className="map-message error-message" role="alert">
            <span className="message-icon" aria-hidden="true">!</span>
            <strong>資料尚未就緒</strong>
            <p>{loadError}</p>
            <button type="button" onClick={() => window.location.reload()}>
              重新載入
            </button>
          </div>
        )}

        {manifest && usageError && !usageLoading && (
          <div className="map-message error-message month-message" role="alert">
            <span className="message-icon" aria-hidden="true">!</span>
            <strong>月份資料尚未就緒</strong>
            <p>{usageError}</p>
            <button
              type="button"
              onClick={() => {
                if (selectedMonthDescriptor) loadMonthUsage(selectedMonthDescriptor);
              }}
            >
              重新載入這個月份
            </button>
          </div>
        )}

        {data && (
          <>
            <aside className="map-summary" aria-label="目前篩選摘要">
              <div className="summary-kicker">
                <span>{scopeText}</span>
                <b>{hourLabel(hour)}</b>
              </div>
              <div className="summary-primary">
                <span>本時段平均使用次數</span>
                <strong>
                  {NUMBER_FORMAT.format(summary.total)}
                  <small>次</small>
                </strong>
              </div>
              <div className="summary-grid">
                <div>
                  <span>納入日期</span>
                  <b>{effectiveDates.length} 日</b>
                </div>
                <div>
                  <span>有值站點</span>
                  <b>{summary.activeCount} 站</b>
                </div>
                <div>
                  <span>站均</span>
                  <b>
                    {NUMBER_FORMAT.format(summary.stationAverage)} 次
                  </b>
                </div>
                <div>
                  <span>最高站點</span>
                  <b title={topStationName}>{topStationName}</b>
                </div>
              </div>
              <p>數值以使用次數呈現；多日期採等權平均，未出現的站日以 0 計入。點選地圖場站可查看起訖關係。</p>
              <p className="summary-scope-note">資料範圍：{monthLabel(selectedMonth)}中，借車時間落在該月的使用紀錄；不含跨月後才納入來源報表的紀錄。</p>
            </aside>

            {selectedStation && (
              <aside className="flow-panel" aria-label="場站起訖關係">
                <div className="flow-panel__head">
                  <div>
                    <span>已選場站</span>
                    <strong>{selectedStation[0]}</strong>
                    <small>
                      {selectedStation[1]} · {selectedStation[2]}
                      {selectedStation[5] ? ` · ${selectedStation[5]}` : ""}
                    </small>
                  </div>
                  <button type="button" onClick={clearFlows}>
                    清除關係
                  </button>
                </div>

                <p className="flow-context">
                  {hourLabel(hour)} · {effectiveDates.length} 日等權平均
                </p>

                <fieldset className="flow-toggle-row">
                  <legend className="sr-only">顯示起訖方向</legend>
                  <label className="flow-toggle is-outgoing">
                    <input
                      type="checkbox"
                      checked={showOutgoing}
                      onChange={() => setShowOutgoing((current) => !current)}
                    />
                    <span>借出</span>
                    <b>{NUMBER_FORMAT.format(flowSummary.outgoingTotal)} 次</b>
                  </label>
                  <label className="flow-toggle is-incoming">
                    <input
                      type="checkbox"
                      checked={showIncoming}
                      onChange={() => setShowIncoming((current) => !current)}
                    />
                    <span>還入</span>
                    <b>{NUMBER_FORMAT.format(flowSummary.incomingTotal)} 次</b>
                  </label>
                </fieldset>

                {flowLoading && <p className="flow-status">正在載入起訖關係…</p>}
                {flowMessage && <p className="flow-status is-error">{flowMessage}</p>}
                {!flowLoading &&
                  !flowMessage &&
                  flowData &&
                  flowSummary.relations.length === 0 && (
                    <p className="flow-status">
                      {!showOutgoing && !showIncoming
                        ? "請開啟至少一個方向以顯示關係線。"
                        : "目前日期與時段沒有可繪製的站間流向。"}
                    </p>
                  )}

                <div className="flow-legend" aria-label="起訖線條圖例">
                  <span><i className="flow-line is-outgoing" />藍色實線：借出</span>
                  <span><i className="flow-line is-incoming" />橘色虛線：還入</span>
                  <small>關係線依目前城市與行政區範圍，每方向顯示前 60 條；越深、越粗代表平均使用次數越多。</small>
                </div>
              </aside>
            )}

            <aside className="map-legend" aria-label="熱力圖圖例">
              <div className="legend-head">
                <span>熱度</span>
                <b>使用次數</b>
              </div>
              <div className="legend-gradient" aria-hidden="true" />
              <div className="legend-scale">
                <span>0</span>
                <span>
                  高於 {NUMBER_FORMAT.format(summary.scaleMax)} 次
                </span>
              </div>
              <p>色階上限採目前篩選站點的第 95 百分位。</p>
            </aside>

            {effectiveDates.length === 0 && (
              <div className="empty-selection" role="status">
                <strong>目前沒有生效日期</strong>
                <span>請勾選日期，並確認平日／假日條件有交集。</span>
              </div>
            )}
          </>
        )}
      </section>
    </main>
  );
}
