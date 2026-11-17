/* 五平台适配层。按当前招聘网站页面结构编写；平台改版后，DOM 选择器可能需要维护。
   统一接口：
     scan()                -> {cards:[{i,title,salary:{lo,hi,text},company,city,href,...}], note}
     apply(card, ctx)      -> {ok, status, skip?, dry?}   mode=list 平台，在当前搜索页完成
     applyDetail(card,ctx) -> {ok, status, skip?, dry?}   mode=detail 平台，已导航到岗位详情页
     nextPage()            -> boolean                      仅 51Job 有实测 UI 翻页
   ctx = { dryRun, cfg, keyword }
   演练（dryRun）模式会走完「扫描 → 打开详情 → 识别投递按钮」，但绝不触发最终投递点击。 */
(function () {
  "use strict";
  const C = window.__AA_COMMON;
  const { sleep, rnd, norm, text, parseSalary, calibratePua, simulateClick, humanScroll, closeOverlays } = C;

  function findClickable(words, root) {
    const els = [...(root || document).querySelectorAll("button,a,[role=button],span,div")];
    return els.find(e => {
      if (e.children.length > 2) return false;
      const t = text(e);
      if (!t || t.length > 14 || !words.some(w => t.includes(w))) return false;
      const r = e.getBoundingClientRect();
      return r.width > 30 && r.height > 16 && getComputedStyle(e).visibility !== "hidden";
    }) || null;
  }

  function result(ok, status, extra) { return Object.assign({ ok, status }, extra || {}); }

  /* ---------------- 1. BOSS 直聘 ---------------- */
  /* 点击「立即沟通」后 BOSS 有两条分支：
     A. 弹出招呼语编辑框，需要点「发送」才真正发出；
     B. 弹出简历选择框，需要点「发送在线简历」；若只能上传附件则跳过，绝不误点「确定」触发文件选择框。
     旧版只等页面文案变化，既不点弹窗按钮又盲点「确定」，导致 40 秒超时。 */
  async function bossAfterChat() {
    const visible = el => {
      if (!el) return false;
      const s = getComputedStyle(el);
      return s.display !== "none" && s.visibility !== "hidden" && el.getBoundingClientRect().width > 0;
    };
    const dlgSel = ".dialog-wrap,[role=dialog],[class*=chat-dialog],[class*=resume-dialog],[class*=dialog-container]";
    const dialogs = () => [...document.querySelectorAll(dlgSel)].filter(visible);
    const dialogText = () => dialogs().map(d => norm(d.innerText || d.textContent || "")).join(" ");
    const pick = words => {
      for (const d of dialogs()) {
        for (const e of d.querySelectorAll("button,a,[role=button],span,div")) {
          if (!visible(e) || e.children.length > 1) continue;
          const t = text(e);
          if (!t || t.length > 16) continue;
          if (words.some(w => t === w || (w.length >= 4 && t.includes(w)))) return e;
        }
      }
      // 聊天侧栏里的发送按钮（不在 dialog-wrap 内）
      const scope = [...document.querySelectorAll("[class*=chat-],[class*=im-]")].filter(visible);
      for (const s of scope) {
        const e = [...s.querySelectorAll("button,a,[role=button]")]
          .find(x => visible(x) && x.children.length === 0 && words.includes(text(x)));
        if (e) return e;
      }
      return null;
    };
    const sent = () => {
      const body = norm(document.body.innerText || "").slice(0, 20000);
      return /已向BOSS发送消息|发送成功|投递成功/.test(body) ||
        text(document.querySelector("a.op-btn-chat")) === "继续沟通";
    };

    await sleep(rnd(700, 1200));
    if (sent()) return result(true, "已发送招呼语");

    // 先处理简历选择框；只有「上传附件简历」而没有在线简历入口时安全跳过
    const online = pick(["发送在线简历", "在线简历发送", "发送我的在线简历", "EXPORT发送在线简历"]);
    if (online) {
      await simulateClick(online);
      await sleep(rnd(800, 1300));
    } else if (/上传附件简历|拖拽文件到这里/.test(dialogText())) {
      return result(false, "SKIP:需人工上传附件简历", { skip: true });
    }

    // 招呼语编辑框：精确点发送类按钮，不点「确定 / 上传 / 附件」
    const send = pick(["发送招呼语", "立即发送", "确认发送", "发送"]);
    if (send) {
      await simulateClick(send);
      await sleep(rnd(1000, 1600));
    }
    await sleep(rnd(500, 900));
    if (sent()) return result(true, "已发送招呼语");
    if (/上传附件简历|拖拽文件到这里/.test(dialogText())) {
      return result(false, "SKIP:需人工上传附件简历", { skip: true });
    }
    return result(false, "投递未确认（弹窗已处理）");
  }

  const boss = {
    name: "BOSS直聘", mode: "list",
    async scan() {
      await humanScroll();
      // 注意：薪资字段必须用原始 innerText 保留 PUA 私有区字符，不能用 text()（norm 会删除 PUA 导致解码失败）
      const rawText = el => el && (el.innerText != null ? el.innerText : el.textContent) || "";
      const cards = [...document.querySelectorAll(".job-card-wrap")].map((el, i) => ({
        i,
        title: text(el.querySelector(".job-title,[class*=job-name],[class*=job-title]")).split("\n")[0] ||
               text(el).split("\n")[0],
        salaryRaw: rawText(el.querySelector(".job-salary")).trim(),
        company: text(el.querySelector(".company-name,[class*=company-name]")).slice(0, 40),
        city: text(el.querySelector(".company-location,.job-area,[class*=company-location]")).slice(0, 24),
        href: (el.querySelector('a[href*="job_detail"]') || {}).href ||
              el.getAttribute("data-jid") || ""
      }));
      // 加密字体：整页统一校准零点，避免逐卡片解码偏移
      const cal = calibratePua(cards.map(c => c.salaryRaw).filter(Boolean));
      const z = cal ? cal.z : null;
      const suspect = !!(cal && cal.n && cal.sane / cal.n < 0.5);
      cards.forEach(c => { c.salary = parseSalary(c.salaryRaw, z); c.salarySuspect = suspect; });
      return { cards, note: cal ? "字体零点 0x" + cal.z.toString(16) + " 合理 " + cal.sane + "/" + cal.n : "薪资为明文" };
    },
    async apply(card, ctx) {
      const el = document.querySelectorAll(".job-card-wrap")[card.i];
      if (!el) return result(false, "卡片已失效", { skip: true });
      const titleEl = el.querySelector(".job-title,[class*=job-name],[class*=job-title]") || el;
      await simulateClick(titleEl);
      await sleep(rnd(900, 1600));
      const btn = document.querySelector("a.op-btn-chat");
      const label = text(btn);
      if (label !== "立即沟通") return result(false, "SKIP:" + (label || "无沟通按钮"), { skip: true });
      if (ctx.dryRun) return result(true, "演练·已识别[立即沟通]，未点击", { dry: true });
      await simulateClick(btn);
      // 弹窗确认链路：发送招呼语 / 发送在线简历 / 需人工上传则跳过；不得盲点「确定」
      const r = await bossAfterChat();
      closeOverlays([
        ".chat-block-layer", ".chat-block-dialog", ".upload-resume-dialog",
        ".upload-select-dialog", "[class*=chat-dialog]"
      ], { noClick: true });
      return r;
    },
    nextPage() { return false; }
  };

  /* ---------------- 2. 智联招聘 ---------------- */
  const zhilian = {
    name: "智联招聘", mode: "list",
    async scan() {
      await humanScroll();
      const cards = [...document.querySelectorAll(".job-card")].map((el, i) => ({
        i,
        title: text(el.querySelector(".job-card__title-main")),
        salaryRaw: text(el.querySelector(".job-card__salary")),
        company: ([...el.querySelectorAll("a")].map(a => text(a))
          .find(s => /公司|集团|中心|研究院|科技/.test(s)) || "").slice(0, 40),
        city: (text(el).match(/(北京|上海|广州|深圳|杭州|成都|南京|武汉|西安|苏州|重庆|天津|长沙|合肥|郑州|东莞|佛山|珠海)/) || [""])[0],
        href: ((el.querySelector('a[href*="job"]') || {}).href || "").slice(0, 200)
      }));
      cards.forEach(c => { c.salary = parseSalary(c.salaryRaw, null); });
      return { cards, note: "薪资明文" };
    },
    async apply(card, ctx) {
      const el = document.querySelectorAll(".job-card")[card.i];
      if (!el) return result(false, "卡片已失效", { skip: true });
      const titleEl = el.querySelector(".job-card__title-main") || el;
      await simulateClick(titleEl);
      await sleep(rnd(900, 1600));
      let btn = document.querySelector(".job-detail-summary__apply");
      let label = text(btn);
      if (!label) { await sleep(900); btn = document.querySelector(".job-detail-summary__apply"); label = text(btn); }
      if (label !== "立即投递") return result(false, "SKIP:" + (label || "无投递按钮"), { skip: true });
      if (ctx.dryRun) return result(true, "演练·已识别[立即投递]，未点击", { dry: true });
      await simulateClick(btn);
      await sleep(rnd(1300, 2000));
      const body = document.body.innerText || "";
      let ok = /投递成功|已向对方发送简历和打招呼语/.test(body) ||
               text(document.querySelector(".job-detail-summary__apply")) === "继续沟通";
      if (!ok) {
        await sleep(1000);
        ok = /投递成功|已向对方发送简历和打招呼语/.test(document.body.innerText || "") ||
             text(document.querySelector(".job-detail-summary__apply")) === "继续沟通";
      }
      closeOverlays([".deliver-greeting-modal", ".deliver-greeting-modal__wrapper", ".banner-drawer__mask"]);
      return result(ok, ok ? "投递成功" : "投递未确认");
    },
    nextPage() { return false; }
  };

  /* ---------------- 3. 猎聘 ---------------- */
  const liepin = {
    name: "猎聘", mode: "detail",
    async scan() {
      await humanScroll();
      const nodes = [...document.querySelectorAll("[class*=jobDetailBox]")];
      const seenHref = new Set();
      const cards = [];
      nodes.forEach((box, i) => {
        const a = box.querySelector('a[href*="liepin.com/a/"], a[href*="liepin.com/job/"], a[href^="/a/"], a[href^="/job/"]') ||
                  (box.matches("a") ? box : null);
        if (!a) return;
        const href = a.href || "";
        if (!href || seenHref.has(href)) return;
        seenHref.add(href);
        const raw = text(box);
        const city = (raw.match(/【\s*([^】]+?)\s*】/) || ["", ""])[1].trim();
        const title = raw.split(/【/)[0].trim().slice(0, 60) || text(a).slice(0, 60);
        const salaryRaw = (raw.match(/\d{1,3}\s*-\s*\d{1,3}\s*[kK](?:·\d{1,2}薪)?/) || [""])[0];
        cards.push({ i: cards.length, title, salaryRaw, salary: parseSalary(salaryRaw, null), city, company: "", href });
      });
      return { cards, note: "详情页两步：聊一聊 → 发简历 → 立即投递" };
    },
    async applyDetail(card, ctx) {
      const visible = el => {
        if (!el) return false;
        const s = getComputedStyle(el), r = el.getBoundingClientRect();
        return s.display !== "none" && s.visibility !== "hidden" && r.width > 0 && r.height > 0;
      };
      // 猎聘详情页主按钮的原生文案就是「继续聊」（次按钮「投简历」），
      // 它是"发起沟通"的入口，绝不能当成"已沟通"跳过——旧版在这里把大量未投递岗位误判为已沟通。
      // 真正的"已投递"标记是 btn-minor 上的「已投递」且带 disabled；以此为准。
      const minor = [...document.querySelectorAll("a.btn-minor")].filter(visible);
      if (minor.some(e => /^已投递$/.test(text(e)))) return result(false, "SKIP:已投递", { skip: true });

      // 沟通入口：优先可见的 btn-main / btn-chat
      const a = [...document.querySelectorAll("a.btn-main,a.btn-chat")].filter(visible)[0];
      if (!a) return result(false, "SKIP:详情页无沟通按钮", { skip: true });
      if (ctx.dryRun) return result(true, "演练·已识别[" + text(a) + "]沟通及发简历链路，未点击", { dry: true });

      await simulateClick(a);
      await sleep(rnd(1200, 1900));

      // 聊天弹窗出现后：①「发简历」(span.im-ui-action-button-title) → ②「发送」按钮。
      // 实测这两个按钮文案是「发简历」和「发送」，不是旧版找的「立即投递」。
      let resumeSent = false;
      const sendResume = findClickable(["发简历", "发送简历", "投递简历"], document);
      if (sendResume) {
        await simulateClick(sendResume);
        await sleep(rnd(900, 1500));
        const sendBtn = findClickable(["立即投递", "发送", "确认投递"], document);
        if (sendBtn) {
          await simulateClick(sendBtn);
          await sleep(rnd(1200, 1800));
          resumeSent = true;
        }
      }

      // 成功判定：以页面出现「已投递」标记为准；或聊天框已显示发出的招呼语/简历。
      const minorAfter = [...document.querySelectorAll("a.btn-minor,a.btn-main")].filter(visible);
      const applied = minorAfter.some(e => /^已投递$/.test(text(e)));
      const body = document.body.innerText || "";
      const greeted = /已向.{0,20}发送|招呼语已发送|简历已发送|投递成功/.test(body);
      const ok = applied || greeted || resumeSent;
      closeOverlays(["[class*=im-ui]"], { noClick: true }); // 只隐藏浮层，绝不点「确定/上传」触发原生文件框
      return result(ok, ok
        ? (applied ? "已投递" : resumeSent ? "已沟通并发简历" : "已发送招呼语")
        : "投递未确认", { note: ok ? "" : "未找到发简历/发送按钮，需人工核对" });
    },
    nextPage() { return false; }
  };

  /* ---------------- 4. 前程无忧 51Job ---------------- */
  const job51 = {
    name: "前程无忧51Job", mode: "list",
    async scan() {
      await humanScroll();
      const cards = [...document.querySelectorAll(".joblist-item")].map((el, i) => {
        const lines = text(el).split(/[\n|]/).map(s => s.trim()).filter(Boolean);
        const salaryRaw = lines.find(l => /[\d.]+\s*[-~]\s*[\d.]+\s*(万|千|k|K|元)/.test(l)) || "";
        return {
          i,
          title: lines[0] || "",
          salaryRaw,
          salary: parseSalary(salaryRaw, null),
          company: lines.find(l => /有限公司|集团|研究院|科技|股份/.test(l)) || "",
          city: (text(el).match(/(北京|上海|广州|深圳|杭州|成都|南京|武汉|西安|苏州|重庆|天津|长沙|合肥|郑州|东莞|佛山|珠海)/) || [""])[0],
          href: ((el.querySelector("a[href]") || {}).href || "").slice(0, 200),
          btn: text(el.querySelector("button"))
        };
      });
      return { cards, note: "列表页直接投递；成功后有 .success-popup + .v-modal 遮罩" };
    },
    async apply(card, ctx) {
      const el = document.querySelectorAll(".joblist-item")[card.i];
      if (!el) return result(false, "卡片已失效", { skip: true });
      const btn = el.querySelector("button");
      const label = text(btn);
      if (label !== "投递") return result(false, "SKIP:" + (label || "无投递按钮"), { skip: true });
      if (ctx.dryRun) return result(true, "演练·已识别[投递]按钮，未点击", { dry: true });
      closeOverlays([".success-popup", ".v-modal"]);
      await simulateClick(btn);
      await sleep(rnd(1200, 1900));
      const body = document.body.innerText || "";
      const ok = /投递成功/.test(body) || text(el.querySelector("button")) === "已申请";
      closeOverlays([".success-popup", ".v-modal"]);
      return result(ok, ok ? "投递成功" : "投递未确认");
    },
    nextPage() {
      const b = document.querySelector(".el-pagination .btn-next, .btn-next");
      if (!b || b.disabled || /disabled/.test(String(b.className))) return false;
      b.click();
      return true;
    }
  };

  /* ---------------- 5. 鱼泡直聘 ---------------- */
  const yupao = {
    name: "鱼泡直聘", mode: "detail",
    async scan() {
      await humanScroll();
      const cards = [...document.querySelectorAll("a.acdce")].map((a, i) => {
        const box = a.closest("div.acbgc") || a.parentElement;
        const raw = text(a);
        const title = text(a.querySelector("div.acbgh")) || raw.split(/\s+/)[0] || "";
        const salaryRaw = text(a.querySelector("span.acbgj")) ||
          (raw.match(/[\d.]+\s*[-~]\s*[\d.]+\s*万?元?\/月/) || [""])[0];
        const boxText = text(box);
        return {
          i,
          title: title.slice(0, 60),
          salaryRaw,
          salary: parseSalary(salaryRaw, null),
          company: (boxText.match(/鱼泡直聘\s*([^\s·]+)/) || ["", ""])[1].slice(0, 40),
          city: (boxText.match(/([\u4e00-\u9fa5]{2,8})·/) || ["", ""])[1],
          href: a.href || ""
        };
      });
      return { cards, note: "详情页投递按钮需按实际页面维护" };
    },
    async applyDetail(card, ctx) {
      const btn = findClickable(["立即投递", "投递简历", "立即沟通", "聊一聊", "免费投递", "联系TA", "申请职位"]);
      if (!btn) return result(false, "SKIP:详情页未识别到投递按钮（需维护 yupao.applyDetail 选择器）", { skip: true });
      const label = text(btn);
      if (ctx.dryRun) return result(true, "演练·已识别[" + label + "]，未点击", { dry: true });
      await simulateClick(btn);
      await sleep(rnd(1200, 2000));
      const ok = /投递成功|已投递|已发送|沟通中/.test(document.body.innerText || "");
      closeOverlays([]);
      return result(ok, ok ? "投递成功" : "投递未确认");
    },
    nextPage() { return false; }
  };

  window.__AA_ADAPTERS = { boss, zhilian, liepin, job51, yupao };
})();
