(() => {
  "use strict";

  if (window.__vortexContentLoaded) return;
  window.__vortexContentLoaded = true;

  const ENABLED_KEY = "vortexEnabledDomains";
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
    domain: (window.location.hostname || "").toLowerCase(),
    domainEnabled: false,
    settings: { ...DEFAULT_SETTINGS },
    activeVideo: null,
    menuOpen: false,
    busy: false,
    observerStarted: false,
    mse: {
      recording: false,
      hasMediaSource: false,
      videoBytes: 0,
      audioBytes: 0,
    },
    pendingExports: new Map(),
    pendingPageInfo: new Map(),
    toastTimer: null,
    doneIconTimer: null,
  };

  let hostEl = null;
  let shadowRoot = null;
  let uiRefs = null;
  let hideDelayTimer = null;
  let domainConfigReadyPromise = Promise.resolve();

  function formatMb(bytes) {
    const mb = (Number(bytes) || 0) / (1024 * 1024);
    return `${mb.toFixed(1)} MB`;
  }

  function cleanTitleText(rawTitle) {
    return String(rawTitle || "")
      .replace(/\s*[|\-•·]\s*(Instagram|Facebook|Threads|YouTube|Google Drive).*$/i, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function getTimestampTag() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    return (
      `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_` +
      `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
    );
  }

  function getUrlPathKey(rawUrl) {
    try {
      return new URL(rawUrl).pathname;
    } catch (_) {
      return String(rawUrl || "").split("?")[0];
    }
  }

  function buildSmartFilename(platform, author, title, ext = "mp4") {
    const pTag = platform && platform !== "Web" ? `[${platform}] ` : "";
    let cleanAuth = String(author || "").replace(/^@+/, "").trim();
    cleanAuth = cleanAuth.replace(/[<>:"/\\|?*\x00-\x1f]+/g, "_");
    const authPrefix = cleanAuth ? `@${cleanAuth} - ` : "";

    let cleanBody = cleanTitleText(title);
    if (cleanAuth && cleanBody.toLowerCase().startsWith(cleanAuth.toLowerCase())) {
      cleanBody = cleanBody.slice(cleanAuth.length).replace(/^[\s:\-–]+/, "");
    }
    if (!cleanBody) cleanBody = "video";

    let base = `${pTag}${authPrefix}${cleanBody}`
      .replace(/[<>:"/\\|?*\x00-\x1f]+/g, "_")
      .replace(/\s+/g, " ")
      .trim();

    if (base.length > 110) base = base.slice(0, 110).trim();
    const ts = getTimestampTag();
    return `${base}_${ts}.${ext.toLowerCase()}`;
  }

  function sendRuntime(msg) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (resp) => {
          if (chrome.runtime.lastError) {
            resolve({ ok: false, error: chrome.runtime.lastError.message });
            return;
          }
          resolve(resp || { ok: false, error: "Empty response" });
        });
      } catch (err) {
        resolve({ ok: false, error: err.message });
      }
    });
  }

  function triggerAnchorBlobDownload(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      a.remove();
      URL.revokeObjectURL(url);
    }, 3000);
  }

  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result);
      reader.onerror = () => reject(new Error("Gagal membaca blob."));
      reader.readAsDataURL(blob);
    });
  }

  async function saveBlobDirectly(blob, filename, category = "Video") {
    try {
      if (blob && blob.size <= 45 * 1024 * 1024) {
        const dataUrl = await blobToDataUrl(blob);
        if (typeof dataUrl === "string" && dataUrl.startsWith("data:")) {
          const ext = (filename.split(".").pop() || "mp4").toLowerCase();
          const res = await sendRuntime({
            type: "VORTEX_BROWSER_DOWNLOAD",
            payload: { url: dataUrl, filename, ext, category },
          });
          if (res && res.ok) return;
        }
      }
    } catch (_) {}
    triggerAnchorBlobDownload(blob, filename);
  }

  async function fetchBinaryWithProgress(url, onPct) {
    try {
      const resp = await fetch(url, { credentials: "include" });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const total = parseInt(resp.headers.get("content-length") || "0", 10) || 0;
      if (!resp.body || typeof resp.body.getReader !== "function") {
        const buf = new Uint8Array(await resp.arrayBuffer());
        if (typeof onPct === "function") onPct(100);
        return buf;
      }

      const reader = resp.body.getReader();
      const chunks = [];
      let received = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          chunks.push(value);
          received += value.byteLength;
          if (total > 0 && typeof onPct === "function") {
            onPct(Math.min(99, Math.round((received / total) * 100)));
          }
        }
      }

      const merged = new Uint8Array(received);
      let offset = 0;
      for (const c of chunks) {
        merged.set(c, offset);
        offset += c.byteLength;
      }
      if (typeof onPct === "function") onPct(100);
      return merged;
    } catch (_) {
      const startRes = await sendRuntime({ type: "VORTEX_PROXY_FETCH_START", url });
      if (!startRes.ok) {
        throw new Error(startRes.error || "Gagal mengambil data media.");
      }
      const totalBytes = startRes.totalBytes || 0;
      const out = new Uint8Array(totalBytes);
      let offset = 0;
      const SLICE = 512 * 1024;
      while (offset < totalBytes) {
        const sliceRes = await sendRuntime({
          type: "VORTEX_PROXY_FETCH_SLICE",
          fetchId: startRes.fetchId,
          offset,
          length: SLICE,
        });
        if (!sliceRes.ok) throw new Error(sliceRes.error || "Proxy slice gagal.");
        const arr = new Uint8Array(sliceRes.bytes || []);
        out.set(arr, offset);
        offset += arr.byteLength;
        if (totalBytes > 0 && typeof onPct === "function") {
          onPct(Math.min(100, Math.round((offset / totalBytes) * 100)));
        }
        if (sliceRes.done || arr.byteLength === 0) break;
      }
      return out;
    }
  }

  function requestPageMediaInfo(forceScan = false) {
    document.querySelectorAll('video[data-vortex-target="1"]').forEach((v) => {
      v.removeAttribute("data-vortex-target");
    });
    if (state.activeVideo && state.activeVideo.isConnected) {
      const r = state.activeVideo.getBoundingClientRect();
      const vh = window.innerHeight || 800;
      if (r.width >= 100 && r.height >= 80 && r.bottom > 0 && r.top < vh) {
        state.activeVideo.setAttribute("data-vortex-target", "1");
      }
    }

    return new Promise((resolve) => {
      const requestId = `info_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const timer = setTimeout(() => {
        state.pendingPageInfo.delete(requestId);
        resolve({
          platform: "Web",
          title: document.title,
          author: "",
          caption: "",
          thumbnail: "",
          durationSec: 0,
          videoDomId: "",
          domVideos: [],
          progressive: [],
          dashVideos: [],
          dashAudios: [],
          carouselItems: [],
        });
      }, 2500);

      state.pendingPageInfo.set(requestId, (payload) => {
        clearTimeout(timer);
        resolve(payload || {});
      });

      window.postMessage(
        {
          source: "vortex-content",
          type: forceScan ? "FORCE_SCAN" : "GET_PAGE_MEDIA_INFO",
          requestId,
        },
        "*"
      );
    });
  }

  function pushDomainConfigToHook() {
    window.postMessage(
      {
        source: "vortex-content",
        type: "SET_DOMAIN_CONFIG",
        domainActive: Boolean(state.domainEnabled),
        maxHistory: Number(state.settings.maxHistoryPerTab) || 15,
      },
      "*"
    );
  }

  function ensureDomObserverStarted() {
    if (!state.domainEnabled) return;
    scanVideos(document);
    if (state.observerStarted) return;
    state.observerStarted = true;

    const observer = new MutationObserver((mutations) => {
      if (!state.domainEnabled) return;
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (node.nodeType !== Node.ELEMENT_NODE) continue;
          if (node.tagName === "VIDEO") {
            attachVideoWatchers(node);
          } else {
            scanVideos(node);
          }
        }
      }
    });

    if (document.documentElement) {
      observer.observe(document.documentElement, { childList: true, subtree: true });
    }
  }

  async function checkDomainVisibility() {
    try {
      const res = await chrome.storage.local.get([ENABLED_KEY, SETTINGS_KEY]);
      const list = Array.isArray(res[ENABLED_KEY]) ? res[ENABLED_KEY] : [];
      state.domainEnabled = Boolean(
        state.domain && list.map((d) => String(d || "").toLowerCase()).includes(state.domain)
      );
      const rawSettings = res[SETTINGS_KEY];
      state.settings = {
        ...DEFAULT_SETTINGS,
        ...(rawSettings && typeof rawSettings === "object" ? rawSettings : {}),
      };
    } catch (_) {
      state.domainEnabled = false;
    }

    pushDomainConfigToHook();
    if (state.domainEnabled) {
      ensureDomObserverStarted();
    } else {
      state.menuOpen = false;
      state.mse.recording = false;
      if (hostEl) hostEl.style.display = "none";
    }
  }

  async function disableForCurrentDomain() {
    try {
      const res = await chrome.storage.local.get(ENABLED_KEY);
      const list = Array.isArray(res[ENABLED_KEY]) ? res[ENABLED_KEY] : [];
      const next = list.filter((d) => String(d || "").toLowerCase() !== state.domain);
      await chrome.storage.local.set({ [ENABLED_KEY]: next });
      state.domainEnabled = false;
      state.menuOpen = false;
      if (uiRefs && uiRefs.menu) uiRefs.menu.classList.remove("open");
      if (hostEl) hostEl.style.display = "none";
      pushDomainConfigToHook();
      sendRuntime({ type: "VORTEX_SET_BADGE_COUNT", count: 0 });
    } catch (_) {}
  }

  function setHoverButtonState(mode, pct = 0) {
    if (!uiRefs) return;
    if (state.doneIconTimer) {
      clearTimeout(state.doneIconTimer);
      state.doneIconTimer = null;
    }

    const circumference = 69.115; // 2 * pi * 11
    if (mode === "progress") {
      state.busy = true;
      uiRefs.iconLogo.classList.add("hidden");
      uiRefs.iconDone.classList.add("hidden");
      uiRefs.progressWrap.classList.remove("hidden");
      const clamped = Math.max(0, Math.min(100, Math.round(pct)));
      const offset = circumference - (clamped / 100) * circumference;
      uiRefs.progressCircle.style.strokeDashoffset = String(offset);
      uiRefs.progressText.textContent = `${clamped}`;
    } else if (mode === "done") {
      state.busy = false;
      uiRefs.iconLogo.classList.add("hidden");
      uiRefs.progressWrap.classList.add("hidden");
      uiRefs.iconDone.classList.remove("hidden");
      state.doneIconTimer = setTimeout(() => {
        setHoverButtonState("idle");
      }, 2200);
    } else {
      state.busy = false;
      uiRefs.iconLogo.classList.remove("hidden");
      uiRefs.progressWrap.classList.add("hidden");
      uiRefs.iconDone.classList.add("hidden");
    }
  }

  function buildVariantsFromBucket(bucket, fallbackAudioUrl) {
    const variants = [];
    const seenUrls = new Set();
    const seenLabels = new Set();
    const addVar = (v) => {
      if (!v.url || seenUrls.has(v.url) || seenLabels.has(v.label)) return;
      seenUrls.add(v.url);
      seenLabels.add(v.label);
      variants.push(v);
    };

    for (const p of bucket.progressive || []) {
      addVar({
        label: `${p.label || "MP4"} (Siap Putar)`,
        mode: "direct",
        url: p.url,
        audioUrl: null,
      });
    }

    const primaryAudio =
      (bucket.dashAudios && bucket.dashAudios[0]?.url) || fallbackAudioUrl || null;
    for (const dv of bucket.dashVideos || []) {
      if (primaryAudio) {
        addVar({
          label: `${dv.label || "HD"} + Audio (MP4)`,
          mode: "dash_merge",
          url: dv.url,
          audioUrl: primaryAudio,
        });
      } else {
        addVar({
          label: `${dv.label || "Video"} (Tanpa Audio)`,
          mode: "direct",
          url: dv.url,
          audioUrl: null,
        });
      }
    }

    return { variants, audioUrl: primaryAudio };
  }

  async function buildUnifiedMediaCards(forceScan = false) {
    await domainConfigReadyPromise;
    if (!state.domainEnabled && !forceScan) {
      return {
        platform: "Web",
        title: document.title || "Video",
        author: "",
        cards: [],
        mse: state.mse,
        domainEnabled: false,
      };
    }

    const [pageInfo, tabMediaResp] = await Promise.all([
      requestPageMediaInfo(forceScan),
      sendRuntime({ type: "VORTEX_GET_TAB_MEDIA" }),
    ]);

    const sniffGroups = tabMediaResp.ok && Array.isArray(tabMediaResp.groups) ? tabMediaResp.groups : [];
    const sniffItems = tabMediaResp.ok && Array.isArray(tabMediaResp.items) ? tabMediaResp.items : [];
    const sniffAudioByAsset = new Map();
    let genericSniffAudio = null;
    for (const item of sniffItems) {
      if (item.streamRole === "dash_audio" || item.kind === "AUDIO") {
        if (item.assetKey) {
          if (!sniffAudioByAsset.has(item.assetKey)) sniffAudioByAsset.set(item.assetKey, item.url);
        } else if (!genericSniffAudio) {
          genericSniffAudio = item.url;
        }
      }
    }

    const resolveFallbackAudio = (assetKeys = []) => {
      for (const ak of assetKeys || []) {
        if (ak && sniffAudioByAsset.has(String(ak))) return sniffAudioByAsset.get(String(ak));
      }
      if (!assetKeys || assetKeys.length === 0) return genericSniffAudio;
      return null;
    };

    const platform = pageInfo.platform || "Web";
    const fallbackAuthor = pageInfo.author || "";
    const fallbackTitle = cleanTitleText(pageInfo.caption || pageInfo.title || document.title) || "Video";
    const domVideos = Array.isArray(pageInfo.domVideos) ? pageInfo.domVideos : [];

    const cards = [];
    const coveredUrls = new Set();
    const coveredPathKeys = new Set();
    const coveredAssetKeys = new Set();
    const usedDomIds = new Set();

    const markBucketCovered = (variants, assetKeys = []) => {
      for (const ak of assetKeys || []) {
        if (ak) coveredAssetKeys.add(String(ak));
      }
      for (const v of variants || []) {
        if (v.url) {
          coveredUrls.add(v.url);
          coveredPathKeys.add(getUrlPathKey(v.url));
        }
        if (v.audioUrl) {
          coveredUrls.add(v.audioUrl);
          coveredPathKeys.add(getUrlPathKey(v.audioUrl));
        }
      }
    };

    const isAlreadyCovered = (variants, assetKeys = []) => {
      for (const ak of assetKeys || []) {
        if (ak && coveredAssetKeys.has(String(ak))) return true;
      }
      for (const v of variants || []) {
        if (v.url && (coveredUrls.has(v.url) || coveredPathKeys.has(getUrlPathKey(v.url)))) {
          return true;
        }
      }
      return false;
    };

    const addCardFromSource = (srcObj, cardId, titleOverride, domIdOverride) => {
      const matchedFallbackAudio = resolveFallbackAudio(srcObj.assetKeys);
      const { variants, audioUrl } = buildVariantsFromBucket(srcObj, matchedFallbackAudio);
      if (variants.length === 0) return;
      if (isAlreadyCovered(variants, srcObj.assetKeys)) return;

      markBucketCovered(variants, srcObj.assetKeys);
      const domId = domIdOverride || srcObj.videoDomId || "";
      if (domId) usedDomIds.add(domId);

      const progPreview = (srcObj.progressive && srcObj.progressive[0]?.url) || "";
      const author = srcObj.author || fallbackAuthor;
      const title =
        titleOverride ||
        cleanTitleText(srcObj.caption || srcObj.title) ||
        fallbackTitle;

      cards.push({
        id: cardId,
        videoDomId: domId,
        platform,
        author,
        title,
        durationSec: srcObj.durationSec || pageInfo.durationSec || 0,
        thumbnail: srcObj.thumbnail || pageInfo.thumbnail || "",
        previewUrl: progPreview,
        variants,
        audioUrl,
        assetKeys: srcObj.assetKeys || [],
      });
    };

    // 1. Per-video entries from DOM/React Fiber (IG/FB/Threads multi-post feed & carousels)
    if (Array.isArray(pageInfo.videoEntries) && pageInfo.videoEntries.length > 0) {
      pageInfo.videoEntries.forEach((entry, eIdx) => {
        if (Array.isArray(entry.carouselItems) && entry.carouselItems.length > 0) {
          entry.carouselItems.forEach((slide, sIdx) => {
            const slideTitle = `Slide ${slide.slideIndex || sIdx + 1}: ${cleanTitleText(entry.caption) || fallbackTitle}`;
            addCardFromSource(
              {
                ...slide,
                author: entry.author || fallbackAuthor,
              },
              `entry_${eIdx}_slide_${sIdx}`,
              slideTitle,
              entry.videoDomId
            );
          });
        } else {
          addCardFromSource(entry, `entry_${eIdx}`, null, entry.videoDomId);
        }
      });
    }

    // 2. Fallback single page extraction (YouTube / Google Drive / single IG carousel)
    if (cards.length === 0) {
      if (Array.isArray(pageInfo.carouselItems) && pageInfo.carouselItems.length > 0) {
        pageInfo.carouselItems.forEach((slide, idx) => {
          addCardFromSource(
            slide,
            `carousel_${idx + 1}`,
            `Slide ${slide.slideIndex || idx + 1}: ${fallbackTitle}`,
            domVideos[idx]?.videoDomId || pageInfo.videoDomId || ""
          );
        });
      } else {
        addCardFromSource(
          pageInfo,
          "page_primary",
          fallbackTitle,
          pageInfo.videoDomId || domVideos[0]?.videoDomId || ""
        );
      }
    }

    // 3. Sniffer grouped streams (only when genuinely distinct from DOM-extracted cards)
    sniffGroups.forEach((grp, idx) => {
      if (grp.assetKey && coveredAssetKeys.has(String(grp.assetKey))) {
        return;
      }

      const remainingVars = (grp.variants || []).filter(
        (v) => v.url && !coveredUrls.has(v.url) && !coveredPathKeys.has(getUrlPathKey(v.url))
      );
      if (remainingVars.length === 0) return;

      if (grp.kind === "AUDIO" && cards.some((c) => c.audioUrl === remainingVars[0].url || c.audioUrl)) {
        return;
      }

      const matchedDom =
        domVideos.find((d) => !usedDomIds.has(d.videoDomId) && d.src && d.src.startsWith("http") && remainingVars.some((v) => v.url === d.src)) ||
        domVideos.find((d) => !usedDomIds.has(d.videoDomId)) ||
        null;

      markBucketCovered(remainingVars, grp.assetKey ? [grp.assetKey] : []);
      if (matchedDom && matchedDom.videoDomId) usedDomIds.add(matchedDom.videoDomId);

      const progVariant = remainingVars.find((v) => v.mode === "direct");
      const groupAudio = grp.audioUrl || resolveFallbackAudio(grp.assetKey ? [grp.assetKey] : []);
      cards.push({
        id: grp.id || `sniff_${idx}`,
        videoDomId: matchedDom ? matchedDom.videoDomId : "",
        platform,
        author: cards.length === 0 ? fallbackAuthor : "",
        title: cleanTitleText(grp.title) || (cards.length === 0 ? fallbackTitle : `Stream #${cards.length + 1}`),
        durationSec: grp.durationSec || (matchedDom ? matchedDom.durationSec : 0),
        thumbnail: (cards.length === 0 ? pageInfo.thumbnail : "") || (matchedDom ? matchedDom.thumbnail : ""),
        previewUrl: progVariant ? progVariant.url : "",
        variants: remainingVars,
        audioUrl: groupAudio,
      });
    });

    // 4. Direct <video src> fallback when nothing else matched
    if (cards.length === 0) {
      domVideos.forEach((dv, idx) => {
        if (dv.src && dv.src.startsWith("http") && !coveredUrls.has(dv.src)) {
          coveredUrls.add(dv.src);
          cards.push({
            id: `dom_${idx}`,
            videoDomId: dv.videoDomId,
            platform,
            author: fallbackAuthor,
            title: fallbackTitle,
            durationSec: dv.durationSec || 0,
            thumbnail: dv.thumbnail || "",
            previewUrl: dv.src,
            variants: [{ label: "Video Player (MP4)", mode: "direct", url: dv.src, audioUrl: null }],
            audioUrl: null,
          });
        }
      });
    }

    return {
      cards,
      mse: state.mse,
      platform,
      author: fallbackAuthor,
      title: fallbackTitle,
    };
  }

  async function downloadStandaloneOption(opt, meta = {}) {
    const platform = meta.platform || "Web";
    const author = meta.author || "";
    const title = meta.title || document.title || "video";
    state.menuOpen = false;
    if (uiRefs) uiRefs.menu.classList.remove("open");

    try {
      if (opt.mode === "hls") {
        if (!window.__vortexMuxer) throw new Error("Muxer belum dimuat.");
        setHoverButtonState("progress", 2);
        const { blob, ext } = await window.__vortexMuxer.downloadHlsM3u8InBrowser(
          opt.url,
          (done, total) => {
            const pct = total > 0 ? Math.round((done / total) * 100) : 0;
            setHoverButtonState("progress", pct);
          },
          Number(state.settings.parallelConnections) || 6
        );
        await saveBlobDirectly(blob, buildSmartFilename(platform, author, title, ext), "Video");
        setHoverButtonState("done");
        showToast("Unduhan HLS selesai disimpan.");
      } else if (opt.mode === "dash_merge" && opt.audioUrl) {
        if (!window.__vortexMuxer) throw new Error("Muxer belum dimuat.");
        setHoverButtonState("progress", 2);
        let vPct = 0;
        let aPct = 0;
        const updateCombined = () => {
          setHoverButtonState("progress", Math.round(vPct * 0.75 + aPct * 0.25));
        };
        const [vBytes, aBytes] = await Promise.all([
          fetchBinaryWithProgress(opt.url, (p) => {
            vPct = p;
            updateCombined();
          }),
          fetchBinaryWithProgress(opt.audioUrl, (p) => {
            aPct = p;
            updateCombined();
          }),
        ]);
        setHoverButtonState("progress", 99);
        const merged = window.__vortexMuxer.mergeFmp4VideoAudio(vBytes, aBytes);
        await saveBlobDirectly(
          new Blob([merged], { type: "video/mp4" }),
          buildSmartFilename(platform, author, title, "mp4"),
          "Video"
        );
        setHoverButtonState("done");
        showToast("Video + audio digabung & disimpan.");
      } else if (opt.mode === "audio") {
        const ext = opt.url.toLowerCase().includes(".mp3") ? "mp3" : "m4a";
        const fname = buildSmartFilename(platform, author, title, ext);
        const res = await sendRuntime({
          type: "VORTEX_BROWSER_DOWNLOAD",
          payload: { url: opt.url, filename: fname, ext, category: "Audio" },
        });
        if (!res.ok) throw new Error(res.error || "Gagal memulai unduhan audio.");
        setHoverButtonState("done");
        showToast("Mengunduh audio...");
      } else {
        const fname = buildSmartFilename(platform, author, title, "mp4");
        const res = await sendRuntime({
          type: "VORTEX_BROWSER_DOWNLOAD",
          payload: { url: opt.url, filename: fname, ext: "mp4", category: "Video" },
        });
        if (!res.ok) {
          setHoverButtonState("progress", 2);
          const bytes = await fetchBinaryWithProgress(opt.url, (p) => setHoverButtonState("progress", p));
          await saveBlobDirectly(new Blob([bytes], { type: "video/mp4" }), fname, "Video");
        }
        setHoverButtonState("done");
        showToast("Unduhan video dimulai.");
      }
    } catch (err) {
      setHoverButtonState("idle");
      showToast(`Gagal: ${err.message || "Tidak dapat mengunduh"}`);
    }
  }

  function exportMseStandalone(meta = {}) {
    return new Promise((resolve) => {
      const requestId = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const timer = setTimeout(() => {
        state.pendingExports.delete(requestId);
        resolve({ ok: false, error: "MSE export timeout." });
      }, 20000);

      state.pendingExports.set(requestId, (payload) => {
        clearTimeout(timer);
        try {
          const videoBuf = payload.videoBuffer;
          const audioBuf = payload.audioBuffer;
          if ((!videoBuf || videoBuf.byteLength === 0) && (!audioBuf || audioBuf.byteLength === 0)) {
            resolve({ ok: false, error: "Buffer MSE kosong. Putar video beberapa detik terlebih dahulu." });
            return;
          }

          let finalBytes;
          if (videoBuf && videoBuf.byteLength > 0 && audioBuf && audioBuf.byteLength > 0 && window.__vortexMuxer) {
            finalBytes = window.__vortexMuxer.mergeFmp4VideoAudio(
              new Uint8Array(videoBuf),
              new Uint8Array(audioBuf)
            );
          } else {
            finalBytes = new Uint8Array(videoBuf && videoBuf.byteLength > 0 ? videoBuf : audioBuf);
          }

          const filename = buildSmartFilename(
            meta.platform || "Web",
            meta.author || "",
            meta.title || document.title || "mse_video",
            "mp4"
          );
          saveBlobDirectly(new Blob([finalBytes], { type: "video/mp4" }), filename, "Video");
          setHoverButtonState("done");
          resolve({ ok: true, filename });
        } catch (err) {
          resolve({ ok: false, error: err.message });
        }
      });

      window.postMessage(
        {
          source: "vortex-content",
          type: "EXPORT_CURRENT_BUFFER",
          requestId,
          formatMode: "mp4",
        },
        "*"
      );
    });
  }

  function ensureOverlayUi() {
    if (hostEl || !document.body) return;
    hostEl = document.createElement("div");
    hostEl.id = "vortex-floating-host";
    hostEl.style.cssText =
      "position:fixed;z-index:2147483646;display:none;pointer-events:none;font-family:'Segoe UI',system-ui,sans-serif;";

    shadowRoot = hostEl.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = `
      .hidden { display: none !important; }
      .vx-wrap {
        position: relative;
        pointer-events: auto;
        display: inline-flex;
        flex-direction: column;
        align-items: flex-end;
      }
      .vx-capsule {
        display: inline-flex;
        align-items: center;
        height: 34px;
        border-radius: 999px;
        background: rgba(15, 23, 42, 0.88);
        border: 1px solid rgba(56, 189, 248, 0.75);
        box-shadow: 0 4px 14px rgba(0, 0, 0, 0.45);
        overflow: hidden;
        backdrop-filter: blur(6px);
      }
      .vx-main-btn {
        width: 34px;
        height: 34px;
        padding: 0;
        border: 0;
        background: transparent;
        color: #f8fafc;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        position: relative;
      }
      .vx-main-btn:hover {
        background: rgba(14, 165, 233, 0.25);
        color: #38bdf8;
      }
      .vx-chevron-btn {
        width: 22px;
        height: 34px;
        padding: 0;
        border: 0;
        border-left: 1px solid rgba(148, 163, 184, 0.25);
        background: transparent;
        color: #cbd5e1;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
      }
      .vx-chevron-btn:hover {
        background: rgba(14, 165, 233, 0.25);
        color: #ffffff;
      }
      .vx-progress-wrap {
        position: relative;
        width: 28px;
        height: 28px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
      }
      .vx-progress-svg {
        transform: rotate(-90deg);
      }
      .vx-progress-text {
        position: absolute;
        font-size: 9px;
        font-weight: 700;
        color: #38bdf8;
      }
      .vx-menu {
        margin-top: 6px;
        width: 268px;
        background: #0f172a;
        border: 1px solid #334155;
        border-radius: 10px;
        padding: 6px;
        box-shadow: 0 12px 28px rgba(0, 0, 0, 0.55);
        color: #f1f5f9;
        display: none;
        flex-direction: column;
        gap: 3px;
      }
      .vx-menu.open { display: flex; }
      .vx-menu-header {
        padding: 4px 8px 6px;
        font-size: 11px;
        color: #94a3b8;
        border-bottom: 1px solid #1e293b;
        display: flex;
        justify-content: space-between;
      }
      .vx-item {
        width: 100%;
        text-align: left;
        background: transparent;
        border: 0;
        border-radius: 6px;
        padding: 7px 9px;
        color: #f1f5f9;
        font-family: inherit;
        font-size: 12px;
        font-weight: 500;
        cursor: pointer;
      }
      .vx-item:hover { background: #1e293b; }
      .vx-item-accent { color: #38bdf8; font-weight: 600; }
      .vx-item-danger { color: #f87171; }
      .vx-note {
        padding: 6px 9px;
        font-size: 11px;
        color: #94a3b8;
      }
      .vx-divider {
        height: 1px;
        background: #1e293b;
        margin: 2px 0;
      }
      .vx-variants {
        display: flex;
        flex-direction: column;
        gap: 2px;
      }
      .vx-toast {
        margin-top: 5px;
        padding: 5px 10px;
        border-radius: 6px;
        background: #0284c7;
        color: #ffffff;
        font-size: 11px;
        display: none;
        max-width: 260px;
      }
      .vx-toast.show { display: block; }
    `;

    const wrap = document.createElement("div");
    wrap.className = "vx-wrap";

    const capsule = document.createElement("div");
    capsule.className = "vx-capsule";

    const mainBtn = document.createElement("button");
    mainBtn.type = "button";
    mainBtn.className = "vx-main-btn";
    mainBtn.setAttribute("aria-label", "Unduh video terbaik");
    mainBtn.title = "Klik untuk unduh kualitas terbaik (Klik panah untuk opsi)";
    mainBtn.innerHTML = `
      <svg id="vx-icon-logo" width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M12 3V14M12 14L7.5 9.5M12 14L16.5 9.5" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>
        <path d="M5 17.5C5 18.8807 6.11929 20 7.5 20H16.5C17.8807 20 19 18.8807 19 17.5" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>
      </svg>
      <svg id="vx-icon-done" class="hidden" width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M5 13L9 17L19 7" stroke="#22c55e" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
      <div id="vx-progress-wrap" class="vx-progress-wrap hidden">
        <svg class="vx-progress-svg" width="28" height="28" viewBox="0 0 28 28">
          <circle cx="14" cy="14" r="11" stroke="rgba(148,163,184,0.28)" stroke-width="2.5" fill="none"/>
          <circle id="vx-progress-circle" cx="14" cy="14" r="11" stroke="#38bdf8" stroke-width="2.5" fill="none" stroke-dasharray="69.115" stroke-dashoffset="69.115" stroke-linecap="round"/>
        </svg>
        <span id="vx-progress-text" class="vx-progress-text">0</span>
      </div>
    `;

    const chevronBtn = document.createElement("button");
    chevronBtn.type = "button";
    chevronBtn.className = "vx-chevron-btn";
    chevronBtn.setAttribute("aria-label", "Pilih resolusi dan opsi unduhan");
    chevronBtn.title = "Pilih resolusi / Audio / MSE";
    chevronBtn.innerHTML = `
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M6 9L12 15L18 9" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
    `;

    capsule.append(mainBtn, chevronBtn);

    const menu = document.createElement("div");
    menu.className = "vx-menu";

    const menuHeader = document.createElement("div");
    menuHeader.className = "vx-menu-header";
    menuHeader.innerHTML = `<span id="vx-menu-platform">Pilih Kualitas</span><span id="vx-mse-info">Auto-MSE</span>`;

    const variantsBox = document.createElement("div");
    variantsBox.className = "vx-variants";

    const btnAudio = document.createElement("button");
    btnAudio.type = "button";
    btnAudio.className = "vx-item hidden";
    btnAudio.textContent = "Unduh Audio Saja (M4A)";

    const btnMse = document.createElement("button");
    btnMse.type = "button";
    btnMse.className = "vx-item";
    btnMse.textContent = "Simpan Buffer MSE (0.0 MB)";

    const divider = document.createElement("div");
    divider.className = "vx-divider";

    const btnHideDomain = document.createElement("button");
    btnHideDomain.type = "button";
    btnHideDomain.className = "vx-item vx-item-danger";
    btnHideDomain.textContent = "Sembunyikan ikon di domain ini";

    const toast = document.createElement("div");
    toast.className = "vx-toast";

    menu.append(menuHeader, variantsBox, btnAudio, btnMse, divider, btnHideDomain);
    wrap.append(capsule, menu, toast);
    shadowRoot.append(style, wrap);
    document.body.appendChild(hostEl);

    uiRefs = {
      wrap,
      mainBtn,
      chevronBtn,
      iconLogo: mainBtn.querySelector("#vx-icon-logo"),
      iconDone: mainBtn.querySelector("#vx-icon-done"),
      progressWrap: mainBtn.querySelector("#vx-progress-wrap"),
      progressCircle: mainBtn.querySelector("#vx-progress-circle"),
      progressText: mainBtn.querySelector("#vx-progress-text"),
      menu,
      menuPlatform: menuHeader.querySelector("#vx-menu-platform"),
      mseInfo: menuHeader.querySelector("#vx-mse-info"),
      variantsBox,
      btnAudio,
      btnMse,
      btnHideDomain,
      toast,
      lastMeta: { platform: "Web", author: "", title: document.title },
      lastAudioUrl: null,
    };

    wrap.addEventListener("mouseenter", () => {
      if (hideDelayTimer) clearTimeout(hideDelayTimer);
    });

    wrap.addEventListener("mouseleave", () => {
      if (!state.menuOpen && !state.busy) scheduleHide();
    });

    // 1-Click Instant Download on Main Icon
    mainBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (state.busy) return;
      state.menuOpen = false;
      menu.classList.remove("open");

      const unified = await buildUnifiedMediaCards();
      const targetCard =
        (state.activeVideo &&
          unified.cards.find((c) => c.videoDomId === state.activeVideo.getAttribute("data-vortex-vid"))) ||
        unified.cards[0];

      if (targetCard && targetCard.variants.length > 0) {
        const chosen = pickPreferredHoverVariant(
          targetCard.variants,
          state.settings.defaultHoverQuality
        );
        await downloadStandaloneOption(chosen || targetCard.variants[0], {
          platform: targetCard.platform,
          author: targetCard.author,
          title: targetCard.title,
        });
      } else if (state.mse.videoBytes + state.mse.audioBytes > 0) {
        const res = await exportMseStandalone({
          platform: unified.platform,
          author: unified.author,
          title: unified.title,
        });
        showToast(res.ok ? `Buffer MP4 tersimpan (${res.filename})` : `Gagal: ${res.error}`);
      } else {
        state.menuOpen = true;
        menu.classList.add("open");
        await refreshMenuDynamicItems();
      }
    });

    const toggleMenu = async (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (state.busy) return;
      state.menuOpen = !state.menuOpen;
      menu.classList.toggle("open", state.menuOpen);
      if (state.menuOpen) {
        await refreshMenuDynamicItems();
      }
    };

    chevronBtn.addEventListener("click", toggleMenu);
    mainBtn.addEventListener("contextmenu", toggleMenu);

    btnAudio.addEventListener("click", async () => {
      if (uiRefs.lastAudioUrl) {
        await downloadStandaloneOption(
          { url: uiRefs.lastAudioUrl, mode: "audio" },
          uiRefs.lastMeta
        );
      }
    });

    btnMse.addEventListener("click", async () => {
      state.menuOpen = false;
      menu.classList.remove("open");
      const res = await exportMseStandalone(uiRefs.lastMeta);
      showToast(res.ok ? `Disimpan: ${res.filename}` : `Gagal: ${res.error}`);
    });

    btnHideDomain.addEventListener("click", () => {
      disableForCurrentDomain();
    });

    document.addEventListener("click", (e) => {
      if (state.menuOpen && hostEl && !hostEl.contains(e.target)) {
        state.menuOpen = false;
        menu.classList.remove("open");
      }
    });
  }

  function showToast(text) {
    if (!uiRefs) return;
    uiRefs.toast.textContent = text;
    uiRefs.toast.classList.add("show");
    if (state.toastTimer) clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => {
      if (uiRefs) uiRefs.toast.classList.remove("show");
    }, 3500);
  }

  async function refreshMenuDynamicItems() {
    if (!uiRefs) return;
    uiRefs.variantsBox.innerHTML = '<div class="vx-note">Mendeteksi stream...</div>';
    uiRefs.btnAudio.classList.add("hidden");

    const unified = await buildUnifiedMediaCards();
    const targetCard =
      (state.activeVideo &&
        unified.cards.find((c) => c.videoDomId === state.activeVideo.getAttribute("data-vortex-vid"))) ||
      unified.cards[0] ||
      null;

    const meta = targetCard
      ? { platform: targetCard.platform, author: targetCard.author, title: targetCard.title }
      : { platform: unified.platform, author: unified.author, title: unified.title };

    uiRefs.lastMeta = meta;
    uiRefs.lastAudioUrl = targetCard ? targetCard.audioUrl : null;
    uiRefs.menuPlatform.textContent = targetCard ? `${targetCard.platform} - Kualitas` : "Pilih Kualitas";
    uiRefs.variantsBox.innerHTML = "";

    if (!targetCard || targetCard.variants.length === 0) {
      const note = document.createElement("div");
      note.className = "vx-note";
      note.textContent = "Stream belum tertangkap. Putar video 2 detik atau pakai Buffer MSE di bawah.";
      uiRefs.variantsBox.appendChild(note);
    } else {
      targetCard.variants.slice(0, 6).forEach((v, idx) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = idx === 0 ? "vx-item vx-item-accent" : "vx-item";
        btn.textContent = v.label;
        btn.addEventListener("click", () => downloadStandaloneOption(v, meta));
        uiRefs.variantsBox.appendChild(btn);
      });
    }

    if (uiRefs.lastAudioUrl) {
      uiRefs.btnAudio.classList.remove("hidden");
    }

    updateMseUiIndicators();
  }

  function updateMseUiIndicators() {
    if (!uiRefs) return;
    const total = state.mse.videoBytes + state.mse.audioBytes;
    const labelMb = formatMb(total);
    uiRefs.btnMse.textContent = total > 0 ? `Simpan Buffer MSE (${labelMb})` : "Simpan Buffer MSE (Belum ada data)";
    uiRefs.mseInfo.textContent = total > 0 ? `Buffer ${labelMb}` : "Auto-MSE";
  }

  function scheduleHide() {
    if (hideDelayTimer) clearTimeout(hideDelayTimer);
    hideDelayTimer = setTimeout(() => {
      if (!state.menuOpen && !state.busy && hostEl) {
        hostEl.style.display = "none";
      }
    }, 900);
  }

  function pickPreferredHoverVariant(variants = [], pref = "best") {
    if (!Array.isArray(variants) || variants.length === 0) return null;
    if (pref === "best") return variants[0];
    if (pref === "audio") {
      return (
        variants.find((v) => v.mode === "audio" || /audio|m4a|mp3/i.test(v.label || "")) ||
        variants[0]
      );
    }
    const targetH = parseInt(String(pref).replace(/[^0-9]/g, ""), 10);
    if (!targetH) return variants[0];
    const videoOnlyOrMuxed = variants.filter(
      (v) => v.mode !== "audio" && !/^audio/i.test(v.label || "")
    );
    const pool = videoOnlyOrMuxed.length > 0 ? videoOnlyOrMuxed : variants;
    const withH = pool.map((v) => {
      const m = String(v.label || "").match(/(\d{3,4})p/i);
      const h = Number(v.height) || (m ? parseInt(m[1], 10) : 0);
      return { v, h };
    });
    const exact = withH.find((x) => x.h === targetH);
    if (exact) return exact.v;
    const atOrBelow = withH.filter((x) => x.h > 0 && x.h <= targetH).sort((a, b) => b.h - a.h);
    if (atOrBelow.length > 0) return atOrBelow[0].v;
    return pool[0];
  }

  function positionOverlayForVideo(video) {
    if (!state.domainEnabled || !video) return;
    ensureOverlayUi();
    if (!hostEl) return;

    const rect = video.getBoundingClientRect();
    if (rect.width < 120 || rect.height < 80 || rect.bottom < 0 || rect.top > window.innerHeight) {
      return;
    }

    state.activeVideo = video;
    const topPos = Math.max(8, rect.top + 10);
    const rightPos = Math.max(8, window.innerWidth - rect.right + 12);

    hostEl.style.top = `${topPos}px`;
    hostEl.style.right = `${rightPos}px`;
    hostEl.style.left = "auto";
    hostEl.style.display = "block";

    if (hideDelayTimer) clearTimeout(hideDelayTimer);
  }

  function attachVideoWatchers(video) {
    if (!video || video.dataset.vortexAttached === "1") return;
    video.dataset.vortexAttached = "1";

    video.addEventListener("mouseenter", () => positionOverlayForVideo(video));
    video.addEventListener("mousemove", () => positionOverlayForVideo(video));
    video.addEventListener("play", () => positionOverlayForVideo(video));
    video.addEventListener("mouseleave", () => {
      if (!state.menuOpen && !state.busy) scheduleHide();
    });
  }

  function scanVideos(root = document) {
    if (!root || typeof root.querySelectorAll !== "function") return;
    root.querySelectorAll("video").forEach(attachVideoWatchers);
  }

  function highlightVideoById(videoDomId) {
    if (!videoDomId) return false;
    const target = document.querySelector(`video[data-vortex-vid="${CSS.escape(videoDomId)}"]`);
    if (!target) return false;

    target.scrollIntoView({ behavior: "smooth", block: "center" });
    const prevOutline = target.style.outline;
    const prevOffset = target.style.outlineOffset;
    target.style.outline = "3px solid #38bdf8";
    target.style.outlineOffset = "-3px";
    setTimeout(() => {
      target.style.outline = prevOutline;
      target.style.outlineOffset = prevOffset;
    }, 1800);
    positionOverlayForVideo(target);
    return true;
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window || !event.data || event.data.source !== "vortex-mse-hook") {
      return;
    }
    const msg = event.data;
    if (msg.type === "MSE_STATUS" && msg.payload) {
      state.mse = msg.payload;
      updateMseUiIndicators();
    } else if (msg.type === "MSE_EXPORT_RESULT" && msg.requestId) {
      const resolver = state.pendingExports.get(msg.requestId);
      if (resolver) {
        state.pendingExports.delete(msg.requestId);
        resolver(msg.payload || {});
      }
    } else if (msg.type === "PAGE_MEDIA_INFO_RESULT" && msg.requestId) {
      const resolver = state.pendingPageInfo.get(msg.requestId);
      if (resolver) {
        state.pendingPageInfo.delete(msg.requestId);
        resolver(msg.payload || {});
      }
    }
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message) return false;
    if (typeof window !== "undefined" && window !== window.top) return false;

    if (message.type === "VORTEX_GET_UNIFIED_MEDIA") {
      buildUnifiedMediaCards(false)
        .then((data) => sendResponse({ ok: true, ...data }))
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      return true;
    }

    if (message.type === "VORTEX_FORCE_SCAN") {
      buildUnifiedMediaCards(true)
        .then((data) => sendResponse({ ok: true, ...data }))
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      return true;
    }

    if (message.type === "VORTEX_CLEAR_PAGE_CACHE") {
      window.postMessage({ source: "vortex-content", type: "CLEAR_PAGE_CACHE" }, "*");
      state.mse.videoBytes = 0;
      state.mse.audioBytes = 0;
      state.menuOpen = false;
      if (uiRefs && uiRefs.menu) uiRefs.menu.classList.remove("open");
      sendResponse({ ok: true });
      return false;
    }

    if (message.type === "VORTEX_STANDALONE_DOWNLOAD") {
      downloadStandaloneOption(message.option, message.meta || { title: message.title })
        .then(() => sendResponse({ ok: true }))
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      return true;
    }

    if (message.type === "VORTEX_HIGHLIGHT_VIDEO") {
      const found = highlightVideoById(message.videoDomId);
      sendResponse({ ok: found });
      return false;
    }

    if (message.type !== "VORTEX_MSE_CMD") return false;
    const cmd = message.command;
    if (cmd === "start") {
      window.postMessage({ source: "vortex-content", type: "START_RECORDING" }, "*");
      sendResponse({ ok: true, mse: { ...state.mse, recording: true } });
      return false;
    }
    if (cmd === "stop") {
      window.postMessage({ source: "vortex-content", type: "STOP_RECORDING" }, "*");
      sendResponse({ ok: true, mse: { ...state.mse, recording: false } });
      return false;
    }
    if (cmd === "clear") {
      window.postMessage({ source: "vortex-content", type: "CLEAR_BUFFER" }, "*");
      sendResponse({ ok: true, mse: state.mse });
      return false;
    }
    if (cmd === "status") {
      window.postMessage({ source: "vortex-content", type: "GET_STATUS" }, "*");
      setTimeout(() => sendResponse({ ok: true, mse: state.mse }), 40);
      return true;
    }
    if (cmd === "stop_export") {
      exportMseStandalone(message.meta || {}).then((res) => sendResponse(res));
      return true;
    }
    return false;
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") return;
    let shouldPush = false;
    if (changes[ENABLED_KEY]) {
      const list = Array.isArray(changes[ENABLED_KEY].newValue) ? changes[ENABLED_KEY].newValue : [];
      state.domainEnabled = Boolean(
        state.domain && list.map((d) => String(d || "").toLowerCase()).includes(state.domain)
      );
      if (state.domainEnabled) {
        ensureDomObserverStarted();
      } else {
        state.menuOpen = false;
        state.mse.recording = false;
        if (uiRefs && uiRefs.menu) uiRefs.menu.classList.remove("open");
        if (hostEl) hostEl.style.display = "none";
      }
      shouldPush = true;
    }
    if (changes[SETTINGS_KEY]) {
      const rawSettings = changes[SETTINGS_KEY].newValue;
      state.settings = {
        ...DEFAULT_SETTINGS,
        ...(rawSettings && typeof rawSettings === "object" ? rawSettings : {}),
      };
      shouldPush = true;
    }
    if (shouldPush) {
      pushDomainConfigToHook();
    }
  });

  function init() {
    domainConfigReadyPromise = checkDomainVisibility();

    window.addEventListener(
      "scroll",
      () => {
        if (state.domainEnabled && state.activeVideo && hostEl && hostEl.style.display !== "none") {
          positionOverlayForVideo(state.activeVideo);
        }
      },
      { passive: true }
    );
  }

  init();
})();
