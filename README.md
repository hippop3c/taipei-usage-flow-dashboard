# 雙北使用熱力圖

[開啟 GitHub Pages 互動網頁](https://hippop3c.github.io/taipei-usage-flow-dashboard/)

將 `E:\` 內台北市、新北市的每月 Access 請款報表，依「借車時間」聚合成每日、每小時、每站的使用次數與逐站借出／還入資料。資料按月拆檔，新增月份不會重建或放大其他月份的公開資料。

## 一鍵更新月份

在專案根目錄執行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\update-dashboard.ps1 `
  -Period 2026-07 `
  -DriveRoot 'E:\'
```

`-Period` 必須是 `YYYY-MM`。主控會自動計算該月首末日，例如 `2026-07` 只掃描 `20260701-20260731_*.accdb`；二月與閏年也會依實際天數處理。更新依序完成：

1. 以 32-bit ACE OLEDB `Mode=Read` 讀取該月 Access 報表，建立 usage checkpoint。
2. 更新該月 usage JSON，並將月份 descriptor 加入 manifest。
3. 讀取同一月份報表建立 OD checkpoint。
4. 重建該月份的逐站 flow JSON。

已完成的來源 checkpoint 預設會續跑略過。來源檔有變更或需要重讀該月時加上 `-Force`：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\update-dashboard.ps1 `
  -Period 2026-07 `
  -DriveRoot 'E:\' `
  -Force
```

## 資料與 checkpoint 位置

每次只覆寫指定月份，其他月份原樣保留：

```text
public/
  subsidy-data.js                  # 場站清單與月份 manifest
  months/YYYY-MM/
    usage.json                     # 該月 dates、valuesByDate、meta
    flows/<stationId>.json         # 該月逐站借出／還入

work/
  months/YYYY-MM/
    usage/                         # 可續跑 usage checkpoint
    od/                            # 可續跑 OD checkpoint 與來源 audit
    flow-stage/                    # 該月 flow 暫存
  audits/
    YYYY-MM-usage-merge.json
    YYYY-MM-flow-build.json
```

`public/subsidy-data.js` 的月份契約如下；場站索引採 append-only，加入新站不會改動舊月份既有 index：

```js
window.SUBSIDY_HEATMAP_DATA = {
  stations: [/* [name, city, district, lat, lng, stationId] */],
  months: [{
    period: "2026-07",
    dates: ["2026-07-01", "..."],
    usageUrl: "/months/2026-07/usage.json",
    flowBaseUrl: "/months/2026-07/flows",
    holidayDates: []
  }]
};
```

頁面的月份選單只顯示 manifest 中已成功產生的月份。切換月份時只載入該月 `usage.json`；點選場站時才載入該月對應 flow。複選日期的等權平均只在目前選取月份內計算，缺少的站日小時視為 0。

所有包含來源表名與核對次數的 audit 都位於 `work/`，不寫到公開頁。

## 國定假日設定

週六、週日由前端依日期判斷；週末以外的國定假日是唯一非報表輸入，版本控管於 [`scripts/holidays.json`](scripts/holidays.json)。目前已納入行政院人事行政總處 2026 年辦公日曆中的平日放假日期。新增其他年份的月份時，請先將該年平日放假的 ISO 日期加入此檔再執行更新；合併器只會把屬於指定月份的日期寫入 descriptor 與月資料。

## 環境需求

- Windows 64-bit 主機與 32-bit Windows PowerShell 5.1。
- 32-bit Microsoft Access Database Engine（`Microsoft.ACE.OLEDB.12.0`）。
- Node.js `>=22.13.0` 與 pnpm。
- 預設場站資料為相鄰專案 `..\youbike-hourly-heatmap\data.js`；可在一鍵指令加上 `-StationData '<path>'` 覆寫。

若場站主檔需補充新站，可先產生 `work\station-master.json`，usage 主控會自動以 append-only 方式加入：

```powershell
python .\scripts\export_station_master.py '<場站基本資料.xlsx>' .\work\station-master.json
```

## 預覽與驗證

```powershell
pnpm install
pnpm dev
```

正式驗證：

```powershell
pnpm lint
pnpm test
pnpm build
```

## 資料口徑

- 時段使用「借車時間」，不使用可能延遲數日或數月的扣款時間。
- 公開資料只有使用次數 metric；每個 cell 固定為 `[stationIndex, 0, count]`，不帶補助金額。
- 資料是「該月請款報表中，借車時間落在該月的使用紀錄」，不是該月完整全體騎乘；該月借車但之後月份才入帳者不在本批報表。
