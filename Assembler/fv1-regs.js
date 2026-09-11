// FV-1 Register viewer -- a second window watching the simulator's core.
//
// Shows the register file as the program is running: the accumulator, the
// audio in and out, the pots, the LFO state and the 32 general-purpose
// registers, each as its S.23 value and the 24-bit word behind it.
//
// It is a real window rather than another flyout because the flyouts share
// one edge of the screen with the editor, and the point of watching registers
// is to do it while editing. A window can be dragged to a second display and
// left there.
//
// Where the browser offers it (Chromium's Document Picture-in-Picture) the
// window is a floating one: it stays on top of the editor and has no address
// bar, since a bar reading about:blank over a register file said nothing
// useful. Elsewhere, and when "Always on top" is turned off in the viewer's
// own header, it is an ordinary popup.
//
// Either way the window is opened blank and the document written into it,
// rather than loading a viewer page from the site. Two pages opened from
// file:// URLs are separate origins in Chrome, and a viewer page loaded that
// way could not be reached from here at all -- while a blank window is always
// the opener's origin, whatever the opener was served from. The one cost is
// that the viewer's markup and styles live in this file rather than in one of
// their own.

let regsWin = null;
let regsWinFloating = false;   // a picture-in-picture window rather than a popup
let regsEls = null;            // element handles inside the popup
let regsPoll = null;           // watches for the window being closed
let regsThemeObserver = null;
let regsLastState = null;
let regsAliases = null;        // key of the alias set last painted
let regsAliasMap = null;       // register index -> [names from EQU lines]

const REGS_ONE = 0x800000;
const REGS_MAX_SCOPES = 6;
const REGS_WINDOWS = [
    {s: 0.064, label: '64 ms'}, {s: 0.25, label: '250 ms'}, {s: 1, label: '1 s'},
    {s: 4, label: '4 s'}, {s: 16, label: '16 s'}
];

// Hardware names for the low half of the file, in the order the viewer lists
// them. Anything not here is only reachable by number, and is not shown.
const REGS_IO = [
    {i: 0x14, name: 'ADCL'}, {i: 0x15, name: 'ADCR'},
    {i: 0x16, name: 'DACL'}, {i: 0x17, name: 'DACR'},
    {i: 0x18, name: 'ADDR_PTR'}
];
const REGS_POTS = [
    {i: 0x10, name: 'POT0'}, {i: 0x11, name: 'POT1'}, {i: 0x12, name: 'POT2'},
    {i: 0x19, name: 'POT3', ext: true}, {i: 0x1a, name: 'POT4', ext: true},
    {i: 0x1b, name: 'POT5', ext: true}
];
const REGS_HW_NAMES = {
    SIN0_RATE: 0x00, SIN0_RANGE: 0x01, SIN1_RATE: 0x02, SIN1_RANGE: 0x03,
    RMP0_RATE: 0x04, RMP0_RANGE: 0x05, RMP1_RATE: 0x06, RMP1_RANGE: 0x07,
    SIN2_RATE: 0x08, SIN2_RANGE: 0x09, SIN3_RATE: 0x0a, SIN3_RANGE: 0x0b,
    RMP2_RATE: 0x0c, RMP2_RANGE: 0x0d, RMP3_RATE: 0x0e, RMP3_RANGE: 0x0f,
    POT0: 0x10, POT1: 0x11, POT2: 0x12, ADCL: 0x14, ADCR: 0x15,
    DACL: 0x16, DACR: 0x17, ADDR_PTR: 0x18, POT3: 0x19, POT4: 0x1a, POT5: 0x1b
};

// ---- the popup document ---------------------------------------------------

const REGS_CSS = `
:root {
    --bg: #f8f9fa; --fg: #333; --muted: #666; --border: #dee2e6;
    --row: rgba(127,127,127,0.08); --bar: #3b7dd8; --neg: #d8743b;
    --ok: #2e7d32; --warn: #b26a00; --alias: #1f6f9f;
}
body.dark { --bg: #2a2a2a; --fg: #e0e0e0; --muted: #999; --border: #444;
    --row: rgba(255,255,255,0.05); --bar: #5b9cf0; --neg: #f0a05b; --alias: #7fc4ea; }
* { box-sizing: border-box; }
body { margin: 0; padding: 12px 14px; background: var(--bg); color: var(--fg);
    font: 13px/1.35 -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; }
body.stopped .val, body.stopped .hex, body.stopped .fill { opacity: 0.45; }
header { display: flex; align-items: baseline; gap: 12px; margin-bottom: 8px;
    padding-bottom: 8px; border-bottom: 1px solid var(--border); }
header h1 { font-size: 15px; margin: 0; font-weight: 600; }
#status { font-size: 12px; color: var(--muted); }
#status.running { color: var(--ok); }
#status.warn { color: var(--warn); }
#rate { font-size: 12px; color: var(--muted); margin-left: auto; }
#float-ctl { display: flex; align-items: center; gap: 4px; font-size: 11px;
    color: var(--muted); white-space: nowrap; cursor: pointer; }
#float-ctl input { margin: 0; }
#float-ctl.hidden { display: none; }
h2 { font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em;
    color: var(--muted); margin: 12px 0 4px; font-weight: 600; }
.rows { display: grid; grid-template-columns: 1fr; gap: 2px; }
.rows.two { grid-template-columns: 1fr 1fr; column-gap: 12px; }
@media (max-width: 520px) { .rows.two { grid-template-columns: 1fr; } }
.row { display: grid; grid-template-columns: minmax(5em, 1fr) 5.4em 6.2em; align-items: center;
    column-gap: 8px; row-gap: 2px; padding: 3px 6px 4px; border-radius: 3px; background: var(--row);
    font-variant-numeric: tabular-nums; }
.row .bar { grid-column: 1 / -1; height: 3px; }
.row.hidden { display: none; }
.name { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 12px;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.name .alias { color: var(--alias); }
.name .alias::before { content: ' '; }
.name.aliased .hw { color: var(--muted); font-size: 11px; }
.hex { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 12px;
    color: var(--muted); }
.val { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 12px;
    text-align: right; }
.bar { position: relative; height: 8px; background: rgba(127,127,127,0.18);
    border-radius: 2px; overflow: hidden; }
.bar::after { content: ''; position: absolute; left: 50%; top: 0; bottom: 0;
    width: 1px; background: rgba(127,127,127,0.5); }
.fill { position: absolute; top: 0; bottom: 0; background: var(--bar); }
.fill.neg { background: var(--neg); }
.bar.uni::after { display: none; }
.lfo { display: grid; grid-template-columns: 5em 1fr 1fr 1fr 1fr; align-items: center;
    gap: 8px; padding: 3px 6px; border-radius: 3px; background: var(--row);
    font-variant-numeric: tabular-nums; font-size: 12px; }
.lfo.hidden { display: none; }
.lfo .name { font-weight: 600; }
.lfo .k { color: var(--muted); font-size: 11px; display: block; }
.lfo .v { font-family: ui-monospace, Menlo, Consolas, monospace; }
.lfo .bar { grid-column: 1 / -1; margin-top: 2px; }
.note { font-size: 11px; color: var(--muted); margin-top: 10px; }
.row .name { cursor: pointer; }
.row .name:hover { text-decoration: underline; }
.row.scoped .name .hw, .row.scoped .name .alias { color: var(--bar); }
#scopes-head { display: flex; align-items: center; gap: 8px; }
#scopes-head h2 { margin: 0; flex: 1; }
#scopes-head select { font-size: 11px; background: var(--bg); color: var(--fg);
    border: 1px solid var(--border); border-radius: 3px; padding: 1px 4px; }
#scopes-hint { font-size: 11px; color: var(--muted); margin: 2px 0 4px; }
.scope { background: var(--row); border-radius: 3px; padding: 4px 6px; margin-bottom: 4px; }
.scope-head { display: flex; align-items: baseline; gap: 8px; font-size: 12px; }
.scope-head .name { font-family: ui-monospace, Menlo, Consolas, monospace; flex: 1; }
.scope-head .v { font-family: ui-monospace, Menlo, Consolas, monospace; color: var(--muted); }
.scope-head .x { cursor: pointer; color: var(--muted); padding: 0 4px; }
.scope-head .x:hover { color: var(--fg); }
.scope canvas { display: block; width: 100%; height: 72px; }
`;

function regsRowHtml(id, name, opts) {
    const cls = 'row' + (opts && opts.hidden ? ' hidden' : '');
    const bar = opts && opts.uni ? 'bar uni' : 'bar';
    return '<div class="' + cls + '" id="row-' + id + '">' +
        '<span class="name" id="name-' + id + '"><span class="hw">' + name + '</span></span>' +
        '<span class="hex" id="hex-' + id + '"></span>' +
        '<span class="val" id="val-' + id + '"></span>' +
        '<div class="' + bar + '"><div class="fill" id="fill-' + id + '"></div></div>' +
        '</div>';
}

function regsLfoHtml(kind, n) {
    const id = kind + n;
    const hidden = n >= 2 ? ' hidden' : '';
    const name = kind.toUpperCase() + n;
    const a = kind === 'sin'
        ? ['Rate', 'Range', 'Value', 'Phase']
        : ['Rate', 'Range', 'Value', 'Position'];
    return '<div class="lfo' + hidden + '" id="lfo-' + id + '">' +
        '<span class="name">' + name + '</span>' +
        a.map((k, j) => '<span><span class="k">' + k + '</span>' +
            '<span class="v" id="' + id + '-' + j + '"></span></span>').join('') +
        '<div class="bar uni"><div class="fill" id="fill-' + id + '"></div></div>' +
        '</div>';
}

function regsDocument() {
    let regRows = '';
    for (let n = 0; n < 32; n++) regRows += regsRowHtml('r' + n, 'REG' + n);
    return '<!doctype html><html><head><meta charset="utf-8">' +
        '<title>FV-1 Registers</title><style>' + REGS_CSS + '</style></head>' +
        '<body class="stopped">' +
        '<header><h1>FV-1 Registers</h1><span id="status">Not running</span>' +
        '<span id="rate"></span>' +
        '<label id="float-ctl" title="Keep this window above the editor">' +
        '<input type="checkbox" id="float"> Always on top</label></header>' +
        '<div class="rows">' + regsRowHtml('acc', 'ACC') + '</div>' +
        '<div id="scopes-head"><h2>Scopes</h2><label for="scope-window">Window</label>' +
        '<select id="scope-window">' +
        REGS_WINDOWS.map(w => '<option value="' + w.s + '">' + w.label + '</option>').join('') +
        '</select></div>' +
        '<div id="scopes-hint">Click a register name below to watch it over time.</div>' +
        '<div id="scopes"></div>' +
        '<h2>Audio</h2><div class="rows two">' +
        REGS_IO.filter(r => r.i !== 0x18).map(r => regsRowHtml('x' + r.i, r.name)).join('') +
        '</div>' +
        '<h2>Pots</h2><div class="rows two">' +
        REGS_POTS.map(r => regsRowHtml('x' + r.i, r.name, {hidden: r.ext, uni: true})).join('') +
        '</div>' +
        '<h2>LFOs</h2><div class="rows">' +
        regsLfoHtml('sin', 0) + regsLfoHtml('sin', 1) +
        regsLfoHtml('rmp', 0) + regsLfoHtml('rmp', 1) +
        regsLfoHtml('sin', 2) + regsLfoHtml('sin', 3) +
        regsLfoHtml('rmp', 2) + regsLfoHtml('rmp', 3) +
        '</div>' +
        '<h2>Address pointer</h2><div class="rows">' +
        regsRowHtml('x' + 0x18, 'ADDR_PTR', {uni: true}) + '</div>' +
        '<h2>Registers</h2><div class="rows two" id="regs">' + regRows + '</div>' +
        '<div class="note">Values are read once per screen refresh, not per sample: ' +
        'a register that changes at audio rate shows whatever it held at that ' +
        'instant. Names in colour come from <code>EQU</code> lines in the editor.</div>' +
        '</body></html>';
}

// ---- open / close ---------------------------------------------------------

function simRegsIsOpen() {
    return !!(regsWin && !regsWin.closed);
}

// Floating means a Document Picture-in-Picture window: always on top, no
// address bar. It is the default wherever the browser has it, and the choice
// is remembered across sessions.
const REGS_FLOAT_KEY = 'fv1_regs_float';
const REGS_SIZE = {width: 620, height: 820};

function regsCanFloat() {
    return typeof window.documentPictureInPicture !== 'undefined' &&
        typeof window.documentPictureInPicture.requestWindow === 'function';
}

function regsWantsFloat() {
    if (!regsCanFloat()) return false;
    try { return localStorage.getItem(REGS_FLOAT_KEY) !== '0'; } catch (e) { return true; }
}

function regsRememberFloat(on) {
    try { localStorage.setItem(REGS_FLOAT_KEY, on ? '1' : '0'); } catch (e) { /* private mode */ }
}

async function simRegsOpen() {
    if (simRegsIsOpen()) {
        regsWin.focus();
        return;
    }
    let win = null;
    let floating = false;
    if (regsWantsFloat()) {
        // Needs a user gesture, and there is only ever one such window in
        // the browser; either refusal falls through to a popup.
        try {
            win = await window.documentPictureInPicture.requestWindow(REGS_SIZE);
            floating = true;
        } catch (e) { win = null; }
    }
    if (!win) {
        win = window.open('', 'fv1-registers',
            'width=' + REGS_SIZE.width + ',height=' + REGS_SIZE.height +
            ',resizable=yes,scrollbars=yes');
    }
    if (!win) {
        if (typeof simStatus === 'function') {
            simStatus('The register viewer was blocked - allow popups for this page', 'warn');
        }
        return;
    }
    regsAttach(win, floating);
}

// Reopen the viewer the other way round. A click inside a floating window
// counts as a gesture on this page too, so a popup can be opened from it;
// a click inside a popup does not carry over, and the floating window cannot
// be requested from there. In that case the choice is remembered, the popup
// closed, and the button in the panel takes over.
async function regsSetFloating(on) {
    regsRememberFloat(on);
    if (on === regsWinFloating || !simRegsIsOpen()) return;
    let win = null;
    if (on) {
        try { win = await window.documentPictureInPicture.requestWindow(REGS_SIZE); }
        catch (e) { win = null; }
    } else {
        win = window.open('', 'fv1-registers',
            'width=' + REGS_SIZE.width + ',height=' + REGS_SIZE.height +
            ',resizable=yes,scrollbars=yes');
    }
    const old = regsWin;
    if (win) {
        regsAttach(win, on);
        try { old.close(); } catch (e) { /* already gone */ }
        return;
    }
    simRegsClose();
    if (typeof openFlyout === 'function') openFlyout('sim');
    if (typeof simDebugToolsSet === 'function') simDebugToolsSet(true);
    regsPanelNote('Press <b>Open register viewer</b> to reopen it ' +
        (on ? 'floating' : 'as a window') + '.');
    window.focus();
}

// The note under the panel's button, which carries a message while the
// viewer is closed and reverts when it opens.
let regsPanelNoteHtml = null;
function regsPanelNote(html) {
    const el = document.getElementById('simRegsNote');
    if (!el) return;
    if (html === null) {
        if (regsPanelNoteHtml !== null) el.innerHTML = regsPanelNoteHtml;
        return;
    }
    if (regsPanelNoteHtml === null) regsPanelNoteHtml = el.innerHTML;
    el.innerHTML = html;
}

function regsAttach(win, floating) {
    win.document.open();
    win.document.write(regsDocument());
    win.document.close();
    regsWin = win;
    regsWinFloating = floating;
    regsEls = null;
    regsAliases = null;        // a fresh document has no names painted yet
    regsCollectEls();
    regsApplyTheme();
    regsRefreshAliases();
    regsPanelNote(null);
    // Nothing has been posted before the first Play. A file of zeros is what
    // the core holds then, and reads better than a page of empty cells.
    regsPaint(regsLastState || regsBlankState());
    regsUpdateStatus();

    // There is no reliable close event to hook on a document written into a
    // popup, so it is polled. Half a second is plenty: nothing is lost while
    // the worklet posts to a window that has gone.
    clearInterval(regsPoll);
    regsPoll = setInterval(() => {
        if (!simRegsIsOpen()) simRegsClose();
    }, 500);

    if (!regsThemeObserver && window.MutationObserver) {
        regsThemeObserver = new MutationObserver(regsApplyTheme);
        regsThemeObserver.observe(document.body, {attributes: true, attributeFilter: ['class']});
    }
    if (typeof simSetWatch === 'function') simSetWatch({viewer: true});
}

function regsBlankState() {
    const lfo = () => [0, 1, 2, 3].map(() => ({phase: 0, value: 0, range: 0, pos: 0, amp: 4096}));
    return {regs: new Array(64).fill(0), acc: 0, pacc: 0, sin: lfo(), rmp: lfo(),
            scopes: [], extended: false, hasProgram: true};
}

function simRegsClose() {
    clearInterval(regsPoll);
    regsPoll = null;
    if (regsWin && !regsWin.closed) {
        try { regsWin.close(); } catch (e) { /* already gone */ }
    }
    regsWin = null;
    regsWinFloating = false;
    regsEls = null;
    if (typeof simSetWatch === 'function') simSetWatch({viewer: false});
}

function regsCollectEls() {
    const d = regsWin.document;
    const get = (id) => d.getElementById(id);
    const els = {
        body: d.body, status: get('status'), rate: get('rate'),
        rows: {}, lfo: {}
    };
    const addRow = (id) => {
        els.rows[id] = {row: get('row-' + id), name: get('name-' + id),
            hex: get('hex-' + id), val: get('val-' + id), fill: get('fill-' + id)};
    };
    addRow('acc');
    for (const r of REGS_IO) addRow('x' + r.i);
    for (const r of REGS_POTS) addRow('x' + r.i);
    for (let n = 0; n < 32; n++) addRow('r' + n);
    for (const kind of ['sin', 'rmp']) {
        for (let n = 0; n < 4; n++) {
            const id = kind + n;
            els.lfo[id] = {box: get('lfo-' + id), fill: get('fill-' + id),
                f: [0, 1, 2, 3].map(j => get(id + '-' + j))};
        }
    }
    els.scopes = get('scopes');
    els.scopeWindow = get('scope-window');
    els.scopeCards = {};
    els.floatCtl = get('float-ctl');
    els.float = get('float');
    regsEls = els;

    els.floatCtl.classList.toggle('hidden', !regsCanFloat());
    els.float.checked = regsWinFloating;
    els.float.addEventListener('change', () => regsSetFloating(els.float.checked));

    // Register rows toggle a scope. ACC is not offered: it is zeroed at the
    // end of every sample, which is the only moment a scope reads.
    const rowIndex = (id) => id[0] === 'r' ? 0x20 + +id.slice(1) : +id.slice(1);
    for (const id of Object.keys(els.rows)) {
        if (id === 'acc' || !els.rows[id].name) continue;
        els.rows[id].name.addEventListener('click', () => regsToggleScope(rowIndex(id)));
    }
    els.scopeWindow.value = String(simWatch.window);
    els.scopeWindow.addEventListener('change', () => {
        simSetWatch({window: +els.scopeWindow.value});
    });
    regsSyncScopeCards();
}

// ---- scopes ---------------------------------------------------------------

function regsToggleScope(idx) {
    const list = simWatch.scopes.slice();
    const at = list.indexOf(idx);
    if (at >= 0) list.splice(at, 1);
    else if (list.length < REGS_MAX_SCOPES) list.push(idx);
    else return;
    simSetWatch({scopes: list});
    regsSyncScopeCards();
}

function regsRegName(idx) {
    if (idx >= 0x20) return 'REG' + (idx - 0x20);
    for (const k of Object.keys(REGS_HW_NAMES)) if (REGS_HW_NAMES[k] === idx) return k;
    return 'r' + idx;
}

function regsRowIdFor(idx) {
    return idx >= 0x20 ? 'r' + (idx - 0x20) : 'x' + idx;
}

// One card per watched register, in watch order. Cards are kept across a
// resync so a canvas is not thrown away and recreated on every click.
function regsSyncScopeCards() {
    if (!regsEls || !simRegsIsOpen()) return;
    const els = regsEls;
    const d = regsWin.document;
    const want = simWatch.scopes;
    for (const key of Object.keys(els.scopeCards)) {
        if (!want.includes(+key)) {
            els.scopeCards[key].card.remove();
            delete els.scopeCards[key];
        }
    }
    for (const idx of want) {
        if (!els.scopeCards[idx]) {
            const card = d.createElement('div');
            card.className = 'scope';
            card.innerHTML = '<div class="scope-head"><span class="name"></span>' +
                '<span class="v"></span><span class="x" title="Remove">\u2715</span></div>' +
                '<canvas></canvas>';
            card.querySelector('.x').addEventListener('click', () => regsToggleScope(idx));
            const canvas = card.querySelector('canvas');
            els.scopeCards[idx] = {card, canvas, name: card.querySelector('.name'),
                v: card.querySelector('.v')};
        }
        els.scopes.appendChild(els.scopeCards[idx].card);
    }
    for (const id of Object.keys(els.rows)) {
        const r = els.rows[id];
        if (!r.row || id === 'acc') continue;
        const idx = id[0] === 'r' ? 0x20 + +id.slice(1) : +id.slice(1);
        r.row.classList.toggle('scoped', want.includes(idx));
    }
    els.scopes.hidden = want.length === 0;
    regsNameScopeCards();
}

function regsNameScopeCards() {
    if (!regsEls) return;
    const aliases = regsAliasMap || {};
    for (const key of Object.keys(regsEls.scopeCards)) {
        const idx = +key;
        const names = aliases[idx];
        regsSet(regsEls.scopeCards[key].name,
            regsRegName(idx) + (names ? '  ' + names.join(', ') : ''));
    }
}

function regsPaintScopes(s) {
    if (!regsEls || !s.scopes) return;
    const dark = regsEls.body.classList.contains('dark');
    for (const sc of s.scopes) {
        const card = regsEls.scopeCards[sc.reg];
        if (!card) continue;
        const canvas = card.canvas;
        const w = canvas.clientWidth || 300;
        const h = canvas.clientHeight || 72;
        const dpr = regsWin.devicePixelRatio || 1;
        if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
            canvas.width = Math.round(w * dpr);
            canvas.height = Math.round(h * dpr);
        }
        const ctx = canvas.getContext('2d');
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, w, h);
        const n = sc.min.length;
        const y = (v) => (1 - Math.max(-1, Math.min(1, v))) * (h - 2) / 2 + 1;
        // Zero line and the full-scale bounds.
        ctx.strokeStyle = dark ? 'rgba(255,255,255,0.18)' : 'rgba(0,0,0,0.15)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, y(0) + 0.5); ctx.lineTo(w, y(0) + 0.5);
        ctx.stroke();
        // The envelope: the band between each bin's min and max.
        ctx.fillStyle = dark ? 'rgba(91,156,240,0.85)' : 'rgba(59,125,216,0.85)';
        ctx.beginPath();
        for (let i = 0; i < n; i++) ctx.lineTo(i * w / (n - 1), y(sc.max[i]));
        for (let i = n - 1; i >= 0; i--) ctx.lineTo(i * w / (n - 1), y(sc.min[i]));
        ctx.closePath();
        ctx.fill();
        // A band thinner than a pixel would vanish, so a line is drawn along it too.
        ctx.strokeStyle = ctx.fillStyle;
        ctx.beginPath();
        for (let i = 0; i < n; i++) {
            const py = y((sc.min[i] + sc.max[i]) / 2);
            if (i === 0) ctx.moveTo(0, py); else ctx.lineTo(i * w / (n - 1), py);
        }
        ctx.stroke();
        const last = n - 1;
        regsSet(card.v, regsFloat(sc.min[last] * REGS_ONE) + ' .. ' +
            regsFloat(sc.max[last] * REGS_ONE));
    }
}

function regsApplyTheme() {
    if (!regsEls) return;
    const dark = document.body.classList.contains('dark-mode');
    regsEls.body.classList.toggle('dark', dark);
}

// ---- formatting -----------------------------------------------------------

function regsHex(v) {
    return '0x' + ((Math.round(v) | 0) & 0xFFFFFF).toString(16).toUpperCase().padStart(6, '0');
}

function regsFloat(v) {
    const f = v / REGS_ONE;
    // Six places is what a 24-bit value carries, and a fixed width keeps the
    // column from twitching as values pass through zero.
    return (f < 0 ? '' : '+') + f.toFixed(6);
}

function regsSet(el, text) {
    if (el && el.textContent !== text) el.textContent = text;
}

// Bipolar bar: zero in the middle, negative values grow leftwards.
function regsBar(fill, f, unipolar) {
    if (!fill) return;
    const c = Math.max(-1, Math.min(1, f));
    if (unipolar) {
        fill.style.left = '0';
        fill.style.width = (Math.max(0, c) * 100).toFixed(1) + '%';
        fill.classList.remove('neg');
        return;
    }
    const w = Math.abs(c) * 50;
    fill.style.left = (c < 0 ? 50 - w : 50).toFixed(1) + '%';
    fill.style.width = w.toFixed(1) + '%';
    fill.classList.toggle('neg', c < 0);
}

function regsPaintRow(r, v, unipolar) {
    if (!r) return;
    regsSet(r.hex, regsHex(v));
    regsSet(r.val, regsFloat(v));
    regsBar(r.fill, v / REGS_ONE, unipolar);
}

function regsHz(n) {
    if (n >= 100) return n.toFixed(0) + ' Hz';
    if (n >= 10) return n.toFixed(1) + ' Hz';
    return n.toFixed(2) + ' Hz';
}

// ---- painting a snapshot --------------------------------------------------

function regsPaint(s) {
    if (!regsEls || !simRegsIsOpen()) return;
    const els = regsEls;
    const regs = s.regs;
    const rate = typeof simGetRate === 'function' ? simGetRate() : 32768;

    regsPaintRow(els.rows.acc, s.acc);
    for (const r of REGS_IO) {
        if (r.i === 0x18) continue;
        regsPaintRow(els.rows['x' + r.i], regs[r.i]);
    }
    // ADDR_PTR is a delay address, not a signal: RMPA reads ACC[23:8] as the
    // sample to fetch, so the value column shows that address rather than
    // the S.23 reading, and the bar is its place in the tank.
    {
        const r = els.rows['x' + 0x18];
        const v = regs[0x18];
        const mask = s.extended ? 0xFFFF : 0x7FFF;
        const addr = Math.floor(v / 256) & mask;
        regsSet(r.hex, regsHex(v));
        regsSet(r.val, addr + ' smp');
        regsBar(r.fill, addr / (mask + 1), true);
    }
    const ext = regsShowExtended(s);
    for (const r of REGS_POTS) {
        const row = els.rows['x' + r.i];
        if (r.ext && row.row) row.row.classList.toggle('hidden', !ext);
        regsPaintRow(row, regs[r.i], true);
    }
    for (let n = 0; n < 32; n++) regsPaintRow(els.rows['r' + n], regs[0x20 + n]);

    for (let n = 0; n < 4; n++) {
        const L = els.lfo['sin' + n];
        if (n >= 2 && L.box) L.box.classList.toggle('hidden', !ext);
        const sin = s.sin[n];
        // AN-0001: f = Kf * R / (2 pi 2^17), with Kf the 9-bit rate field.
        const kf = Math.floor(regs[n < 2 ? 2 * n : 8 + 2 * (n - 2)] / 16384) & 0x1FF;
        const ka = Math.floor(sin.range / 256) & 0x7FFF;
        regsSet(L.f[0], kf + '  (' + regsHz(kf * rate / (2 * Math.PI * 131072)) + ')');
        regsSet(L.f[1], ka + '  (±' + (ka / 4).toFixed(0) + ' smp)');
        regsSet(L.f[2], regsFloat(sin.value));
        // Phase as a turn, since a wrapped radian count is not a number a
        // reader can place on the wave.
        let turn = (sin.phase / (2 * Math.PI)) % 1;
        if (turn < 0) turn += 1;
        regsSet(L.f[3], (turn * 360).toFixed(0) + '°');
        regsBar(L.fill, sin.range ? sin.value / sin.range : 0, false);
    }
    for (let n = 0; n < 4; n++) {
        const L = els.lfo['rmp' + n];
        if (n >= 2 && L.box) L.box.classList.toggle('hidden', !ext);
        const rmp = s.rmp[n];
        const rateReg = regs[n < 2 ? 4 + 2 * n : 12 + 2 * (n - 2)];
        // The rate field as WLDR wrote it: a signed 16-bit count, negative to
        // run the ramp the other way.
        const kf = Math.round(rateReg / 256);
        regsSet(L.f[0], String(kf));
        regsSet(L.f[1], rmp.amp + ' smp');
        regsSet(L.f[2], regsFloat(rmp.value));
        regsSet(L.f[3], rmp.pos.toFixed(1));
        regsBar(L.fill, rmp.amp ? rmp.pos / rmp.amp : 0, true);
    }

    regsSet(els.rate, typeof simRateLabel === 'function' ? simRateLabel(rate) : rate + ' Hz');
    regsPaintScopes(s);
    regsUpdateStatus();
}

// The extended rows are shown as soon as the source asks for them, like the
// pot sliders: the build that reads POT3 cannot exist until the pragma does.
// The tank size shown for ADDR_PTR still follows the loaded build, since that
// is the one deciding it.
function regsShowExtended(s) {
    if (typeof simShowExtended === 'function') return simShowExtended();
    return !!(s && s.extended);
}

// The pragma appeared or went while the viewer is open.
function regsRefreshExtended() {
    if (!simRegsIsOpen()) return;
    regsPaint(regsLastState || regsBlankState());
}

function regsUpdateStatus() {
    if (!regsEls || !simRegsIsOpen()) return;
    const running = typeof simIsRunning === 'function' && simIsRunning();
    const halted = typeof simDebugIsHalted === 'function' && simDebugIsHalted();
    const hasProg = !regsLastState || regsLastState.hasProgram;
    regsEls.body.classList.toggle('stopped', !running && !halted);
    let text, cls;
    if (halted) { text = 'Halted - ' + simDebugWhere(); cls = 'warn'; }
    else if (running && hasProg) { text = 'Running'; cls = 'running'; }
    else if (running) { text = 'No program loaded'; cls = 'warn'; }
    else { text = regsLastState ? 'Stopped' : 'Not running'; cls = ''; }
    regsSet(regsEls.status, text);
    regsEls.status.className = cls;
}

// The engine posts these at about 20 Hz while a viewer is open, and once on
// every load, reset and watch, so the window has something to show when the
// simulator is stopped.
function simRegsOnState(s) {
    regsLastState = s;
    regsPaint(s);
}

// Play and Stop reach here through simUpdateTransport.
function simRegsOnTransport() {
    regsUpdateStatus();
}

// ---- register names from the source ---------------------------------------

// Read the EQU lines out of the editor so REG5 can be shown as whatever the
// program calls it. Both SpinASM spellings are taken -- `equ name value` and
// `name equ value` -- and an alias of an alias resolves through the chain, so
// `equ fb reg5` then `equ fb_l fb` names REG5 twice. Only equates that land on
// a register are kept; coefficients and delay addresses are not registers.
function regsParseAliases(src) {
    const byName = {};
    const order = [];
    if (src) {
        for (const raw of src.split(/\r?\n/)) {
            const line = raw.replace(/(;|\/\/).*$/, '');
            let m = /^\s*equ\s+([A-Za-z_][\w]*)\s+(\S+)/i.exec(line) ||
                    /^\s*([A-Za-z_][\w]*)\s+equ\s+(\S+)/i.exec(line);
            if (!m) continue;
            byName[m[1].toUpperCase()] = m[2].toUpperCase();
            order.push(m[1].toUpperCase());
        }
    }
    const resolve = (name, depth) => {
        if (depth > 8) return -1;
        const hw = REGS_HW_NAMES[name];
        if (hw !== undefined) return hw;
        const reg = /^REG(\d+)$/.exec(name);
        if (reg) return +reg[1] < 32 ? 0x20 + +reg[1] : -1;
        let num = -1;
        if (/^0X[0-9A-F]+$/.test(name)) num = parseInt(name.slice(2), 16);
        else if (/^\$[0-9A-F]+$/.test(name)) num = parseInt(name.slice(1), 16);
        else if (/^\d+$/.test(name)) num = parseInt(name, 10);
        if (num >= 0) return num < 64 ? num : -1;
        if (byName[name] !== undefined) return resolve(byName[name], depth + 1);
        return -1;
    };
    const out = {};
    for (const name of order) {
        const idx = resolve(byName[name], 0);
        if (idx < 0) continue;
        (out[idx] = out[idx] || []).push(name.toLowerCase());
    }
    return out;
}

function regsRefreshAliases() {
    if (!regsEls || !simRegsIsOpen()) return;
    let src = '';
    try {
        if (typeof editor !== 'undefined' && editor && editor.getValue) src = editor.getValue();
    } catch (e) { /* editor not up yet */ }
    const aliases = regsParseAliases(src);
    const key = JSON.stringify(aliases);
    if (regsAliases === key) return;
    regsAliases = key;
    regsAliasMap = aliases;

    const paint = (r, idx, hw) => {
        if (!r || !r.name) return;
        const names = aliases[idx];
        r.name.classList.toggle('aliased', !!names);
        r.name.innerHTML = '<span class="hw">' + hw + '</span>' +
            (names ? '<span class="alias">' + names.map(regsEscape).join(', ') + '</span>' : '');
        if (r.row) r.row.title = names ? hw + ': ' + names.join(', ') : hw;
    };
    for (let n = 0; n < 32; n++) paint(regsEls.rows['r' + n], 0x20 + n, 'REG' + n);
    for (const r of REGS_IO) paint(regsEls.rows['x' + r.i], r.i, r.name);
    for (const r of REGS_POTS) paint(regsEls.rows['x' + r.i], r.i, r.name);
    regsNameScopeCards();
}

function regsEscape(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ---- wiring ---------------------------------------------------------------

document.addEventListener('DOMContentLoaded', () => {
    // Follow the editor for the names, on the same kind of debounce the pot
    // labels use. Monaco may not be up yet, so poll briefly for it.
    let tries = 0;
    const attach = setInterval(() => {
        if (typeof editor !== 'undefined' && editor && editor.onDidChangeModelContent) {
            clearInterval(attach);
            let timer = null;
            editor.onDidChangeModelContent(() => {
                clearTimeout(timer);
                timer = setTimeout(regsRefreshAliases, 300);
            });
        } else if (++tries > 40) {
            clearInterval(attach);
        }
    }, 250);
});

// A viewer left open after the page that feeds it has gone would sit there
// showing stale numbers with nothing to say they are stale.
window.addEventListener('pagehide', () => {
    if (simRegsIsOpen()) {
        try { regsWin.close(); } catch (e) { /* already gone */ }
    }
});
