(function () {
  "use strict";
  const AA = window.AA;
  const $ = id => document.getElementById(id);

  const FIELDS = ["salaryMinK", "salaryFloorK", "gapMin", "gapMax", "kwPauseMin", "kwPauseMax",
    "longEvery", "longMin", "longMax", "maxFail", "maxPages", "cityPref"];
  const CHECKS = ["dryRun", "strictCity"];
  const AREAS = ["keywords", "includeWords", "excludeWords"];

  function renderPlatforms(cfg) {
    $("platforms").innerHTML = AA.PLATFORM_ORDER.map(k => {
      const m = AA.META[k];
      return '<div class="platform-row">' +
        '<label class="chk"><input type="checkbox" data-plat="' + k + '"' + (cfg.platforms[k] ? " checked" : "") + '>' +
        '<span class="nm">' + m.name + '</span></label>' +
        '<span class="tag">' + (m.mode === "detail" ? "详情页投递" : "列表页投递") + '</span>' +
        '<input type="number" min="1" max="500" data-limit="' + k + '" value="' + cfg.limits[k] + '">' +
        '<span class="tag">家</span></div>';
    }).join("");
  }

  async function fill() {
    const cfg = await AA.loadCfg();
    FIELDS.forEach(k => { $(k).value = cfg[k]; });
    CHECKS.forEach(k => { $(k).checked = !!cfg[k]; });
    AREAS.forEach(k => { $(k).value = cfg[k].join("\n"); });
    renderPlatforms(cfg);
    updateBadge();
    const d = await AA.get(["logs"]);
    const logs = d.logs || [];
    const ok = logs.filter(r => r["是否成功"] === "Y").length;
    const live = logs.filter(r => r["模式"] === "实投" && r["是否成功"] === "Y").length;
    $("status").textContent = "台账 " + logs.length + " 条 ｜ 动作成功 " + ok + " ｜ 其中实际投递 " + live;
  }

  function updateBadge() {
    const dry = $("dryRun").checked;
    const b = $("modeBadge");
    b.textContent = dry ? "演练模式" : "实投模式";
    b.className = "badge " + (dry ? "badge-dry" : "badge-live");
    const w = $("liveWarn");
    w.style.display = "block";
    w.innerHTML = dry
      ? '<b>演练模式</b>：只搜索、筛选、打开详情、识别按钮，不点击最终投递按钮；台账里「实际投递」为 0。'
      : '<b>实投模式</b>：点击「开始」后会向真实 HR 发送简历/招呼语，动作不可撤回。控制台启动时会再弹一次确认。请确认已登录、已核对筛选规则与当日额度。';
  }

  function collect() {
    const cfg = AA.normalizeCfg(null);
    FIELDS.forEach(k => { cfg[k] = k === "cityPref" ? $(k).value.trim() : Number($(k).value || 0); });
    CHECKS.forEach(k => { cfg[k] = $(k).checked; });
    AREAS.forEach(k => { cfg[k] = AA.splitLines($(k).value); });
    document.querySelectorAll("[data-plat]").forEach(el => { cfg.platforms[el.dataset.plat] = el.checked; });
    document.querySelectorAll("[data-limit]").forEach(el => { cfg.limits[el.dataset.limit] = Math.max(1, Number(el.value || 1)); });
    return AA.normalizeCfg(cfg);
  }

  $("dryRun").addEventListener("change", updateBadge);
  $("save").addEventListener("click", async () => {
    await AA.set({ cfg: collect() });
    $("status").className = "stat-line ok";
    $("status").textContent = "配置已保存 ✓ 控制台开始运行时会读取这份配置";
    setTimeout(fill, 1600);
  });
  $("openConsole").addEventListener("click", async () => {
    await AA.set({ cfg: collect() });
    chrome.tabs.create({ url: chrome.runtime.getURL("console.html") });
  });
  $("export").addEventListener("click", async () => {
    const d = await AA.get(["logs"]);
    AA.downloadCSV(d.logs || [], "投递台账.csv");
  });

  fill();
})();
