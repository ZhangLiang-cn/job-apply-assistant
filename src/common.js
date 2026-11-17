/* 页面侧公共能力：薪资解析（含 BOSS PUA 加密字体解码）、风控检测、
   模拟人工点击/滚动、浮层清理。注入到招聘网站的 isolated world 中运行。 */
(function () {
  "use strict";

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const rnd = (a, b) => Math.floor(a + Math.random() * (b - a + 1));
  const norm = s => String(s || "").replace(/\u00a0/g, " ").replace(/[\ue000-\uf8ff]/g, "").replace(/\s+/g, " ").trim();
  const text = el => norm(el && (el.innerText != null ? el.innerText : el.textContent));

  const PUA_START = 0xE000, PUA_END = 0xF8FF;

  /* BOSS 直聘薪资用私有区字形替换数字。整页统一校准零点 z：
     枚举候选 z，统计能解出「合理薪资区间」的条数，并偏好整 5 薪档 + 12~20 薪。 */
  function calibratePua(raws) {
    const codes = (raws || []).flatMap(s => [...String(s || "")].map(c => c.codePointAt(0)))
      .filter(v => v >= PUA_START && v <= PUA_END);
    if (!codes.length) return null;
    const lo = Math.min(...codes), hi = Math.max(...codes);
    let best = { z: 0xE031, n: 0, sane: 0, score: -1 };
    for (let z = lo - 3; z <= hi + 1; z++) {
      let n = 0, sane = 0;
      for (const s of raws) {
        const out = decodePua(s, z);
        const m = String(out || "").match(/^(\d{1,3})\s*-\s*(\d{1,3})K(?:·(\d{1,2})薪)?/);
        if (m && +m[1] >= 3 && +m[2] <= 200 && +m[1] <= +m[2]) {
          n++;
          const months = m[3] ? +m[3] : 0;
          const monthOK = !months || (months >= 12 && months <= 20);
          const roundOK = (+m[1] % 5 === 0) && (+m[2] % 5 === 0);
          if (monthOK && roundOK) sane++;
        }
      }
      const score = sane * 10 + n;
      if (score > best.score) best = { z, n, sane, score };
    }
    return best.n ? best : null;
  }

  function decodePua(s, z) {
    if (z == null) return String(s || "");
    return [...String(s || "")].map(c => {
      const v = c.codePointAt(0), d = v - z;
      return (v >= PUA_START && v <= PUA_END && d >= 0 && d <= 9) ? String(d) : c;
    }).join("").replace(/[\ue000-\uf8ff]/g, "");
  }

  /* 统一换算成 K / 月。支持：
     1.5-2.5万 / 2-3.5万·15薪 / 8千-1.2万 / 20-40k / 1.2-2.4万元/月 / 25K-40K·14薪 / 30万/年 / 2万以上 */
  function parseSalary(raw, z) {
    const s = norm(z != null ? decodePua(raw, z) : raw);
    if (!s) return null;
    const yearly = /\/年|年薪|年\s*薪/.test(s);
    const conv = (v, u) => {
      const n = parseFloat(v);
      if (!isFinite(n)) return NaN;
      if (u === "万") return n * 10;
      if (u === "千" || u === "k" || u === "K") return n;
      if (u === "元") return n / 1000;
      return n;
    };
    let lo, hi;
    const m = s.match(/([\d.]+)\s*(万|千|k|K|元)?\s*[-~至]\s*([\d.]+)\s*(万|千|k|K|元)/);
    if (m) {
      const unitHi = m[4];
      const unitLo = m[2] || unitHi;
      lo = conv(m[1], unitLo);
      hi = conv(m[3], unitHi);
    } else {
      const one = s.match(/([\d.]+)\s*(万|千|k|K|元)\s*(?:以上|起|及以上|\+)/);
      if (one) { lo = hi = conv(one[1], one[2]); }
      else {
        const nums = [...s.matchAll(/([\d.]+)\s*(万|千|k|K|元)/g)].map(x => conv(x[1], x[2]));
        if (!nums.length) return null;
        lo = Math.min(...nums); hi = Math.max(...nums);
      }
    }
    if (!isFinite(lo) || !isFinite(hi)) return null;
    if (yearly) { lo /= 12; hi /= 12; }
    if (lo > hi) [lo, hi] = [hi, lo];
    if (!(lo >= 1 && hi <= 300)) return null;
    return { lo: +lo.toFixed(2), hi: +hi.toFixed(2), text: s };
  }

  /* 风控硬停止检测：命中即整任务停止，不做任何点击、不尝试绕过。 */
  const RISK_RE = /(安全验证|人机验证|图形验证码|请输入验证码|拖动滑块|请按住滑块|滑块验证|拖动到最右边|访问频繁|操作过于频繁|账号异常|行为异常|账号行为异常|打招呼太频繁|沟通机会已用完|沟通次数已用完|今日沟通已达上限|沟通次数已达|您已达到沟通上限|投递过于频繁|今日投递已达|投递次数已达|今日投递已超过上限|已达上限|请稍后再试|今日已达|明天再试|明天再来|请登录后再试|登录已失效)/;
  const RISK_URL = /captcha|verify|security_check|safe\.liepin\.com|captchaPage|_security_check/i;

  function detectRisk() {
    const url = location.href || "";
    if (RISK_URL.test(url)) return "风控页面跳转: " + url.slice(0, 120);
    const body = norm(document.body && document.body.innerText).slice(0, 20000);
    const m = body.match(RISK_RE);
    if (m) {
      const i = body.indexOf(m[0]);
      return body.slice(Math.max(0, i - 20), i + 60);
    }
    return "";
  }

  /* 模拟人工点击：滚动到视口 → hover → 按下/松开 → 原生 click。
     只调用一次 click，避免重复触发投递。 */
  async function simulateClick(el) {
    if (!el) return false;
    // 用 instant 而非 smooth：平滑滚动在弹窗/iframe 里偶尔会让后续 click 卡住
    try { el.scrollIntoView({ block: "center", behavior: "auto" }); } catch (_) {}
    await sleep(rnd(260, 620));
    const r = el.getBoundingClientRect();
    const opt = { bubbles: true, cancelable: true, view: window, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
    for (const t of ["mouseover", "mousemove", "mousedown"]) {
      try { el.dispatchEvent(new MouseEvent(t, opt)); } catch (_) {}
      await sleep(rnd(40, 110));
    }
    try { el.dispatchEvent(new MouseEvent("mouseup", opt)); } catch (_) {}
    await sleep(rnd(60, 140));
    el.click();
    return true;
  }

  async function humanScroll() {
    const y = rnd(80, 320) * (Math.random() < 0.5 ? -1 : 1);
    try { window.scrollBy({ top: y, behavior: "smooth" }); } catch (_) {}
    await sleep(rnd(260, 620));
  }

  /* 清理各平台投递成功后的确认弹窗与遮罩（实测选择器）。
     注意：只隐藏遮罩，不会去点击任何验证码 / 滑块相关元素。 */
  function closeOverlays(extraSelectors, opts) {
    const base = [
      ".success-popup", ".v-modal", ".chat-block-layer", ".chat-block-dialog",
      ".deliver-greeting-modal", ".deliver-greeting-modal__wrapper",
      ".banner-drawer__mask", ".banner-drawer__panel", ".s-dialog__overlay",
      "[class*=modal__mask]", "[class*=dialog__mask]", ".el-dialog__wrapper"
    ].concat(extraSelectors || []);
    let n = 0;
    base.forEach(sel => {
      document.querySelectorAll(sel).forEach(e => {
        n++;
        e.style.display = "none";
        e.style.pointerEvents = "none";
      });
    });
    // BOSS 的「上传简历」弹窗里盲点「确定」会触发原生文件选择框，导致页面脚本永久挂起。
    // 这类平台传 { noClick: true }，只隐藏浮层，不点任何按钮。
    if (opts && opts.noClick) return n;
    // 弹窗内的「留在此页 / 好 / 我知道了」属于正常确认按钮，可以点
    const closer = /^(留在此页|好|我知道了|确定|关闭)$/;
    [...document.querySelectorAll(".chat-block-dialog *, .el-dialog__wrapper *, [class*=dialog] *, [class*=modal] *")]
      .filter(e => e.children.length === 0 && closer.test(text(e)))
      .slice(0, 3)
      .forEach(e => { try { e.click(); } catch (_) {} });
    return n;
  }

  function byText(selector, words) {
    const list = [...document.querySelectorAll(selector)];
    return list.find(e => words.some(w => text(e).includes(w))) || null;
  }

  window.__AA_COMMON = {
    sleep, rnd, norm, text,
    calibratePua, decodePua, parseSalary,
    detectRisk,
    simulateClick, humanScroll, closeOverlays, byText
  };
})();
