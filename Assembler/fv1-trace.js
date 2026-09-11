// FV-1 ACC trace -- the accumulator after every line, shown in the editor.
//
// The FV-1 runs all of its instructions every sample, so one sample's pass is
// a complete trace of the program, and there is no stepping to do to see it:
// the core records ACC after each instruction and the value is written at the
// end of the line that produced it, live, while the program plays. A SKP line
// says whether it was taken, a line the skip jumped over says so, and a line
// whose result had to be clamped is marked with how often that happened.
//
// The readout belongs to the build the core is running. Once the source is
// edited past that build the lines no longer match the addresses, so the
// trace is taken down until the next assemble rather than left drifting.

let traceOn = false;
let traceDecorations = [];
let traceLines = null;        // address -> line, for the build the core runs
let traceVersion = null;      // editor version the build was made from
let traceLastPaint = 0;
let tracePending = null;      // a snapshot held back by the paint throttle
let tracePendingTimer = null;
let traceStaleShown = false;
let traceLastClip = null;     // the previous snapshot's counts, for the rate
let traceLastSamples = 0;

const TRACE_PAINT_MS = 80;    // the eye cannot read numbers faster

function simTraceToggle(on) {
    traceOn = !!on;
    if (typeof simSetWatch === 'function') simSetWatch({trace: traceOn});
    if (!traceOn) simTraceClear();
    simTraceNote();
}

function simTraceClear() {
    if (typeof editor === 'undefined' || !editor || !traceDecorations.length) return;
    traceDecorations = editor.deltaDecorations(traceDecorations, []);
}

// Called from the assemble hook with the line map of the build just loaded.
function simTraceOnLoad(lines) {
    traceLines = lines ? lines.slice() : null;
    traceVersion = null;
    try {
        if (typeof editor !== 'undefined' && editor && editor.getModel()) {
            traceVersion = editor.getModel().getAlternativeVersionId();
        }
    } catch (e) { /* no editor yet */ }
    traceStaleShown = false;
    simTraceClear();
    simTraceNote();
}

function simTraceIsStale() {
    if (!traceLines || traceVersion === null) return true;
    try {
        return editor.getModel().getAlternativeVersionId() !== traceVersion;
    } catch (e) {
        return true;
    }
}

function simTraceOnState(s) {
    if (!traceOn || !s.trace) return;
    if (typeof editor === 'undefined' || !editor || typeof monaco === 'undefined') return;
    if (simTraceIsStale()) {
        if (!traceStaleShown) {
            simTraceClear();
            traceStaleShown = true;
            simTraceNote();
        }
        return;
    }
    // Throttled by deferring, not dropping: the snapshot posted on a reset or
    // a program load is a single message, and if it fell inside the window it
    // would never be drawn -- the engine is stopped and nothing follows it.
    const now = performance.now();
    if (now - traceLastPaint < TRACE_PAINT_MS) {
        tracePending = s;
        if (!tracePendingTimer) {
            tracePendingTimer = setTimeout(() => {
                tracePendingTimer = null;
                const p = tracePending;
                tracePending = null;
                if (p) simTraceOnState(p);
            }, TRACE_PAINT_MS - (now - traceLastPaint));
        }
        return;
    }
    tracePending = null;
    traceLastPaint = now;

    const model = editor.getModel();
    const t = s.trace;
    const decs = [];
    // Straight after a reset or a load nothing has run, and a trace of that
    // would call every line skipped. Show nothing until the first pass.
    if (t.samples === 0) {
        simTraceClear();
        traceLastClip = null;
        return;
    }
    for (let pc = 0; pc < t.len && pc < traceLines.length; pc++) {
        const line = traceLines[pc];
        if (!line || line > model.getLineCount()) continue;
        let text, cls;
        if (!t.ran[pc]) {
            text = '⇒ skipped';
            cls = 'fv1-trace fv1-trace-skip';
        } else {
            text = '⇒ ' + simTraceFloat(t.acc[pc]);
            cls = 'fv1-trace';
            if (t.skip[pc]) {
                text += '  taken';
                cls += ' fv1-trace-taken';
            }
            const clipText = simTraceClipText(t, pc);
            if (clipText) {
                text += '  ⚠ ' + clipText;
                cls += ' fv1-trace-clip';
            }
        }
        const col = model.getLineMaxColumn(line);
        decs.push({
            range: new monaco.Range(line, col, line, col),
            options: {
                after: {content: '  ' + text, inlineClassName: cls, cursorStops: 'none'},
                // The range is empty -- the text hangs off the end of the line
                // -- and Monaco drops injected text on an empty range unless
                // told to keep it.
                showIfCollapsed: true,
                stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges
            }
        });
    }
    traceDecorations = editor.deltaDecorations(traceDecorations, decs);
    traceLastClip = t.clip;
    traceLastSamples = t.samples;
}

// The counts arrive cumulative, so each snapshot is compared with the one
// before it: the share of samples since then on which the line clipped. A
// sample count going backwards means the core was reset, and the comparison
// starts afresh.
function simTraceClipText(t, pc) {
    const reset = !traceLastClip || traceLastClip.length !== t.clip.length ||
        t.samples < traceLastSamples;
    const dClip = t.clip[pc] - (reset ? 0 : traceLastClip[pc]);
    const dSamples = t.samples - (reset ? 0 : traceLastSamples);
    if (dClip <= 0 || dSamples <= 0) return '';
    const pct = Math.min(100, Math.round(100 * dClip / dSamples));
    return 'clip ' + (pct === 0 ? '<1' : pct) + '%';
}

function simTraceFloat(v) {
    const f = v / 0x800000;
    return (f < 0 ? '' : '+') + f.toFixed(6);
}

function simTraceNote() {
    const el = document.getElementById('simTraceNote');
    if (!el) return;
    if (!traceOn) {
        el.textContent = 'Off. When on, each line in the editor shows the ' +
            'accumulator after it ran, whether a SKP was taken, and how often ' +
            'the result clipped.';
    } else if (!traceLines) {
        el.textContent = 'Waiting for a build - press Assemble.';
    } else if (simTraceIsStale()) {
        el.textContent = 'Source changed since the last build - the trace is ' +
            'hidden until you assemble again.';
    } else {
        el.textContent = 'Showing the accumulator after each line, while the ' +
            'program plays.';
    }
}

document.addEventListener('DOMContentLoaded', () => {
    const box = document.getElementById('simTrace');
    if (box) box.addEventListener('change', () => simTraceToggle(box.checked));
    simTraceNote();
    // Watch for the source moving past the build, so the note changes as soon
    // as the trace comes down rather than on the next snapshot.
    let tries = 0;
    const attach = setInterval(() => {
        if (typeof editor !== 'undefined' && editor && editor.onDidChangeModelContent) {
            clearInterval(attach);
            editor.onDidChangeModelContent(() => {
                if (traceOn && !traceStaleShown && simTraceIsStale()) {
                    simTraceClear();
                    traceStaleShown = true;
                    simTraceNote();
                }
            });
        } else if (++tries > 40) {
            clearInterval(attach);
        }
    }, 250);
});
