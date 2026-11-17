/* 扩展页面（popup / console / background）共用的配置、平台元数据与筛选规则。
   这个文件不接触任何招聘网站 DOM，可被 chrome-extension:// 页面直接 <script src> 引入。 */
(function () {
  "use strict";

  // 默认不预置任何岗位偏好。用户可在配置面板中自行填写关键词和筛选规则。
  const INCLUDE_WORDS = [];
  const EXCLUDE_WORDS = [];
  const KEYWORDS = [];

  const DEFAULTS = {
    platforms: { boss: true, zhilian: true, liepin: true, job51: true, yupao: true },
    keywords: KEYWORDS,
    includeWords: INCLUDE_WORDS,
    excludeWords: EXCLUDE_WORDS,
    salaryMinK: 0,           // 默认不限制最低薪资，由用户自行设置
    salaryFloorK: 0,
    strictCity: false,       // 默认不锁定城市
    cityPref: "",
    cities: {
      boss: "",              // 默认沿用招聘网站页面中的城市条件
      zhilian: "",
      liepin: "",
      job51: "",
      yupao: ""
    },
    limits: { boss: 150, zhilian: 100, liepin: 100, job51: 100, yupao: 100 },
    maxPages: 1,             // 每关键词翻页数；仅 51Job 有实测的 UI 翻页
    gapMin: 11, gapMax: 20,  // 两家之间的随机间隔（秒）
    kwPauseMin: 12, kwPauseMax: 22, // 换关键词休息（秒）
    longEvery: 8, longMin: 40, longMax: 60, // 每 N 家长休息
    maxFail: 3,              // 连续失败达到即停
    dryRun: true,            // 默认演练；只有用户主动切换并二次确认后才进入真实投递
    readPauseMin: 1, readPauseMax: 2
  };

  /* 平台元数据：host 用于 host_permissions 与标签页识别，searchUrl 均为实测过的搜索入口。
     mode = list  : 列表页内点卡片出详情，投递动作可在当前页完成
     mode = detail: 需要导航到岗位详情页后再投递，由总控台逐卡片调度 */
  const META = {
    boss: {
      name: "BOSS直聘", host: "www.zhipin.com", mode: "list", paged: false,
      entry: "https://www.zhipin.com/",
      searchUrl: (kw, cfg) =>
        "https://www.zhipin.com/web/geek/jobs?query=" + encodeURIComponent(kw) +
        (cfg.cities.boss ? "&city=" + encodeURIComponent(cfg.cities.boss) : "")
    },
    zhilian: {
      name: "智联招聘", host: "www.zhaopin.com", mode: "list", paged: false,
      entry: "https://www.zhaopin.com/",
      searchUrl: (kw, cfg) =>
        "https://www.zhaopin.com/jobs/?pageMode=search&kw=" + encodeURIComponent(kw) +
        (cfg.cities.zhilian ? "&jl=" + cfg.cities.zhilian : "")
    },
    liepin: {
      name: "猎聘", host: "www.liepin.com", mode: "detail", paged: false,
      entry: "https://www.liepin.com/",
      searchUrl: (kw) =>
        "https://www.liepin.com/zhaopin/?key=" + encodeURIComponent(kw) + "&scene=input&workYearCode=0"
    },
    job51: {
      name: "前程无忧51Job", host: "we.51job.com", mode: "list", paged: true,
      entry: "https://we.51job.com/",
      searchUrl: (kw) =>
        "https://we.51job.com/pc/search?keyword=" + encodeURIComponent(kw)
    },
    yupao: {
      name: "鱼泡直聘", host: "www.yupao.com", mode: "detail", paged: false,
      entry: "https://www.yupao.com/",
      searchUrl: (kw) =>
        "https://www.yupao.com/topic/a1c0/?keywords=" + encodeURIComponent(kw)
    }
  };

  const PLATFORM_ORDER = ["boss", "zhilian", "liepin", "job51", "yupao"];
  const PLATFORM_NAMES = Object.fromEntries(PLATFORM_ORDER.map(k => [k, META[k].name]));

  /* 本次执行范围：
     - scope 为具体平台时，只执行该平台；即使配置面板里没勾选该平台也强制执行。
     - scope 为 all / 空 / 非法值时，回退到配置面板的 platforms 勾选。
     这是单一平台执行的唯一判定入口，控制台生成计划和渲染卡片都走这里，
     保证「选了 BOSS，其他平台一步都不会跑」。 */
  function activePlatforms(cfg, scope) {
    if (scope && scope !== "all" && PLATFORM_ORDER.includes(scope)) return [scope];
    const c = cfg || {};
    return PLATFORM_ORDER.filter(p => !!(c.platforms && c.platforms[p]));
  }

  /* 生成执行计划：平台 × 关键词 × 页码。
     非 paged 平台固定 1 页；只有 scope 内的平台会出现在计划里。 */
  function buildPlan(cfg, scope) {
    const c = cfg || {};
    const keywords = Array.isArray(c.keywords) ? c.keywords : [];
    const pages = Math.max(1, Number(c.maxPages) || 1);
    const plan = [];
    for (const p of activePlatforms(c, scope)) {
      const n = META[p].paged ? pages : 1;
      for (const kw of keywords) {
        for (let pg = 1; pg <= n; pg++) plan.push({ platform: p, keyword: kw, page: pg });
      }
    }
    return plan;
  }

  function normalizeCfg(raw) {
    const c = JSON.parse(JSON.stringify(DEFAULTS));
    const r = raw || {};
    for (const k of Object.keys(c)) {
      if (r[k] === undefined) continue;
      if (k === "platforms" || k === "limits" || k === "cities") Object.assign(c[k], r[k]);
      else c[k] = r[k];
    }
    for (const k of ["keywords", "includeWords", "excludeWords"]) {
      if (!Array.isArray(c[k])) c[k] = DEFAULTS[k];
      c[k] = c[k].map(s => String(s).trim()).filter(Boolean);
    }
    return c;
  }

  function splitLines(s) {
    return String(s || "").split(/[\n,，、;；]/).map(x => x.trim()).filter(Boolean);
  }

  /* 统一筛选：薪资下限 + 用户自定义期望/屏蔽关键词 + 可选城市条件 + 去重。
     - 薪资：只按区间下限判定，下限 >= max(salaryMinK, salaryFloorK) 才过；不看上限。
     - 城市：仅在 strictCity 开启时校验岗位卡片中的城市。
     - 关键词规则只作用于岗位标题，避免岗位描述中的词语误伤。 */
  function filterCard(card, cfg, seen) {
    const title = String(card.title || "").trim();
    if (!title) return { pass: false, why: "无岗位名" };
    const sal = card.salary;
    if (!sal || !isFinite(sal.lo)) return { pass: false, why: "薪资无法解析" };
    const floor = Math.max(cfg.salaryMinK || 0, cfg.salaryFloorK || 0);
    if (sal.lo < floor) return { pass: false, why: "下限" + sal.lo + "K<" + floor + "K" };
    if (cfg.includeWords.length && !cfg.includeWords.some(w => title.includes(w))) {
      return { pass: false, why: "未命中期望关键词" };
    }
    const hit = cfg.excludeWords.find(w => title.toLowerCase().includes(String(w).toLowerCase()));
    if (hit) return { pass: false, why: "屏蔽词:" + hit };
    const city = String(card.city || "").trim();
    if (cfg.strictCity) {
      if (!city || /^(全国|多地|不限|远程|出差)$/.test(city)) return { pass: false, why: "城市读不到/无效" };
      if (cfg.cityPref && !city.includes(cfg.cityPref)) return { pass: false, why: "非偏好城市:" + city };
    }
    const key = [card.platform, title, sal.text, city, card.company || ""].join("|");
    if (seen.has(key)) return { pass: false, why: "已投递/已去重" };
    return {
      pass: true, why: "", key: key,
      cityScore: city.includes(cfg.cityPref) ? 0 : 1
    };
  }

  const CSV_COLS = ["平台", "关键词", "岗位", "薪资", "城市", "公司", "状态", "是否成功", "模式", "时间"];
  function csvCell(v) { return '"' + String(v == null ? "" : v).replace(/"/g, '""') + '"'; }
  function toCSV(rows) {
    const head = CSV_COLS.map(csvCell).join(",");
    const lines = (rows || []).map(r => CSV_COLS.map(c => csvCell(r[c])).join(","));
    return "\ufeff" + [head].concat(lines).join("\r\n");
  }
  function downloadCSV(rows, filename) {
    const blob = new Blob([toCSV(rows)], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = filename || "投递台账.csv";
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  const get = keys => new Promise(res => chrome.storage.local.get(keys, res));
  const set = obj => new Promise(res => chrome.storage.local.set(obj, res));
  async function loadCfg() { const d = await get("cfg"); return normalizeCfg(d.cfg); }

  window.AA = {
    DEFAULTS, META, PLATFORM_ORDER, PLATFORM_NAMES, CSV_COLS,
    normalizeCfg, splitLines, filterCard, toCSV, downloadCSV,
    activePlatforms, buildPlan,
    get, set, loadCfg
  };
})();
