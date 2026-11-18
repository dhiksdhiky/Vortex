(() => {
  "use strict";

  function readU32(u8, offset) {
    return (
      ((u8[offset] << 24) >>> 0) +
      (u8[offset + 1] << 16) +
      (u8[offset + 2] << 8) +
      u8[offset + 3]
    );
  }

  function readI32(u8, offset) {
    return (
      (u8[offset] << 24) |
      (u8[offset + 1] << 16) |
      (u8[offset + 2] << 8) |
      u8[offset + 3]
    );
  }

  function writeU32(u8, offset, val) {
    u8[offset] = (val >>> 24) & 0xff;
    u8[offset + 1] = (val >>> 16) & 0xff;
    u8[offset + 2] = (val >>> 8) & 0xff;
    u8[offset + 3] = val & 0xff;
  }

  function writeI32(u8, offset, val) {
    writeU32(u8, offset, val | 0);
  }

  function readU64BigInt(u8, offset) {
    const hi = BigInt(readU32(u8, offset));
    const lo = BigInt(readU32(u8, offset + 4));
    return (hi << 32n) | lo;
  }

  function writeU64BigInt(u8, offset, bigVal) {
    const hi = Number((bigVal >> 32n) & 0xffffffffn);
    const lo = Number(bigVal & 0xffffffffn);
    writeU32(u8, offset, hi);
    writeU32(u8, offset + 4, lo);
  }

  function readType(u8, offset) {
    return String.fromCharCode(
      u8[offset],
      u8[offset + 1],
      u8[offset + 2],
      u8[offset + 3]
    );
  }

  function parseBoxes(u8, start = 0, end = u8.length) {
    const boxes = [];
    let pos = start;
    while (pos + 8 <= end) {
      let size = readU32(u8, pos);
      const type = readType(u8, pos + 4);
      let headerSize = 8;
      if (size === 1) {
        if (pos + 16 > end) break;
        size = Number(readU64BigInt(u8, pos + 8));
        headerSize = 16;
      } else if (size === 0) {
        size = end - pos;
      }
      if (size < headerSize || pos + size > end) break;
      boxes.push({
        type,
        start: pos,
        end: pos + size,
        size,
        headerSize,
        payloadStart: pos + headerSize,
      });
      pos += size;
    }
    return boxes;
  }

  function concatUint8(arrays) {
    let total = 0;
    for (const a of arrays) total += a.byteLength;
    const out = new Uint8Array(total);
    let offset = 0;
    for (const a of arrays) {
      out.set(a, offset);
      offset += a.byteLength;
    }
    return out;
  }

  function makeBox(typeStr, childrenOrPayload) {
    const payload = Array.isArray(childrenOrPayload)
      ? concatUint8(childrenOrPayload)
      : childrenOrPayload;
    const out = new Uint8Array(8 + payload.byteLength);
    writeU32(out, 0, out.byteLength);
    out[4] = typeStr.charCodeAt(0);
    out[5] = typeStr.charCodeAt(1);
    out[6] = typeStr.charCodeAt(2);
    out[7] = typeStr.charCodeAt(3);
    out.set(payload, 8);
    return out;
  }

  function makeFullBox(typeStr, version, flags, bodyBytes) {
    const payload = new Uint8Array(4 + bodyBytes.byteLength);
    payload[0] = version & 0xff;
    payload[1] = (flags >>> 16) & 0xff;
    payload[2] = (flags >>> 8) & 0xff;
    payload[3] = flags & 0xff;
    payload.set(bodyBytes, 4);
    return makeBox(typeStr, payload);
  }

  function extractMvhdTimescale(mvhdBytes) {
    const version = mvhdBytes[8];
    const tsOff = version === 1 ? 28 : 20;
    return tsOff + 4 <= mvhdBytes.byteLength ? readU32(mvhdBytes, tsOff) || 1000 : 1000;
  }

  function extractTrackTimescale(trakBytes) {
    const tc = parseBoxes(trakBytes, 8, trakBytes.byteLength);
    const mdia = tc.find((b) => b.type === "mdia");
    if (!mdia) return 1000;
    const mdc = parseBoxes(trakBytes, mdia.payloadStart, mdia.end);
    const mdhd = mdc.find((b) => b.type === "mdhd");
    if (!mdhd) return 1000;
    const version = trakBytes[mdhd.payloadStart];
    const tsOff = mdhd.payloadStart + (version === 1 ? 20 : 12);
    return tsOff + 4 <= mdhd.end ? readU32(trakBytes, tsOff) || 1000 : 1000;
  }

  function extractTrexDefaults(mvexBytes) {
    const def = { duration: 0, size: 0, flags: 0 };
    if (!mvexBytes) return def;
    const children = parseBoxes(mvexBytes, 8, mvexBytes.byteLength);
    const trex = children.find((b) => b.type === "trex");
    if (!trex || trex.payloadStart + 24 > trex.end) return def;
    def.duration = readU32(mvexBytes, trex.payloadStart + 12);
    def.size = readU32(mvexBytes, trex.payloadStart + 16);
    def.flags = readU32(mvexBytes, trex.payloadStart + 20);
    return def;
  }

  function patchMvhdNextTrackId(mvhdBytes, nextTrackId, totalDurationSec = 0) {
    const copy = new Uint8Array(mvhdBytes);
    const version = copy[8];
    if (totalDurationSec > 0) {
      const ts = extractMvhdTimescale(copy);
      const durUnits = Math.round(totalDurationSec * ts);
      if (version === 1 && 40 <= copy.byteLength) {
        writeU64BigInt(copy, 32, BigInt(durUnits));
      } else if (version === 0 && 28 <= copy.byteLength) {
        writeU32(copy, 24, durUnits);
      }
    }
    const nextIdOffset = version === 1 ? 116 : 104;
    if (nextIdOffset + 4 <= copy.byteLength) {
      writeU32(copy, nextIdOffset, nextTrackId);
    }
    return copy;
  }

  function patchTrakId(trakBytes, newTrackId, totalDurationSec = 0, mvhdTimescale = 1000) {
    const copy = new Uint8Array(trakBytes);
    const children = parseBoxes(copy, 8, copy.byteLength);
    const tkhd = children.find((b) => b.type === "tkhd");
    if (tkhd) {
      const version = copy[tkhd.payloadStart];
      const idOffset = tkhd.payloadStart + (version === 1 ? 20 : 12);
      if (idOffset + 4 <= tkhd.end) {
        writeU32(copy, idOffset, newTrackId);
      }
      if (totalDurationSec > 0) {
        const tkDur = Math.round(totalDurationSec * mvhdTimescale);
        if (version === 1 && tkhd.payloadStart + 36 <= tkhd.end) {
          writeU64BigInt(copy, tkhd.payloadStart + 28, BigInt(tkDur));
        } else if (version === 0 && tkhd.payloadStart + 24 <= tkhd.end) {
          writeU32(copy, tkhd.payloadStart + 20, tkDur);
        }
      }
    }
    if (totalDurationSec > 0) {
      const mdia = children.find((b) => b.type === "mdia");
      if (mdia) {
        const mdc = parseBoxes(copy, mdia.payloadStart, mdia.end);
        const mdhd = mdc.find((b) => b.type === "mdhd");
        if (mdhd) {
          const mv = copy[mdhd.payloadStart];
          const tsOff = mdhd.payloadStart + (mv === 1 ? 20 : 12);
          const ts = tsOff + 4 <= mdhd.end ? readU32(copy, tsOff) || 1000 : 1000;
          const mDur = Math.round(totalDurationSec * ts);
          if (mv === 1 && mdhd.payloadStart + 32 <= mdhd.end) {
            writeU64BigInt(copy, mdhd.payloadStart + 24, BigInt(mDur));
          } else if (mv === 0 && mdhd.payloadStart + 20 <= mdhd.end) {
            writeU32(copy, mdhd.payloadStart + 16, mDur);
          }
        }
      }
    }
    return copy;
  }

  function extractFragments(u8, topBoxes) {
    const fragments = [];
    for (let i = 0; i < topBoxes.length; i += 1) {
      const box = topBoxes[i];
      if (box.type === "moof") {
        const nextBox = topBoxes[i + 1];
        if (nextBox && nextBox.type === "mdat") {
          fragments.push({
            moofBox: box,
            mdatBox: nextBox,
          });
          i += 1;
        }
      }
    }
    return fragments;
  }

  function extractAllSamplesFromFmp4(u8, fragments, trexDefaults) {
    const samples = [];
    for (const frag of fragments) {
      const { moofBox, mdatBox } = frag;
      const moofChildren = parseBoxes(u8, moofBox.payloadStart, moofBox.end);
      for (const child of moofChildren) {
        if (child.type !== "traf") continue;
        const tfc = parseBoxes(u8, child.payloadStart, child.end);
        const tfhd = tfc.find((b) => b.type === "tfhd");
        if (!tfhd) continue;

        const tfFlags =
          (u8[tfhd.payloadStart + 1] << 16) |
          (u8[tfhd.payloadStart + 2] << 8) |
          u8[tfhd.payloadStart + 3];
        let pos = tfhd.payloadStart + 8;
        let baseDataOffset = null;
        if (tfFlags & 0x01) {
          baseDataOffset = Number(readU64BigInt(u8, pos));
          pos += 8;
        }
        if (tfFlags & 0x02) pos += 4;
        const tfDefDur = (tfFlags & 0x08) && pos + 4 <= tfhd.end ? readU32(u8, pos) : trexDefaults.duration;
        if (tfFlags & 0x08) pos += 4;
        const tfDefSize = (tfFlags & 0x10) && pos + 4 <= tfhd.end ? readU32(u8, pos) : trexDefaults.size;
        if (tfFlags & 0x10) pos += 4;
        const tfDefFlags = (tfFlags & 0x20) && pos + 4 <= tfhd.end ? readU32(u8, pos) : trexDefaults.flags;

        for (const trun of tfc.filter((b) => b.type === "trun")) {
          const trVer = u8[trun.payloadStart];
          const trFlags =
            (u8[trun.payloadStart + 1] << 16) |
            (u8[trun.payloadStart + 2] << 8) |
            u8[trun.payloadStart + 3];
          const count = readU32(u8, trun.payloadStart + 4);
          let tpos = trun.payloadStart + 8;

          let dataOffset = 0;
          const hasDataOffset = Boolean(trFlags & 0x0001);
          if (hasDataOffset) {
            dataOffset = readI32(u8, tpos);
            tpos += 4;
          }
          const hasFirstFlags = Boolean(trFlags & 0x0004);
          let firstSampleFlags = 0;
          if (hasFirstFlags) {
            firstSampleFlags = readU32(u8, tpos);
            tpos += 4;
          }

          let dataCursor;
          if (baseDataOffset !== null) {
            dataCursor = baseDataOffset + (hasDataOffset ? dataOffset : 0);
          } else if (tfFlags & 0x020000) {
            dataCursor = moofBox.start + (hasDataOffset ? dataOffset : 0);
          } else {
            dataCursor = hasDataOffset ? moofBox.start + dataOffset : mdatBox.payloadStart;
          }
          if (dataCursor < mdatBox.payloadStart || dataCursor >= mdatBox.end) {
            dataCursor = mdatBox.payloadStart;
          }

          const hasDur = Boolean(trFlags & 0x0100);
          const hasSize = Boolean(trFlags & 0x0200);
          const hasFlags = Boolean(trFlags & 0x0400);
          const hasCts = Boolean(trFlags & 0x0800);

          for (let i = 0; i < count && tpos <= trun.end; i += 1) {
            const dur = hasDur ? readU32(u8, tpos) : tfDefDur;
            if (hasDur) tpos += 4;
            const sz = hasSize ? readU32(u8, tpos) : tfDefSize;
            if (hasSize) tpos += 4;
            const fl = hasFlags
              ? readU32(u8, tpos)
              : (i === 0 && hasFirstFlags ? firstSampleFlags : tfDefFlags);
            if (hasFlags) tpos += 4;
            const cts = hasCts
              ? (trVer === 0 ? readU32(u8, tpos) : readI32(u8, tpos))
              : 0;
            if (hasCts) tpos += 4;

            if (sz > 0 && dataCursor + sz <= mdatBox.end) {
              samples.push({
                duration: dur > 0 ? dur : (trexDefaults.duration || 1),
                size: sz,
                isSync: (fl & 0x00010000) === 0,
                ctsOffset: cts,
                data: u8.subarray(dataCursor, dataCursor + sz),
              });
            }
            dataCursor += sz;
          }
        }
      }
    }
    return samples;
  }

  function buildSttsBox(samples) {
    const runs = [];
    for (const s of samples) {
      if (runs.length > 0 && runs[runs.length - 1].delta === s.duration) {
        runs[runs.length - 1].count += 1;
      } else {
        runs.push({ count: 1, delta: s.duration });
      }
    }
    const body = new Uint8Array(4 + runs.length * 8);
    writeU32(body, 0, runs.length);
    for (let i = 0; i < runs.length; i += 1) {
      writeU32(body, 4 + i * 8, runs[i].count);
      writeU32(body, 8 + i * 8, runs[i].delta);
    }
    return makeFullBox("stts", 0, 0, body);
  }

  function buildCttsBox(samples) {
    let hasNonZero = false;
    let hasNegative = false;
    for (const s of samples) {
      if (s.ctsOffset !== 0) hasNonZero = true;
      if (s.ctsOffset < 0) hasNegative = true;
    }
    if (!hasNonZero) return null;

    const runs = [];
    for (const s of samples) {
      if (runs.length > 0 && runs[runs.length - 1].offset === s.ctsOffset) {
        runs[runs.length - 1].count += 1;
      } else {
        runs.push({ count: 1, offset: s.ctsOffset });
      }
    }
    const version = hasNegative ? 1 : 0;
    const body = new Uint8Array(4 + runs.length * 8);
    writeU32(body, 0, runs.length);
    for (let i = 0; i < runs.length; i += 1) {
      writeU32(body, 4 + i * 8, runs[i].count);
      if (version === 1) {
        writeI32(body, 8 + i * 8, runs[i].offset);
      } else {
        writeU32(body, 8 + i * 8, runs[i].offset);
      }
    }
    return makeFullBox("ctts", version, 0, body);
  }

  function buildStssBox(samples) {
    const syncIndices = [];
    for (let i = 0; i < samples.length; i += 1) {
      if (samples[i].isSync) syncIndices.push(i + 1);
    }
    if (syncIndices.length === 0 && samples.length > 0) {
      syncIndices.push(1);
    }
    const body = new Uint8Array(4 + syncIndices.length * 4);
    writeU32(body, 0, syncIndices.length);
    for (let i = 0; i < syncIndices.length; i += 1) {
      writeU32(body, 4 + i * 4, syncIndices[i]);
    }
    return makeFullBox("stss", 0, 0, body);
  }

  function buildStszBox(samples) {
    const body = new Uint8Array(8 + samples.length * 4);
    writeU32(body, 0, 0); // variable sample sizes
    writeU32(body, 4, samples.length);
    for (let i = 0; i < samples.length; i += 1) {
      writeU32(body, 8 + i * 4, samples[i].size);
    }
    return makeFullBox("stsz", 0, 0, body);
  }

  function buildStscBox(chunks) {
    const runs = [];
    for (let i = 0; i < chunks.length; i += 1) {
      const spc = chunks[i].samples.length;
      if (runs.length === 0 || runs[runs.length - 1].spc !== spc) {
        runs.push({ firstChunk: i + 1, spc });
      }
    }
    const body = new Uint8Array(4 + runs.length * 12);
    writeU32(body, 0, runs.length);
    for (let i = 0; i < runs.length; i += 1) {
      writeU32(body, 4 + i * 12, runs[i].firstChunk);
      writeU32(body, 8 + i * 12, runs[i].spc);
      writeU32(body, 12 + i * 12, 1); // sample_description_index
    }
    return makeFullBox("stsc", 0, 0, body);
  }

  function buildStcoBox(chunkOffsets) {
    const body = new Uint8Array(4 + chunkOffsets.length * 4);
    writeU32(body, 0, chunkOffsets.length);
    for (let i = 0; i < chunkOffsets.length; i += 1) {
      writeU32(body, 4 + i * 4, chunkOffsets[i]);
    }
    return makeFullBox("stco", 0, 0, body);
  }

  function groupSamplesIntoChunks(samples, timescale, trackId, targetChunkSec = 0.5) {
    const chunks = [];
    const targetUnits = Math.max(1, Math.round(targetChunkSec * timescale));
    let curSamples = [];
    let curUnits = 0;
    let totalUnits = 0;
    let chunkStartSec = 0;

    for (const s of samples) {
      if (curSamples.length === 0) {
        chunkStartSec = totalUnits / timescale;
      }
      curSamples.push(s);
      curUnits += s.duration;
      totalUnits += s.duration;
      if (curUnits >= targetUnits) {
        chunks.push({ trackId, startSec: chunkStartSec, samples: curSamples });
        curSamples = [];
        curUnits = 0;
      }
    }
    if (curSamples.length > 0) {
      chunks.push({ trackId, startSec: chunkStartSec, samples: curSamples });
    }
    return chunks;
  }

  function rebuildTrakStandard(origTrakBytes, newTrackId, totalDurationSec, mvhdTimescale, trackDurUnits, stblBox) {
    const tc = parseBoxes(origTrakBytes, 8, origTrakBytes.byteLength);
    const outChildren = [];

    for (const child of tc) {
      if (child.type === "edts") {
        // Drop fragmented edit lists that carry 0 duration and confuse desktop players
        continue;
      }
      if (child.type === "tkhd") {
        const tkCopy = new Uint8Array(origTrakBytes.subarray(child.start, child.end));
        const ver = tkCopy[8];
        const idOff = 8 + (ver === 1 ? 20 : 12);
        writeU32(tkCopy, idOff, newTrackId);
        const tkDur = Math.round(totalDurationSec * mvhdTimescale);
        if (ver === 1 && tkCopy.byteLength >= 44) {
          writeU64BigInt(tkCopy, 36, BigInt(tkDur));
        } else if (ver === 0 && tkCopy.byteLength >= 32) {
          writeU32(tkCopy, 28, tkDur);
        }
        outChildren.push(tkCopy);
        continue;
      }
      if (child.type === "mdia") {
        const mdc = parseBoxes(origTrakBytes, child.payloadStart, child.end);
        const mdChildren = [];
        for (const mc of mdc) {
          if (mc.type === "mdhd") {
            const mdCopy = new Uint8Array(origTrakBytes.subarray(mc.start, mc.end));
            const mv = mdCopy[8];
            if (mv === 1 && mdCopy.byteLength >= 40) {
              writeU64BigInt(mdCopy, 32, BigInt(trackDurUnits));
            } else if (mv === 0 && mdCopy.byteLength >= 28) {
              writeU32(mdCopy, 24, trackDurUnits);
            }
            mdChildren.push(mdCopy);
          } else if (mc.type === "minf") {
            const minfC = parseBoxes(origTrakBytes, mc.payloadStart, mc.end);
            const minfParts = [];
            for (const mfc of minfC) {
              if (mfc.type === "stbl") {
                minfParts.push(stblBox);
              } else {
                minfParts.push(origTrakBytes.subarray(mfc.start, mfc.end));
              }
            }
            mdChildren.push(makeBox("minf", minfParts));
          } else {
            mdChildren.push(origTrakBytes.subarray(mc.start, mc.end));
          }
        }
        outChildren.push(makeBox("mdia", mdChildren));
        continue;
      }
      outChildren.push(origTrakBytes.subarray(child.start, child.end));
    }

    return makeBox("trak", outChildren);
  }

  function extractStsdFromTrak(trakBytes) {
    const tc = parseBoxes(trakBytes, 8, trakBytes.byteLength);
    const mdia = tc.find((b) => b.type === "mdia");
    if (!mdia) return null;
    const minf = parseBoxes(trakBytes, mdia.payloadStart, mdia.end).find((b) => b.type === "minf");
    if (!minf) return null;
    const stbl = parseBoxes(trakBytes, minf.payloadStart, minf.end).find((b) => b.type === "stbl");
    if (!stbl) return null;
    const stsd = parseBoxes(trakBytes, stbl.payloadStart, stbl.end).find((b) => b.type === "stsd");
    return stsd ? trakBytes.subarray(stsd.start, stsd.end) : null;
  }

  function shiftStcoInContainer(bytes, offsetStart, offsetEnd, delta) {
    const boxes = parseBoxes(bytes, offsetStart, offsetEnd);
    for (const b of boxes) {
      if (b.type === "stco") {
        const count = readU32(bytes, b.payloadStart + 4);
        for (let i = 0; i < count; i += 1) {
          const entryOff = b.payloadStart + 8 + i * 4;
          if (entryOff + 4 > b.end) break;
          const oldVal = readU32(bytes, entryOff);
          writeU32(bytes, entryOff, Math.max(0, oldVal + delta));
        }
      } else if (b.type === "co64") {
        const count = readU32(bytes, b.payloadStart + 4);
        const bigDelta = BigInt(delta);
        for (let i = 0; i < count; i += 1) {
          const entryOff = b.payloadStart + 8 + i * 8;
          if (entryOff + 8 > b.end) break;
          const oldVal = readU64BigInt(bytes, entryOff);
          writeU64BigInt(bytes, entryOff, oldVal + bigDelta);
        }
      } else if (["mdia", "minf", "stbl"].includes(b.type)) {
        shiftStcoInContainer(bytes, b.payloadStart, b.end, delta);
      }
    }
  }

  /**
   * Merge video and audio MP4 buffers into a standard progressive MP4 ([ftyp][moov][mdat]).
   * Defragments DASH fMP4 streams with 0.5s interleaved chunks and trims audio to match video duration.
   */
  function mergeFmp4VideoAudio(videoBuf, audioBuf) {
    const vU8 = videoBuf instanceof Uint8Array ? videoBuf : new Uint8Array(videoBuf);
    if (!audioBuf || audioBuf.byteLength === 0) return vU8;
    const aU8 = audioBuf instanceof Uint8Array ? audioBuf : new Uint8Array(audioBuf);

    const vTop = parseBoxes(vU8);
    const aTop = parseBoxes(aU8);

    const vFtypBox = vTop.find((b) => b.type === "ftyp");
    const vMoovBox = vTop.find((b) => b.type === "moov");
    const aMoovBox = aTop.find((b) => b.type === "moov");
    if (!vMoovBox || !aMoovBox) {
      return vU8;
    }

    const vMoovChildren = parseBoxes(vU8, vMoovBox.payloadStart, vMoovBox.end);
    const aMoovChildren = parseBoxes(aU8, aMoovBox.payloadStart, aMoovBox.end);

    const vTraks = vMoovChildren.filter((b) => b.type === "trak");
    if (vTraks.length > 1) {
      return vU8;
    }

    const vMvhdBox = vMoovChildren.find((b) => b.type === "mvhd");
    const vTrakBox = vTraks[0];
    const aTrakBox = aMoovChildren.find((b) => b.type === "trak");
    if (!vMvhdBox || !vTrakBox || !aTrakBox) {
      return vU8;
    }

    const vFragments = extractFragments(vU8, vTop);
    const aFragments = extractFragments(aU8, aTop);

    const ftypBytes = vFtypBox
      ? vU8.subarray(vFtypBox.start, vFtypBox.end)
      : (() => {
          const p = new Uint8Array(12);
          p.set([0x69, 0x73, 0x6f, 0x6d, 0, 0, 2, 0, 0x69, 0x73, 0x6f, 0x6d]); // isom
          return makeBox("ftyp", p);
        })();

    const rawMvhd = vU8.subarray(vMvhdBox.start, vMvhdBox.end);
    const rawVTrak = vU8.subarray(vTrakBox.start, vTrakBox.end);
    const rawATrak = aU8.subarray(aTrakBox.start, aTrakBox.end);

    const otherVideoMoovChildren = vMoovChildren
      .filter((b) => !["mvhd", "trak", "mvex"].includes(b.type))
      .map((b) => vU8.subarray(b.start, b.end));

    // Defragment fMP4 into clean Standard Progressive MP4 [ftyp][moov][mdat]
    if (vFragments.length > 0 && aFragments.length > 0) {
      const vMvexBox = vMoovChildren.find((b) => b.type === "mvex");
      const aMvexBox = aMoovChildren.find((b) => b.type === "mvex");

      const mvhdTimescale = extractMvhdTimescale(rawMvhd);
      const vTimescale = extractTrackTimescale(rawVTrak);
      const aTimescale = extractTrackTimescale(rawATrak);
      const vTrexDefs = extractTrexDefaults(vMvexBox ? vU8.subarray(vMvexBox.start, vMvexBox.end) : null);
      const aTrexDefs = extractTrexDefaults(aMvexBox ? aU8.subarray(aMvexBox.start, aMvexBox.end) : null);

      const vSamples = extractAllSamplesFromFmp4(vU8, vFragments, vTrexDefs);
      const aSamplesRaw = extractAllSamplesFromFmp4(aU8, aFragments, aTrexDefs);

      if (vSamples.length > 0 && aSamplesRaw.length > 0) {
        let totalVideoUnits = 0;
        for (const s of vSamples) totalVideoUnits += s.duration;
        const videoDurationSec = totalVideoUnits / vTimescale;

        // Trim audio samples to video duration so short clips never freeze on trailing audio
        const aSamples = [];
        let totalAudioUnits = 0;
        for (const s of aSamplesRaw) {
          if (videoDurationSec > 0 && (totalAudioUnits / aTimescale) >= (videoDurationSec + 0.04)) {
            break;
          }
          aSamples.push(s);
          totalAudioUnits += s.duration;
        }
        if (aSamples.length === 0) aSamples.push(aSamplesRaw[0]);

        const vStsd = extractStsdFromTrak(rawVTrak);
        const aStsd = extractStsdFromTrak(rawATrak);
        if (vStsd && aStsd) {
          const vChunks = groupSamplesIntoChunks(vSamples, vTimescale, 1, 0.5);
          const aChunks = groupSamplesIntoChunks(aSamples, aTimescale, 2, 0.5);

          const interleavedChunks = [...vChunks, ...aChunks].sort(
            (a, b) => (a.startSec - b.startSec) || (a.trackId - b.trackId)
          );

          const vStts = buildSttsBox(vSamples);
          const vCtts = buildCttsBox(vSamples);
          const vStss = buildStssBox(vSamples);
          const vStsc = buildStscBox(vChunks);
          const vStsz = buildStszBox(vSamples);
          const vStcoPlaceholder = buildStcoBox(new Array(vChunks.length).fill(0));

          const aStts = buildSttsBox(aSamples);
          const aCtts = buildCttsBox(aSamples);
          const aStsc = buildStscBox(aChunks);
          const aStsz = buildStszBox(aSamples);
          const aStcoPlaceholder = buildStcoBox(new Array(aChunks.length).fill(0));

          const vStblDraft = makeBox("stbl", [
            vStsd,
            vStts,
            ...(vCtts ? [vCtts] : []),
            vStss,
            vStsc,
            vStsz,
            vStcoPlaceholder,
          ]);
          const aStblDraft = makeBox("stbl", [
            aStsd,
            aStts,
            ...(aCtts ? [aCtts] : []),
            aStsc,
            aStsz,
            aStcoPlaceholder,
          ]);

          const patchedMvhd = patchMvhdNextTrackId(rawMvhd, 3, videoDurationSec);
          const draftVTrak = rebuildTrakStandard(rawVTrak, 1, videoDurationSec, mvhdTimescale, totalVideoUnits, vStblDraft);
          const draftATrak = rebuildTrakStandard(rawATrak, 2, videoDurationSec, mvhdTimescale, totalAudioUnits, aStblDraft);

          const draftMoov = makeBox("moov", [
            patchedMvhd,
            ...otherVideoMoovChildren,
            draftVTrak,
            draftATrak,
          ]);

          const mdatDataStart = ftypBytes.byteLength + draftMoov.byteLength + 8;
          let mdatCursor = 0;
          const vOffsets = [];
          const aOffsets = [];
          const mdatChunksData = [];

          for (const ch of interleavedChunks) {
            const absOffset = mdatDataStart + mdatCursor;
            if (ch.trackId === 1) vOffsets.push(absOffset);
            else aOffsets.push(absOffset);
            for (const s of ch.samples) {
              mdatChunksData.push(s.data);
              mdatCursor += s.data.byteLength;
            }
          }

          const finalVStbl = makeBox("stbl", [
            vStsd,
            vStts,
            ...(vCtts ? [vCtts] : []),
            vStss,
            vStsc,
            vStsz,
            buildStcoBox(vOffsets),
          ]);
          const finalAStbl = makeBox("stbl", [
            aStsd,
            aStts,
            ...(aCtts ? [aCtts] : []),
            aStsc,
            aStsz,
            buildStcoBox(aOffsets),
          ]);

          const finalVTrak = rebuildTrakStandard(rawVTrak, 1, videoDurationSec, mvhdTimescale, totalVideoUnits, finalVStbl);
          const finalATrak = rebuildTrakStandard(rawATrak, 2, videoDurationSec, mvhdTimescale, totalAudioUnits, finalAStbl);

          const finalMoov = makeBox("moov", [
            patchedMvhd,
            ...otherVideoMoovChildren,
            finalVTrak,
            finalATrak,
          ]);

          const mdatPayload = concatUint8(mdatChunksData);
          const finalMdat = makeBox("mdat", mdatPayload);
          return concatUint8([ftypBytes, finalMoov, finalMdat]);
        }
      }
    }

    // Non-fragmented progressive MP4 fallback (shift stco/co64)
    const patchedMvhd = patchMvhdNextTrackId(rawMvhd, 3);
    const patchedVTrak = patchTrakId(rawVTrak, 1);
    const patchedATrak = patchTrakId(rawATrak, 2);

    const vMdatBox = vTop.find((b) => b.type === "mdat");
    const aMdatBox = aTop.find((b) => b.type === "mdat");
    if (vMdatBox && aMdatBox) {
      const vMdatPayload = vU8.subarray(vMdatBox.payloadStart, vMdatBox.end);
      const aMdatPayload = aU8.subarray(aMdatBox.payloadStart, aMdatBox.end);
      const combinedMdat = makeBox("mdat", [vMdatPayload, aMdatPayload]);

      const draftMoov = makeBox("moov", [
        patchedMvhd,
        ...otherVideoMoovChildren,
        patchedVTrak,
        patchedATrak,
      ]);

      const newVMdatPayloadStart = ftypBytes.byteLength + draftMoov.byteLength + 8;
      const newAMdatPayloadStart = newVMdatPayloadStart + vMdatPayload.byteLength;
      const vDelta = newVMdatPayloadStart - vMdatBox.payloadStart;
      const aDelta = newAMdatPayloadStart - aMdatBox.payloadStart;

      shiftStcoInContainer(patchedVTrak, 8, patchedVTrak.byteLength, vDelta);
      shiftStcoInContainer(patchedATrak, 8, patchedATrak.byteLength, aDelta);

      const finalMoov = makeBox("moov", [
        patchedMvhd,
        ...otherVideoMoovChildren,
        patchedVTrak,
        patchedATrak,
      ]);

      return concatUint8([ftypBytes, finalMoov, combinedMdat]);
    }

    return vU8;
  }

  function parseM3u8Attrs(attrStr) {
    const out = {};
    const rx = /([A-Z0-9-]+)=("([^"]*)"|([^,]*))/g;
    let m;
    while ((m = rx.exec(attrStr)) !== null) {
      out[m[1]] = m[3] !== undefined ? m[3] : m[4];
    }
    return out;
  }

  function hexToBytes(hex) {
    const clean = hex.replace(/^0x/i, "").padStart(32, "0");
    const out = new Uint8Array(16);
    for (let i = 0; i < 16; i += 1) {
      out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16) || 0;
    }
    return out;
  }

  function seqToIv(seq) {
    const iv = new Uint8Array(16);
    writeU32(iv, 12, seq >>> 0);
    return iv;
  }

  async function downloadHlsM3u8InBrowser(m3u8Url, onProgress, concurrency = 6) {
    const resp = await fetch(m3u8Url, { credentials: "include" });
    if (!resp.ok) throw new Error(`HTTP ${resp.status} saat mengambil playlist M3U8.`);
    let playlistUrl = resp.url || m3u8Url;
    let text = await resp.text();

    if (text.includes("#EXT-X-STREAM-INF")) {
      const lines = text.split(/\r?\n/).map((l) => l.trim());
      let bestUrl = "";
      let bestScore = -1;
      for (let i = 0; i < lines.length; i += 1) {
        if (!lines[i].startsWith("#EXT-X-STREAM-INF:")) continue;
        const attrs = parseM3u8Attrs(lines[i].slice("#EXT-X-STREAM-INF:".length));
        let nextLine = "";
        for (let j = i + 1; j < lines.length; j += 1) {
          if (lines[j] && !lines[j].startsWith("#")) {
            nextLine = lines[j];
            i = j;
            break;
          }
        }
        if (!nextLine) continue;
        const bw = parseInt(attrs.BANDWIDTH || "0", 10) || 0;
        const res = attrs.RESOLUTION || "";
        const h = res.includes("x") ? parseInt(res.split("x")[1], 10) || 0 : 0;
        const score = h * 10_000_000 + bw;
        if (score >= bestScore) {
          bestScore = score;
          bestUrl = new URL(nextLine, playlistUrl).href;
        }
      }
      if (!bestUrl) throw new Error("Tidak ada varian stream di master M3U8.");
      const subResp = await fetch(bestUrl, { credentials: "include" });
      if (!subResp.ok) throw new Error(`HTTP ${subResp.status} saat mengambil sub-playlist.`);
      playlistUrl = subResp.url || bestUrl;
      text = await subResp.text();
    }

    const lines = text.split(/\r?\n/).map((l) => l.trim());
    let mediaSeq = 0;
    let mapUri = null;
    let currentKey = null;
    const keyCache = new Map();
    const segments = [];

    for (const line of lines) {
      if (!line) continue;
      if (line.startsWith("#EXT-X-MEDIA-SEQUENCE:")) {
        mediaSeq = parseInt(line.split(":")[1], 10) || 0;
      } else if (line.startsWith("#EXT-X-MAP:")) {
        const attrs = parseM3u8Attrs(line.slice("#EXT-X-MAP:".length));
        if (attrs.URI) mapUri = new URL(attrs.URI, playlistUrl).href;
      } else if (line.startsWith("#EXT-X-KEY:")) {
        const attrs = parseM3u8Attrs(line.slice("#EXT-X-KEY:".length));
        const method = (attrs.METHOD || "NONE").toUpperCase();
        if (method === "NONE") {
          currentKey = null;
        } else if (method === "AES-128" && attrs.URI) {
          currentKey = {
            uri: new URL(attrs.URI, playlistUrl).href,
            ivHex: attrs.IV || null,
          };
        } else {
          throw new Error(`Metode enkripsi HLS tidak didukung di browser: ${method}`);
        }
      } else if (!line.startsWith("#")) {
        segments.push({
          url: new URL(line, playlistUrl).href,
          seq: mediaSeq + segments.length,
          key: currentKey ? { ...currentKey } : null,
        });
      }
    }

    if (segments.length === 0) {
      throw new Error("Playlist M3U8 tidak berisi segmen media.");
    }

    let initBytes = null;
    if (mapUri) {
      const mapResp = await fetch(mapUri, { credentials: "include" });
      if (!mapResp.ok) throw new Error(`Gagal mengunduh init segment: HTTP ${mapResp.status}`);
      initBytes = new Uint8Array(await mapResp.arrayBuffer());
    }

    async function getCryptoKey(uri) {
      if (keyCache.has(uri)) return keyCache.get(uri);
      const kr = await fetch(uri, { credentials: "include" });
      if (!kr.ok) throw new Error(`Gagal mengunduh kunci AES-128: HTTP ${kr.status}`);
      const rawKey = await kr.arrayBuffer();
      const imported = await crypto.subtle.importKey("raw", rawKey, { name: "AES-CBC" }, false, ["decrypt"]);
      keyCache.set(uri, imported);
      return imported;
    }

    const results = new Array(segments.length);
    let nextIdx = 0;
    let doneCount = 0;
    const workerCount = Math.max(1, Math.min(16, Number(concurrency) || 6));
    const workers = Array.from({ length: Math.min(workerCount, segments.length) }, async () => {
      while (true) {
        const idx = nextIdx;
        nextIdx += 1;
        if (idx >= segments.length) break;
        const seg = segments[idx];
        const sr = await fetch(seg.url, { credentials: "include" });
        if (!sr.ok) throw new Error(`Segmen ${idx} gagal: HTTP ${sr.status}`);
        let buf = await sr.arrayBuffer();
        if (seg.key) {
          const cryptoKey = await getCryptoKey(seg.key.uri);
          const iv = seg.key.ivHex ? hexToBytes(seg.key.ivHex) : seqToIv(seg.seq);
          buf = await crypto.subtle.decrypt({ name: "AES-CBC", iv }, cryptoKey, buf);
        }
        results[idx] = new Uint8Array(buf);
        doneCount += 1;
        if (typeof onProgress === "function") {
          onProgress(doneCount, segments.length);
        }
      }
    });

    await Promise.all(workers);

    const allParts = initBytes ? [initBytes, ...results] : results;
    const merged = concatUint8(allParts);
    const isMp4 = Boolean(initBytes) || segments[0].url.toLowerCase().includes(".m4s");
    return {
      blob: new Blob([merged], { type: isMp4 ? "video/mp4" : "video/mp2t" }),
      ext: isMp4 ? "mp4" : "ts",
    };
  }

  const api = {
    mergeFmp4VideoAudio,
    downloadHlsM3u8InBrowser,
  };

  if (typeof window !== "undefined") {
    window.__vortexMuxer = api;
  }
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})();
