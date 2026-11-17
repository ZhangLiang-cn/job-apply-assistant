/* 注入到招聘网站页面的执行入口。
   每次注入只做一件由总控台下发的事：scan / apply / detailApply / nextPage，
   完成后把结果广播回扩展（chrome.runtime），总控台按 seq 匹配。
   注意：本文件只做 DOM 层面的模拟点击，不 fetch、不调用任何平台接口。 */
(async () => {
  "use strict";
  const C = window.__AA_COMMON;
  if (!C || !window.__AA_ADAPTERS) {
    chrome.runtime.sendMessage({ type: "AA_RESULT", seq: -1, ok: false, error: "公共模块未加载" }).catch(() => {});
    return;
  }
  const store = await chrome.storage.local.get("job");
  const job = store.job;
  if (!job || !job.seq) return;
  if (window.__AA_LAST_SEQ === job.seq) return; // 同一页面重复注入时防重入
  window.__AA_LAST_SEQ = job.seq;

  const send = payload => chrome.runtime.sendMessage(
    Object.assign({ type: "AA_RESULT", seq: job.seq, platform: job.platform, mode: job.mode }, payload)
  ).catch(() => {});
  // 兜底：页面弹窗/原生文件框偶尔会让 await 永久挂起，20 秒后主动放弃等待，
  // 避免总控台再等 40 秒才报「页面脚本执行超时」。超时后不会补发任何点击。
  const withTimeout = (p, ms, label) => Promise.race([
    Promise.resolve(p),
    new Promise(r => setTimeout(() => r({ ok: false, status: label + "超时，已停止等待" }), ms))
  ]);

  // 动作前先做风控检测：命中则一个像素都不点
  const riskBefore = C.detectRisk();
  if (riskBefore) { send({ ok: false, risk: riskBefore, status: "风控命中，未执行任何操作" }); return; }

  const ad = window.__AA_ADAPTERS[job.platform];
  if (!ad) { send({ ok: false, error: "未知平台 " + job.platform }); return; }

  const ctx = { dryRun: !!job.dryRun, cfg: job.cfg || {}, keyword: job.keyword || "" };
  let out;
  try {
    if (job.mode === "scan") {
      const r = await ad.scan();
      out = { ok: true, cards: r.cards || [], note: r.note || "" };
    } else if (job.mode === "apply") {
      // 演练模式下由 adapter 自己保证不点最终投递按钮
      out = await withTimeout(ad.apply(job.card, ctx), 20000, "投递处理");
    } else if (job.mode === "detailApply") {
      out = await withTimeout(
        ad.applyDetail ? ad.applyDetail(job.card, ctx) : ad.apply(job.card, ctx),
        20000, "投递处理"
      );
    } else if (job.mode === "nextPage") {
      out = { ok: !!ad.nextPage(), next: true };
    } else {
      out = { ok: false, error: "未知模式 " + job.mode };
    }
  } catch (e) {
    out = { ok: false, error: String(e && e.stack || e).slice(0, 400) };
  }

  // 动作后再检测一次风控（弹窗/跳转/额度提示都可能在此刻出现）
  const riskAfter = C.detectRisk();
  if (riskAfter) out.risk = riskAfter;
  send(out);
})();
