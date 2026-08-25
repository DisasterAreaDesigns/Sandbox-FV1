// FV-1 Simulator -- Web Audio front end for fv1-emu.js
//
// Builds an AudioWorklet that runs the FV-1 core at the chip's native
// 32768 Hz, feeds it a test tone, an audio file or live input, and lets the
// three pots be swept while it plays.
//
// The worklet is assembled at runtime from FV1Core.toString() and loaded via
// a blob: URL. That is deliberate -- addModule() on a plain script file is
// blocked by CORS when the assembler is opened from a file:// URL, which is
// how a lot of people will run this. Building the module as a blob keeps the
// simulator working both locally and when served over http.

let simCtx = null;
let simNode = null;
let simSource = null;         // current source node
let simInputGain = null;
let simOutputGain = null;
let simDryGain = null;
let simAnalyser = null;
let simStream = null;         // live input MediaStream, so we can stop it
let simFileBuffer = null;
let simFileBytes = null;      // undecoded copy, so a rate change can re-decode
let simFileName = null;
let simRunning = false;
let simBypass = false;
let simMeterTimer = null;
let simLoadedProgram = null;

// The FV-1's sample rate is its crystal frequency, so the selector is really
// a crystal swap: a program's behaviour in samples never changes, but every
// delay and sweep scales in absolute time. 32768 Hz is the stock part.
const SIM_RATE = 32768;
let simRate = SIM_RATE;

// ---- worklet source -------------------------------------------------------

function buildWorkletSource() {
    if (typeof FV1Core === 'undefined') {
        throw new Error('fv1-emu.js not loaded');
    }
    const processor = [
        'class FV1Processor extends AudioWorkletProcessor {',
        '    constructor() {',
        '        super();',
        '        this.core = new FV1Core();',
        '        this.pots = [0.5, 0.5, 0.5];',
        '        this.peakL = 0;',
        '        this.peakR = 0;',
        '        this.frames = 0;',
        '        this.port.onmessage = (e) => {',
        '            const d = e.data;',
        '            if (d.type === "program") {',
        '                this.core.setProgram(new Uint8Array(d.bytes));',
        '                this.port.postMessage({type: "loaded", ok: this.core.hasProgram});',
        '            } else if (d.type === "pots") {',
        '                this.pots = d.values;',
        '            } else if (d.type === "reset") {',
        '                this.core.reset();',
        '            }',
        '        };',
        '    }',
        '    process(inputs, outputs) {',
        '        const input = inputs[0];',
        '        const output = outputs[0];',
        '        const outL = output[0];',
        '        const outR = output.length > 1 ? output[1] : null;',
        '        const hasIn = input && input.length > 0 && input[0].length > 0;',
        '        const inL = hasIn ? input[0] : null;',
        '        const inR = hasIn && input.length > 1 ? input[1] : inL;',
        '        for (let i = 0; i < outL.length; i++) {',
        '            this.core.setPots(this.pots[0], this.pots[1], this.pots[2]);',
        '            this.core.run(inL ? inL[i] : 0, inR ? inR[i] : 0);',
        '            const l = this.core.getDACL();',
        '            const r = this.core.getDACR();',
        '            outL[i] = l;',
        '            if (outR) outR[i] = r;',
        '            const al = Math.abs(l);',
        '            const ar = Math.abs(r);',
        '            if (al > this.peakL) this.peakL = al;',
        '            if (ar > this.peakR) this.peakR = ar;',
        '        }',
        '        this.frames += outL.length;',
        '        if (this.frames >= 2048) {',
        '            this.port.postMessage({type: "level", peak: [this.peakL, this.peakR]});',
        '            this.peakL = 0;',
        '            this.peakR = 0;',
        '            this.frames = 0;',
        '        }',
        '        return true;',
        '    }',
        '}',
        'registerProcessor("fv1-processor", FV1Processor);'
    ].join('\n');

    return FV1Core.toString() + '\n' + processor;
}

// ---- engine ---------------------------------------------------------------

// Build the whole audio graph, publishing to the module-level handles only
// once every piece succeeded. Partial construction used to leave simCtx set
// with null gain nodes, so a second Play press skipped setup entirely and
// failed deep inside connect() with an unhelpful message.
async function simInitEngine() {
    const ctx = new (window.AudioContext || window.webkitAudioContext)({
        sampleRate: simRate
    });

    let node;
    try {
        const src = buildWorkletSource();
        const url = URL.createObjectURL(new Blob([src], {type: 'application/javascript'}));
        try {
            await ctx.audioWorklet.addModule(url);
        } finally {
            URL.revokeObjectURL(url);
        }
        node = new AudioWorkletNode(ctx, 'fv1-processor', {
            numberOfInputs: 1,
            numberOfOutputs: 1,
            outputChannelCount: [2]
        });
    } catch (err) {
        try { await ctx.close(); } catch (e) { /* already closing */ }
        if (location.protocol === 'file:') {
            throw new Error('the audio engine will not load from a file:// page. ' +
                'Serve the Assembler folder over http instead - see the readme.');
        }
        throw err;
    }

    node.port.onmessage = (e) => {
        if (e.data.type === 'level') simUpdateMeters(e.data.peak);
    };

    const inputGain = ctx.createGain();
    const outputGain = ctx.createGain();
    const dryGain = ctx.createGain();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;

    inputGain.connect(node);
    node.connect(outputGain);
    dryGain.connect(outputGain);
    outputGain.connect(analyser);
    analyser.connect(ctx.destination);
    dryGain.gain.value = 0;

    simCtx = ctx;
    simNode = node;
    simInputGain = inputGain;
    simOutputGain = outputGain;
    simDryGain = dryGain;
    simAnalyser = analyser;
    simApplyLevels();
}

// Drop the engine so the next Play press starts from scratch.
function simTeardownEngine() {
    simDisconnectSource();
    if (simCtx) {
        try { simCtx.close(); } catch (e) { /* already closed */ }
    }
    simCtx = null;
    simNode = null;
    simInputGain = null;
    simOutputGain = null;
    simDryGain = null;
    simAnalyser = null;
}

async function simStart() {
    if (simRunning) return;
    try {
        // Gate on the node, not the context: a half-built engine must rebuild.
        if (!simNode) await simInitEngine();

        await simCtx.resume();

        // Always push the program to the worklet here. simLoadedProgram may
        // have been captured by the assemble hook before the engine existed,
        // in which case the worklet itself still has nothing loaded. Nothing to
        // load is a dead end -- simReportRate below would otherwise paint over
        // the warning with a cheerful 'Running at'.
        if (!simLoadProgram()) {
            simStop();
            return;
        }

        await simConnectSource();
        simRunning = true;
        simUpdateTransport();
        simReportRate();
    } catch (err) {
        simTeardownEngine();
        simRunning = false;
        simUpdateTransport();
        simStatus('Could not start: ' + err.message, 'error');
        console.error('[fv1-sim]', err);
    }
}

function simStop() {
    if (!simRunning) return;
    simDisconnectSource();
    if (simCtx) simCtx.suspend();
    simRunning = false;
    simUpdateTransport();
    simUpdateMeters([0, 0]);
    simStatus('Stopped', '');
}

// Ctrl+P (Alt+P off the Mac) reaches this from anywhere in the app, including
// with the editor focused. Starting from the keyboard also opens the panel:
// every bit of feedback the simulator gives -- the meter, the status line,
// whether Play even took -- lives in there, so audio starting behind a closed
// panel would be a sound with no visible cause. Stopping leaves the panel as
// it found it.
function simShortcutTogglePlay() {
    const starting = !simRunning;
    simTogglePlay();
    if (starting && typeof openFlyout === 'function') openFlyout('sim');
}

function simPanic() {
    simStop();
    if (simNode) simNode.port.postMessage({type: 'reset'});
    simStatus('Core reset - delay memory cleared', '');
}

// ---- program loading ------------------------------------------------------

// Pull the current build out of the assembler and hand it to the worklet.
// Safe to call before the engine exists: the bytes are cached and pushed
// again once the worklet is up.
function simLoadProgram() {
    if (typeof assembledData !== 'undefined' && assembledData) {
        simLoadedProgram = new Uint8Array(assembledData);
    }
    if (!simLoadedProgram) {
        simStatus('Nothing assembled yet - press Assemble first', 'warn');
        simSetProgramState('Not loaded', '');
        return false;
    }
    if (simNode) {
        simNode.port.postMessage({
            type: 'program',
            bytes: simLoadedProgram.buffer.slice(0)
        });
    }
    simSetProgramState(simNode
        ? 'Loaded (' + simLoadedProgram.length + ' bytes)'
        : 'Ready (' + simLoadedProgram.length + ' bytes) - press Play', 'loaded');
    return true;
}

function simSetProgramState(text, cls) {
    const el = document.getElementById('simProgramState');
    if (el) {
        el.textContent = text;
        el.className = 'sim-program-state' + (cls ? ' ' + cls : '');
    }
}

// ---- sources --------------------------------------------------------------

// The click train. One second between clicks, and the click itself is a short
// 2 kHz burst rather than a bare one-sample impulse. An impulse puts most of
// its energy above where a laptop speaker can reproduce it, so it barely
// registers, and its DC content walks the state of anything with a feedback
// path. A 2 kHz burst is audible, sits below Nyquist even at the 8.192 kHz
// crystal, and at 3 ms is still brief enough to read as an impulse against the
// delay times these programs work in.
const SIM_CLICK_PERIOD = 1.0;      // seconds between clicks
const SIM_CLICK_FREQ = 2000;       // Hz
const SIM_CLICK_CYCLES = 6;        // whole cycles per burst -- 3 ms at 2 kHz

// A whole number of cycles, so the window closes on a zero crossing.
function simClickLength(sampleRate) {
    return Math.round(SIM_CLICK_CYCLES * sampleRate / SIM_CLICK_FREQ);
}

// Write one click into the head of `data` and leave the rest silent. Pure, so
// the headless tests can check the shape without a Web Audio context.
function simFillClick(data, sampleRate) {
    const n = simClickLength(sampleRate);
    const len = Math.min(data.length, n);
    const w = 2 * Math.PI * SIM_CLICK_FREQ / sampleRate;
    for (let i = 0; i < len; i++) {
        // A Hann window over whole cycles both starts and ends at zero, so the
        // loop point never puts a step in the signal, and it leaves the burst
        // symmetric enough that the positive and negative half-cycles cancel
        // instead of handing the program a DC offset to integrate.
        const win = 0.5 * (1 - Math.cos(2 * Math.PI * i / n));
        data[i] = Math.sin(w * i) * win;
    }
    for (let i = len; i < data.length; i++) data[i] = 0;
    return data;
}

function simSourceType() {
    const el = document.getElementById('simSource');
    return el ? el.value : 'tone';
}

async function simConnectSource() {
    simDisconnectSource();
    if (!simCtx || !simInputGain || !simDryGain) return;
    const type = simSourceType();

    if (type === 'tone' || type === 'saw' || type === 'square') {
        const osc = simCtx.createOscillator();
        osc.type = type === 'tone' ? 'sine' : (type === 'saw' ? 'sawtooth' : 'square');
        osc.frequency.value = simNumber('simToneFreq', 440);
        osc.start();
        simSource = osc;
    } else if (type === 'click') {
        // A one-second buffer with a single click at the top of it, looped, so
        // the clicks land exactly a second apart however the crystal is set.
        // That makes it a stopwatch you can hear: a delay's repeats and a
        // reverb tail can both be read straight off the gap between clicks
        // without measuring anything.
        const buf = simCtx.createBuffer(1, Math.round(simCtx.sampleRate * SIM_CLICK_PERIOD),
            simCtx.sampleRate);
        simFillClick(buf.getChannelData(0), simCtx.sampleRate);
        const node = simCtx.createBufferSource();
        node.buffer = buf;
        node.loop = true;
        node.start();
        simSource = node;
    } else if (type === 'noise') {
        const len = Math.floor(simCtx.sampleRate * 2);
        const buf = simCtx.createBuffer(1, len, simCtx.sampleRate);
        const data = buf.getChannelData(0);
        for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
        const node = simCtx.createBufferSource();
        node.buffer = buf;
        node.loop = true;
        node.start();
        simSource = node;
    } else if (type === 'file') {
        if (!simFileBuffer) {
            simStatus('Choose an audio file first', 'warn');
            return;
        }
        const node = simCtx.createBufferSource();
        node.buffer = simFileBuffer;
        node.loop = true;
        node.start();
        simSource = node;
    } else if (type === 'input') {
        try {
            simStream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    echoCancellation: false,
                    noiseSuppression: false,
                    autoGainControl: false
                }
            });
            simSource = simCtx.createMediaStreamSource(simStream);
        } catch (err) {
            simStatus('Microphone access denied or unavailable', 'error');
            return;
        }
    }

    if (simSource) {
        simSource.connect(simInputGain);
        simSource.connect(simDryGain);
    }
}

function simDisconnectSource() {
    if (simSource) {
        try { simSource.stop(); } catch (e) { /* live input has no stop() */ }
        try { simSource.disconnect(); } catch (e) { /* already gone */ }
        simSource = null;
    }
    if (simStream) {
        simStream.getTracks().forEach(t => t.stop());
        simStream = null;
    }
}

// Decode against a context running at the rate we intend to play at, so the
// browser does the resampling once, at decode time. A throwaway offline
// context is used when the engine is not up, so a failed decode never leaves
// a half-built engine behind in simCtx.
async function simDecodeFile(bytes) {
    const decodeCtx = simCtx || new (window.OfflineAudioContext ||
        window.webkitOfflineAudioContext)(1, 1, simRate);
    return decodeCtx.decodeAudioData(bytes.slice(0));
}

async function simRedecodeFile() {
    if (!simFileBytes) return;
    try {
        simFileBuffer = await simDecodeFile(simFileBytes);
    } catch (err) {
        simStatus('Could not re-decode ' + (simFileName || 'the audio file') +
            ' at the new rate: ' + err.message, 'error');
    }
}

async function simLoadAudioFile(fileInput) {
    const file = fileInput.files && fileInput.files[0];
    if (!file) return;
    try {
        const bytes = await file.arrayBuffer();
        // Keep the undecoded bytes: decodeAudioData resamples to the context
        // rate and detaches the buffer it is given, so a later crystal change
        // has to start from the original file rather than resample twice.
        simFileBytes = bytes;
        simFileBuffer = await simDecodeFile(bytes);
        simFileName = file.name;
        // The file input already shows the name, so this only adds what it
        // cannot: how long the file turned out to be once decoded.
        const label = document.getElementById('simFileLabel');
        if (label) label.textContent = simFileBuffer.duration.toFixed(1) + ' s';
        const sel = document.getElementById('simSource');
        if (sel) sel.value = 'file';
        simOnSourceChange();
        simStatus('Loaded ' + file.name, 'ok');
    } catch (err) {
        simStatus('Could not decode that file: ' + err.message, 'error');
    }
}

async function simOnSourceChange() {
    const type = simSourceType();
    const toneRow = document.getElementById('simToneRow');
    const fileRow = document.getElementById('simFileRow');
    if (toneRow) toneRow.style.display =
        (type === 'tone' || type === 'saw' || type === 'square') ? '' : 'none';
    if (fileRow) fileRow.style.display = (type === 'file') ? '' : 'none';
    if (simRunning) await simConnectSource();
}

function simOnToneFreqChange() {
    const f = simNumber('simToneFreq', 440);
    const out = document.getElementById('simToneFreqValue');
    if (out) out.textContent = f + ' Hz';
    if (simSource && simSource.frequency) {
        simSource.frequency.setTargetAtTime(f, simCtx.currentTime, 0.01);
    }
}

// ---- clock ----------------------------------------------------------------

// AudioContext.sampleRate is fixed at construction, so changing the crystal
// means tearing the engine down and rebuilding it. That clears delay memory,
// exactly as pulling the chip's power would.
async function simOnRateChange() {
    const sel = document.getElementById('simRate');
    const rate = sel ? parseFloat(sel.value) : SIM_RATE;
    if (!isFinite(rate) || rate === simRate) return;
    simRate = rate;
    simUpdateRateInfo();

    const wasRunning = simRunning;
    if (simRunning) simStop();
    if (simNode) simTeardownEngine();
    await simRedecodeFile();

    if (wasRunning) {
        await simStart();
    } else {
        simStatus('Clock set to ' + simRateLabel(), '');
    }
}

// The browser is free to refuse the rate we asked for, and some do. The core
// is clocked by the context, so a refusal silently rescales every delay and
// sweep -- report the rate actually in use rather than let it pass as
// correct. This is the only place the running rate is announced, so the
// warning cannot be overwritten by a later 'Running at' message.
function simReportRate() {
    const actual = simCtx ? simCtx.sampleRate : simRate;
    if (Math.abs(actual - simRate) > 1) {
        simStatus('Browser gave ' + Math.round(actual) + ' Hz, not ' +
            Math.round(simRate) + ' Hz - delay and LFO times are off by ' +
            (actual / simRate).toFixed(2) + 'x', 'warn');
    } else {
        simStatus('Running at ' + Math.round(actual) + ' Hz', 'ok');
    }
}

function simRateLabel() {
    return (simRate / 1000).toFixed(3).replace(/\.?0+$/, '') + ' kHz';
}

// The delay RAM is a fixed 32768 words, so its length in seconds -- and the
// bandwidth -- both follow the crystal.
function simUpdateRateInfo() {
    const el = document.getElementById('simRateInfo');
    if (!el) return;
    el.textContent = 'Max delay ' + (32768 / simRate).toFixed(2) + ' s, ' +
        'Nyquist ' + (simRate / 2000).toFixed(1) + ' kHz';
}

// ---- controls -------------------------------------------------------------

function simNumber(id, fallback) {
    const el = document.getElementById(id);
    if (!el) return fallback;
    const v = parseFloat(el.value);
    return isNaN(v) ? fallback : v;
}

// The pot values the core is actually running, not what the sliders say. The
// sliders are whole percent, so a MIDI CC -- 128 steps -- cannot be stored in
// one without losing resolution. Keep the real value here and let the slider
// be the coarse display of it.
let simPots = [0.5, 0.5, 0.5];

// Set one pot from any source. `opts.from` names the control that moved, so a
// slider is not fought for the thumb while it is the thing being dragged.
// `opts.defer` sends the value to the core but leaves the display for the
// caller to refresh, which is how MIDI keeps audio responding at full rate
// while its redraws are batched.
function simSetPot(i, v01, opts) {
    if (i < 0 || i > 2) return;
    const v = Math.max(0, Math.min(1, v01));
    if (simPots[i] === v) return;
    simPots[i] = v;

    simPushPots();
    if (!opts || !opts.defer) simRefreshPotDisplay(i, opts && opts.from);
}

function simRefreshPotDisplay(i, from) {
    if (from !== 'slider') {
        const slider = document.getElementById('simPot' + i);
        if (slider) slider.value = String(Math.round(simPots[i] * 100));
    }
    const out = document.getElementById('simPot' + i + 'Value');
    if (out) out.textContent = Math.round(simPots[i] * 100) + '%';
}

function simPushPots() {
    if (simNode) simNode.port.postMessage({type: 'pots', values: simPots.slice()});
}

// Slider handler: read all three back out of the DOM, which also covers the
// initial call at startup. The display is refreshed either way, since the
// percentage beside an untouched slider still has to be drawn once.
function simSendPots() {
    for (let i = 0; i < 3; i++) {
        simSetPot(i, simNumber('simPot' + i, 50) / 100, {from: 'slider', defer: true});
        simRefreshPotDisplay(i, 'slider');
    }
}

// Read-only view of what the core is running, for tests and for MIDI to
// compare against before it decides a message changed anything.
window.simGetPots = () => simPots.slice();

function simApplyLevels() {
    if (!simCtx) return;
    const inDb = simNumber('simInputLevel', 0);
    const outDb = simNumber('simOutputLevel', 0);
    const inLabel = document.getElementById('simInputLevelValue');
    const outLabel = document.getElementById('simOutputLevelValue');
    if (inLabel) inLabel.textContent = inDb.toFixed(0) + ' dB';
    if (outLabel) outLabel.textContent = outDb.toFixed(0) + ' dB';

    const inGain = Math.pow(10, inDb / 20);
    const outGain = Math.pow(10, outDb / 20);
    simRampGain(simInputGain, simBypass ? 0 : inGain);
    simRampGain(simDryGain, simBypass ? inGain : 0);
    simRampGain(simOutputGain, outGain);
}

// Slew a gain rather than stepping it. Bypass switches the wet and dry paths
// against each other, and under MIDI control that happens often enough that a
// hard switch would click on every press.
function simRampGain(node, value) {
    if (!node) return;
    if (!simCtx || typeof node.gain.setTargetAtTime !== 'function') {
        node.gain.value = value;
        return;
    }
    node.gain.setTargetAtTime(value, simCtx.currentTime, 0.005);
}

function simToggleBypass() {
    const el = document.getElementById('simBypass');
    simBypass = el ? el.checked : false;
    simApplyLevels();
    if (simBypass) simStatus('Bypassed - hearing dry signal', 'warn');
    else simReportRate();
}

// ---- control naming -------------------------------------------------------
//
// A program can name the simulator's pots with a magic comment:
//
//     ; #POT0 Delay time
//     ; #POT1 Feedback
//
// The tag is read from the comment portion of a line, so it can never collide
// with code, and the assembler ignores it because it is inside a comment. A pot
// with no tag keeps its hardware name.

function simParseControlNames(src) {
    const names = {pot: new Array(3).fill(null)};
    if (!src) return names;

    for (const line of src.split(/\r?\n/)) {
        // Take the text after the first comment marker on the line. A line with
        // no marker is scanned whole, which picks up tags sitting inside a
        // /* */ block.
        const semi = line.indexOf(';');
        const dbl = line.indexOf('//');
        let cut = -1;
        if (semi >= 0 && (dbl < 0 || semi < dbl)) cut = semi + 1;
        else if (dbl >= 0) cut = dbl + 2;
        const text = cut >= 0 ? line.slice(cut) : line;

        const m = /#(POT[0-2])\b[ \t]*(.*)$/i.exec(text);
        if (!m) continue;

        // Stop the name at a further comment marker or a block-comment close,
        // so `/* #POT0 Mix */` names the pot "Mix" rather than "Mix */".
        const name = m[2].replace(/(;|\/\/|\*\/).*$/, '').trim();
        if (!name) continue;
        names.pot[+m[1].slice(3)] = name;
    }
    return names;
}

function simSetControlLabel(id, name, fallback) {
    const el = document.getElementById(id + 'Label');
    if (!el) return;
    el.textContent = name || fallback;
    el.classList.toggle('sim-renamed', !!name);
    // Keep the hardware name reachable once a program has renamed a pot, so it
    // is still obvious which one is being driven.
    const host = el.closest ? el.closest('.sim-slider-row') : null;
    if (host) host.title = name ? name + '  \u2014  ' + fallback : fallback;
}

// Re-read the names from the editor. Cheap, so it can run on every edit.
function simRefreshControlNames() {
    let src = '';
    try {
        if (typeof editor !== 'undefined' && editor && editor.getValue) src = editor.getValue();
    } catch (e) { /* editor not up yet */ }
    const names = simParseControlNames(src);
    for (let i = 0; i < 3; i++) simSetControlLabel('simPot' + i, names.pot[i], 'POT' + i);
}

// ---- display --------------------------------------------------------------

function simStatus(msg, kind) {
    const el = document.getElementById('simStatus');
    if (!el) return;
    el.textContent = msg;
    el.className = 'sim-status' + (kind ? ' sim-status-' + kind : '');
}

function simUpdateTransport() {
    const btn = document.getElementById('simPlayBtn');
    if (btn) {
        btn.textContent = simRunning ? 'Stop' : 'Play';
        btn.classList.toggle('sim-playing', simRunning);
    }
}

function simUpdateMeters(peak) {
    for (let i = 0; i < 2; i++) {
        const bar = document.getElementById('simMeter' + i);
        if (!bar) continue;
        const p = peak && peak[i] ? peak[i] : 0;
        bar.style.width = Math.min(100, p * 100).toFixed(1) + '%';
        bar.classList.toggle('sim-meter-clip', p >= 0.999);
    }
}

// ---- wiring ---------------------------------------------------------------

function simTogglePlay() {
    if (simRunning) simStop(); else simStart();
}

// Reload the simulator whenever a new build succeeds, so the loop is
// edit -> assemble -> hear it, with no extra click.
function simHookAssemble() {
    if (typeof window.assemble !== 'function') return;
    if (window.assemble.__simHooked) return;
    const original = window.assemble;
    const wrapped = function () {
        const result = original.apply(this, arguments);
        simRefreshControlNames();
        if (typeof assembledData !== 'undefined' && assembledData) {
            simLoadProgram();
            const auto = document.getElementById('simAutoReload');
            if (simRunning && simNode && auto && auto.checked) {
                simNode.port.postMessage({type: 'reset'});
            }
        }
        return result;
    };
    wrapped.__simHooked = true;
    window.assemble = wrapped;
}

document.addEventListener('DOMContentLoaded', () => {
    simHookAssemble();
    simRefreshControlNames();
    simSendPots();
    simOnSourceChange();
    simOnToneFreqChange();
    simUpdateRateInfo();
    if (typeof AudioWorkletNode === 'undefined') {
        simStatus('This browser has no AudioWorklet support - simulator unavailable', 'error');
        const btn = document.getElementById('simPlayBtn');
        if (btn) btn.disabled = true;
    } else if (location.protocol === 'file:') {
        simStatus('Opened as a local file - if Play fails, serve this folder ' +
            'over http (see readme)', 'warn');
    }

    // Follow the names as they are typed rather than waiting for an assemble.
    // Monaco may not be up yet, so poll briefly for it.
    let tries = 0;
    const attach = setInterval(() => {
        if (typeof editor !== 'undefined' && editor && editor.onDidChangeModelContent) {
            clearInterval(attach);
            let timer = null;
            editor.onDidChangeModelContent(() => {
                clearTimeout(timer);
                timer = setTimeout(simRefreshControlNames, 300);
            });
            simRefreshControlNames();
        } else if (++tries > 40) {
            clearInterval(attach);
        }
    }, 250);
});
