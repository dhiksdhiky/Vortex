(() => {
  "use strict";

  if (window.__vortexMseHookInstalled) return;
  window.__vortexMseHookInstalled = true;

  const MAX_BUFFER_BYTES = 180 * 1024 * 1024; // 180 MiB rolling auto-buffer ceiling
  const mediaSourceOrder = [];
  const mediaSourceBuffers = new WeakMap();
  const bufferMeta = new WeakMap();

  const state = {
    recording: false, // Only capture MSE RAM buffer on demand to keep Chrome fast
    hasMediaSource: false,
    domainActive: false,
    maxHistory: 15,
  };
  const ignoredVideoKeys = new Set();

  function classifyMime(mimeType) {
    const lower = String(mimeType || "").toLowerCase();
    if (lower.startsWith("audio/")) return "audio";
    return "video";
  }

  function toUint8Array(data) {
    if (data instanceof ArrayBuffer) {
      return new Uint8Array(data.slice(0));
    }
    if (ArrayBuffer.isView(data)) {
      return new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
    }
    return null;
  }

  function looksLikeInitSegment(bytes) {
    if (!bytes || bytes.length < 8) return false;
    const ascii4 = String.fromCharCode(bytes[4], bytes[5], bytes[6], bytes[7]);
    if (ascii4 === "ftyp" || ascii4 === "moov") return true;
    if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return true;
    return false;
  }

  function getActiveMediaSource() {
    for (let i = mediaSourceOrder.length - 1; i >= 0; i -= 1) {
      const ms = mediaSourceOrder[i];
      const set = mediaSourceBuffers.get(ms);
      if (!set) continue;
      for (const sb of set) {
        const meta = bufferMeta.get(sb);
        if (meta && meta.recordedBytes > 0) return ms;
      }
    }
    return mediaSourceOrder[mediaSourceOrder.length - 1] || null;
  }

  function totalTrackedBytesForSource(ms) {
    let videoBytes = 0;
    let audioBytes = 0;
    if (!ms) return { videoBytes, audioBytes };
    const set = mediaSourceBuffers.get(ms);
    if (!set) return { videoBytes, audioBytes };
    for (const sb of set) {
      const meta = bufferMeta.get(sb);
      if (!meta) continue;
      if (meta.kind === "audio") audioBytes += meta.recordedBytes;
      else videoBytes += meta.recordedBytes;
    }
    return { videoBytes, audioBytes };
  }

  function totalAllTrackedBytes() {
    let total = 0;
    for (const ms of mediaSourceOrder) {
      const { videoBytes, audioBytes } = totalTrackedBytesForSource(ms);
      total += videoBytes + audioBytes;
    }
    return total;
  }

  function pruneOldMediaSourcesIfNeeded() {
    while (mediaSourceOrder.length > 2 || totalAllTrackedBytes() > MAX_BUFFER_BYTES) {
      if (mediaSourceOrder.length <= 1) break;
      const oldest = mediaSourceOrder.shift();
      const set = mediaSourceBuffers.get(oldest);
      if (set) {
        for (const sb of set) {
          const meta = bufferMeta.get(sb);
          if (meta) {
            meta.chunks = [];
            meta.recordedBytes = 0;
          }
        }
      }
    }
  }

  function emitStatus() {
    const activeMs = getActiveMediaSource();
    const { videoBytes, audioBytes } = totalTrackedBytesForSource(activeMs);
    window.postMessage(
      {
        source: "vortex-mse-hook",
        type: "MSE_STATUS",
        payload: {
          recording: state.recording,
          hasMediaSource: state.hasMediaSource,
          videoBytes,
          audioBytes,
        },
      },
      "*"
    );
  }

  function concatChunks(chunks) {
    let total = 0;
    for (const c of chunks) total += c.byteLength;
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) {
      merged.set(c, offset);
      offset += c.byteLength;
    }
    return merged;
  }

  function exportRecordedBuffers(requestId, formatMode) {
    const activeMs = getActiveMediaSource();
    const videoParts = [];
    const audioParts = [];

    if (activeMs) {
      const set = mediaSourceBuffers.get(activeMs);
      if (set) {
        for (const sb of set) {
          const meta = bufferMeta.get(sb);
          if (!meta || meta.chunks.length === 0) continue;
          const combined = concatChunks(meta.chunks);
          if (meta.kind === "audio") audioParts.push(combined);
          else videoParts.push(combined);
        }
      }
    }

    const videoBuffer = videoParts.length > 0 ? concatChunks(videoParts).buffer : new ArrayBuffer(0);
    const audioBuffer = audioParts.length > 0 ? concatChunks(audioParts).buffer : new ArrayBuffer(0);

    const transferList = [videoBuffer];
    if (audioBuffer.byteLength > 0) transferList.push(audioBuffer);

    window.postMessage(
      {
        source: "vortex-mse-hook",
        type: "MSE_EXPORT_RESULT",
        requestId,
        payload: {
          formatMode: formatMode || "mp4",
          videoBuffer,
          audioBuffer: audioBuffer.byteLength > 0 ? audioBuffer : null,
        },
      },
      "*",
      transferList
    );
  }

  function clearRecordedBuffers() {
    for (const ms of mediaSourceOrder) {
      const set = mediaSourceBuffers.get(ms);
      if (!set) continue;
      for (const sb of set) {
        const meta = bufferMeta.get(sb);
        if (meta) {
          meta.chunks = [];
          meta.recordedBytes = 0;
          meta.initAppended = false;
        }
      }
    }
    emitStatus();
  }

  if (typeof window.MediaSource === "function" && window.MediaSource.prototype) {
    const origAddSourceBuffer = window.MediaSource.prototype.addSourceBuffer;
    window.MediaSource.prototype.addSourceBuffer = function (mimeType) {
      state.hasMediaSource = true;
      if (!mediaSourceBuffers.has(this)) {
        mediaSourceBuffers.set(this, new Set());
        mediaSourceOrder.push(this);
        pruneOldMediaSourcesIfNeeded();
      }
      const sb = origAddSourceBuffer.call(this, mimeType);
      bufferMeta.set(sb, {
        parentMs: this,
        kind: classifyMime(mimeType),
        mimeType: String(mimeType || ""),
        initSegment: null,
        initAppended: false,
        chunks: [],
        recordedBytes: 0,
      });
      mediaSourceBuffers.get(this).add(sb);
      emitStatus();
      return sb;
    };
  }

  if (typeof window.SourceBuffer === "function" && window.SourceBuffer.prototype) {
    const origAppendBuffer = window.SourceBuffer.prototype.appendBuffer;
    window.SourceBuffer.prototype.appendBuffer = function (data) {
      try {
        const meta = bufferMeta.get(this);
        if (meta) {
          const copy = toUint8Array(data);
          if (copy && copy.byteLength > 0) {
            if (!meta.initSegment && looksLikeInitSegment(copy)) {
              meta.initSegment = copy;
            }
            if (state.recording) {
              const msTotals = totalTrackedBytesForSource(meta.parentMs);
              if (msTotals.videoBytes + msTotals.audioBytes + copy.byteLength <= MAX_BUFFER_BYTES) {
                if (!meta.initAppended && meta.initSegment && meta.initSegment !== copy) {
                  meta.chunks.push(meta.initSegment);
                  meta.recordedBytes += meta.initSegment.byteLength;
                  meta.initAppended = true;
                }
                if (copy === meta.initSegment) {
                  meta.initAppended = true;
                }
                meta.chunks.push(copy);
                meta.recordedBytes += copy.byteLength;
              }
              pruneOldMediaSourcesIfNeeded();
            }
          }
        }
      } catch (_) {}
      return origAppendBuffer.call(this, data);
    };
  }

  // --- Platform-Specific Extractors (MAIN World) ---

  function cleanMetaCdnUrl(rawUrl) {
    if (!rawUrl || typeof rawUrl !== "string") return "";
    const unescaped = rawUrl.replace(/&amp;/g, "&").replace(/\\\//g, "/");
    try {
      const u = new URL(unescaped);
      u.searchParams.delete("bytestart");
      u.searchParams.delete("byteend");
      return u.href;
    } catch (_) {
      return unescaped;
    }
  }

  function extractAssetKeyFromUrl(rawUrl) {
    if (!rawUrl || typeof rawUrl !== "string") return "";
    try {
      const u = new URL(rawUrl);
      const efgRaw = u.searchParams.get("efg");
      if (efgRaw) {
        const normalized = efgRaw.replace(/-/g, "+").replace(/_/g, "/");
        const pad = normalized.length % 4 === 0 ? "" : "=".repeat(4 - (normalized.length % 4));
        const bin = atob(normalized + pad);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
        const efg = JSON.parse(new TextDecoder().decode(bytes));
        const key = efg && (efg.xpv_asset_id || efg.video_id);
        if (key) return String(key);
      }
      if (u.hostname.includes("googlevideo.com")) {
        return u.searchParams.get("id") || "";
      }
    } catch (_) {}
    return "";
  }

  function formatResolutionLabel(shortSide, bandwidth) {
    if (shortSide >= 2000) return "2160p";
    if (shortSide >= 1350) return "1440p";
    if (shortSide >= 1040) return "1080p";
    if (shortSide >= 700 && shortSide <= 740) return "720p";
    if (shortSide >= 520 && shortSide <= 560) return "540p";
    if (shortSide >= 460 && shortSide <= 500) return "480p";
    if (shortSide >= 340 && shortSide <= 380) return "360p";
    if (shortSide > 0) return `${shortSide}p`;
    if (bandwidth > 0) return `${Math.round(bandwidth / 1000)}kbps`;
    return "Video";
  }

  function parseMetaDashManifest(xmlText) {
    const rawVideos = [];
    const audios = [];
    if (!xmlText || typeof xmlText !== "string" || !xmlText.includes("<Representation")) {
      return { videos: [], audios };
    }
    try {
      const doc = new DOMParser().parseFromString(xmlText, "text/xml");
      const sets = doc.querySelectorAll("AdaptationSet");
      sets.forEach((set) => {
        const setMime = (set.getAttribute("mimeType") || set.getAttribute("contentType") || "").toLowerCase();
        const reps = set.querySelectorAll("Representation");
        reps.forEach((rep) => {
          const repMime = (rep.getAttribute("mimeType") || setMime || "").toLowerCase();
          const baseUrlEl = rep.querySelector("BaseURL");
          if (!baseUrlEl || !baseUrlEl.textContent) return;
          const url = cleanMetaCdnUrl(baseUrlEl.textContent.trim());
          if (!url.startsWith("http")) return;
          const width = parseInt(rep.getAttribute("width") || "0", 10) || 0;
          const height = parseInt(rep.getAttribute("height") || "0", 10) || 0;
          const bandwidth = parseInt(rep.getAttribute("bandwidth") || "0", 10) || 0;
          const codecs = rep.getAttribute("codecs") || "";

          if (repMime.includes("audio") || (!height && !width && codecs.startsWith("mp4a"))) {
            audios.push({ url, bandwidth, codecs, assetKey: extractAssetKeyFromUrl(url) });
          } else {
            const shortSide = (width > 0 && height > 0) ? Math.min(width, height) : (height || width);
            const label = formatResolutionLabel(shortSide, bandwidth);
            rawVideos.push({
              url,
              width,
              height,
              shortSide,
              bandwidth,
              label,
              codecs,
              assetKey: extractAssetKeyFromUrl(url),
            });
          }
        });
      });
    } catch (_) {}

    // Sort highest resolution, prefer avc1 (H.264) over vp09, then highest bandwidth
    rawVideos.sort((a, b) => {
      if (b.shortSide !== a.shortSide) return b.shortSide - a.shortSide;
      const aAvc = a.codecs && a.codecs.toLowerCase().includes("avc1") ? 1 : 0;
      const bAvc = b.codecs && b.codecs.toLowerCase().includes("avc1") ? 1 : 0;
      if (bAvc !== aAvc) return bAvc - aAvc;
      return (b.bandwidth || 0) - (a.bandwidth || 0);
    });
    const seenLabels = new Set();
    const videos = [];
    for (const v of rawVideos) {
      if (seenLabels.has(v.label)) continue;
      seenLabels.add(v.label);
      videos.push(v);
    }

    audios.sort((a, b) => b.bandwidth - a.bandwidth);
    return { videos, audios };
  }

  function extractSingleMetaItemMedia(itemObj, outBucket) {
    if (!itemObj || typeof itemObj !== "object") return;

    if (Array.isArray(itemObj.video_versions)) {
      for (const v of itemObj.video_versions) {
        if (v && v.url) {
          const h = parseInt(v.height || "0", 10) || 0;
          outBucket.progressive.push({
            url: cleanMetaCdnUrl(v.url),
            height: h,
            width: parseInt(v.width || "0", 10) || 0,
            label: h > 0 ? `${h}p` : "MP4",
            source: "ig_video_versions",
          });
        }
      }
    }

    const progKeys = [
      ["browser_native_hd_url", "HD"],
      ["playable_url_quality_hd", "HD"],
      ["hd_src_no_ratelimit", "HD"],
      ["hd_src", "HD"],
      ["browser_native_sd_url", "SD"],
      ["playable_url", "SD"],
      ["sd_src_no_ratelimit", "SD"],
      ["sd_src", "SD"],
    ];
    for (const [key, lbl] of progKeys) {
      if (typeof itemObj[key] === "string" && itemObj[key].startsWith("http")) {
        outBucket.progressive.push({
          url: cleanMetaCdnUrl(itemObj[key]),
          height: lbl === "HD" ? 720 : 480,
          label: lbl,
          source: key,
        });
      }
    }

    for (const dashKey of ["video_dash_manifest", "dash_manifest", "dashManifest"]) {
      if (typeof itemObj[dashKey] === "string" && itemObj[dashKey].includes("<Representation")) {
        const parsed = parseMetaDashManifest(itemObj[dashKey]);
        outBucket.dashVideos.push(...parsed.videos);
        outBucket.dashAudios.push(...parsed.audios);
      }
    }

    if (!outBucket.thumbnail) {
      const cands = itemObj.image_versions2 && Array.isArray(itemObj.image_versions2.candidates)
        ? itemObj.image_versions2.candidates
        : null;
      if (cands && cands[0] && cands[0].url) {
        outBucket.thumbnail = cleanMetaCdnUrl(cands[0].url);
      } else if (typeof itemObj.display_url === "string" && itemObj.display_url.startsWith("http")) {
        outBucket.thumbnail = cleanMetaCdnUrl(itemObj.display_url);
      } else if (typeof itemObj.thumbnail_src === "string" && itemObj.thumbnail_src.startsWith("http")) {
        outBucket.thumbnail = cleanMetaCdnUrl(itemObj.thumbnail_src);
      }
    }

    if (!outBucket.durationSec && (itemObj.video_duration || itemObj.duration_s)) {
      outBucket.durationSec = Number(itemObj.video_duration || itemObj.duration_s) || 0;
    }
  }

  function inspectMetaObjectGraph(rootObj, result) {
    const visited = new Set();
    const queue = [{ obj: rootObj, depth: 0 }];
    let steps = 0;

    while (queue.length > 0 && steps < 480) {
      const { obj, depth } = queue.shift();
      if (!obj || typeof obj !== "object" || depth > 7) continue;
      if (visited.has(obj)) continue;
      visited.add(obj);
      steps += 1;

      if (Array.isArray(obj)) {
        for (let i = 0; i < Math.min(obj.length, 30); i += 1) {
          if (obj[i] && typeof obj[i] === "object") {
            queue.push({ obj: obj[i], depth: depth + 1 });
          }
        }
        continue;
      }

      // Author & Caption extraction
      if (!result.author) {
        const u = obj.user || obj.owner || obj.actor;
        if (u && typeof u === "object") {
          const uname = u.username || u.name || "";
          if (typeof uname === "string" && uname.trim()) {
            result.author = uname.trim();
          }
        }
      }

      if (!result.caption) {
        if (obj.caption && typeof obj.caption.text === "string" && obj.caption.text.trim()) {
          result.caption = obj.caption.text.trim();
        } else if (obj.message && typeof obj.message.text === "string" && obj.message.text.trim()) {
          result.caption = obj.message.text.trim();
        } else if (typeof obj.accessibility_caption === "string" && obj.accessibility_caption.trim()) {
          result.caption = obj.accessibility_caption.trim();
        }
      }

      // Carousel multi-slide media (IG / Threads)
      if (Array.isArray(obj.carousel_media) && obj.carousel_media.length > 0 && result.carouselItems.length === 0) {
        obj.carousel_media.forEach((slide, idx) => {
          const slideBucket = {
            slideIndex: idx + 1,
            thumbnail: "",
            durationSec: 0,
            progressive: [],
            dashVideos: [],
            dashAudios: [],
          };
          extractSingleMetaItemMedia(slide, slideBucket);
          if (slideBucket.progressive.length > 0 || slideBucket.dashVideos.length > 0) {
            result.carouselItems.push(slideBucket);
          }
        });
      }

      extractSingleMetaItemMedia(obj, result);

      // Stop BFS immediately once a media stream source is extracted so neighbor posts cannot bleed in
      if (result.dashVideos.length > 0 || result.progressive.length > 0 || result.carouselItems.length > 0) {
        break;
      }

      const keys = Object.keys(obj);
      for (const k of keys) {
        if (k === "return" || k === "_owner" || k === "alternate" || k === "stateNode") continue;
        try {
          const val = obj[k];
          if (val && typeof val === "object") {
            queue.push({ obj: val, depth: depth + 1 });
          }
        } catch (_) {}
      }
    }
  }

  function dedupMediaLists(bucket) {
    const dedupByUrlAndLabel = (arr, dedupLabel) => {
      const seenUrls = new Set();
      const seenLabels = new Set();
      return arr.filter((item) => {
        if (!item.url || seenUrls.has(item.url)) return false;
        if (dedupLabel && item.label && seenLabels.has(item.label)) return false;
        seenUrls.add(item.url);
        if (dedupLabel && item.label) seenLabels.add(item.label);
        return true;
      });
    };

    bucket.progressive.sort((a, b) => (b.height || 0) - (a.height || 0));
    bucket.progressive = dedupByUrlAndLabel(bucket.progressive, true);

    bucket.dashVideos.sort(
      (a, b) => ((b.shortSide || b.height || 0) - (a.shortSide || a.height || 0)) || ((b.bandwidth || 0) - (a.bandwidth || 0))
    );
    bucket.dashVideos = dedupByUrlAndLabel(bucket.dashVideos, true);

    bucket.dashAudios.sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0));
    bucket.dashAudios = dedupByUrlAndLabel(bucket.dashAudios, false);

    const keySet = new Set();
    for (const list of [bucket.progressive, bucket.dashVideos, bucket.dashAudios]) {
      for (const item of list) {
        const ak = item.assetKey || extractAssetKeyFromUrl(item.url);
        if (ak) keySet.add(ak);
      }
    }
    bucket.assetKeys = Array.from(keySet);
  }

  function extractDomAuthorAndCaption(videoEl) {
    const out = { author: "", caption: "" };
    if (!videoEl) return out;
    const container =
      videoEl.closest("article") ||
      videoEl.closest('[role="presentation"]') ||
      videoEl.parentElement?.parentElement?.parentElement;
    if (!container) return out;

    const links = container.querySelectorAll('a[href^="/"]');
    for (const a of links) {
      const href = a.getAttribute("href") || "";
      if (/^\/(p|reel|reels|stories|explore|accounts|direct)\b/i.test(href)) continue;
      const m = href.match(/^\/([A-Za-z0-9._]{2,40})\/?(\?.*)?$/);
      if (m && m[1]) {
        out.author = m[1];
        break;
      }
    }

    const spans = container.querySelectorAll('h1, span[dir="auto"]');
    for (const s of spans) {
      const txt = (s.textContent || "").trim();
      if (txt.length >= 8 && txt !== out.author && !/^(like|comment|share|audio|original audio)/i.test(txt)) {
        out.caption = txt.slice(0, 140);
        break;
      }
    }
    return out;
  }

  function extractMetaForVideoElement(videoEl) {
    const result = {
      author: "",
      caption: "",
      thumbnail: "",
      durationSec: 0,
      progressive: [],
      dashVideos: [],
      dashAudios: [],
      carouselItems: [],
      assetKeys: [],
    };
    if (!videoEl) return result;

    let node = videoEl;
    for (let hop = 0; hop < 12 && node; hop += 1) {
      const fiberKey = Object.keys(node).find(
        (k) =>
          k.startsWith("__reactFiber$") ||
          k.startsWith("__reactProps$") ||
          k.startsWith("__reactInternalInstance$")
      );
      if (fiberKey && node[fiberKey]) {
        let fiber = node[fiberKey];
        for (let up = 0; up < 10 && fiber; up += 1) {
          if (fiber.memoizedProps) inspectMetaObjectGraph(fiber.memoizedProps, result);
          if (result.progressive.length === 0 && result.dashVideos.length === 0 && result.carouselItems.length === 0) {
            if (fiber.pendingProps) inspectMetaObjectGraph(fiber.pendingProps, result);
          }
          if (result.progressive.length > 0 || result.dashVideos.length > 0 || result.carouselItems.length > 0) {
            break;
          }
          fiber = fiber.return;
        }
        if (result.progressive.length > 0 || result.dashVideos.length > 0 || result.carouselItems.length > 0) {
          break;
        }
      }
      node = node.parentElement;
    }

    if (!result.author || !result.caption) {
      const domMeta = extractDomAuthorAndCaption(videoEl);
      if (!result.author && domMeta.author) result.author = domMeta.author;
      if (!result.caption && domMeta.caption) result.caption = domMeta.caption;
    }

    dedupMediaLists(result);
    result.carouselItems.forEach(dedupMediaLists);
    return result;
  }

  function extractMetaFromDom(targetVideo) {
    if (targetVideo) {
      const single = extractMetaForVideoElement(targetVideo);
      if (single.progressive.length > 0 || single.dashVideos.length > 0 || single.carouselItems.length > 0) {
        return single;
      }
    }
    const allVideos = Array.from(document.querySelectorAll("video")).slice(0, 3);
    for (const v of allVideos) {
      const m = extractMetaForVideoElement(v);
      if (m.progressive.length > 0 || m.dashVideos.length > 0 || m.carouselItems.length > 0) {
        return m;
      }
    }
    return extractMetaForVideoElement(targetVideo);
  }

  function extractYouTubeInfo() {
    const result = {
      platform: "YouTube",
      title: document.title,
      author: "",
      thumbnail: "",
      durationSec: 0,
      progressive: [],
      dashVideos: [],
      dashAudios: [],
      carouselItems: [],
    };
    let playerResp = null;
    try {
      const player = document.getElementById("movie_player");
      if (player && typeof player.getPlayerResponse === "function") {
        playerResp = player.getPlayerResponse();
      }
    } catch (_) {}

    if (!playerResp && window.ytInitialPlayerResponse) {
      playerResp = window.ytInitialPlayerResponse;
    }
    if (!playerResp || !playerResp.streamingData) return result;

    if (playerResp.videoDetails) {
      const vd = playerResp.videoDetails;
      if (vd.title) result.title = vd.title;
      if (vd.author) result.author = vd.author;
      if (vd.lengthSeconds) result.durationSec = parseInt(vd.lengthSeconds, 10) || 0;
      if (vd.videoId) result.thumbnail = `https://i.ytimg.com/vi/${vd.videoId}/hqdefault.jpg`;
    }

    const sd = playerResp.streamingData;
    if (Array.isArray(sd.formats)) {
      for (const f of sd.formats) {
        if (f && f.url) {
          const h = parseInt(f.height || "0", 10) || 0;
          result.progressive.push({
            url: f.url,
            height: h,
            label: f.qualityLabel || (h > 0 ? `${h}p` : "MP4"),
            mimeType: f.mimeType || "video/mp4",
          });
        }
      }
    }

    if (Array.isArray(sd.adaptiveFormats)) {
      for (const f of sd.adaptiveFormats) {
        if (!f || !f.url) continue;
        const mime = String(f.mimeType || "").toLowerCase();
        if (mime.startsWith("video/mp4")) {
          const h = parseInt(f.height || "0", 10) || 0;
          result.dashVideos.push({
            url: f.url,
            height: h,
            bandwidth: parseInt(f.bitrate || "0", 10) || 0,
            label: f.qualityLabel || (h > 0 ? `${h}p` : "Video"),
            mimeType: mime,
          });
        } else if (mime.startsWith("audio/mp4")) {
          result.dashAudios.push({
            url: f.url,
            bandwidth: parseInt(f.bitrate || "0", 10) || 0,
            mimeType: mime,
          });
        }
      }
    }

    dedupMediaLists(result);
    return result;
  }

  async function extractGoogleDriveInfo() {
    const result = {
      platform: "Drive",
      title: document.title,
      author: "",
      thumbnail: "",
      durationSec: 0,
      progressive: [],
      dashVideos: [],
      dashAudios: [],
      carouselItems: [],
    };
    const match = window.location.pathname.match(/\/file\/d\/([^/]+)/) || window.location.search.match(/[?&]id=([^&]+)/);
    const docId = match ? match[1] : null;
    if (!docId) return result;

    result.thumbnail = `https://drive.google.com/thumbnail?id=${encodeURIComponent(docId)}&sz=w320`;
    try {
      const resp = await fetch(`https://drive.google.com/get_video_info?docid=${encodeURIComponent(docId)}`, {
        credentials: "include",
      });
      if (!resp.ok) return result;
      const bodyText = await resp.text();
      const params = new URLSearchParams(bodyText);
      const title = params.get("title");
      if (title) result.title = title;
      const lenSec = parseInt(params.get("length_seconds") || "0", 10) || 0;
      if (lenSec > 0) result.durationSec = lenSec;

      const streamMap = params.get("fmt_stream_map") || "";
      const itagHeights = { 37: 1080, 22: 720, 59: 480, 78: 480, 18: 360 };
      for (const pair of streamMap.split(",")) {
        const sep = pair.indexOf("|");
        if (sep === -1) continue;
        const itag = parseInt(pair.slice(0, sep), 10) || 0;
        const streamUrl = pair.slice(sep + 1).trim();
        if (streamUrl.startsWith("http")) {
          const h = itagHeights[itag] || 360;
          result.progressive.push({
            url: streamUrl,
            height: h,
            label: `${h}p`,
            source: `drive_itag_${itag}`,
          });
        }
      }
      dedupMediaLists(result);
    } catch (_) {}

    return result;
  }

  function captureVideoSnapshot(videoEl) {
    if (!videoEl) return "";
    if (videoEl.poster && videoEl.poster.startsWith("http")) return videoEl.poster;
    try {
      if (videoEl.readyState >= 2 && videoEl.videoWidth > 0 && videoEl.videoHeight > 0) {
        const canvas = document.createElement("canvas");
        canvas.width = 160;
        canvas.height = Math.max(60, Math.round((videoEl.videoHeight / videoEl.videoWidth) * 160));
        const ctx = canvas.getContext("2d");
        if (ctx) {
          ctx.drawImage(videoEl, 0, 0, canvas.width, canvas.height);
          return canvas.toDataURL("image/jpeg", 0.65);
        }
      }
    } catch (_) {}
    return "";
  }

  function detectPlatformTag(host) {
    if (host.includes("instagram.com")) return "IG";
    if (host.includes("facebook.com") || host.includes("fb.com")) return "FB";
    if (host.includes("threads.net") || host.includes("threads.com")) return "Threads";
    if (host.includes("youtube.com") || host.includes("youtu.be")) return "YouTube";
    if (host.includes("drive.google.com") || host.includes("docs.google.com")) return "Drive";
    return "Web";
  }

  const seenVideosMap = new Map();
  let nextVideoDomSeq = 1;

  function collectDomVideos() {
    const list = [];
    const vh = window.innerHeight || 800;
    document.querySelectorAll("video").forEach((v) => {
      let vid = v.getAttribute("data-vortex-vid");
      if (!vid) {
        vid = `vx_vid_${nextVideoDomSeq++}`;
        v.setAttribute("data-vortex-vid", vid);
      }
      const rect = v.getBoundingClientRect();
      const visibleH = Math.max(0, Math.min(rect.bottom, vh) - Math.max(rect.top, 0));
      const isInViewport = rect.width >= 100 && rect.height >= 80 && visibleH >= 40;
      list.push({
        el: v,
        videoDomId: vid,
        isTarget: v.getAttribute("data-vortex-target") === "1",
        isInViewport,
        rectTop: rect.top,
        width: v.videoWidth || Math.round(rect.width) || 0,
        height: v.videoHeight || Math.round(rect.height) || 0,
        durationSec: Number.isFinite(v.duration) ? Math.round(v.duration) : 0,
        src: v.currentSrc || v.src || "",
        thumbnail: captureVideoSnapshot(v),
      });
    });
    return list;
  }

  function scanAndCacheMetaVideos(forceScan = false) {
    if (!state.domainActive && !forceScan) {
      return [];
    }
    if (forceScan) {
      ignoredVideoKeys.clear();
    }
    const host = (window.location.hostname || "").toLowerCase();
    const platform = detectPlatformTag(host);
    if (platform !== "IG" && platform !== "FB" && platform !== "Threads") {
      return [];
    }

    const domList = collectDomVideos();
    const activeCacheKeys = new Set();

    // Reset viewport status on previously cached entries
    for (const entry of seenVideosMap.values()) {
      entry.isInViewport = false;
      entry.isTarget = false;
    }

    for (const d of domList) {
      const extracted = extractMetaForVideoElement(d.el);
      if (
        extracted.progressive.length === 0 &&
        extracted.dashVideos.length === 0 &&
        extracted.carouselItems.length === 0
      ) {
        continue;
      }

      const cacheKey =
        (extracted.assetKeys && extracted.assetKeys[0]) ||
        extracted.progressive[0]?.url ||
        extracted.dashVideos[0]?.url ||
        d.videoDomId;

      if (!cacheKey) continue;
      if (!forceScan && ignoredVideoKeys.has(cacheKey)) continue;
      activeCacheKeys.add(cacheKey);

      const prev = seenVideosMap.get(cacheKey);
      const thumb = extracted.thumbnail || d.thumbnail || (prev ? prev.thumbnail : "");
      seenVideosMap.set(cacheKey, {
        ...extracted,
        cacheKey,
        videoDomId: d.videoDomId,
        isTarget: d.isTarget,
        isInViewport: d.isInViewport,
        rectTop: d.rectTop,
        thumbnail: thumb,
        durationSec: extracted.durationSec || d.durationSec || (prev ? prev.durationSec : 0),
        lastSeenAt: Date.now(),
      });
    }

    // Prune oldest if cache grows beyond configured maxHistory
    const maxHist = Math.max(5, Math.min(50, Number(state.maxHistory) || 15));
    if (seenVideosMap.size > maxHist) {
      const keys = Array.from(seenVideosMap.keys());
      for (let i = 0; i < keys.length - maxHist; i += 1) {
        seenVideosMap.delete(keys[i]);
      }
    }

    // Clear stale DOM IDs for unmounted videos
    const mountedDomIds = new Set(domList.map((d) => d.videoDomId));
    for (const entry of seenVideosMap.values()) {
      if (entry.videoDomId && !mountedDomIds.has(entry.videoDomId)) {
        entry.videoDomId = "";
      }
    }

    const sorted = Array.from(seenVideosMap.values()).sort((a, b) => {
      if (a.isTarget !== b.isTarget) return a.isTarget ? -1 : 1;
      if (a.isInViewport !== b.isInViewport) return a.isInViewport ? -1 : 1;
      if (a.isInViewport && b.isInViewport) return (a.rectTop || 0) - (b.rectTop || 0);
      return (b.lastSeenAt || 0) - (a.lastSeenAt || 0);
    });
    return sorted;
  }

  if (typeof window !== "undefined") {
    document.addEventListener(
      "play",
      () => {
        if (!state.domainActive) return;
        scanAndCacheMetaVideos();
      },
      true
    );
  }

  async function handleGetPageMediaInfo(requestId, forceScan = false) {
    const host = (window.location.hostname || "").toLowerCase();
    const platform = detectPlatformTag(host);
    if (forceScan) {
      ignoredVideoKeys.clear();
    }
    const pageSuppressed =
      !forceScan &&
      (!state.domainActive || ignoredVideoKeys.has(`PAGE:${window.location.href}`));

    const domVideosRaw = pageSuppressed
      ? []
      : collectDomVideos().filter((d) => {
          if (forceScan) return true;
          const keys = [d.currentSrc, d.src, d.videoDomId].filter(Boolean);
          return !keys.some((k) => ignoredVideoKeys.has(k));
        });
    const domVideos = domVideosRaw.map(({ el, ...rest }) => rest);
    const targetVideo = pageSuppressed
      ? null
      : document.querySelector('video[data-vortex-target="1"]') ||
        domVideosRaw.find((d) => d.isInViewport)?.el ||
        document.querySelector("video");
    const targetDomInfo =
      domVideos.find((d) => d.isTarget) ||
      domVideos.find((d) => d.isInViewport) ||
      domVideos[0] ||
      null;

    let info = {
      platform,
      title: document.title,
      author: "",
      caption: "",
      thumbnail: targetDomInfo ? targetDomInfo.thumbnail : "",
      durationSec: targetDomInfo ? targetDomInfo.durationSec : 0,
      videoDomId: targetDomInfo ? targetDomInfo.videoDomId : "",
      domVideos,
      videoEntries: [],
      progressive: [],
      dashVideos: [],
      dashAudios: [],
      carouselItems: [],
      assetKeys: [],
    };

    try {
      if (!pageSuppressed) {
        if (platform === "YouTube") {
          const yt = extractYouTubeInfo();
          info = { ...info, ...yt, platform };
        } else if (platform === "Drive") {
          const gd = await extractGoogleDriveInfo();
          info = { ...info, ...gd, platform };
        } else if (platform === "IG" || platform === "FB" || platform === "Threads") {
          const entries = scanAndCacheMetaVideos(forceScan);
          info.videoEntries = entries;

          const rawMeta = targetVideo
            ? extractMetaForVideoElement(targetVideo)
            : entries[0] || extractMetaFromDom(targetVideo);
          const metaKey =
            (rawMeta.assetKeys && rawMeta.assetKeys[0]) ||
            rawMeta.progressive?.[0]?.url ||
            rawMeta.dashVideos?.[0]?.url ||
            (targetVideo && targetVideo.dataset && targetVideo.dataset.vortexId) ||
            "";
          const metaIgnored = !forceScan && metaKey && ignoredVideoKeys.has(metaKey);
          const meta = metaIgnored
            ? entries[0] || {
                progressive: [],
                dashVideos: [],
                dashAudios: [],
                carouselItems: [],
                assetKeys: [],
              }
            : rawMeta;
          info = {
            ...info,
            ...meta,
            platform,
            videoEntries: entries,
            thumbnail: meta.thumbnail || info.thumbnail,
            durationSec: meta.durationSec || info.durationSec,
          };
        }
      }
    } catch (_) {}

    if (!info.thumbnail && targetDomInfo && targetDomInfo.thumbnail) {
      info.thumbnail = targetDomInfo.thumbnail;
    }

    window.postMessage(
      {
        source: "vortex-mse-hook",
        type: "PAGE_MEDIA_INFO_RESULT",
        requestId,
        payload: info,
      },
      "*"
    );
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window || !event.data || event.data.source !== "vortex-content") {
      return;
    }
    const msg = event.data;
    if (msg.type === "START_RECORDING") {
      clearRecordedBuffers();
      state.recording = true;
      emitStatus();
    } else if (msg.type === "STOP_RECORDING") {
      state.recording = false;
      emitStatus();
    } else if (msg.type === "STOP_AND_EXPORT") {
      state.recording = false;
      exportRecordedBuffers(msg.requestId, msg.formatMode);
      emitStatus();
    } else if (msg.type === "EXPORT_CURRENT_BUFFER") {
      exportRecordedBuffers(msg.requestId, msg.formatMode);
      emitStatus();
    } else if (msg.type === "CLEAR_BUFFER") {
      clearRecordedBuffers();
    } else if (msg.type === "GET_STATUS") {
      emitStatus();
    } else if (msg.type === "GET_PAGE_MEDIA_INFO") {
      handleGetPageMediaInfo(msg.requestId, false);
    } else if (msg.type === "SET_DOMAIN_CONFIG") {
      state.domainActive = Boolean(msg.domainActive);
      if (typeof msg.maxHistory === "number" && msg.maxHistory >= 5) {
        state.maxHistory = Math.min(50, Math.round(msg.maxHistory));
      }
      if (!state.domainActive) {
        state.recording = false;
        seenVideosMap.clear();
        clearRecordedBuffers();
      }
      emitStatus();
    } else if (msg.type === "CLEAR_PAGE_CACHE") {
      for (const k of seenVideosMap.keys()) {
        ignoredVideoKeys.add(k);
      }
      for (const v of document.querySelectorAll("video")) {
        const vk = v.currentSrc || v.src || "";
        if (vk && !vk.startsWith("blob:")) ignoredVideoKeys.add(vk);
        if (v.dataset && v.dataset.vortexId) ignoredVideoKeys.add(v.dataset.vortexId);
      }
      const pTag = detectPlatformTag((window.location.hostname || "").toLowerCase());
      if (pTag !== "IG" && pTag !== "FB" && pTag !== "Threads" && window.location.href) {
        ignoredVideoKeys.add(`PAGE:${window.location.href}`);
      }
      seenVideosMap.clear();
      clearRecordedBuffers();
    } else if (msg.type === "FORCE_SCAN") {
      ignoredVideoKeys.clear();
      handleGetPageMediaInfo(msg.requestId, true);
    }
  });
})();
