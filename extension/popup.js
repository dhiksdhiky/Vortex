(() => {
  "use strict";

  const ENABLED_DOMAINS_KEY = "vortexEnabledDomains";
  const SETTINGS_KEY = "vortexSettings";
  const DEFAULT_SETTINGS = {
    downloadSubfolder: "Vortex",
    autoCategoryFolder: true,
    askWhereToSave: false,
    defaultHoverQuality: "best",
    parallelConnections: 6,
    maxHistoryPerTab: 15,
  };

  const state = {
    tab: null,
    domain: "",
    domainEnabled: false,
    manualScanned: false,
    settingsOpen: false,
    settings: { ...DEFAULT_SETTINGS },
    cards: [],
    mse: { recording: false, videoBytes: 0, audioBytes: 0, hasMediaSource: false },
  };

  const els = {
    detectSummary: document.getElementById("detect-summary"),
    btnDomainToggle: document.getElementById("btn-domain-toggle"),
    domainToggleLabel: document.getElementById("domain-toggle-label"),
    btnScan: document.getElementById("btn-scan"),
    btnClear: document.getElementById("btn-clear"),
    btnSettings: document.getElementById("btn-settings"),
    settingsPanel: document.getElementById("settings-panel"),
    btnCloseSettings: document.getElementById("btn-close-settings"),
    btnSaveSettings: document.getElementById("btn-save-settings"),
    btnResetSettings: document.getElementById("btn-reset-settings"),
    setSubfolder: document.getElementById("set-subfolder"),
    setAutoCategory: document.getElementById("set-auto-category"),
    setSaveAs: document.getElementById("set-save-as"),
    setHoverQuality: document.getElementById("set-hover-quality"),
    setParallel: document.getElementById("set-parallel"),
    setMaxHistory: document.getElementById("set-max-history"),
    mainView: document.getElementById("main-view"),
    offNotice: document.getElementById("off-notice"),
    offDomainName: document.getElementById("off-domain-name"),
    btnEnableNow: document.getElementById("btn-enable-now"),
    cardsList: document.getElementById("cards-list"),
    mseBar: document.getElementById("mse-bar"),
    mseStatusLabel: document.getElementById("mse-status-label"),
    btnMseToggle: document.getElementById("btn-mse-toggle"),
    btnMseSave: document.getElementById("btn-mse-save"),
    btnMseClear: document.getElementById("btn-mse-clear"),
    feedback: document.getElementById("popup-feedback"),
    footerDomainInfo: document.getElementById("footer-domain-info"),
  };

  function sendRuntime(msg) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(msg, (resp) => {
        if (chrome.runtime.lastError) {
          resolve({ ok: false, error: chrome.runtime.lastError.message });
          return;
        }
        resolve(resp || { ok: false, error: "No response" });
      });
    });
  }

  function sendToTab(msg) {
    return new Promise((resolve) => {
      if (!state.tab || typeof state.tab.id !== "number") {
        resolve({ ok: false, error: "Tab tidak ditemukan" });
        return;
      }
      chrome.tabs.sendMessage(state.tab.id, msg, { frameId: 0 }, (resp) => {
        if (chrome.runtime.lastError) {
          resolve({ ok: false, error: chrome.runtime.lastError.message });
          return;
        }
        resolve(resp || { ok: false });
      });
    });
  }

  function setFeedback(text, kind) {
    els.feedback.textContent = text || "";
    els.feedback.classList.remove("ok", "err");
    if (kind === "ok") els.feedback.classList.add("ok");
    if (kind === "err") els.feedback.classList.add("err");
  }

  function formatDuration(sec) {
    const s = Math.max(0, Math.round(Number(sec) || 0));
    if (s <= 0) return "";
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const rem = s % 60;
    if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(rem).padStart(2, "0")}`;
    return `${m}:${String(rem).padStart(2, "0")}`;
  }

  function formatSize(bytes) {
    const num = Number(bytes) || 0;
    if (num <= 0) return "0 MB";
    if (num < 1024 * 1024) return `${(num / 1024).toFixed(0)} KB`;
    return `${(num / (1024 * 1024)).toFixed(1)} MB`;
  }

  function getTimestampTag() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    return (
      `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_` +
      `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
    );
  }

  function buildSmartFilename(card, ext = "mp4") {
    const pTag = card.platform && card.platform !== "Web" ? `[${card.platform}] ` : "";
    let cleanAuth = String(card.author || "").replace(/^@+/, "").trim();
    cleanAuth = cleanAuth.replace(/[<>:"/\\|?*\x00-\x1f]+/g, "_");
    const authPrefix = cleanAuth ? `@${cleanAuth} - ` : "";
    const body = String(card.title || state.tab?.title || "video").replace(/[<>:"/\\|?*\x00-\x1f]+/g, "_").trim();
    let base = `${pTag}${authPrefix}${body}`.replace(/\s+/g, " ").trim();
    if (base.length > 110) base = base.slice(0, 110).trim();
    const ts = getTimestampTag();
    return `${base}_${ts}.${ext.toLowerCase()}`;
  }

  async function downloadBlobViaChrome(blob, filename, category = "Video") {
    const url = URL.createObjectURL(blob);
    const ext = (String(filename).split(".").pop() || "mp4").toLowerCase();
    try {
      const res = await sendRuntime({
        type: "VORTEX_BROWSER_DOWNLOAD",
        payload: { url, filename, ext, category },
      });
      if (!res.ok) throw new Error(res.error || "Gagal menyimpan blob.");
    } finally {
      setTimeout(() => URL.revokeObjectURL(url), 20000);
    }
  }

  async function fetchBinaryFromPopup(url) {
    const resp = await fetch(url, { credentials: "include" });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return new Uint8Array(await resp.arrayBuffer());
  }

  async function executeCardDownload(card, option, btnEl) {
    const prevLabel = btnEl.textContent;
    btnEl.disabled = true;
    btnEl.textContent = "Memproses...";
    setFeedback("Menyiapkan unduhan...");

    try {
      const tabRes = await sendToTab({
        type: "VORTEX_STANDALONE_DOWNLOAD",
        option,
        meta: {
          platform: card.platform,
          author: card.author,
          title: card.title,
        },
      });
      if (tabRes.ok) {
        setFeedback("Unduhan diproses langsung di tab.", "ok");
        return;
      }

      // Direct popup fallback if tab content script cannot handle
      if (option.mode === "hls") {
        const { blob, ext } = await window.__vortexMuxer.downloadHlsM3u8InBrowser(
          option.url,
          (done, total) => setFeedback(`Mengunduh segmen HLS: ${done}/${total}...`),
          Number(state.settings.parallelConnections) || 6
        );
        await downloadBlobViaChrome(blob, buildSmartFilename(card, ext), "Video");
      } else if (option.mode === "dash_merge" && option.audioUrl) {
        setFeedback("Mengunduh & menggabungkan video + audio...");
        const [vBuf, aBuf] = await Promise.all([
          fetchBinaryFromPopup(option.url),
          fetchBinaryFromPopup(option.audioUrl),
        ]);
        const merged = window.__vortexMuxer.mergeFmp4VideoAudio(vBuf, aBuf);
        await downloadBlobViaChrome(
          new Blob([merged], { type: "video/mp4" }),
          buildSmartFilename(card, "mp4"),
          "Video"
        );
      } else if (option.mode === "audio") {
        const ext = option.url.toLowerCase().includes(".mp3") ? "mp3" : "m4a";
        const res = await sendRuntime({
          type: "VORTEX_BROWSER_DOWNLOAD",
          payload: {
            url: option.url,
            filename: buildSmartFilename(card, ext),
            ext,
            category: "Audio",
          },
        });
        if (!res.ok) throw new Error(res.error);
      } else {
        const res = await sendRuntime({
          type: "VORTEX_BROWSER_DOWNLOAD",
          payload: {
            url: option.url,
            filename: buildSmartFilename(card, "mp4"),
            ext: "mp4",
            category: "Video",
          },
        });
        if (!res.ok) throw new Error(res.error);
      }
      setFeedback("Unduhan selesai / dimulai di browser.", "ok");
    } catch (err) {
      setFeedback(`Gagal: ${err.message}`, "err");
    } finally {
      btnEl.disabled = false;
      btnEl.textContent = prevLabel;
    }
  }

  function renderDomainToggleUi() {
    const isOn = Boolean(state.domainEnabled);
    els.btnDomainToggle.classList.toggle("is-on", isOn);
    els.btnDomainToggle.setAttribute("aria-checked", isOn ? "true" : "false");
    els.domainToggleLabel.textContent = isOn ? "ON" : "OFF";
    els.btnDomainToggle.disabled = !state.domain;

    const showOffNotice = Boolean(state.domain && !isOn && !state.manualScanned && state.cards.length === 0);
    els.offNotice.classList.toggle("hidden", !showOffNotice);
    els.cardsList.classList.toggle("hidden", showOffNotice);
    els.mseBar.classList.toggle("hidden", !isOn && !state.manualScanned);
    if (els.offDomainName) {
      els.offDomainName.textContent = state.domain || "halaman ini";
    }
    if (els.footerDomainInfo) {
      const domLabel = state.domain || "tab internal";
      els.footerDomainInfo.textContent = `Domain: ${domLabel} | Status: ${isOn ? "ON" : "OFF"}`;
    }
  }

  function updateSummaryBar() {
    renderDomainToggleUi();
    if (!state.domainEnabled && !state.manualScanned) {
      els.detectSummary.textContent = "Mode OFF (Hemat Chrome)";
    } else {
      const count = state.cards.length;
      const mseTotal = (state.mse.videoBytes || 0) + (state.mse.audioBytes || 0);
      const parts = [`${count} Video Terdeteksi`];
      if (mseTotal > 0) parts.push(`Buffer ${formatSize(mseTotal)}`);
      els.detectSummary.textContent = parts.join(" | ");
    }

    if (els.btnMseToggle) {
      els.btnMseToggle.textContent = state.mse.recording ? "Stop Rekam" : "Rekam MSE";
      els.btnMseToggle.classList.toggle("btn-danger", Boolean(state.mse.recording));
      els.btnMseToggle.classList.toggle("btn-secondary", !state.mse.recording);
    }

    if (state.mse.recording) {
      els.mseStatusLabel.textContent = `Merekam... (${formatSize(
        (state.mse.videoBytes || 0) + (state.mse.audioBytes || 0)
      )})`;
      els.btnMseSave.disabled = false;
    } else if ((state.mse.videoBytes || 0) + (state.mse.audioBytes || 0) > 0) {
      els.mseStatusLabel.textContent = `${formatSize(
        (state.mse.videoBytes || 0) + (state.mse.audioBytes || 0)
      )} siap disimpan ke MP4`;
      els.btnMseSave.disabled = false;
    } else {
      els.mseStatusLabel.textContent = state.mse.hasMediaSource
        ? "MSE terdeteksi (klik Rekam MSE jika perlu)"
        : "Hemat RAM (aktif hanya saat Rekam MSE)";
      els.btnMseSave.disabled = false;
    }
  }

  function renderCards() {
    updateSummaryBar();
    if (state.cards.length === 0) {
      els.cardsList.innerHTML =
        '<div class="empty-box">Belum ada video terdeteksi di tab ini. Putar video sebentar lalu klik Scan.</div>';
      return;
    }

    const frag = document.createDocumentFragment();
    for (const card of state.cards) {
      const article = document.createElement("article");
      article.className = "video-card";

      const body = document.createElement("div");
      body.className = "card-body";

      const thumbWrap = document.createElement("div");
      thumbWrap.className = "thumb-wrap";

      if (card.thumbnail) {
        const img = document.createElement("img");
        img.className = "thumb-img";
        img.src = card.thumbnail;
        img.alt = card.title || "Thumbnail video";
        img.addEventListener("error", () => {
          img.remove();
        });
        thumbWrap.appendChild(img);
      } else {
        const fallback = document.createElement("div");
        fallback.className = "thumb-fallback";
        fallback.innerHTML = `
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <rect x="3" y="5" width="18" height="14" rx="2" stroke="currentColor" stroke-width="1.8"/>
            <path d="M10 9.5L15 12L10 14.5V9.5Z" fill="currentColor"/>
          </svg>
        `;
        thumbWrap.appendChild(fallback);
      }

      const pBadge = document.createElement("span");
      pBadge.className = "badge-platform";
      pBadge.textContent = card.platform || "Web";
      thumbWrap.appendChild(pBadge);

      const durStr = formatDuration(card.durationSec);
      if (durStr) {
        const dBadge = document.createElement("span");
        dBadge.className = "badge-duration";
        dBadge.textContent = durStr;
        thumbWrap.appendChild(dBadge);
      }

      const previewBox = document.createElement("div");
      previewBox.className = "inline-preview-box hidden";

      if (card.previewUrl) {
        const playBtn = document.createElement("button");
        playBtn.type = "button";
        playBtn.className = "btn-play-preview";
        playBtn.setAttribute("aria-label", "Putar preview video");
        playBtn.title = "Putar preview di sini";
        playBtn.innerHTML = `
          <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M8 5V19L19 12L8 5Z"/>
          </svg>
        `;
        playBtn.addEventListener("click", () => {
          if (!previewBox.classList.contains("hidden")) {
            previewBox.innerHTML = "";
            previewBox.classList.add("hidden");
            return;
          }
          previewBox.innerHTML = "";
          const vid = document.createElement("video");
          vid.className = "inline-preview-video";
          vid.src = card.previewUrl;
          vid.controls = true;
          vid.muted = true;
          vid.autoplay = true;
          vid.playsInline = true;

          const closeBtn = document.createElement("button");
          closeBtn.type = "button";
          closeBtn.className = "btn-close-preview";
          closeBtn.textContent = "×";
          closeBtn.setAttribute("aria-label", "Tutup preview");
          closeBtn.addEventListener("click", () => {
            vid.pause();
            previewBox.innerHTML = "";
            previewBox.classList.add("hidden");
          });

          previewBox.append(vid, closeBtn);
          previewBox.classList.remove("hidden");
        });
        thumbWrap.appendChild(playBtn);
      }

      const metaDiv = document.createElement("div");
      metaDiv.className = "card-meta";

      const authorRow = document.createElement("div");
      authorRow.className = "card-author-row";

      const authorSpan = document.createElement("span");
      authorSpan.className = "card-author";
      authorSpan.textContent = card.author ? `@${card.author.replace(/^@+/, "")}` : `${card.platform || "Web"} Media`;
      authorRow.appendChild(authorSpan);

      if (card.videoDomId) {
        const btnLocate = document.createElement("button");
        btnLocate.type = "button";
        btnLocate.className = "btn btn-secondary btn-sm";
        btnLocate.textContent = "Lihat";
        btnLocate.title = "Sorot lokasi video ini di halaman";
        btnLocate.addEventListener("click", () => {
          sendToTab({ type: "VORTEX_HIGHLIGHT_VIDEO", videoDomId: card.videoDomId });
        });
        authorRow.appendChild(btnLocate);
      }

      const titleP = document.createElement("p");
      titleP.className = "card-title";
      titleP.textContent = card.title || "Video";
      titleP.title = card.title || "";

      metaDiv.append(authorRow, titleP);
      body.append(thumbWrap, metaDiv);

      const controls = document.createElement("div");
      controls.className = "card-controls";

      const select = document.createElement("select");
      select.setAttribute("aria-label", "Pilih kualitas unduhan");

      const seenLabels = new Set();
      const allOpts = [];
      for (const opt of card.variants || []) {
        if (!opt || !opt.label || seenLabels.has(opt.label)) continue;
        seenLabels.add(opt.label);
        allOpts.push(opt);
      }
      if (card.audioUrl && !allOpts.some((o) => o.mode === "audio")) {
        allOpts.push({
          label: "Audio Saja (M4A)",
          mode: "audio",
          url: card.audioUrl,
          audioUrl: null,
        });
      }

      allOpts.forEach((opt, idx) => {
        const oEl = document.createElement("option");
        oEl.value = String(idx);
        oEl.textContent = opt.label;
        select.appendChild(oEl);
      });

      const btnDownload = document.createElement("button");
      btnDownload.type = "button";
      btnDownload.className = "btn btn-primary";
      btnDownload.textContent = "Unduh";
      btnDownload.addEventListener("click", () => {
        const chosen = allOpts[Number(select.value) || 0];
        if (chosen) executeCardDownload(card, chosen, btnDownload);
      });

      controls.append(select, btnDownload);
      article.append(body, previewBox, controls);
      frag.appendChild(article);
    }

    els.cardsList.innerHTML = "";
    els.cardsList.appendChild(frag);
  }

  async function loadUnifiedMedia(forceScan = false) {
    if (!state.domainEnabled && !forceScan) {
      state.cards = [];
      state.mse = { recording: false, videoBytes: 0, audioBytes: 0, hasMediaSource: false };
      renderCards();
      if (state.tab) {
        await sendRuntime({ type: "VORTEX_SET_BADGE_COUNT", tabId: state.tab.id, count: 0 });
      }
      return 0;
    }

    const msgType = forceScan ? "VORTEX_FORCE_SCAN" : "VORTEX_GET_UNIFIED_MEDIA";
    const tabRes = await sendToTab({ type: msgType });
    if (tabRes.ok && Array.isArray(tabRes.cards)) {
      state.cards = tabRes.cards;
      if (tabRes.mse) state.mse = tabRes.mse;
      renderCards();
      if (state.tab) {
        await sendRuntime({
          type: "VORTEX_SET_BADGE_COUNT",
          tabId: state.tab.id,
          count: state.cards.length,
        });
      }
      return state.cards.length;
    }

    // Fallback when content script cannot run on special page
    if (state.tab) {
      const bgRes = await sendRuntime({ type: "VORTEX_GET_TAB_MEDIA", tabId: state.tab.id });
      const groups = bgRes.ok && Array.isArray(bgRes.groups) ? bgRes.groups : [];
      state.cards = groups.map((g, i) => ({
        id: g.id || `bg_${i}`,
        videoDomId: "",
        platform: "Web",
        author: "",
        title: g.title || state.tab.title || `Stream #${i + 1}`,
        durationSec: g.durationSec || 0,
        thumbnail: "",
        previewUrl: "",
        variants: g.variants || [],
        audioUrl: g.audioUrl || null,
      }));
    }
    renderCards();
    if (state.tab) {
      await sendRuntime({
        type: "VORTEX_SET_BADGE_COUNT",
        tabId: state.tab.id,
        count: state.cards.length,
      });
    }
    return state.cards.length;
  }

  async function loadDomainAndSettings() {
    const res = await chrome.storage.local.get([ENABLED_DOMAINS_KEY, SETTINGS_KEY]);
    const list = Array.isArray(res[ENABLED_DOMAINS_KEY]) ? res[ENABLED_DOMAINS_KEY] : [];
    const normalized = list.map((d) => String(d || "").toLowerCase()).filter(Boolean);
    state.domainEnabled = Boolean(state.domain && normalized.includes(state.domain));

    const storedSettings = res[SETTINGS_KEY];
    state.settings = {
      ...DEFAULT_SETTINGS,
      ...(storedSettings && typeof storedSettings === "object" ? storedSettings : {}),
    };
    populateSettingsForm();
  }

  function populateSettingsForm() {
    const s = state.settings;
    els.setSubfolder.value = typeof s.downloadSubfolder === "string" ? s.downloadSubfolder : "Vortex";
    els.setAutoCategory.checked = Boolean(s.autoCategoryFolder);
    els.setSaveAs.checked = Boolean(s.askWhereToSave);
    els.setHoverQuality.value = s.defaultHoverQuality || "best";
    els.setParallel.value = String(Math.max(1, Math.min(16, Number(s.parallelConnections) || 6)));
    els.setMaxHistory.value = String(Math.max(5, Math.min(50, Number(s.maxHistoryPerTab) || 15)));
  }

  function setSettingsOpen(open) {
    state.settingsOpen = Boolean(open);
    els.settingsPanel.classList.toggle("hidden", !state.settingsOpen);
    els.mainView.classList.toggle("hidden", state.settingsOpen);
    els.btnSettings.classList.toggle("active", state.settingsOpen);
    els.btnSettings.setAttribute("aria-expanded", state.settingsOpen ? "true" : "false");
    if (state.settingsOpen) {
      populateSettingsForm();
    }
  }

  async function setDomainEnabled(enable) {
    if (!state.domain) return;
    const cur = await chrome.storage.local.get(ENABLED_DOMAINS_KEY);
    const list = Array.isArray(cur[ENABLED_DOMAINS_KEY]) ? cur[ENABLED_DOMAINS_KEY] : [];
    const next = list
      .map((d) => String(d || "").toLowerCase())
      .filter((d) => d && d !== state.domain);
    if (enable) next.push(state.domain);
    await chrome.storage.local.set({ [ENABLED_DOMAINS_KEY]: next });

    state.domainEnabled = Boolean(enable);
    state.manualScanned = false;

    if (state.domainEnabled) {
      const count = await loadUnifiedMedia(true);
      setFeedback(`Vortex ON di ${state.domain} (${count} video ditemukan).`, "ok");
    } else {
      if (state.tab) {
        await sendRuntime({ type: "VORTEX_CLEAR_TAB_MEDIA", tabId: state.tab.id });
        await sendToTab({ type: "VORTEX_CLEAR_PAGE_CACHE" });
        await sendRuntime({ type: "VORTEX_SET_BADGE_COUNT", tabId: state.tab.id, count: 0 });
      }
      state.cards = [];
      state.mse = { recording: false, videoBytes: 0, audioBytes: 0, hasMediaSource: false };
      renderCards();
      setFeedback(`Vortex OFF di ${state.domain}. Hover dan sniffer dinonaktifkan.`, "ok");
    }
  }

  function bindEvents() {
    els.btnDomainToggle.addEventListener("click", async () => {
      if (!state.domain) return;
      els.btnDomainToggle.disabled = true;
      try {
        await setDomainEnabled(!state.domainEnabled);
      } finally {
        els.btnDomainToggle.disabled = !state.domain;
      }
    });

    els.btnEnableNow.addEventListener("click", async () => {
      if (!state.domain) return;
      await setDomainEnabled(true);
    });

    els.btnScan.addEventListener("click", async () => {
      if (state.settingsOpen) setSettingsOpen(false);
      const prevText = els.btnScan.textContent;
      els.btnScan.disabled = true;
      els.btnScan.textContent = "Scanning...";
      setFeedback("Memindai video di halaman ini...");
      try {
        state.manualScanned = true;
        const count = await loadUnifiedMedia(true);
        setFeedback(`Scan selesai: ${count} video ditemukan.`, "ok");
      } catch (err) {
        setFeedback(`Scan gagal: ${err.message}`, "err");
      } finally {
        els.btnScan.disabled = false;
        els.btnScan.textContent = prevText;
      }
    });

    els.btnClear.addEventListener("click", async () => {
      if (state.settingsOpen) setSettingsOpen(false);
      els.btnClear.disabled = true;
      try {
        state.manualScanned = false;
        if (state.tab) {
          await Promise.all([
            sendRuntime({ type: "VORTEX_CLEAR_TAB_MEDIA", tabId: state.tab.id }),
            sendToTab({ type: "VORTEX_CLEAR_PAGE_CACHE" }),
            sendRuntime({ type: "VORTEX_SET_BADGE_COUNT", tabId: state.tab.id, count: 0 }),
          ]);
        }
        state.cards = [];
        state.mse.videoBytes = 0;
        state.mse.audioBytes = 0;
        renderCards();
        setFeedback("Daftar deteksi dan cache halaman dibersihkan.", "ok");
      } finally {
        els.btnClear.disabled = false;
      }
    });

    els.btnSettings.addEventListener("click", () => {
      setSettingsOpen(!state.settingsOpen);
    });

    els.btnCloseSettings.addEventListener("click", () => {
      setSettingsOpen(false);
    });

    els.btnSaveSettings.addEventListener("click", async () => {
      const nextSettings = {
        downloadSubfolder: String(els.setSubfolder.value || "").trim().replace(/^[/\\]+|[/\\]+$/g, ""),
        autoCategoryFolder: Boolean(els.setAutoCategory.checked),
        askWhereToSave: Boolean(els.setSaveAs.checked),
        defaultHoverQuality: els.setHoverQuality.value || "best",
        parallelConnections: Math.max(1, Math.min(16, parseInt(els.setParallel.value, 10) || 6)),
        maxHistoryPerTab: Math.max(5, Math.min(50, parseInt(els.setMaxHistory.value, 10) || 15)),
      };
      state.settings = nextSettings;
      await chrome.storage.local.set({ [SETTINGS_KEY]: nextSettings });
      populateSettingsForm();
      setSettingsOpen(false);
      setFeedback("Pengaturan tersimpan.", "ok");
    });

    els.btnResetSettings.addEventListener("click", async () => {
      state.settings = { ...DEFAULT_SETTINGS };
      await chrome.storage.local.set({ [SETTINGS_KEY]: state.settings });
      populateSettingsForm();
      setFeedback("Pengaturan dikembalikan ke default.", "ok");
    });

    els.btnMseToggle.addEventListener("click", async () => {
      const cmd = state.mse.recording ? "stop" : "start";
      const res = await sendToTab({ type: "VORTEX_MSE_CMD", command: cmd });
      if (res.ok && res.mse) {
        state.mse = res.mse;
        updateSummaryBar();
        setFeedback(
          cmd === "start"
            ? "Merekam buffer MSE. Putar video hingga selesai lalu klik Simpan MP4."
            : "Perekaman MSE dijeda.",
          "ok"
        );
      } else {
        setFeedback("Muat ulang halaman agar hook MSE aktif.", "err");
      }
    });

    els.btnMseSave.addEventListener("click", async () => {
      els.btnMseSave.disabled = true;
      setFeedback("Menyimpan Auto-Buffer MSE menjadi MP4...");
      const res = await sendToTab({
        type: "VORTEX_MSE_CMD",
        command: "stop_export",
        meta: {
          platform: state.cards[0]?.platform || "Web",
          author: state.cards[0]?.author || "",
          title: state.cards[0]?.title || state.tab?.title || "mse_video",
        },
      });
      els.btnMseSave.disabled = false;
      if (res.ok) {
        setFeedback(`Tersimpan: ${res.filename || "video.mp4"}`, "ok");
      } else {
        setFeedback(`Gagal: ${res.error || "Buffer kosong"}`, "err");
      }
      loadUnifiedMedia(false);
    });

    els.btnMseClear.addEventListener("click", async () => {
      await sendToTab({ type: "VORTEX_MSE_CMD", command: "clear" });
      state.mse.videoBytes = 0;
      state.mse.audioBytes = 0;
      updateSummaryBar();
      setFeedback("Buffer MSE direset.", "ok");
    });
  }

  async function init() {
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    state.tab = activeTab || null;
    if (state.tab && state.tab.url && state.tab.url.startsWith("http")) {
      try {
        state.domain = new URL(state.tab.url).hostname.toLowerCase();
      } catch (_) {}
    }

    bindEvents();
    await loadDomainAndSettings();
    await loadUnifiedMedia(false);
  }

  document.addEventListener("DOMContentLoaded", init);
})();
