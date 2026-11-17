/* 常驻总控台：计划生成 → 标签页导航 → 注入页面脚本 → 收集结果 → 台账 / 限速 / 硬停止。
   放在扩展页面而不是 Service Worker，是因为 SW 会被浏览器回收，长批量任务会丢状态。 */
(function () {
  "use strict";
  const AA = window.AA;
  const $ = id => document.getElementById(id);
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const rnd = (a, b) => Math.floor(a + Math.random() * (b - a + 1));
  const now = () => new Date().toLocaleString("zh-CN", { hour12: false });

  let cfg = null, S = null, workTabId = null, seq = 0;
  let scope = "all"; // 本次执行范围：all 或具体平台；单平台时其他平台绝不进入计划
  const pending = new Map();

  const INJECT_FILES = ["src/common.js", "src/adapters.js", "content.js"];

  chrome.runtime.onMessage.addListener(m => {
    if (m && m.type === "AA_RESULT" && pending.has(m.seq)) {
      const e = pending.get(m.seq);
      pending.delete(m.seq);
      e.res(m);
    }
  });

  function blankState() {
    return {
      running: false, paused: false, stopReason: "", risk: "", dryRun: false,
      logs: [], seen: new Set(), stats: {}, fail: 0,
      cur: "尚未开始", note: ""
    };
  }
  function stat(p) {
    if (!S.stats[p]) S.stats[p] = { ok: 0, sent: 0, fail: 0, skip: 0 };
    return S.stats[p];
  }
  function row(o) {
    return Object.assign({
      平台: "", 关键词: "", 岗位: "", 薪资: "", 城市: "", 公司: "", 状态: "",
      是否成功: "—", 模式: S.dryRun ? "演练" : "实投", 时间: now()
    }, o || {});
  }
  function persist() {
    return AA.set({
      logs: S.logs,
      seen: [...S.seen],
      stats: S.stats,
      state: { running: S.running, paused: S.paused, stopReason: S.stopReason, risk: S.risk }
    });
  }
  function addLog(o) {
    S.logs.push(row(o));
    persist();
    render();
  }

  function render() {
    const dry = S.dryRun;
    const badge = $("modeBadge");
    badge.textContent = dry ? "演练模式" : "实投模式";
    badge.className = "badge " + (dry ? "badge-dry" : "badge-live");

    $("scope").value = scope;
    $("scope").disabled = S.running;
    $("start").disabled = S.running;
    $("pause").disabled = !S.running;
    $("pause").textContent = S.paused ? "▶ 继续" : "⏸ 暂停";
    $("stop").disabled = !S.running;

    const rs = $("runState");
    let txt = "待机", cls = "state";
    if (S.risk) { txt = "已自动停止"; cls += " stop"; }
    else if (S.running && S.paused) { txt = "已暂停"; cls += " pause"; }
    else if (S.running) { txt = "运行中"; cls += " run"; }
    else if (S.stopReason) { txt = S.stopReason.slice(0, 18); }
    rs.textContent = txt; rs.className = cls;

    $("riskBanner").style.display = S.risk ? "block" : "none";
    $("riskText").textContent = S.risk || "";

    const active = AA.activePlatforms(cfg || {}, scope);
    $("cards").innerHTML = AA.PLATFORM_ORDER.map(p => {
      const m = AA.META[p], st = stat(p), lim = (cfg && cfg.limits[p]) || 0;
      const on = active.includes(p);
      const pct = lim ? Math.min(100, Math.round(st.ok / lim * 100)) : 0;
      return '<div class="pcard' + (on ? "" : " off") + '">' +
        '<div class="nm">' + m.name + '</div>' +
        '<div class="num">' + st.ok + '<span style="font-size:12px;color:#6d6b8a"> / ' + lim + '</span></div>' +
        '<div class="sub">' + (on ? "本次执行" : "本次不执行") + ' ｜ 实际投递 ' + st.sent + ' ｜ 跳过 ' + st.skip + ' ｜ 失败 ' + st.fail + '</div>' +
        '<div class="track"><div class="fill" style="width:' + pct + '%"></div></div></div>';
    }).join("");

    $("current").textContent = S.cur;
    $("note").textContent = S.note || "";
    $("logCount").textContent = "共 " + S.logs.length + " 条（显示最近 150 条）";

    const body = $("logBody");
    body.textContent = "";
    const list = S.logs.slice(-150).reverse();
    if (!list.length) {
      const tr = document.createElement("tr");
      const td = document.createElement("td");
      td.colSpan = 6; td.className = "empty"; td.textContent = "暂无记录";
      tr.appendChild(td); body.appendChild(tr); return;
    }
    const frag = document.createDocumentFragment();
    for (const r of list) {
      const tr = document.createElement("tr");
      const vals = [r["时间"], r["平台"], (r["岗位"] || r["状态"] || "").slice(0, 40), r["薪资"], r["状态"], r["是否成功"]];
      vals.forEach((v, i) => {
        const td = document.createElement("td");
        td.textContent = v == null ? "" : String(v);
        if (i === 5) td.className = v === "Y" ? "ok" : (v === "N" ? (String(r["状态"]).indexOf("SKIP") >= 0 ? "skip" : "no") : "skip");
        tr.appendChild(td);
      });
      frag.appendChild(tr);
    }
    body.appendChild(frag);
  }

  /* ---------- 标签页与注入 ---------- */
  async function ensureTab() {
    const d = await AA.get(["workTabId"]);
    if (d.workTabId) {
      try { const t = await chrome.tabs.get(d.workTabId); if (t && t.id) { workTabId = t.id; return; } } catch (_) {}
    }
    const t = await chrome.tabs.create({ url: "about:blank", active: false });
    workTabId = t.id;
    await AA.set({ workTabId });
  }
  function waitTabLoad(id) {
    return new Promise(res => {
      let done = false;
      const f = (tid, info) => {
        if (tid === id && info.status === "complete" && !done) {
          done = true; chrome.tabs.onUpdated.removeListener(f); res(true);
        }
      };
      chrome.tabs.onUpdated.addListener(f);
      setTimeout(() => { if (!done) { chrome.tabs.onUpdated.removeListener(f); res(false); } }, 25000);
    });
  }
  async function navigate(url) {
    const p = waitTabLoad(workTabId);
    await chrome.tabs.update(workTabId, { url });
    await p;
    await sleep(rnd(1900, 3000)); // SPA 结果渲染 + 模拟阅读停留
  }
  const RISK_URL = /captcha|verify|security_check|safe\.liepin\.com|captchaPage|_security_check/i;
  async function urlRisk() {
    try {
      const t = await chrome.tabs.get(workTabId);
      if (t && t.url && RISK_URL.test(t.url)) return "风控页面跳转: " + t.url.slice(0, 140);
    } catch (_) {}
    return "";
  }

  async function inject(mode, extra) {
    // 注入前先验 URL：命中验证码/风控页立即停止，绝不在该页做任何注入或点击
    const preRisk = await urlRisk();
    if (preRisk) { hardStop(preRisk); return { ok: false, risk: preRisk, stopped: true }; }
    const s = ++seq;
    const job = Object.assign({
      seq: s, mode, platform: extra.platform, keyword: extra.keyword || "",
      dryRun: S.dryRun, cfg: cfg
    }, extra);
    await AA.set({ job });
    let resolveFn;
    const p = new Promise(res => { resolveFn = res; pending.set(s, { res }); });
    const timer = setTimeout(() => {
      if (pending.has(s)) { pending.delete(s); resolveFn({ ok: false, error: "页面脚本执行超时" }); }
    }, 40000);
    try {
      await chrome.scripting.executeScript({ target: { tabId: workTabId }, files: INJECT_FILES });
    } catch (e) {
      if (pending.has(s)) {
        pending.delete(s); clearTimeout(timer);
        resolveFn({ ok: false, error: "注入失败: " + String(e && e.message || e) });
      }
    }
    const r = await p;
    clearTimeout(timer);
    // 注入失败时若当前页已是风控页，升级为硬停止（而不是计为普通扫描失败反复重试）
    if (!r.risk && /注入失败|无法访问|Cannot access contents/.test(r.error || "")) {
      const postRisk = await urlRisk();
      if (postRisk) return { ok: false, risk: postRisk, stopped: true };
    }
    return r;
  }

  /* ---------- 限速 / 停止 ---------- */
  async function pacedSleep(ms) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (!S.running || S.risk) return;
      if (S.paused) { await sleep(400); continue; }
      await sleep(Math.min(500, Math.max(50, end - Date.now())));
    }
  }
  function hardStop(reason) {
    if (S.risk) return; // 幂等：已经因风控停止过就不再重复记账
    S.risk = String(reason).slice(0, 180);
    S.stopReason = "风控/额度自动停止";
    S.running = false;
    addLog(row({ 平台: "系统", 状态: "⛔ 自动停止：" + S.risk, 是否成功: "N" }));
    chrome.runtime.sendMessage({ type: "AA_HARD_STOP", reason: S.risk }).catch(() => {});
    persist(); render();
  }
  function softStop(reason) {
    S.stopReason = reason;
    S.running = false;
    addLog(row({ 平台: "系统", 状态: "停止：" + reason, 是否成功: "N" }));
    persist(); render();
  }

  async function processCard(x, step, meta) {
    const c = x.c, f = x.f;
    let r;
    if (meta.mode === "detail") {
      if (!c.href) {
        addLog(row({ 平台: meta.name, 关键词: step.keyword, 岗位: c.title, 薪资: (c.salary || {}).text || "", 状态: "SKIP:无详情链接", 是否成功: "N" }));
        stat(step.platform).skip++; return true;
      }
      S.cur = meta.name + " · 打开详情：" + c.title;
      render();
      await navigate(c.href);
      if (!S.running || S.risk) return false;
      r = await inject("detailApply", { platform: step.platform, keyword: step.keyword, card: c });
    } else {
      S.cur = meta.name + " · 处理：" + c.title;
      render();
      r = await inject("apply", { platform: step.platform, keyword: step.keyword, card: c });
    }
    if (r.risk) { hardStop(r.risk); return false; }

    const st = stat(step.platform);
    const ok = !!r.ok, skip = !!r.skip, dry = !!r.dry;
    const status = r.status || r.error || (ok ? "完成" : "未确认");
    addLog(row({
      平台: meta.name, 关键词: step.keyword, 岗位: c.title,
      薪资: (c.salary || {}).text || "", 城市: c.city || "", 公司: c.company || "",
      状态: status + (c.salarySuspect ? " [薪资解码存疑]" : ""),
      是否成功: ok ? "Y" : "N"
    }));
    if (ok) {
      st.ok++;
      if (!dry) st.sent++;
      S.seen.add(f.key);
      S.fail = 0;
    } else if (skip) {
      st.skip++;
    } else {
      st.fail++; S.fail++;
      if (S.fail >= (cfg.maxFail || 3)) { softStop("连续 " + S.fail + " 次失败"); return false; }
    }
    persist(); render();
    return S.running && !S.risk;
  }

  async function start() {
    if (S.running) return;
    const savedScope = await AA.get(["uiScope"]);
    if (savedScope.uiScope === "all" || AA.PLATFORM_ORDER.includes(savedScope.uiScope)) scope = savedScope.uiScope;
    cfg = await AA.loadCfg();
    const active = AA.activePlatforms(cfg, scope);
    // 实投前二次确认：避免安装后误点「开始」就真的把简历发出去
    if (!cfg.dryRun) {
      const names = active.map(p => AA.META[p].name).join("、");
      const total = active.reduce((s, p) => s + cfg.limits[p], 0);
      const ok = window.confirm(
        "即将以【实投模式】运行\n\n" +
        "本次范围：" + (scope === "all" ? "全部（按配置勾选）" : "仅 " + AA.META[scope].name) + "\n" +
        "平台：" + (names || "未选择任何平台") + "\n" +
        "本轮上限合计：" + total + " 家\n\n" +
        "每一次点击都会把简历或招呼语发给真实 HR，发出后无法撤回。\n" +
        "命中验证码 / 滑块 / 账号异常 / 日额度提示会立即整任务停止，需要你本人手动处理。\n\n" +
        "确认开始实投？（想先只跑流程请用配置面板勾选「演练模式」）"
      );
      if (!ok) return;
    }
    const d = await AA.get(["logs", "seen"]);
    const fresh = blankState();
    S = Object.assign(fresh, {
      running: true, dryRun: !!cfg.dryRun,
      logs: d.logs || [], seen: new Set(d.seen || []),
      cur: "准备中…", note: cfg.dryRun ? "演练模式：不会点击最终投递按钮" : "实投模式：将向真实 HR 发送"
    });
    await ensureTab();
    persist(); render();

    const plan = AA.buildPlan(cfg, scope);
    const donePlatforms = new Set();
    let attempts = 0;

    outer:
    for (const step of plan) {
      if (!S.running || S.risk) break;
      const meta = AA.META[step.platform], st = stat(step.platform), lim = cfg.limits[step.platform];
      if (donePlatforms.has(step.platform) || st.ok >= lim) { donePlatforms.add(step.platform); continue; }

      if (attempts > 0 && step.page === 1) await pacedSleep(rnd(cfg.kwPauseMin, cfg.kwPauseMax) * 1000);
      if (!S.running || S.risk) break;

      S.cur = meta.name + " · 关键词「" + step.keyword + "」· 第 " + step.page + " 页";
      render();
      if (step.page === 1) {
        await navigate(meta.searchUrl(step.keyword, cfg));
      } else {
        const np = await inject("nextPage", { platform: step.platform, keyword: step.keyword });
        if (!np.ok || !np.next) break;
        await sleep(1600);
      }
      if (!S.running || S.risk) break;

      const scan = await inject("scan", { platform: step.platform, keyword: step.keyword });
      if (scan.risk) { hardStop(scan.risk); break; }
      if (!scan.ok) {
        S.fail++;
        addLog(row({ 平台: meta.name, 关键词: step.keyword, 状态: "扫描失败：" + (scan.error || "未知"), 是否成功: "N" }));
        if (S.fail >= (cfg.maxFail || 3)) { softStop("连续 " + S.fail + " 次扫描失败"); break; }
        continue;
      }
      S.note = scan.note || "";
      const cards = (scan.cards || [])
        .map(c => Object.assign({}, c, { platform: step.platform }))
        .map(c => ({ c, f: AA.filterCard(c, cfg, S.seen) }))
        .filter(x => x.f.pass)
        .sort((a, b) => a.f.cityScore - b.f.cityScore);
      addLog(row({
        平台: meta.name, 关键词: step.keyword,
        状态: "扫描 " + (scan.cards || []).length + " 张 · 合格 " + cards.length + " 张",
        是否成功: "—"
      }));

      for (const x of cards) {
        if (!S.running || S.risk || st.ok >= lim) break;
        attempts++;
        if (attempts > 1 && (attempts - 1) % Math.max(1, cfg.longEvery) === 0) {
          await pacedSleep(rnd(cfg.longMin, cfg.longMax) * 1000);
        }
        const go = await processCard(x, step, meta);
        if (!go || S.risk) break outer;
        await pacedSleep(rnd(cfg.gapMin, cfg.gapMax) * 1000);
      }
      if (st.ok >= lim) donePlatforms.add(step.platform);
    }

    S.running = false;
    if (!S.stopReason) S.stopReason = "计划执行完毕";
    S.cur = S.risk ? "已自动停止，等待本人处理" : "任务结束";
    persist(); render();
  }

  /* ---------- 按钮 ---------- */
  $("scope").addEventListener("change", async () => {
    if (S && S.running) return;
    scope = $("scope").value;
    await AA.set({ uiScope: scope });
    render();
  });
  $("start").addEventListener("click", () => { start(); });
  $("pause").addEventListener("click", () => {
    S.paused = !S.paused;
    addLog(row({ 平台: "系统", 状态: S.paused ? "已暂停" : "继续运行", 是否成功: "—" }));
  });
  $("stop").addEventListener("click", () => softStop("用户手动停止"));
  $("export").addEventListener("click", () => AA.downloadCSV(S.logs, "投递台账.csv"));
  $("clear").addEventListener("click", () => {
    if (!confirm("确定清空台账、去重记录与统计？此操作不可撤销（不影响已经投递出去的简历）。")) return;
    S.logs = []; S.seen = new Set(); S.stats = {}; S.fail = 0;
    S.risk = ""; S.stopReason = "";
    persist(); render();
  });
  $("reloadCfg").addEventListener("click", async () => {
    cfg = await AA.loadCfg();
    if (S) { S.dryRun = !!cfg.dryRun; render(); }
    addLog(row({ 平台: "系统", 状态: "配置已重载（关键词 " + cfg.keywords.length + " 个，屏蔽词 " + cfg.excludeWords.length + " 个）", 是否成功: "—" }));
  });

  (async function init() {
    cfg = await AA.loadCfg();
    S = blankState();
    const d = await AA.get(["logs", "seen", "uiScope"]);
    if (d.uiScope === "all" || AA.PLATFORM_ORDER.includes(d.uiScope)) scope = d.uiScope;
    S.logs = d.logs || [];
    S.seen = new Set(d.seen || []);
    S.dryRun = !!cfg.dryRun;
    render();
  })();
})();
