/* iOS 27 液态玻璃控制器：浓度（通透 ↔ 着色）持久化 + 跨页面同步 + 指针高光。
   v=0 → ultra clear（强折射、几乎全透）；v=100 → fully tinted（着色、接近不透明，可读性最高） */
(function () {
  "use strict";
  const KEY = "glassTint";
  const DEFAULT = 58;
  const root = document.documentElement;
  const hasExt = (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local);
  const ranges = [];

  const get = hasExt
    ? () => new Promise(res => chrome.storage.local.get(KEY, d => res(d[KEY])))
    : () => Promise.resolve(localStorage.getItem(KEY));
  const save = hasExt
    ? v => chrome.storage.local.set({ [KEY]: v })
    : v => localStorage.setItem(KEY, String(v));

  function apply(v) {
    const n = Math.max(0, Math.min(100, Number(v)));
    // 玻璃不透明度 0.18 → 0.94；模糊 28px → 8px；饱和度随通透度略增强
    root.style.setProperty("--glass-alpha", (0.18 + n / 100 * 0.76).toFixed(3));
    root.style.setProperty("--glass-blur", (28 - n / 100 * 20).toFixed(1) + "px");
    root.style.setProperty("--glass-sat", (150 + (100 - n) / 100 * 60).toFixed(0) + "%");
    root.dataset.glassTint = String(Math.round(n));
    ranges.forEach(r => { if (document.activeElement !== r) r.value = String(Math.round(n)); });
  }

  function set(v) { const n = Math.max(0, Math.min(100, Number(v))); apply(n); save(n); }

  // 跟随指针的液体高光（rAF 节流，避免每帧写样式）
  let pending = false, px = 50, py = 0;
  document.addEventListener("pointermove", e => {
    px = e.clientX / Math.max(1, window.innerWidth) * 100;
    py = e.clientY / Math.max(1, window.innerHeight) * 100;
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => {
      root.style.setProperty("--mx", px.toFixed(2) + "%");
      root.style.setProperty("--my", py.toFixed(2) + "%");
      pending = false;
    });
  }, { passive: true });

  // 无障碍：系统开启「降低透明度」时直接切到完全着色
  let forced = false;
  try {
    if (window.matchMedia && window.matchMedia("(prefers-reduced-transparency: reduce)").matches) forced = true;
  } catch (_) {}

  window.AA_GLASS = {
    bind(el) {
      if (!el || ranges.includes(el)) return;
      ranges.push(el);
      el.addEventListener("input", () => set(el.value));
      return el;
    },
    set, apply, get,
    get value() { return Number(root.dataset.glassTint || DEFAULT); }
  };

  // 页面上带 data-glass-tint 的滑块自动接管（popup 与控制台共用同一份浓度）
  document.querySelectorAll("[data-glass-tint]").forEach(el => window.AA_GLASS.bind(el));

  (async () => {
    const v = await get();
    apply(forced ? 100 : (v == null ? DEFAULT : v));
    if (hasExt && chrome.storage.onChanged) {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area === "local" && changes[KEY]) apply(changes[KEY].newValue);
      });
    }
  })();
})();
