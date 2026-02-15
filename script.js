(() => {
  const TRACKERS_KEY = "pa_trackers_v3";
  const SETTINGS_KEY = "pa_settings_v3";
  const SESSION_KEY = "ai_price_alert_session";
  const CURRENCY_KEY = "pa_currency";

  const state = {
    step: 1,
    draftUrl: "",
    trackers: [],
    filter: "all",
    search: "",
    sort: "date",
    selected: new Set(),
    timePeriod: "7d"
  };

  const el = (id) => document.getElementById(id);

  const byId = {
    urlInput: el("urlInput"),
    targetPrice: el("targetPrice"),
    priceStep: el("priceStep"),
    mainBtn: el("mainBtn"),
    trackersList: el("trackers-list"),
    toast: el("toast"),
    toastMsg: el("toastMsg"),
    toastTitle: el("toast-title"),
    bulkActions: el("bulk-actions"),
    selectedCount: el("selected-count")
  };

  function getCurrency() {
    return localStorage.getItem(CURRENCY_KEY) || "INR ₹";
  }

  function currencySymbol() {
    const value = getCurrency();
    const map = { "INR ₹": "₹", "USD $": "$", "GBP £": "£", "EUR €": "€" };
    return map[value] || "₹";
  }

  function formatMoney(num) {
    const n = Number(num || 0);
    return `${currencySymbol()}${n.toLocaleString()}`;
  }

  function showToast(message, title = "Success!") {
    if (!byId.toast) return;
    byId.toastTitle.textContent = title;
    byId.toastMsg.textContent = message;
    byId.toast.classList.add("show");
    setTimeout(() => byId.toast?.classList.remove("show"), 2500);
  }

  function saveTrackers() {
    localStorage.setItem(TRACKERS_KEY, JSON.stringify(state.trackers));
  }

  function loadTrackers() {
    try {
      state.trackers = JSON.parse(localStorage.getItem(TRACKERS_KEY) || "[]");
    } catch {
      state.trackers = [];
    }
  }

  function applySessionGuard() {
    const sessionRaw = localStorage.getItem(SESSION_KEY);
    if (!sessionRaw) {
      showToast("Tip: Use signup/signin flow to persist account session.", "Demo Mode");
    }
  }

  function updateStats() {
    const all = state.trackers.length;
    const reached = state.trackers.filter((t) => t.currentPrice <= t.targetPrice).length;
    const active = all - reached;

    el("count-all").textContent = all;
    el("count-active").textContent = active;
    el("count-reached").textContent = reached;

    el("total-trackers").textContent = all;
    el("active-deals").textContent = reached;

    const avgSavings = all
      ? Math.round(
          state.trackers.reduce((acc, t) => {
            if (!t.originalPrice) return acc;
            return acc + ((t.originalPrice - t.currentPrice) / t.originalPrice) * 100;
          }, 0) / all
        )
      : 0;

    el("avg-savings").textContent = `${Math.max(avgSavings, 0)}%`;
    el("sidebar-active-trackers").textContent = active;
    el("sidebar-deals").textContent = reached;
  }

  function filteredTrackers() {
    let list = [...state.trackers];

    if (state.filter === "active") list = list.filter((t) => t.currentPrice > t.targetPrice);
    if (state.filter === "reached") list = list.filter((t) => t.currentPrice <= t.targetPrice);

    const q = state.search.trim().toLowerCase();
    if (q) list = list.filter((t) => t.name.toLowerCase().includes(q) || t.url.toLowerCase().includes(q));

    if (state.sort === "name") list.sort((a, b) => a.name.localeCompare(b.name));
    if (state.sort === "price") list.sort((a, b) => a.currentPrice - b.currentPrice);
    if (state.sort === "date") list.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    return list;
  }

  function drawChart(points) {
    const canvas = el("priceChart");
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    const dpr = window.devicePixelRatio || 1;
    const width = canvas.clientWidth || 600;
    const height = canvas.clientHeight || 260;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx.scale(dpr, dpr);

    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = "#f4f8ff";
    ctx.fillRect(0, 0, width, height);

    if (!points.length) return;

    const pad = 28;
    const min = Math.min(...points);
    const max = Math.max(...points);
    const span = Math.max(max - min, 1);

    ctx.strokeStyle = "#b8cff8";
    ctx.lineWidth = 1;
    for (let i = 0; i < 4; i++) {
      const y = pad + ((height - pad * 2) / 3) * i;
      ctx.beginPath();
      ctx.moveTo(pad, y);
      ctx.lineTo(width - pad, y);
      ctx.stroke();
    }

    const xStep = (width - pad * 2) / (points.length - 1 || 1);

    ctx.beginPath();
    points.forEach((p, i) => {
      const x = pad + i * xStep;
      const y = height - pad - ((p - min) / span) * (height - pad * 2);
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    });

    ctx.strokeStyle = "#1b67ff";
    ctx.lineWidth = 3;
    ctx.stroke();

    const last = points[points.length - 1];
    const lx = pad + (points.length - 1) * xStep;
    const ly = height - pad - ((last - min) / span) * (height - pad * 2);
    ctx.fillStyle = "#10b983";
    ctx.beginPath();
    ctx.arc(lx, ly, 5, 0, Math.PI * 2);
    ctx.fill();
  }

  function showTrend(trackerId) {
    const tracker = state.trackers.find((t) => t.id === trackerId);
    if (!tracker) return;

    const points = tracker.history?.map((h) => h.price) || [tracker.originalPrice, tracker.currentPrice];
    drawChart(points);

    el("product-preview").querySelector("h3").textContent = tracker.name;
    el("product-preview").querySelector("p").textContent = tracker.url;

    el("original-price").textContent = formatMoney(tracker.originalPrice);
    el("current-price").textContent = formatMoney(tracker.currentPrice);
    el("savings-amount").textContent = formatMoney(Math.max(0, tracker.originalPrice - tracker.currentPrice));

    el("trend-lowest").textContent = formatMoney(Math.min(...points));
    el("trend-highest").textContent = formatMoney(Math.max(...points));
    el("trend-since").textContent = new Date(tracker.createdAt).toLocaleDateString();

    const dropPct = Math.round(((tracker.originalPrice - tracker.currentPrice) / tracker.originalPrice) * 100);
    el("prediction-text").textContent = dropPct >= 8 ? "Likely best buy window in next 48h." : "Hold. Small additional drop possible.";
    el("confidence").textContent = `${Math.max(58, Math.min(93, 65 + dropPct))}%`;

    const buyBtn = el("buy-now-btn");
    buyBtn.style.display = "inline-flex";
    buyBtn.onclick = () => window.open(tracker.url, "_blank");

    switchView("price-trends");
  }

  function cardTemplate(t) {
    const reached = t.currentPrice <= t.targetPrice;
    return `
      <div class="tracker-card">
        <label class="checkbox-label"><input type="checkbox" data-check="${t.id}"> Select</label>
        <h4>${t.name}</h4>
        <div class="tracker-meta">Target: <strong>${formatMoney(t.targetPrice)}</strong></div>
        <div class="tracker-meta">Current: <strong>${formatMoney(t.currentPrice)}</strong> ${reached ? "<span style='color:#0fa776'>Target Reached</span>" : ""}</div>
        <div class="tracker-meta">Added: ${new Date(t.createdAt).toLocaleString()}</div>
        <div class="tracker-actions">
          <button class="icon-btn" data-trend="${t.id}"><i class="fa fa-line-chart"></i></button>
          <button class="icon-btn" data-refresh="${t.id}"><i class="fa fa-refresh"></i></button>
          <button class="icon-btn" data-remove="${t.id}"><i class="fa fa-trash"></i></button>
        </div>
      </div>
    `;
  }

  function bindTrackerEvents() {
    document.querySelectorAll("[data-trend]").forEach((btn) => {
      btn.addEventListener("click", () => showTrend(btn.getAttribute("data-trend")));
    });

    document.querySelectorAll("[data-refresh]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const id = btn.getAttribute("data-refresh");
        const t = state.trackers.find((x) => x.id === id);
        if (!t) return;
        const volatility = t.currentPrice * (Math.random() * 0.08 - 0.045);
        t.currentPrice = Math.max(1, Math.round(t.currentPrice + volatility));
        t.history.push({ at: new Date().toISOString(), price: t.currentPrice });
        saveTrackers();
        renderTrackers();
        showToast("Price refreshed");
      });
    });

    document.querySelectorAll("[data-remove]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const id = btn.getAttribute("data-remove");
        state.trackers = state.trackers.filter((t) => t.id !== id);
        state.selected.delete(id);
        saveTrackers();
        renderTrackers();
        showToast("Tracker removed");
      });
    });

    document.querySelectorAll("[data-check]").forEach((box) => {
      box.checked = state.selected.has(box.getAttribute("data-check"));
      box.addEventListener("change", () => {
        const id = box.getAttribute("data-check");
        if (box.checked) state.selected.add(id);
        else state.selected.delete(id);
        refreshBulkActions();
      });
    });
  }

  function refreshBulkActions() {
    const count = state.selected.size;
    byId.selectedCount.textContent = `${count} selected`;
    byId.bulkActions.style.display = count ? "flex" : "none";
  }

  function renderTrackers() {
    const list = filteredTrackers();

    if (!list.length) {
      byId.trackersList.innerHTML = `
        <div class="empty-state">
          <i class="fa fa-rocket"></i>
          <h3>No trackers found</h3>
          <p>Add an alert from New Alert or adjust search/filter.</p>
          <button class="action-btn" onclick="switchView('new-alert')">Create Tracker</button>
        </div>
      `;
    } else {
      byId.trackersList.innerHTML = list.map(cardTemplate).join("");
      bindTrackerEvents();
    }

    updateStats();
    refreshBulkActions();
  }

  function isValidProductUrl(url) {
    try {
      const u = new URL(url);
      return ["http:", "https:"].includes(u.protocol);
    } catch {
      return false;
    }
  }

  function extractName(url) {
    try {
      const host = new URL(url).hostname.replace("www.", "");
      return `Tracked Product • ${host}`;
    } catch {
      return "Tracked Product";
    }
  }

  window.handleFlow = function handleFlow() {
    const url = byId.urlInput.value.trim();
    if (state.step === 1) {
      if (!isValidProductUrl(url)) {
        showToast("Paste a valid product URL", "Invalid URL");
        return;
      }
      state.draftUrl = url;
      state.step = 2;
      byId.priceStep.style.display = "block";
      byId.mainBtn.textContent = "Create Price Alert";
      byId.targetPrice.focus();
      return;
    }

    const target = Number(byId.targetPrice.value);
    if (!target || target <= 0) {
      showToast("Enter a valid target price", "Missing Price");
      return;
    }

    const current = Math.max(target + Math.round(target * (0.08 + Math.random() * 0.35)), 1);
    const tracker = {
      id: `trk_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      url: state.draftUrl,
      name: extractName(state.draftUrl),
      targetPrice: Math.round(target),
      originalPrice: current,
      currentPrice: current,
      createdAt: new Date().toISOString(),
      history: Array.from({ length: 8 }).map((_, i) => ({
        at: new Date(Date.now() - (7 - i) * 86400000).toISOString(),
        price: Math.max(1, Math.round(current - i * (Math.random() * 5)))
      }))
    };

    state.trackers.unshift(tracker);
    saveTrackers();

    byId.urlInput.value = "";
    byId.targetPrice.value = "";
    byId.priceStep.style.display = "none";
    byId.mainBtn.textContent = "Start AI Tracking";
    state.step = 1;
    state.draftUrl = "";

    renderTrackers();
    showToast("Price tracker created");
    switchView("my-trackers");
  };

  window.filterTrackers = function filterTrackers() {
    state.search = el("tracker-search").value;
    renderTrackers();
  };

  window.sortTrackers = function sortTrackers() {
    state.sort = el("sort-trackers").value;
    renderTrackers();
  };

  window.setFilter = function setFilter(filter) {
    state.filter = filter;
    document.querySelectorAll(".filter-tab").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.filter === filter);
    });
    renderTrackers();
  };

  window.switchView = function switchView(viewName) {
    document.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));
    document.querySelectorAll(".nav-item").forEach((n) => n.classList.remove("active"));
    el(`view-${viewName}`)?.classList.add("active");
    document.querySelector(`.nav-item[data-view="${viewName}"]`)?.classList.add("active");
  };

  window.deleteSelected = function deleteSelected() {
    if (!state.selected.size) return;
    state.trackers = state.trackers.filter((t) => !state.selected.has(t.id));
    state.selected.clear();
    saveTrackers();
    renderTrackers();
    showToast("Selected trackers deleted");
  };

  window.exportTrackers = function exportTrackers() {
    const blob = new Blob([JSON.stringify(state.trackers, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "trackers.json";
    a.click();
    URL.revokeObjectURL(a.href);
  };

  window.setTimePeriod = function setTimePeriod(period) {
    state.timePeriod = period;
    document.querySelectorAll(".time-btn").forEach((btn) => {
      btn.classList.toggle("active", btn.textContent.startsWith(period.replace("d", "")));
    });
    showToast(`Switched to ${period} trend view`);
  };

  window.saveSettings = function saveSettings() {
    const payload = {
      push: !!el("push-notifications")?.checked,
      email: !!el("email-alerts")?.checked,
      compact: !!el("compact-view")?.checked,
      refresh: el("refresh-interval")?.value,
      autoDelete: el("auto-delete")?.value,
      dropPercentage: el("drop-percentage")?.value,
      sitePreference: el("site-preference")?.value,
      darkMode: !!el("dark-mode")?.checked
    };
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(payload));
    showToast("Settings saved");
  };

  window.toggleTheme = function toggleTheme() {
    const dark = !!el("dark-mode")?.checked;
    if (dark) {
      document.documentElement.style.setProperty("--bg", "#0b1324");
      document.documentElement.style.setProperty("--bg-2", "#111f37");
      document.documentElement.style.setProperty("--panel", "rgba(17, 30, 53, 0.9)");
      document.documentElement.style.setProperty("--text", "#e9f2ff");
      document.documentElement.style.setProperty("--muted", "#9ab0cf");
    } else {
      document.documentElement.style.setProperty("--bg", "#f2f7ff");
      document.documentElement.style.setProperty("--bg-2", "#e9f2ff");
      document.documentElement.style.setProperty("--panel", "rgba(255, 255, 255, 0.88)");
      document.documentElement.style.setProperty("--text", "#17263f");
      document.documentElement.style.setProperty("--muted", "#6f7f98");
    }
    saveSettings();
  };

  window.connectTelegram = function connectTelegram() {
    showToast("Telegram integration placeholder");
  };

  window.connectWhatsApp = function connectWhatsApp() {
    showToast("WhatsApp integration placeholder");
  };

  window.exportData = window.exportTrackers;

  window.importData = function importData(input) {
    const file = input.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const imported = JSON.parse(String(reader.result));
        if (!Array.isArray(imported)) throw new Error("bad format");
        state.trackers = imported;
        saveTrackers();
        renderTrackers();
        showToast("Data imported");
      } catch {
        showToast("Invalid backup file", "Import Failed");
      }
    };
    reader.readAsText(file);
    input.value = "";
  };

  window.clearAllData = function clearAllData() {
    if (!confirm("Delete all trackers?")) return;
    state.trackers = [];
    state.selected.clear();
    saveTrackers();
    renderTrackers();
    showToast("All data cleared");
  };

  window.saveCurrencyPreference = function saveCurrencyPreference() {
    const value = el("currency-select")?.value || "INR ₹";
    localStorage.setItem(CURRENCY_KEY, value);
    renderTrackers();
    showToast("Currency updated");
  };

  function restoreSettings() {
    try {
      const cfg = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}");
      if (typeof cfg.push === "boolean") el("push-notifications").checked = cfg.push;
      if (typeof cfg.email === "boolean") el("email-alerts").checked = cfg.email;
      if (typeof cfg.compact === "boolean") el("compact-view").checked = cfg.compact;
      if (cfg.refresh) el("refresh-interval").value = cfg.refresh;
      if (cfg.autoDelete) el("auto-delete").value = cfg.autoDelete;
      if (cfg.dropPercentage) el("drop-percentage").value = cfg.dropPercentage;
      if (cfg.sitePreference) el("site-preference").value = cfg.sitePreference;
      if (typeof cfg.darkMode === "boolean") {
        el("dark-mode").checked = cfg.darkMode;
        if (cfg.darkMode) toggleTheme();
      }
    } catch {
      // ignore
    }

    const cur = localStorage.getItem(CURRENCY_KEY);
    if (cur && el("currency-select")) el("currency-select").value = cur;
  }

  document.querySelectorAll(".nav-item").forEach((item) => {
    item.addEventListener("click", () => switchView(item.dataset.view));
  });

  loadTrackers();
  restoreSettings();
  applySessionGuard();
  renderTrackers();
  drawChart([]);
})();
