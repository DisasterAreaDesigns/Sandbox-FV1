// FV-1 debugger -- halting the simulator and stepping it by hand.
//
// The engine runs in an AudioWorklet, which is the right place to catch a
// condition and the wrong place to step from. So a halt moves the whole core
// -- registers, LFO phases, the delay tank -- to this thread, where a second
// FV1Core continues it one instruction at a time with the editor following
// along. Resume hands the state back, and the worklet picks up from wherever
// the stepping left it: a breakpoint that fires every sample, stepped through
// and resumed, really does advance the program a sample at a time.
//
// Breakpoints are conditions rather than places, because on this chip every
// instruction runs every sample and a bare "stop at line 20" would trip on the
// first one. A line breakpoint carries a "when" -- every sample, the first
// run, or a given sample number -- and the others are the conditions that
// matter for audio: a clip, a SKP going one way, ACC or a register crossing a
// value. Value conditions fire when they become true, not while they stay so.
//
// The input while stepping is the ADC as it stood at the halt: the source is
// audio that only the graph can produce, and a held sample is the honest
// stand-in. The status line says so.

let dbgCore = null;           // the halted core, on this thread
let dbgPc = -1;               // next instruction; PROG_LEN means the pass is done
let dbgHalted = false;
let dbgStepped = false;       // has this thread's copy moved past the worklet's
let dbgReason = null;
let dbgAdc = [0, 0];          // input held while stepping, as floats
let dbgLineDecorations = [];
let dbgBreakpoints = [];      // see simDebugAddBreakpoint for the shape
let dbgNextId = 1;
let dbgBpDecorations = {};    // breakpoint id -> Monaco decoration id

const DBG_ONE = 0x800000;
const DBG_RUN_BUDGET = 4096;  // samples a "run to line" may cover before giving up

// ---- halting ----------------------------------------------------------------

function simDebugIsHalted() { return dbgHalted; }

function simDebugHalt() {
    if (dbgHalted) { simDebugResume(); return; }
    if (typeof simIsRunning !== 'function' || !simIsRunning()) {
        simDebugStatus('Press Play first - there is nothing running to halt', 'warn');
        return;
    }
    simPost({type: 'halt'});
    simDebugStatus('Halting at the end of this sample...', '');
}

function simDebugOnHalted(msg) {
    const prog = typeof simGetLoadedProgram === 'function' ? simGetLoadedProgram() : null;
    if (!prog || typeof FV1Core === 'undefined') return;
    dbgCore = new FV1Core();
    dbgCore.setProgram(prog, true, typeof simIsExtended === 'function' && simIsExtended());
    dbgCore.traceOn = true;
    dbgCore.importState(msg.state);
    dbgPc = msg.pc;
    dbgHalted = true;
    dbgStepped = false;
    dbgReason = msg.reason;
    dbgAdc = [dbgCore.regs[dbgCore.ADCL] / dbgCore.ACC_MAX,
              dbgCore.regs[dbgCore.ADCR] / dbgCore.ACC_MAX];
    if (typeof openFlyout === 'function') openFlyout('sim');
    simDebugRefresh();
}

function simDebugOnResumed() {
    dbgHalted = false;
    dbgCore = null;
    dbgPc = -1;
    simDebugClearLine();
    simDebugUpdateButtons();
    simDebugStatus('Running freely', '');
    if (typeof simTraceOnResume === 'function') simTraceOnResume();
    if (typeof regsUpdateStatus === 'function') regsUpdateStatus();
}

function simDebugResume() {
    if (!dbgHalted) return;
    let state = null;
    if (dbgStepped) {
        // The worklet finishes whatever is open: an instruction or two of the
        // current sample, or just its end-of-sample housekeeping.
        state = dbgCore.exportState();
        state.haltedPc = dbgPc;
    }
    simPost({type: 'resume', state: state});
}

// ---- stepping ---------------------------------------------------------------

// One instruction. At the end of a pass the step is the housekeeping and the
// start of the next sample, so the next press lands on the first line again.
function simDebugStep() {
    if (!dbgHalted) return;
    simDebugAdvance();
    dbgStepped = true;
    simDebugRefresh();
}

function simDebugAdvance() {
    if (dbgPc >= dbgCore.PROG_LEN) {
        simDebugNextSample();
        return;
    }
    dbgCore.onInstruction = () => true;
    dbgPc = dbgCore.execute(dbgPc);
    // Past the last line of the source is padding -- NOPs to the end of the
    // image -- and stepping through those one at a time shows nothing. Run
    // them off so the next stop is the end of the sample.
    while (dbgPc < dbgCore.PROG_LEN && !simDebugLineOfPc(dbgPc)) {
        dbgPc = dbgCore.execute(dbgPc);
    }
    dbgCore.onInstruction = null;
}

function simDebugNextSample() {
    dbgCore.endSample();
    if (typeof simGetPots === 'function') dbgCore.setPots(simGetPots());
    dbgCore.beginSample(dbgAdc[0], dbgAdc[1]);
    dbgPc = 0;
}

// The rest of this pass, then stop at the top of the next one.
function simDebugStepSample() {
    if (!dbgHalted) return;
    dbgCore.onInstruction = null;
    if (dbgPc < dbgCore.PROG_LEN) dbgPc = dbgCore.execute(dbgPc);
    simDebugNextSample();
    dbgStepped = true;
    simDebugRefresh();
}

function simDebugRunToLine() {
    if (!dbgHalted) return;
    const input = document.getElementById('simRunToLine');
    const line = input ? +input.value : 0;
    const target = simDebugPcOfLine(line);
    if (target < 0) {
        simDebugStatus('No instruction on line ' + line, 'warn');
        return;
    }
    // At least one instruction, then on until the target is next -- across
    // sample boundaries if need be, up to a budget, since a line inside a
    // SKP block may not come round for a while, or ever.
    let budget = DBG_RUN_BUDGET * dbgCore.PROG_LEN;
    do {
        simDebugAdvance();
    } while (dbgPc !== target && --budget > 0);
    dbgStepped = true;
    simDebugRefresh();
    if (dbgPc !== target) {
        simDebugStatus('Line ' + line + ' was not reached in ' + DBG_RUN_BUDGET +
            ' samples - stopped at ' + simDebugWhere(), 'warn');
    }
}

// ---- the picture ------------------------------------------------------------

function simDebugRefresh() {
    simDebugUpdateButtons();
    simDebugStatus(simDebugReasonText() + ' - ' + simDebugWhere() +
        '. Input held at the halted sample.', 'halted');
    simDebugShowLine();
    const snap = typeof fv1Snapshot === 'function' ? fv1Snapshot(dbgCore) : null;
    if (snap) {
        if (typeof simRegsOnState === 'function') simRegsOnState(snap);
        if (typeof simTraceOnHalted === 'function') simTraceOnHalted(snap, dbgPc);
    }
    if (typeof regsUpdateStatus === 'function') regsUpdateStatus();
}

function simDebugWhere() {
    const sample = dbgCore ? dbgCore.sampleCount.toLocaleString() : '?';
    if (!dbgCore || dbgPc >= dbgCore.PROG_LEN) return 'end of sample ' + sample;
    const line = simDebugLineOfPc(dbgPc);
    return (line ? 'line ' + line : 'pc ' + dbgPc) + ', sample ' + sample;
}

function simDebugReasonText() {
    const r = dbgReason;
    if (!r || r.kind === 'halt') return 'Halted';
    const bp = dbgBreakpoints.find(b => b.id === r.id);
    return 'Breakpoint: ' + (bp ? simDebugLabel(bp) : r.kind);
}

function simDebugShowLine() {
    if (typeof editor === 'undefined' || !editor || typeof monaco === 'undefined') return;
    const line = dbgPc < dbgCore.PROG_LEN ? simDebugLineOfPc(dbgPc) : 0;
    const decs = line ? [{
        range: new monaco.Range(line, 1, line, 1),
        options: {isWholeLine: true, className: 'fv1-debug-line',
                  glyphMarginClassName: 'fv1-debug-arrow',
                  stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges}
    }] : [];
    dbgLineDecorations = editor.deltaDecorations(dbgLineDecorations, decs);
    if (line) editor.revealLineInCenterIfOutsideViewport(line);
}

function simDebugClearLine() {
    if (typeof editor === 'undefined' || !editor || !dbgLineDecorations.length) return;
    dbgLineDecorations = editor.deltaDecorations(dbgLineDecorations, []);
}

function simDebugUpdateButtons() {
    const set = (id, on) => { const el = document.getElementById(id); if (el) el.disabled = !on; };
    set('simStepBtn', dbgHalted);
    set('simStepSampleBtn', dbgHalted);
    set('simRunToBtn', dbgHalted);
    const halt = document.getElementById('simHaltBtn');
    if (halt) {
        halt.textContent = dbgHalted ? 'Resume' : 'Halt';
        halt.classList.toggle('sim-dbg-halted', dbgHalted);
    }
}

function simDebugStatus(msg, kind) {
    const el = document.getElementById('simDebugStatus');
    if (!el) return;
    el.textContent = msg;
    el.className = 'sim-status' + (kind ? ' sim-status-' + kind : '');
}

// ---- lines and addresses ----------------------------------------------------

function simDebugLines() {
    return typeof assembledLines !== 'undefined' && assembledLines ? assembledLines : null;
}

function simDebugLineOfPc(pc) {
    const lines = simDebugLines();
    return lines && pc < lines.length ? lines[pc] : 0;
}

function simDebugPcOfLine(line) {
    const lines = simDebugLines();
    return lines ? lines.indexOf(line) : -1;
}

// ---- breakpoints ------------------------------------------------------------
//
// A breakpoint is kept by line, not by address: the address is looked up from
// the current build each time the list is sent, and a Monaco decoration keeps
// the line itself in step with edits above it. One that lands on a line with
// no instruction stays in the list, greyed, until the build gives it one.

function simDebugAddBreakpoint(spec) {
    const bp = Object.assign({id: dbgNextId++, enabled: true}, spec);
    dbgBreakpoints.push(bp);
    simDebugDecorateBreakpoint(bp);
    simDebugRenderList();
    simDebugPushBreakpoints();
    return bp;
}

function simDebugRemoveBreakpoint(id) {
    const at = dbgBreakpoints.findIndex(b => b.id === id);
    if (at < 0) return;
    const bp = dbgBreakpoints[at];
    dbgBreakpoints.splice(at, 1);
    if (dbgBpDecorations[id] !== undefined && typeof editor !== 'undefined' && editor) {
        editor.deltaDecorations([dbgBpDecorations[id]], []);
    }
    delete dbgBpDecorations[id];
    simDebugRenderList();
    simDebugPushBreakpoints();
}

function simDebugToggleLine(line) {
    const existing = dbgBreakpoints.find(b => b.kind === 'line' && b.line === line);
    if (existing) simDebugRemoveBreakpoint(existing.id);
    else simDebugAddBreakpoint({kind: 'line', line: line, when: 'always'});
}

function simDebugDecorateBreakpoint(bp) {
    if (!bp.line || typeof editor === 'undefined' || !editor || typeof monaco === 'undefined') return;
    const cls = bp.kind === 'line' ? 'fv1-bp-glyph' : 'fv1-bp-glyph fv1-bp-glyph-cond';
    const ids = editor.deltaDecorations([], [{
        range: new monaco.Range(bp.line, 1, bp.line, 1),
        options: {glyphMarginClassName: cls, glyphMarginHoverMessage: {value: simDebugLabel(bp)},
                  stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges}
    }]);
    dbgBpDecorations[bp.id] = ids[0];
}

// Lines move when text is inserted above them; the decorations moved with
// them, so read the lines back before using them.
function simDebugSyncLines() {
    if (typeof editor === 'undefined' || !editor) return;
    const model = editor.getModel();
    if (!model) return;
    let changed = false;
    for (const bp of dbgBreakpoints) {
        const dec = dbgBpDecorations[bp.id];
        if (dec === undefined) continue;
        const range = model.getDecorationRange(dec);
        if (range && range.startLineNumber !== bp.line) {
            bp.line = range.startLineNumber;
            changed = true;
        }
    }
    if (changed) simDebugRenderList();
}

// What the worklet checks: the same list with lines turned into addresses
// and values into S.23. Anything that cannot be resolved is left out.
function simDebugPushBreakpoints() {
    simDebugSyncLines();
    const list = [];
    for (const bp of dbgBreakpoints) {
        if (!bp.enabled) continue;
        const spec = {id: bp.id, kind: bp.kind};
        if (bp.kind === 'line' || bp.kind === 'skip' || (bp.kind === 'clip' && bp.line)) {
            spec.pc = simDebugPcOfLine(bp.line);
            if (spec.pc < 0) continue;
        } else if (bp.kind === 'clip') {
            spec.pc = -1;
        }
        if (bp.kind === 'line') { spec.when = bp.when; spec.sample = bp.sample | 0; }
        if (bp.kind === 'skip') spec.taken = !!bp.taken;
        if (bp.kind === 'acc' || bp.kind === 'reg') {
            spec.op = bp.op;
            spec.value = Math.round(bp.value * DBG_ONE);
            if (bp.kind === 'reg') spec.reg = bp.reg;
        }
        list.push(spec);
    }
    simPost({type: 'breakpoints', list: list});
}

// The build changed: addresses may have moved, and lines that had no
// instruction may have one now.
function simDebugOnLoad() {
    simDebugPushBreakpoints();
    simDebugRenderList();
    simDebugFillRegisters();
}

function simDebugLabel(bp) {
    const fmt = (v) => (v < 0 ? '' : '+') + (+v).toFixed(6);
    switch (bp.kind) {
    case 'line':
        return 'Line ' + bp.line + ', ' + (bp.when === 'first' ? 'first run'
            : bp.when === 'sample' ? 'sample ' + (bp.sample | 0) : 'every sample');
    case 'clip':
        return bp.line ? 'Clip at line ' + bp.line : 'Clip anywhere';
    case 'skip':
        return 'SKP at line ' + bp.line + (bp.taken ? ' taken' : ' not taken');
    case 'acc':
        return 'ACC ' + bp.op + ' ' + fmt(bp.value);
    case 'reg':
        return simDebugRegName(bp.reg) + ' ' + bp.op + ' ' + fmt(bp.value);
    }
    return bp.kind;
}

function simDebugRenderList() {
    const el = document.getElementById('simBpList');
    if (!el) return;
    el.innerHTML = '';
    if (!dbgBreakpoints.length) {
        el.innerHTML = '<div class="sim-bp-empty">None set</div>';
        return;
    }
    for (const bp of dbgBreakpoints) {
        const row = document.createElement('div');
        row.className = 'sim-bp-row';
        const needsLine = bp.kind === 'line' || bp.kind === 'skip' || (bp.kind === 'clip' && bp.line);
        const unresolved = needsLine && simDebugPcOfLine(bp.line) < 0;
        if (unresolved) row.classList.add('sim-bp-unresolved');
        if (!bp.enabled) row.classList.add('sim-bp-off');

        const box = document.createElement('input');
        box.type = 'checkbox';
        box.checked = bp.enabled;
        box.title = 'Enabled';
        box.addEventListener('change', () => {
            bp.enabled = box.checked;
            simDebugRenderList();
            simDebugPushBreakpoints();
        });
        const label = document.createElement('span');
        label.className = 'sim-bp-label';
        label.textContent = simDebugLabel(bp);
        if (unresolved) label.title = 'No instruction on that line in the current build';
        if (bp.line) {
            label.classList.add('sim-bp-link');
            label.addEventListener('click', () => {
                if (typeof editor !== 'undefined' && editor) editor.revealLineInCenter(bp.line);
            });
        }
        const x = document.createElement('button');
        x.className = 'sim-bp-remove';
        x.textContent = '✕';
        x.title = 'Remove';
        x.addEventListener('click', () => simDebugRemoveBreakpoint(bp.id));
        row.append(box, label, x);
        el.appendChild(row);
    }
}

// ---- the add form -----------------------------------------------------------

const DBG_REG_NAMES = {
    0x10: 'POT0', 0x11: 'POT1', 0x12: 'POT2', 0x14: 'ADCL', 0x15: 'ADCR',
    0x16: 'DACL', 0x17: 'DACR', 0x18: 'ADDR_PTR', 0x19: 'POT3', 0x1a: 'POT4', 0x1b: 'POT5'
};

function simDebugRegName(idx) {
    if (idx >= 0x20) return 'REG' + (idx - 0x20);
    return DBG_REG_NAMES[idx] || ('r' + idx);
}

// The register list for a condition: the hardware names, REG0-REG31, and
// the names the program gives them, read the way the viewer reads them.
function simDebugFillRegisters() {
    const sel = document.getElementById('simBpReg');
    if (!sel) return;
    const keep = sel.value;
    let aliases = {};
    try {
        if (typeof regsParseAliases === 'function' && typeof editor !== 'undefined' && editor) {
            aliases = regsParseAliases(editor.getValue());
        }
    } catch (e) { /* no editor yet */ }
    const ext = typeof simIsExtended === 'function' && simIsExtended();
    const order = [0x14, 0x15, 0x16, 0x17, 0x10, 0x11, 0x12];
    if (ext) order.push(0x19, 0x1a, 0x1b);
    order.push(0x18);
    for (let i = 0; i < 32; i++) order.push(0x20 + i);
    sel.innerHTML = '';
    for (const idx of order) {
        const opt = document.createElement('option');
        opt.value = String(idx);
        opt.textContent = simDebugRegName(idx) + (aliases[idx] ? '  ' + aliases[idx].join(', ') : '');
        sel.appendChild(opt);
    }
    if (keep) sel.value = keep;
}

function simDebugBpKindChange() {
    const kind = document.getElementById('simBpKind').value;
    const show = (id, on) => { const el = document.getElementById(id); if (el) el.style.display = on ? '' : 'none'; };
    show('simBpLine', kind === 'line' || kind === 'clip' || kind === 'skip');
    show('simBpWhen', kind === 'line');
    show('simBpSample', kind === 'line' && document.getElementById('simBpWhen').value === 'sample');
    show('simBpTaken', kind === 'skip');
    show('simBpReg', kind === 'reg');
    show('simBpOp', kind === 'acc' || kind === 'reg');
    show('simBpValue', kind === 'acc' || kind === 'reg');
    const line = document.getElementById('simBpLine');
    if (line) line.placeholder = kind === 'clip' ? 'line (any)' : 'line';
}

function simDebugAddFromForm() {
    const v = (id) => { const el = document.getElementById(id); return el ? el.value : ''; };
    const kind = v('simBpKind');
    const line = parseInt(v('simBpLine'), 10) || 0;
    const spec = {kind: kind};
    if (kind === 'line' || kind === 'skip') {
        if (!line) { simDebugStatus('A line number is needed', 'warn'); return; }
        spec.line = line;
    }
    if (kind === 'clip' && line) spec.line = line;
    if (kind === 'line') {
        spec.when = v('simBpWhen');
        spec.sample = parseInt(v('simBpSample'), 10) || 0;
    }
    if (kind === 'skip') spec.taken = v('simBpTaken') === '1';
    if (kind === 'acc' || kind === 'reg') {
        spec.op = v('simBpOp');
        const val = parseFloat(v('simBpValue'));
        if (!isFinite(val)) { simDebugStatus('A value between -1 and +1 is needed', 'warn'); return; }
        spec.value = Math.max(-1, Math.min(0.99999988, val));
        if (kind === 'reg') spec.reg = parseInt(v('simBpReg'), 10);
    }
    simDebugAddBreakpoint(spec);
}

// ---- wiring -----------------------------------------------------------------

document.addEventListener('DOMContentLoaded', () => {
    simDebugUpdateButtons();
    simDebugRenderList();
    simDebugBpKindChange();
    const when = document.getElementById('simBpWhen');
    if (when) when.addEventListener('change', simDebugBpKindChange);

    let tries = 0;
    const attach = setInterval(() => {
        if (typeof editor !== 'undefined' && editor && editor.onMouseDown && typeof monaco !== 'undefined') {
            clearInterval(attach);
            // A click in the glyph margin sets or clears a line breakpoint.
            editor.onMouseDown((e) => {
                if (e.target && e.target.type === monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN &&
                    e.target.position) {
                    simDebugToggleLine(e.target.position.lineNumber);
                }
            });
            let timer = null;
            editor.onDidChangeModelContent(() => {
                clearTimeout(timer);
                timer = setTimeout(() => { simDebugSyncLines(); simDebugFillRegisters(); }, 300);
            });
            simDebugFillRegisters();
        } else if (++tries > 40) {
            clearInterval(attach);
        }
    }, 250);
});
