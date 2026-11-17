/* 极简 Service Worker：只负责初始化存储。
   长任务调度全部放在常驻的 console.html 页面里，避免 SW 被浏览器回收导致任务中断。 */
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get(["cfg", "logs", "seen", "state"], d => {
    const patch = {};
    if (!d.cfg) patch.cfg = null;            // 由 popup / console 首次加载时套用默认值
    if (!Array.isArray(d.logs)) patch.logs = [];
    if (!Array.isArray(d.seen)) patch.seen = [];
    if (!d.state) patch.state = { running: false, paused: false, stopReason: "" };
    if (!d.uiScope) patch.uiScope = "all";
    if (Object.keys(patch).length) chrome.storage.local.set(patch);
  });
});

// 风控硬停止时给一个系统通知，方便用户及时回来手动处理
chrome.runtime.onMessage.addListener(msg => {
  if (msg && msg.type === "AA_HARD_STOP" && msg.reason) {
    try {
      chrome.notifications.create("aa-risk-" + Date.now(), {
        type: "basic",
        iconUrl: "icon128.png",
        title: "投递任务已自动停止",
        message: "检测到平台风控 / 额度提示：" + String(msg.reason).slice(0, 110) + "。请本人手动处理后重新运行，插件不会自动绕过。",
        priority: 2
      });
    } catch (_) {}
  }
});
