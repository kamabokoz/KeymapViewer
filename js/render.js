// SVG rendering of a keyboard view model
import { bounds } from './keymap.js';

const U = 56;      // px per key unit
const GAP = 3;     // gap between keys

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const textWidth = (s) => { let w = 0; for (const ch of s) w += /[　-鿿＀-￯가-힯]/.test(ch) ? 1 : ch === ' ' ? 0.3 : /[A-Z@%&MW]/.test(ch) ? 0.68 : 0.56; return w; };

function fit(str, maxW, base) {
  const tw = textWidth(str) || 1;
  return Math.max(7, Math.min(base, maxW / tw));
}

export function renderKeyboard(view, layerIdx, { selectedKey = -1, idPrefix = 'k' } = {}) {
  const layer = view.layers[layerIdx];
  const b = bounds(view.keys);
  const W = b.maxX * U + 2, H = b.maxY * U + 2;
  const parts = [`<svg class="kb" viewBox="-1 -1 ${W + 1} ${H + 1}" xmlns="http://www.w3.org/2000/svg" style="min-width:${Math.round(b.maxX * 38)}px" role="img" aria-label="${esc(layer.name)}">`];
  view.keys.forEach((k, i) => {
    const lg = layer.legends[i] || { tap: [], kind: 'none' };
    const x = k.x * U + GAP / 2, y = k.y * U + GAP / 2, w = k.w * U - GAP, h = k.h * U - GAP;
    const tr = k.r ? ` transform="rotate(${k.r} ${k.rx * U} ${k.ry * U})"` : '';
    const cls = `key kind-${lg.kind || 'func'}${i === selectedKey ? ' sel' : ''}`;
    parts.push(`<g class="${cls}" data-i="${i}" id="${idPrefix}${i}"${tr}><title>${esc(lg.title || '')}</title>`);
    if (k.encoder) {
      const r = Math.min(w, h) / 2;
      parts.push(`<circle class="cap" cx="${x + w / 2}" cy="${y + h / 2}" r="${r}"/>`);
    } else {
      parts.push(`<rect class="cap" x="${x}" y="${y}" width="${w}" height="${h}" rx="7"/>`);
      if (k.w2 && k.h2 && (k.w2 !== k.w || k.h2 !== k.h || k.x2 || k.y2)) {
        parts.push(`<rect class="cap" x="${x + k.x2 * U}" y="${y + k.y2 * U}" width="${k.w2 * U - GAP}" height="${k.h2 * U - GAP}" rx="7"/>`);
      }
      parts.push(`<rect class="top" x="${x + 4}" y="${y + 3}" width="${Math.max(0, w - 8)}" height="${Math.max(0, h - 10)}" rx="5"/>`);
    }
    const tap = lg.tap || [];
    const hold = lg.hold ? String(lg.hold) : '';
    const cx = x + w / 2;
    const innerW = w - 8;
    const areaTop = y + 3, areaH = h - 10 - (hold ? 11 : 0);
    const n = tap.length;
    if (n) {
      const base = n === 1 ? (tap[0].length <= 2 ? 17 : 13) : n === 2 ? 11.5 : 9.5;
      const sizes = tap.map((t) => fit(t, innerW, base));
      const lh = Math.min(...sizes) * 1.15;
      const total = lh * n;
      let ty = areaTop + areaH / 2 - total / 2 + lh * 0.8;
      tap.forEach((t, j) => {
        parts.push(`<text class="lg${n > 1 && j === 0 ? ' shift' : ''}" x="${cx}" y="${ty}" font-size="${sizes[j].toFixed(1)}">${esc(t)}</text>`);
        ty += lh;
      });
    }
    if (hold) {
      const fs = fit(hold, innerW, 9);
      parts.push(`<text class="hold" x="${cx}" y="${y + h - 5}" font-size="${fs.toFixed(1)}">${esc(hold)}</text>`);
    }
    parts.push('</g>');
  });
  parts.push('</svg>');
  return parts.join('');
}
