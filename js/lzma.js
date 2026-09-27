// Minimal LZMA / LZMA2 / .xz decoder (decode-only, whole-buffer).
// Vial keyboard definitions are compressed with Python's lzma.compress() (.xz container, LZMA2 filter).
// Also accepts the legacy ".lzma" (LZMA-alone) format.

class RangeDecoder {
  constructor(buf, pos) {
    this.buf = buf;
    this.pos = pos;
    if (buf[this.pos++] !== 0) throw new Error('LZMA: bad range coder header');
    this.range = 0xFFFFFFFF;
    this.code = 0;
    for (let i = 0; i < 4; i++) this.code = ((this.code << 8) | buf[this.pos++]) >>> 0;
  }
  normalize() {
    if (this.range < 0x1000000) {
      this.range = (this.range << 8) >>> 0;
      this.code = ((this.code << 8) | this.buf[this.pos++]) >>> 0;
    }
  }
  bit(probs, i) {
    const p = probs[i];
    const bound = (this.range >>> 11) * p;
    let b;
    if (this.code < bound) {
      this.range = bound >>> 0;
      probs[i] = p + ((2048 - p) >>> 5);
      b = 0;
    } else {
      this.range = (this.range - bound) >>> 0;
      this.code = (this.code - bound) >>> 0;
      probs[i] = p - (p >>> 5);
      b = 1;
    }
    this.normalize();
    return b;
  }
  direct(n) {
    let res = 0;
    for (let i = 0; i < n; i++) {
      this.range >>>= 1;
      let b = 0;
      if (this.code >= this.range) { this.code = (this.code - this.range) >>> 0; b = 1; }
      res = res * 2 + b;
      this.normalize();
    }
    return res;
  }
  tree(probs, base, n) {
    let m = 1;
    for (let i = 0; i < n; i++) m = (m << 1) | this.bit(probs, base + m);
    return m - (1 << n);
  }
  reverseTree(probs, base, n) {
    let m = 1, sym = 0;
    for (let i = 0; i < n; i++) {
      const b = this.bit(probs, base + m);
      m = (m << 1) | b;
      sym |= b << i;
    }
    return sym;
  }
}

class OutBuf {
  constructor(size) { this.buf = new Uint8Array(size || 65536); this.len = 0; }
  push(b) {
    if (this.len >= this.buf.length) {
      const n = new Uint8Array(this.buf.length * 2);
      n.set(this.buf);
      this.buf = n;
    }
    this.buf[this.len++] = b;
  }
  get(dist) { return this.buf[this.len - dist]; } // dist >= 1
  result() { return this.buf.slice(0, this.len); }
}

const probsArr = (n) => new Uint16Array(n).fill(1024);

class LenDecoder {
  constructor() { this.reset(); }
  reset() {
    this.choice = probsArr(2);
    this.low = probsArr(16 << 3);
    this.mid = probsArr(16 << 3);
    this.high = probsArr(256);
  }
  decode(rc, posState) {
    if (rc.bit(this.choice, 0) === 0) return rc.tree(this.low, posState << 3, 3);
    if (rc.bit(this.choice, 1) === 0) return 8 + rc.tree(this.mid, posState << 3, 3);
    return 16 + rc.tree(this.high, 0, 8);
  }
}
// tree() indexes base+m with m starting at 1, so give each sub-tree 8 slots (index 1..7 used)

class LzmaState {
  constructor(out) { this.out = out; this.dictStart = 0; }
  setProps(propByte) {
    let d = propByte;
    if (d >= 9 * 5 * 5) throw new Error('LZMA: bad props');
    this.lc = d % 9; d = (d / 9) | 0;
    this.lp = d % 5; this.pb = (d / 5) | 0;
  }
  reset() {
    this.literal = probsArr(0x300 << (this.lc + this.lp));
    this.isMatch = probsArr(12 << 4);
    this.isRep = probsArr(12);
    this.isRepG0 = probsArr(12);
    this.isRepG1 = probsArr(12);
    this.isRepG2 = probsArr(12);
    this.isRep0Long = probsArr(12 << 4);
    this.posSlot = probsArr(4 << 6);
    this.posDecoders = probsArr(1 + 114);
    this.align = probsArr(16);
    this.lenDec = new LenDecoder();
    this.repLenDec = new LenDecoder();
    this.state = 0;
    this.rep0 = this.rep1 = this.rep2 = this.rep3 = 0;
  }
  decodeDistance(rc, len) {
    const lenState = Math.min(len, 3);
    const posSlot = rc.tree(this.posSlot, lenState << 6, 6);
    if (posSlot < 4) return posSlot;
    const numDirect = (posSlot >>> 1) - 1;
    let dist = (2 | (posSlot & 1)) * Math.pow(2, numDirect);
    if (posSlot < 14) {
      dist += rc.reverseTree(this.posDecoders, dist - posSlot, numDirect);
    } else {
      dist += rc.direct(numDirect - 4) * 16;
      dist += rc.reverseTree(this.align, 0, 4);
    }
    return dist;
  }
  // Decode until `unpackSize` bytes produced (or end marker when unpackSize < 0)
  decode(rc, unpackSize) {
    const out = this.out;
    const target = unpackSize < 0 ? Infinity : out.len + unpackSize;
    const pbMask = (1 << this.pb) - 1, lpMask = (1 << this.lp) - 1;
    while (out.len < target) {
      const posState = out.len & pbMask;
      const st = this.state;
      if (rc.bit(this.isMatch, (st << 4) + posState) === 0) {
        const prev = out.len > this.dictStart ? out.get(1) : 0;
        const litState = ((out.len & lpMask) << this.lc) + (prev >>> (8 - this.lc));
        const base = 0x300 * litState;
        let sym = 1;
        if (st >= 7) {
          let matchByte = out.get(this.rep0 + 1);
          while (sym < 0x100) {
            const matchBit = (matchByte >>> 7) & 1;
            matchByte <<= 1;
            const b = rc.bit(this.literal, base + ((1 + matchBit) << 8) + sym);
            sym = (sym << 1) | b;
            if (matchBit !== b) break;
          }
        }
        while (sym < 0x100) sym = (sym << 1) | rc.bit(this.literal, base + sym);
        out.push(sym & 0xFF);
        this.state = st < 4 ? 0 : st < 10 ? st - 3 : st - 6;
        continue;
      }
      let len;
      if (rc.bit(this.isRep, st) !== 0) {
        if (out.len === this.dictStart) throw new Error('LZMA: rep with empty dict');
        if (rc.bit(this.isRepG0, st) === 0) {
          if (rc.bit(this.isRep0Long, (st << 4) + posState) === 0) {
            this.state = st < 7 ? 9 : 11;
            out.push(out.get(this.rep0 + 1));
            continue;
          }
        } else {
          let dist;
          if (rc.bit(this.isRepG1, st) === 0) dist = this.rep1;
          else {
            if (rc.bit(this.isRepG2, st) === 0) dist = this.rep2;
            else { dist = this.rep3; this.rep3 = this.rep2; }
            this.rep2 = this.rep1;
          }
          this.rep1 = this.rep0;
          this.rep0 = dist;
        }
        len = this.repLenDec.decode(rc, posState);
        this.state = st < 7 ? 8 : 11;
      } else {
        this.rep3 = this.rep2; this.rep2 = this.rep1; this.rep1 = this.rep0;
        len = this.lenDec.decode(rc, posState);
        this.state = st < 7 ? 7 : 10;
        this.rep0 = this.decodeDistance(rc, len);
        if (this.rep0 === 0xFFFFFFFF) {
          if (unpackSize < 0) return; // end marker
          throw new Error('LZMA: unexpected end marker');
        }
        if (this.rep0 >= out.len - this.dictStart) throw new Error('LZMA: distance out of range');
      }
      len += 2;
      for (let i = 0; i < len && out.len < target; i++) out.push(out.get(this.rep0 + 1));
    }
  }
}

function decodeLzma2(buf, pos, out) {
  const lz = new LzmaState(out);
  let needProps = true;
  for (;;) {
    const c = buf[pos++];
    if (c === undefined) throw new Error('LZMA2: truncated');
    if (c === 0x00) return pos;
    if (c === 0x01 || c === 0x02) {
      if (c === 0x01) lz.dictStart = out.len;
      const size = ((buf[pos] << 8) | buf[pos + 1]) + 1;
      pos += 2;
      for (let i = 0; i < size; i++) out.push(buf[pos + i]);
      pos += size;
      continue;
    }
    if (c < 0x80) throw new Error('LZMA2: bad control byte');
    const unpacked = ((c & 0x1F) << 16) + (buf[pos] << 8) + buf[pos + 1] + 1;
    const packed = (buf[pos + 2] << 8) + buf[pos + 3] + 1;
    pos += 4;
    const reset = (c >>> 5) & 3;
    if (reset === 3) lz.dictStart = out.len;
    if (reset >= 2) { lz.setProps(buf[pos++]); needProps = false; }
    else if (needProps) throw new Error('LZMA2: missing props');
    if (reset >= 1) lz.reset();
    const rc = new RangeDecoder(buf, pos);
    lz.decode(rc, unpacked);
    pos += packed;
  }
}

const XZ_MAGIC = [0xFD, 0x37, 0x7A, 0x58, 0x5A, 0x00];

function readVarint(buf, pos) {
  let v = 0, mul = 1, b;
  do { b = buf[pos++]; v += (b & 0x7F) * mul; mul *= 128; } while (b & 0x80);
  return [v, pos];
}

function decodeXz(buf) {
  const out = new OutBuf(buf.length * 6);
  const checkType = buf[7] & 0x0F;
  const checkSize = checkType === 0 ? 0 : checkType <= 3 ? 4 : checkType <= 6 ? 8 : checkType <= 9 ? 16 : checkType <= 12 ? 32 : 64;
  let pos = 12;
  for (;;) {
    const hdrByte = buf[pos];
    if (hdrByte === 0x00 || hdrByte === undefined) break; // index
    const blockStart = pos;
    const hdrSize = (hdrByte + 1) * 4;
    const flags = buf[pos + 1];
    let p = pos + 2;
    if (flags & 0x40) [, p] = readVarint(buf, p);
    if (flags & 0x80) [, p] = readVarint(buf, p);
    const nFilters = (flags & 3) + 1;
    for (let i = 0; i < nFilters; i++) {
      let id, sz;
      [id, p] = readVarint(buf, p);
      [sz, p] = readVarint(buf, p);
      if (id !== 0x21) throw new Error('xz: unsupported filter 0x' + id.toString(16));
      p += sz;
    }
    pos = blockStart + hdrSize;
    const dataStart = pos;
    pos = decodeLzma2(buf, pos, out);
    while ((pos - dataStart) % 4) pos++;
    pos += checkSize;
  }
  return out.result();
}

function decodeLzmaAlone(buf) {
  const lz = new LzmaState(null);
  lz.setProps(buf[0]);
  let size = 0;
  let unknown = true;
  for (let i = 0; i < 8; i++) if (buf[5 + i] !== 0xFF) unknown = false;
  if (!unknown) for (let i = 7; i >= 0; i--) size = size * 256 + buf[5 + i];
  const out = new OutBuf(unknown ? buf.length * 6 : size);
  lz.out = out;
  lz.reset();
  const rc = new RangeDecoder(buf, 13);
  lz.decode(rc, unknown ? -1 : size);
  return out.result();
}

export function lzmaDecompress(bytes) {
  const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (XZ_MAGIC.every((b, i) => buf[i] === b)) return decodeXz(buf);
  return decodeLzmaAlone(buf);
}
