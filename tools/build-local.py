#!/usr/bin/env python3
"""Build a single self-contained HTML file (keymap-viewer-local.html) that works when opened
directly from disk (file://). All ES modules, CSS, icons and the QR libraries are inlined.

    python3 tools/build-local.py            # writes dist/keymap-viewer-local.html
"""
import base64, os, re, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'dist', 'keymap-viewer-local.html')

# module path (relative to ROOT) -> variable name; order = dependency order
MODULES = [
    'js/vial-keycodes.js', 'js/lzma.js', 'js/keymap.js', 'js/render.js', 'js/db.js',
    'vendor/qrcode.mjs', 'js/share.js', 'js/vial.js', 'js/zmk.js', 'js/app.js',
]


def var_name(path):
    return '__m_' + re.sub(r'\W', '_', os.path.splitext(os.path.basename(path))[0])


def resolve(frm, spec):
    return os.path.normpath(os.path.join(os.path.dirname(frm), spec)).replace(os.sep, '/')


def transform(path, src):
    """Turn one ES module into `const __m_x = (() => { ...; return {exports} })();`"""
    exports = []

    def imp(m):
        what, spec = m.group(1).strip(), m.group(2)
        mod = var_name(resolve(path, spec))
        if what.startswith('{'):
            names = [n.strip() for n in what.strip('{} ').split(',') if n.strip()]
            parts = [f"{a.split(' as ')[0].strip()}: {a.split(' as ')[1].strip()}" if ' as ' in a else a for a in names]
            return f"const {{ {', '.join(parts)} }} = {mod};"
        return f"const {what} = {mod}.default;"

    src = re.sub(r"^import\s+(.+?)\s+from\s+['\"](.+?)['\"];?\s*$", imp, src, flags=re.M)

    def exp_decl(m):
        kind, name = m.group(1), m.group(2)
        exports.append(name)
        return f"{kind} {name}"

    src = re.sub(r"^export\s+(async function|function|class|const|let)\s+([A-Za-z_$][\w$]*)", exp_decl, src, flags=re.M)
    src, n = re.subn(r"^export\s+default\s+", "const __default = ", src, flags=re.M)
    if n:
        exports.append('default: __default')
    if re.search(r"^\s*(import|export)\s", src, flags=re.M):
        sys.exit(f'unsupported import/export form left in {path}')
    return f"// ---- {path} ----\nconst {var_name(path)} = (() => {{\n{src}\nreturn {{ {', '.join(exports)} }};\n}})();\n"


def read(p):
    with open(os.path.join(ROOT, p), encoding='utf-8') as f:
        return f.read()


def main():
    bundle = ''.join(transform(p, read(p)) for p in MODULES)
    jsqr = read('vendor/jsQR.js')
    worker_body = "self.onmessage=(e)=>{const{data,width,height}=e.data;const r=self.jsQR(new Uint8ClampedArray(data),width,height,{inversionAttempts:'dontInvert'});self.postMessage(r&&r.data?r.data:null);};"
    worker_factory = (
        "globalThis.__KV_QR_WORKER = () => {\n"
        "  const src = document.getElementById('jsqr-src').textContent + '\\n' + " + repr(worker_body) + ";\n"
        "  return new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));\n"
        "};\n"
    )
    css = read('css/style.css')
    icon_svg = 'data:image/svg+xml;base64,' + base64.b64encode(read('icons/icon.svg').encode()).decode()
    with open(os.path.join(ROOT, 'icons/apple-touch-icon.png'), 'rb') as f:
        touch = 'data:image/png;base64,' + base64.b64encode(f.read()).decode()

    html = read('index.html')
    html = html.replace('<link rel="manifest" href="manifest.webmanifest">\n', '')
    html = html.replace('href="icons/apple-touch-icon.png"', f'href="{touch}"')
    html = html.replace('icons/icon.svg', icon_svg)
    html = html.replace('<link rel="stylesheet" href="css/style.css">', f'<style>\n{css}\n</style>')
    # jsQR: classic script (defines window.jsQR for the main-thread fallback) whose text also feeds the worker
    scripts = (
        f'<script id="jsqr-src">\n{jsqr}\n</script>\n'
        f'<script>\n{worker_factory}</script>\n'
        f'<script type="module">\n{bundle}</script>'
    )
    html = html.replace('<script type="module" src="js/app.js"></script>', '')
    html = html.replace('</body>', scripts + '\n</body>')
    if 'src="js/' in html or 'href="css/' in html:
        sys.exit('external reference left in HTML')
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, 'w', encoding='utf-8') as f:
        f.write(html)
    print(f'wrote {OUT} ({os.path.getsize(OUT) // 1024} KB)')


if __name__ == '__main__':
    main()
