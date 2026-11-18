(() => {
  "use strict";

  const CORE_BASE = "http://127.0.0.1:17890";
  const STORAGE_KEY = "vortex_tab_media_v2";
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

  let enabledDomainsSet = new Set();
  let cachedSettings = { ...DEFAULT_SETTINGS };
  let configLoaded = false;

  async function loadDomainAndSettings() {
    try {
      const res = await chrome.storage.local.get([ENABLED_DOMAINS_KEY, SETTINGS_KEY]);
      const domains = Array.isArray(res[ENABLED_DOMAINS_KEY]) ? res[ENABLED_DOMAINS_KEY] : [];
      enabledDomainsSet = new Set(domains.map((d) => String(d || "").toLowerCase()).filter(Boolean));
      const storedSettings = res[SETTINGS_KEY];
      cachedSettings = {
        ...DEFAULT_SETTINGS,
        ...(storedSettings && typeof storedSettings === "object" ? storedSettings : {}),
      };
      configLoaded = true;
    } catch (_) {}
  }

  const configReadyPromise = loadDomainAndSettings();

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") return;
    if (changes[ENABLED_DOMAINS_KEY]) {
      const domains = Array.isArray(changes[ENABLED_DOMAINS_KEY].newValue)
        ? changes[ENABLED_DOMAINS_KEY].newValue
        : [];
      enabledDomainsSet = new Set(domains.map((d) => String(d || "").toLowerCase()).filter(Boolean));
    }
    if (changes[SETTINGS_KEY]) {
      const next = changes[SETTINGS_KEY].newValue;
      cachedSettings = {
        ...DEFAULT_SETTINGS,
        ...(next && typeof next === "object" ? next : {}),
      };
    }
  });

  function extractHostnameSafe(rawUrl) {
    try {
      if (!rawUrl) return "";
      return new URL(rawUrl).hostname.toLowerCase();
    } catch (_) {
      return "";
    }
  }

  const tabMediaMap = new Map();
  const requestHeadersById = new Map();
  const requestHeadersByUrl = new Map();
  const mseUploads = new Map();
  const proxySessions = new Map();

  const CAPTURED_HEADER_NAMES = new Set([
    "referer",
    "user-agent",
    "authorization",
    "origin",
  ]);

  const IGNORED_SEGMENT_EXTS = [".ts", ".m4s", ".cmf", ".vtt", ".srt", ".key"];

  function decodeBase64Json(b64) {
    try {
      const normalized = b64.replace(/-/g, "+").replace(/_/g, "/");
      const pad = normalized.length % 4 === 0 ? "" : "=".repeat(4 - (normalized.length % 4));
      const binary = atob(normalized + pad);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) {
        bytes[i] = binary.charCodeAt(i);
      }
      const text = new TextDecoder().decode(bytes);
      return JSON.parse(text);
    } catch (_) {
      return null;
    }
  }

  function normalizeMediaUrlAndMeta(rawUrl) {
    let url = String(rawUrl || "");
    const meta = {
      cleanUrl: url,
      streamRole: "unknown", // progressive | dash_video | dash_audio | hls | dash_mpd
      assetKey: "",
      vencodeTag: "",
      bitrate: 0,
      durationSec: 0,
      itag: 0,
      label: "",
    };

    try {
      const u = new URL(url);
      const host = u.hostname.toLowerCase();
      const pathLower = u.pathname.toLowerCase();

      // Meta CDN (Instagram, Facebook, Threads)
      if (host.includes("fbcdn.net") || host.includes("cdninstagram.com")) {
        u.searchParams.delete("bytestart");
        u.searchParams.delete("byteend");
        meta.cleanUrl = u.href;

        const efgRaw = u.searchParams.get("efg");
        if (efgRaw) {
          const efg = decodeBase64Json(efgRaw);
          if (efg && typeof efg === "object") {
            const tag = String(efg.vencode_tag || "");
            meta.vencodeTag = tag;
            meta.bitrate = Number(efg.bitrate) || 0;
            meta.durationSec = Math.round(Number(efg.duration_s) || 0);
            meta.assetKey = String(efg.xpv_asset_id || efg.video_id || "");
            const tagLower = tag.toLowerCase();
            if (tagLower.includes("audio")) {
              meta.streamRole = "dash_audio";
              meta.label = "Audio";
            } else if (tagLower.includes("dash") || tagLower.includes("vp9") || tagLower.includes("h264") || tagLower.includes("av1")) {
              meta.streamRole = "dash_video";
              const resMatch = tag.match(/(\d{3,4})p/i);
              if (resMatch) {
                meta.label = `${resMatch[1]}p`;
              } else if (meta.bitrate > 0) {
                meta.label = `${Math.round(meta.bitrate / 1000)}kbps`;
              } else {
                meta.label = "Video";
              }
            } else if (tagLower.includes("progressive")) {
              meta.streamRole = "progressive";
              meta.label = "MP4";
            }
          }
        }
        return meta;
      }

      // Google Drive / YouTube videoplayback CDN
      if (host.includes("googlevideo.com") && pathLower.includes("videoplayback")) {
        u.searchParams.delete("range");
        u.searchParams.delete("rn");
        u.searchParams.delete("rbuf");
        u.searchParams.delete("ump");
        u.searchParams.delete("srfvp");
        meta.cleanUrl = u.href;

        const itag = parseInt(u.searchParams.get("itag") || "0", 10) || 0;
        const mime = (u.searchParams.get("mime") || "").toLowerCase();
        meta.itag = itag;
        meta.assetKey = u.searchParams.get("id") || "";

        const progressiveItags = { 18: "360p", 22: "720p", 37: "1080p", 59: "480p", 78: "480p" };
        if (progressiveItags[itag]) {
          meta.streamRole = "progressive";
          meta.label = progressiveItags[itag];
        } else if (mime.startsWith("audio/") || itag === 140 || itag === 139 || itag === 251 || itag === 250) {
          meta.streamRole = "dash_audio";
          meta.label = "Audio";
        } else if (mime.startsWith("video/")) {
          meta.streamRole = "dash_video";
          const vidItags = { 137: "1080p", 136: "720p", 135: "480p", 134: "360p", 133: "240p", 299: "1080p60", 298: "720p60" };
          meta.label = vidItags[itag] || "Video";
        }
        return meta;
      }

      meta.cleanUrl = u.href;
    } catch (_) {}

    return meta;
  }

  async function persistTabMedia() {
    try {
      const obj = {};
      for (const [tabId, list] of tabMediaMap.entries()) {
        obj[String(tabId)] = list;
      }
      await chrome.storage.session.set({ [STORAGE_KEY]: obj });
    } catch (_) {}
  }

  async function restoreTabMedia() {
    try {
      const res = await chrome.storage.session.get(STORAGE_KEY);
      const saved = res && res[STORAGE_KEY];
      if (saved && typeof saved === "object") {
        for (const [tid, list] of Object.entries(saved)) {
          const numId = Number(tid);
          if (!Number.isNaN(numId) && Array.isArray(list)) {
            tabMediaMap.set(numId, list);
          }
        }
      }
    } catch (_) {}
  }

  restoreTabMedia();

  function groupMediaItems(items) {
    const groupsMap = new Map();
    const standalone = [];

    for (const item of items) {
      if (item.assetKey) {
        const key = `asset_${item.assetKey}`;
        if (!groupsMap.has(key)) {
          groupsMap.set(key, {
            groupKey: key,
            assetKey: item.assetKey,
            durationSec: item.durationSec || 0,
            tabTitle: item.tabTitle || "",
            pageUrl: item.pageUrl || "",
            videos: [],
            audios: [],
          });
        }
        const g = groupsMap.get(key);
        if (!g.durationSec && item.durationSec) g.durationSec = item.durationSec;
        if (!g.tabTitle && item.tabTitle) g.tabTitle = item.tabTitle;
        if (item.streamRole === "dash_audio" || item.kind === "AUDIO") {
          g.audios.push(item);
        } else {
          g.videos.push(item);
        }
      } else {
        standalone.push(item);
      }
    }

    const groups = [];
    for (const g of groupsMap.values()) {
      g.videos.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
      g.audios.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
      const bestAudio = g.audios[0]?.url || null;
      if (g.videos.length > 0) {
        const seenLabels = new Set();
        const dedupVariants = [];
        for (const v of g.videos) {
          const lbl = v.label ? `${v.label} (MP4)` : "Video MP4";
          if (seenLabels.has(lbl)) continue;
          seenLabels.add(lbl);
          dedupVariants.push({
            label: lbl,
            mode: v.streamRole === "dash_video" && bestAudio ? "dash_merge" : "direct",
            url: v.url,
            audioUrl: v.streamRole === "dash_video" ? bestAudio : null,
            bitrate: v.bitrate || 0,
          });
        }
        groups.push({
          id: g.groupKey,
          assetKey: g.assetKey,
          durationSec: g.durationSec,
          title: g.tabTitle,
          pageUrl: g.pageUrl,
          kind: g.videos[0].kind,
          variants: dedupVariants,
          audioUrl: bestAudio,
        });
      } else if (g.audios.length > 0) {
        groups.push({
          id: g.groupKey,
          assetKey: g.assetKey,
          durationSec: g.durationSec,
          title: g.tabTitle,
          pageUrl: g.pageUrl,
          kind: "AUDIO",
          variants: [
            {
              label: "Audio M4A",
              mode: "audio",
              url: g.audios[0].url,
              audioUrl: null,
            },
          ],
          audioUrl: g.audios[0].url,
        });
      }
    }

    const fallbackAudio = standalone.find((x) => x.streamRole === "dash_audio" || x.kind === "AUDIO")?.url || null;
    for (const item of standalone) {
      if (item.streamRole === "dash_audio" && groups.some((g) => g.audioUrl)) {
        continue;
      }
      if (item.kind === "HLS" && Array.isArray(item.variants) && item.variants.length > 0) {
        const seenHlsLabels = new Set();
        const hlsVariants = [];
        for (const v of item.variants) {
          const lbl = `${v.label} (HLS)`;
          if (seenHlsLabels.has(lbl)) continue;
          seenHlsLabels.add(lbl);
          hlsVariants.push({
            label: lbl,
            mode: "hls",
            url: v.url,
            audioUrl: null,
          });
        }
        groups.push({
          id: item.id,
          durationSec: item.durationSec || 0,
          title: item.tabTitle || "",
          pageUrl: item.pageUrl || "",
          kind: "HLS",
          variants: hlsVariants,
          audioUrl: null,
        });
      } else {
        const isDashVideo = item.streamRole === "dash_video";
        const audioPair = item.pairedAudioUrl || (isDashVideo ? fallbackAudio : null);
        groups.push({
          id: item.id,
          durationSec: item.durationSec || 0,
          title: item.tabTitle || "",
          pageUrl: item.pageUrl || "",
          kind: item.kind,
          variants: [
            {
              label: item.kind === "HLS" ? "Stream HLS" : item.label || item.kind || "MP4",
              mode: item.kind === "HLS" ? "hls" : isDashVideo && audioPair ? "dash_merge" : item.formatHint === "mp3" ? "audio" : "direct",
              url: item.url,
              audioUrl: isDashVideo ? audioPair : null,
            },
          ],
          audioUrl: item.formatHint === "mp3" ? item.url : audioPair,
        });
      }
    }

    return groups;
  }

  function updateBadge(tabId) {
    if (typeof tabId !== "number" || tabId < 0) return;
    const items = tabMediaMap.get(tabId) || [];
    const groups = groupMediaItems(items);
    const text = groups.length > 0 ? String(groups.length) : "";
    chrome.action.setBadgeText({ tabId, text }).catch(() => {});
    chrome.action.setBadgeBackgroundColor({ tabId, color: "#0ea5e9" }).catch(() => {});
  }

  function extractImportantHeaders(headerList) {
    const out = {};
    if (!Array.isArray(headerList)) return out;
    for (const h of headerList) {
      if (!h || !h.name || !h.value) continue;
      const lower = h.name.toLowerCase();
      if (CAPTURED_HEADER_NAMES.has(lower)) {
        out[h.name] = h.value;
      }
    }
    return out;
  }

  function cleanUrlForMatch(rawUrl) {
    try {
      const u = new URL(rawUrl);
      return u.pathname.toLowerCase();
    } catch (_) {
      return String(rawUrl || "").toLowerCase().split("?")[0];
    }
  }

  function classifyMedia(url, contentType, urlMeta) {
    if (
      !url ||
      url.startsWith(CORE_BASE) ||
      url.startsWith("chrome-extension://") ||
      url.startsWith("blob:") ||
      url.startsWith("data:")
    ) {
      return null;
    }

    const path = cleanUrlForMatch(url);
    const ct = String(contentType || "").split(";")[0].trim().toLowerCase();

    if (IGNORED_SEGMENT_EXTS.some((ext) => path.endsWith(ext))) {
      return null;
    }
    if (ct === "video/mp2t" || (ct === "application/octet-stream" && path.endsWith(".m4s"))) {
      return null;
    }

    if (
      path.endsWith(".m3u8") ||
      url.toLowerCase().includes(".m3u8?") ||
      ct === "application/vnd.apple.mpegurl" ||
      ct === "application/x-mpegurl" ||
      ct === "audio/mpegurl"
    ) {
      return { kind: "HLS", formatHint: "mp4", isM3u8: true };
    }

    if (
      path.endsWith(".mpd") ||
      url.toLowerCase().includes(".mpd?") ||
      ct === "application/dash+xml"
    ) {
      return { kind: "DASH", formatHint: "mp4", isM3u8: false };
    }

    if (urlMeta && urlMeta.streamRole === "dash_audio") {
      return { kind: "AUDIO", formatHint: "mp3", isM3u8: false };
    }

    if (path.endsWith(".mp4") || ct === "video/mp4" || path.includes("videoplayback")) {
      return { kind: "MP4", formatHint: "mp4", isM3u8: false };
    }
    if (path.endsWith(".webm") || ct === "video/webm") {
      return { kind: "WEBM", formatHint: "mp4", isM3u8: false };
    }
    if (path.endsWith(".mkv") || ct === "video/x-matroska") {
      return { kind: "MKV", formatHint: "mp4", isM3u8: false };
    }
    if (path.endsWith(".mov") || ct === "video/quicktime") {
      return { kind: "MOV", formatHint: "mp4", isM3u8: false };
    }
    if (
      path.endsWith(".mp3") ||
      path.endsWith(".m4a") ||
      path.endsWith(".aac") ||
      path.endsWith(".flac") ||
      path.endsWith(".wav") ||
      ct.startsWith("audio/")
    ) {
      return { kind: "AUDIO", formatHint: "mp3", isM3u8: false };
    }
    if (ct.startsWith("video/")) {
      return { kind: "VIDEO", formatHint: "mp4", isM3u8: false };
    }

    return null;
  }

  function parseM3u8Attributes(attrText) {
    const attrs = {};
    const regex = /([A-Z0-9-]+)=("([^"]*)"|([^,]*))/g;
    let match;
    while ((match = regex.exec(attrText)) !== null) {
      attrs[match[1]] = match[3] !== undefined ? match[3] : match[4];
    }
    return attrs;
  }

  function parseMasterM3u8(text, masterUrl) {
    if (!text || !text.includes("#EXT-X-STREAM-INF")) {
      return { variants: [], audioTracks: [] };
    }

    const lines = text.split(/\r?\n/).map((l) => l.trim());
    const variants = [];
    const audioTracks = [];
    const seenUrls = new Set();

    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (!line) continue;

      if (line.startsWith("#EXT-X-MEDIA:")) {
        const attrs = parseM3u8Attributes(line.slice("#EXT-X-MEDIA:".length));
        if ((attrs.TYPE || "").toUpperCase() === "AUDIO" && attrs.URI) {
          try {
            const absUri = new URL(attrs.URI, masterUrl).href;
            audioTracks.push({
              name: attrs.NAME || attrs.LANGUAGE || "Audio Track",
              language: attrs.LANGUAGE || "",
              url: absUri,
            });
          } catch (_) {}
        }
        continue;
      }

      if (line.startsWith("#EXT-X-STREAM-INF:")) {
        const attrs = parseM3u8Attributes(line.slice("#EXT-X-STREAM-INF:".length));
        let nextUrl = "";
        for (let j = i + 1; j < lines.length; j += 1) {
          if (lines[j] && !lines[j].startsWith("#")) {
            nextUrl = lines[j];
            i = j;
            break;
          }
        }
        if (!nextUrl) continue;

        try {
          const absUrl = new URL(nextUrl, masterUrl).href;
          if (seenUrls.has(absUrl)) continue;
          seenUrls.add(absUrl);

          const resStr = attrs.RESOLUTION || "";
          let height = 0;
          let label = "";
          if (resStr.includes("x")) {
            const parts = resStr.split("x");
            height = parseInt(parts[1], 10) || 0;
            label = height > 0 ? `${height}p` : resStr;
          } else if (attrs.NAME) {
            label = attrs.NAME;
          } else if (attrs.BANDWIDTH) {
            const kbps = Math.round((parseInt(attrs.BANDWIDTH, 10) || 0) / 1000);
            label = kbps > 0 ? `${kbps} kbps` : "Stream";
          } else {
            label = "Variant";
          }

          const bandwidth = parseInt(attrs.BANDWIDTH || "0", 10) || 0;
          variants.push({
            label,
            resolution: height > 0 ? `${height}p` : "best",
            height,
            bandwidth,
            url: absUrl,
          });
        } catch (_) {}
      }
    }

    variants.sort((a, b) => (b.height - a.height) || (b.bandwidth - a.bandwidth));
    return { variants, audioTracks };
  }

  async function enrichM3u8Variants(tabId, mediaUrl, reqHeaders) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      const resp = await fetch(mediaUrl, { credentials: "include", signal: controller.signal });
      clearTimeout(timer);
      if (!resp.ok) return;

      const text = await resp.text();
      const parsed = parseMasterM3u8(text, mediaUrl);
      if (parsed.variants.length === 0 && parsed.audioTracks.length === 0) return;

      const list = tabMediaMap.get(tabId);
      if (!list) return;
      const target = list.find((item) => item.url === mediaUrl);
      if (!target) return;

      target.variants = parsed.variants;
      target.audioTracks = parsed.audioTracks;
      if (reqHeaders && Object.keys(reqHeaders).length > 0) {
        target.headers = { ...target.headers, ...reqHeaders };
      }
      await persistTabMedia();
    } catch (_) {}
  }

  function linkDashPairs(list) {
    const audios = list.filter((x) => x.streamRole === "dash_audio");
    for (const item of list) {
      if (item.streamRole === "dash_video") {
        let matched = null;
        if (item.assetKey) {
          matched = audios.find((a) => a.assetKey === item.assetKey) || null;
        } else {
          matched = audios.find((a) => !a.assetKey) || audios[0] || null;
        }
        item.pairedAudioUrl = matched ? matched.url : null;
      }
    }
  }

  function recordDetectedMedia(tabId, item) {
    if (typeof tabId !== "number" || tabId < 0) return;
    const list = tabMediaMap.get(tabId) || [];
    const existingIdx = list.findIndex((entry) => entry.url === item.url);
    if (existingIdx !== -1) {
      const existing = list[existingIdx];
      existing.headers = { ...existing.headers, ...item.headers };
      if (item.sizeBytes > 0 && !existing.sizeBytes) existing.sizeBytes = item.sizeBytes;
      if (item.tabTitle && !existing.tabTitle) existing.tabTitle = item.tabTitle;
    } else {
      list.unshift(item);
      if (list.length > 60) list.pop();
      tabMediaMap.set(tabId, list);
      updateBadge(tabId);
    }
    linkDashPairs(list);
    persistTabMedia();
  }

  const sendHeadersListener = (details) => {
    if (details.tabId < 0) return;
    const captured = extractImportantHeaders(details.requestHeaders);
    if (Object.keys(captured).length > 0) {
      requestHeadersById.set(details.requestId, captured);
      requestHeadersByUrl.set(details.url, captured);
      if (requestHeadersById.size > 800) {
        const firstKey = requestHeadersById.keys().next().value;
        requestHeadersById.delete(firstKey);
      }
      if (requestHeadersByUrl.size > 800) {
        const firstUrl = requestHeadersByUrl.keys().next().value;
        requestHeadersByUrl.delete(firstUrl);
      }
    }
  };

  try {
    chrome.webRequest.onSendHeaders.addListener(
      sendHeadersListener,
      { urls: ["<all_urls>"] },
      ["requestHeaders", "extraHeaders"]
    );
  } catch (_) {
    chrome.webRequest.onSendHeaders.addListener(
      sendHeadersListener,
      { urls: ["<all_urls>"] },
      ["requestHeaders"]
    );
  }

  chrome.webRequest.onHeadersReceived.addListener(
    (details) => {
      if (details.tabId < 0) return;
      if (details.statusCode >= 400) return;
      if (configLoaded && enabledDomainsSet.size === 0) return;

      let contentType = "";
      let sizeBytes = 0;
      if (Array.isArray(details.responseHeaders)) {
        for (const h of details.responseHeaders) {
          if (!h || !h.name) continue;
          const lower = h.name.toLowerCase();
          if (lower === "content-type") contentType = h.value || "";
          if (lower === "content-length") {
            const parsedLen = parseInt(h.value || "0", 10);
            if (!Number.isNaN(parsedLen)) sizeBytes = parsedLen;
          }
        }
      }

      const urlMeta = normalizeMediaUrlAndMeta(details.url);
      const classified = classifyMedia(urlMeta.cleanUrl, contentType, urlMeta);
      if (!classified) return;

      const reqHeaders =
        requestHeadersById.get(details.requestId) ||
        requestHeadersByUrl.get(details.url) ||
        {};
      requestHeadersById.delete(details.requestId);

      // Keep segmented request capture if we cleaned bytestart/range params, only ignore tiny non-ranged probes
      const hadByteRangeParam = details.url !== urlMeta.cleanUrl;
      if (!hadByteRangeParam && sizeBytes > 0 && sizeBytes < 10240 && !classified.isM3u8 && classified.kind !== "DASH") {
        return;
      }

      const item = {
        id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        url: urlMeta.cleanUrl,
        kind: classified.kind,
        formatHint: classified.formatHint,
        contentType,
        sizeBytes: hadByteRangeParam ? 0 : sizeBytes,
        streamRole: urlMeta.streamRole,
        assetKey: urlMeta.assetKey,
        vencodeTag: urlMeta.vencodeTag,
        bitrate: urlMeta.bitrate,
        durationSec: urlMeta.durationSec || 0,
        itag: urlMeta.itag,
        label: urlMeta.label,
        pairedAudioUrl: null,
        headers: reqHeaders,
        variants: [],
        audioTracks: [],
        detectedAt: Date.now(),
      };

      chrome.tabs.get(details.tabId, async (tab) => {
        if (!configLoaded) {
          await configReadyPromise;
        }
        const pageUrl =
          (!chrome.runtime.lastError && tab && tab.url) ||
          details.initiator ||
          details.documentUrl ||
          "";
        const pageHost = extractHostnameSafe(pageUrl);
        if (!pageHost || !enabledDomainsSet.has(pageHost)) {
          return;
        }
        if (!chrome.runtime.lastError && tab) {
          item.pageUrl = tab.url || details.initiator || "";
          item.tabTitle = tab.title || "";
        }
        recordDetectedMedia(details.tabId, item);
        if (classified.isM3u8) {
          enrichM3u8Variants(details.tabId, urlMeta.cleanUrl, reqHeaders);
        }
      });
    },
    { urls: ["<all_urls>"] },
    ["responseHeaders"]
  );

  chrome.tabs.onRemoved.addListener((tabId) => {
    tabMediaMap.delete(tabId);
    persistTabMedia();
  });

  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.status === "loading" && changeInfo.url) {
      tabMediaMap.delete(tabId);
      updateBadge(tabId);
      persistTabMedia();
    }
  });

  function sanitizeBrowserFilename(name, fallbackExt = "mp4") {
    let clean = String(name || "vortex_video")
      .replace(/[<>:"/\\|?*\x00-\x1f]+/g, "_")
      .replace(/\s+/g, " ")
      .trim();
    if (!clean) clean = "vortex_video";
    if (!/\.[a-z0-9]{2,5}$/i.test(clean)) {
      clean = `${clean}.${fallbackExt}`;
    }
    if (clean.length > 160) {
      const dot = clean.lastIndexOf(".");
      const ext = dot !== -1 ? clean.slice(dot) : `.${fallbackExt}`;
      clean = `${clean.slice(0, 150)}${ext}`;
    }
    return clean;
  }

  function sanitizeSubfolderPath(rawPath) {
    if (!rawPath) return "";
    return String(rawPath)
      .split(/[\\/]+/)
      .map((seg) =>
        seg
          .replace(/[<>:"|?*\x00-\x1f]+/g, "_")
          .replace(/\s+/g, " ")
          .trim()
      )
      .filter((seg) => seg && seg !== "." && seg !== "..")
      .join("/");
  }

  function buildDownloadTargetPath(payload = {}, settings = DEFAULT_SETTINGS) {
    const fallbackExt =
      String(payload.ext || "mp4")
        .replace(/[^a-z0-9]/gi, "")
        .toLowerCase() || "mp4";
    const cleanFile = sanitizeBrowserFilename(
      payload.filename || payload.title || "vortex_video",
      fallbackExt
    );
    const dotIdx = cleanFile.lastIndexOf(".");
    const actualExt = dotIdx !== -1 ? cleanFile.slice(dotIdx + 1).toLowerCase() : fallbackExt;

    const parts = [];
    const baseSub = sanitizeSubfolderPath(settings.downloadSubfolder);
    if (baseSub) parts.push(baseSub);

    if (settings.autoCategoryFolder) {
      const cat = String(payload.category || "").toLowerCase();
      const isAudio =
        cat === "audio" || ["m4a", "mp3", "aac", "ogg", "opus", "wav"].includes(actualExt);
      parts.push(isAudio ? "Audio" : "Video");
    }

    parts.push(cleanFile);
    return parts.join("/");
  }

  async function triggerBrowserDownload(payload) {
    const url = payload.url;
    if (!url) throw new Error("URL download tidak valid.");
    if (!configLoaded) {
      await configReadyPromise;
    }
    const targetPath = buildDownloadTargetPath(payload, cachedSettings);
    const saveAs =
      typeof payload.saveAs === "boolean" ? payload.saveAs : Boolean(cachedSettings.askWhereToSave);
    const downloadId = await chrome.downloads.download({
      url,
      filename: targetPath,
      conflictAction: "uniquify",
      saveAs,
    });
    return { downloadId, filename: targetPath };
  }

  async function collectCookiesForUrls(urls) {
    const cookiePairs = new Map();
    for (const rawUrl of urls) {
      if (!rawUrl || !rawUrl.startsWith("http")) continue;
      try {
        const list = await chrome.cookies.getAll({ url: rawUrl });
        for (const c of list) {
          if (c && c.name) cookiePairs.set(c.name, c.value || "");
        }
      } catch (_) {}
    }
    const parts = [];
    for (const [k, v] of cookiePairs.entries()) parts.push(`${k}=${v}`);
    return parts.join("; ");
  }

  async function handleEnqueueCore(payload) {
    const targetUrl = normalizeMediaUrlAndMeta(payload.url).cleanUrl;
    const pageUrl = payload.pageUrl || "";
    const storedHeaders = requestHeadersByUrl.get(targetUrl) || {};
    const mergedHeaders = { ...storedHeaders, ...(payload.headers || {}) };
    if (pageUrl && !mergedHeaders.Referer && !mergedHeaders.referer) {
      mergedHeaders.Referer = pageUrl;
    }
    if (!mergedHeaders["User-Agent"] && !mergedHeaders["user-agent"] && navigator.userAgent) {
      mergedHeaders["User-Agent"] = navigator.userAgent;
    }

    const cookieString = await collectCookiesForUrls([targetUrl, pageUrl]);
    const resp = await fetch(`${CORE_BASE}/api/enqueue`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: targetUrl,
        page_url: pageUrl || null,
        title: payload.title || null,
        headers: mergedHeaders,
        cookies: cookieString || null,
        engine_hint: payload.engineHint || "auto",
        format_mode: payload.formatMode || "mp4",
        resolution: payload.resolution || "best",
      }),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(data.detail || `Vortex Core HTTP ${resp.status}`);
    return data;
  }

  async function startProxyFetch(url) {
    const resp = await fetch(url, { credentials: "include" });
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status} saat mengambil media.`);
    }
    const buf = new Uint8Array(await resp.arrayBuffer());
    const id = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    proxySessions.set(id, buf);
    setTimeout(() => proxySessions.delete(id), 120_000);
    return { fetchId: id, totalBytes: buf.byteLength };
  }

  function readProxySlice(fetchId, offset, length) {
    const buf = proxySessions.get(fetchId);
    if (!buf) throw new Error("Proxy buffer session expired.");
    const end = Math.min(buf.byteLength, offset + length);
    const slice = buf.subarray(offset, end);
    const done = end >= buf.byteLength;
    if (done) proxySessions.delete(fetchId);
    return { bytes: Array.from(slice), done, totalBytes: buf.byteLength };
  }

  async function handleMseFinish(uploadId) {
    const session = mseUploads.get(uploadId);
    if (!session) throw new Error("MSE upload session expired.");
    mseUploads.delete(uploadId);

    const videoBlob = new Blob(session.videoParts, { type: "video/mp4" });
    const formData = new FormData();
    formData.append("video_blob", videoBlob, "video.bin");
    if (session.audioParts.length > 0) {
      formData.append("audio_blob", new Blob(session.audioParts, { type: "audio/mp4" }), "audio.bin");
    }
    formData.append("title", session.title || "MSE Capture");
    if (session.pageUrl) formData.append("page_url", session.pageUrl);
    formData.append("format_mode", session.formatMode || "mp4");

    const resp = await fetch(`${CORE_BASE}/api/mse/upload`, { method: "POST", body: formData });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(data.detail || `MSE upload HTTP ${resp.status}`);
    return data;
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    const type = message && message.type;

    if (type === "VORTEX_CHECK_HEALTH") {
      fetch(`${CORE_BASE}/api/health`)
        .then((r) => r.json().then((d) => ({ ok: r.ok, data: d })))
        .then((res) => sendResponse(res))
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      return true;
    }

    if (type === "VORTEX_GET_TAB_MEDIA") {
      const tabId = typeof message.tabId === "number" ? message.tabId : sender.tab?.id;
      const items = typeof tabId === "number" ? (tabMediaMap.get(tabId) || []) : [];
      const groups = groupMediaItems(items);
      sendResponse({ ok: true, items, groups });
      return false;
    }

    if (type === "VORTEX_CLEAR_TAB_MEDIA") {
      const tabId = typeof message.tabId === "number" ? message.tabId : sender.tab?.id;
      if (typeof tabId === "number") {
        tabMediaMap.delete(tabId);
        updateBadge(tabId);
        persistTabMedia();
      }
      sendResponse({ ok: true });
      return false;
    }

    if (type === "VORTEX_SET_BADGE_COUNT") {
      const tabId = typeof message.tabId === "number" ? message.tabId : sender.tab?.id;
      const count = Math.max(0, Number(message.count) || 0);
      if (typeof tabId === "number" && tabId >= 0) {
        const text = count > 0 ? String(count) : "";
        chrome.action.setBadgeText({ tabId, text }).catch(() => {});
        chrome.action.setBadgeBackgroundColor({ tabId, color: "#0ea5e9" }).catch(() => {});
      }
      sendResponse({ ok: true });
      return false;
    }

    if (type === "VORTEX_BROWSER_DOWNLOAD") {
      triggerBrowserDownload(message.payload || {})
        .then((res) => sendResponse({ ok: true, data: res }))
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      return true;
    }

    if (type === "VORTEX_PROXY_FETCH_START") {
      startProxyFetch(message.url)
        .then((res) => sendResponse({ ok: true, ...res }))
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      return true;
    }

    if (type === "VORTEX_PROXY_FETCH_SLICE") {
      try {
        const res = readProxySlice(message.fetchId, message.offset || 0, message.length || 524288);
        sendResponse({ ok: true, ...res });
      } catch (err) {
        sendResponse({ ok: false, error: err.message });
      }
      return false;
    }

    if (type === "VORTEX_ENQUEUE") {
      handleEnqueueCore(message.payload || {})
        .then((data) => sendResponse({ ok: true, data }))
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      return true;
    }

    if (type === "VORTEX_MSE_START") {
      const uploadId = `${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
      mseUploads.set(uploadId, {
        title: message.title || "MSE Capture",
        pageUrl: message.pageUrl || "",
        formatMode: message.formatMode || "mp4",
        videoParts: [],
        audioParts: [],
      });
      sendResponse({ ok: true, uploadId });
      return false;
    }

    if (type === "VORTEX_MSE_CHUNK") {
      const session = mseUploads.get(message.uploadId);
      if (!session) {
        sendResponse({ ok: false, error: "Upload session not found." });
        return false;
      }
      const chunkBytes = new Uint8Array(message.bytes || []);
      if (message.kind === "audio") session.audioParts.push(chunkBytes);
      else session.videoParts.push(chunkBytes);
      sendResponse({ ok: true });
      return false;
    }

    if (type === "VORTEX_MSE_FINISH") {
      handleMseFinish(message.uploadId)
        .then((data) => sendResponse({ ok: true, data }))
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      return true;
    }

    if (type === "VORTEX_OPEN_DASHBOARD") {
      chrome.tabs.query({ url: `${CORE_BASE}/*` }, (tabs) => {
        if (tabs && tabs.length > 0) {
          chrome.tabs.update(tabs[0].id, { active: true });
          if (typeof tabs[0].windowId === "number") {
            chrome.windows.update(tabs[0].windowId, { focused: true });
          }
        } else {
          chrome.tabs.create({ url: CORE_BASE });
        }
        sendResponse({ ok: true });
      });
      return true;
    }

    return false;
  });
})();
