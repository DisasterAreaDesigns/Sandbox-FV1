// FV-1 Simulator -- MIDI control
//
// Drives the simulator's on-screen controls from a MIDI controller attached to
// this computer, using the Web MIDI API. Nothing here touches the audio graph
// or the DSP core: a CC moves the same pot state a slider moves, so a program
// cannot tell the difference between a fader and a mouse.
//
// The map is fixed, matching the Disaster Area control-change assignments:
//
//     CC50 -> POT0    CC51 -> POT1    CC52 -> POT2
//     CC53 -> POT3    CC54 -> POT4    CC55 -> POT5
//     CC102 -> bypass, 0-63 bypassed, 64-127 engaged
//
// POT3-POT5 exist only under #extended and have no sliders until a program
// declares it. Their CCs are always mapped anyway: the pot values are live
// either way, and a controller that has to be re-learned depending on which
// program is loaded is worse than one that always sends to the same place.
//
// The pedal itself has no MIDI input. This is the simulator only.

const MIDI_MAP = {
    50: 'pot0',
    51: 'pot1',
    52: 'pot2',
    53: 'pot3',
    54: 'pot4',
    55: 'pot5',
    102: 'bypass'
};

const MIDI_PREFS_KEY = 'fv1_sim_midi';

let midiAccess = null;
let midiInputs = [];           // MIDIInput objects, in menu order
let midiDeviceName = 'all';    // remembered by name -- ids are not stable
let midiChannel = 0;           // 0 = omni, else 1-16

// A fader sweep can arrive at roughly a message per millisecond, and each
// message would otherwise cost three DOM writes. Values reach the core
// immediately -- audio must not wait on the compositor, and a hidden tab stops
// painting entirely while its audio keeps running -- but the redraws are
// batched to one frame. A backgrounded tab therefore still responds to the
// controller, and catches its display up when it is looked at again.
let midiDirty = [false, false, false, false, false, false];
let midiPendingText = null;
let midiFrame = 0;
let midiFlashTimer = null;

// ---- support and connection ----------------------------------------------

function midiSupported() {
    return typeof navigator !== 'undefined' &&
        typeof navigator.requestMIDIAccess === 'function';
}

async function midiConnect() {
    if (!midiSupported()) {
        midiStatus('No Web MIDI - use Chrome, Edge or Firefox', 'error');
        return;
    }
    if (midiAccess) {
        midiRefreshDevices();
        return;
    }

    midiStatus('Requesting MIDI access...', '');
    try {
        // sysex is not needed for control changes, and asking for it turns a
        // silent grant into a scarier permission prompt.
        midiAccess = await navigator.requestMIDIAccess({sysex: false});
    } catch (e) {
        midiAccess = null;
        midiStatus('MIDI access denied - allow it and retry', 'error');
        midiSetConnected(false);
        return;
    }

    midiAccess.onstatechange = () => midiRefreshDevices();
    midiSetConnected(true);
    midiRefreshDevices();
}

// Rebuild the device menu and re-attach the handler. Runs on connect and on
// every plug or unplug, so a controller powered on after the page loaded still
// lands on the remembered selection.
function midiRefreshDevices() {
    if (!midiAccess) return;

    midiInputs = [];
    midiAccess.inputs.forEach((input) => midiInputs.push(input));

    const sel = document.getElementById('midiDevice');
    if (sel) {
        const previous = midiDeviceName;
        sel.innerHTML = '';

        const all = document.createElement('option');
        all.value = 'all';
        all.textContent = 'All inputs';
        sel.appendChild(all);

        for (const input of midiInputs) {
            const opt = document.createElement('option');
            opt.value = input.name || input.id;
            opt.textContent = input.name || input.id;
            sel.appendChild(opt);
        }

        // Keep the remembered device selected even while it is unplugged, so
        // it reattaches by itself when it comes back.
        if (previous !== 'all' && !midiInputs.some(i => (i.name || i.id) === previous)) {
            const ghost = document.createElement('option');
            ghost.value = previous;
            ghost.textContent = previous + ' (not connected)';
            sel.appendChild(ghost);
        }
        sel.value = previous;
    }

    midiAttach();

    if (!midiInputs.length) {
        midiStatus('No inputs found - connect a controller', 'warn');
    } else if (midiDeviceName === 'all') {
        midiStatus('Listening to ' + midiInputs.length +
            (midiInputs.length === 1 ? ' input' : ' inputs'), 'ok');
    } else if (midiInputs.some(i => (i.name || i.id) === midiDeviceName)) {
        midiStatus('Listening to ' + midiDeviceName, 'ok');
    } else {
        midiStatus(midiDeviceName + ' is not connected', 'warn');
    }
}

// Listen on the chosen input, or on all of them. Handlers are cleared first so
// a device dropped from the selection stops being heard.
function midiAttach() {
    for (const input of midiInputs) {
        const name = input.name || input.id;
        const wanted = midiDeviceName === 'all' || name === midiDeviceName;
        input.onmidimessage = wanted ? (e) => midiHandleMessage(e.data) : null;
    }
}

// ---- message handling -----------------------------------------------------

// Act on one raw MIDI message. Exposed on window so it can be driven from a
// test without a controller attached.
function midiHandleMessage(data) {
    if (!data || data.length < 3) return;

    const status = data[0];
    if (status < 0x80) return;          // running status: not delivered by Web MIDI
    if (status >= 0xF0) return;         // clock, active sensing, sysex
    if ((status & 0xF0) !== 0xB0) return;

    const channel = (status & 0x0F) + 1;
    if (midiChannel !== 0 && channel !== midiChannel) return;

    const cc = data[1];
    const value = data[2];
    const target = MIDI_MAP[cc];
    if (!target) return;

    if (target === 'bypass') {
        midiApplyBypass(value);
        midiNote('CC' + cc + ' \u2192 bypass \u00b7 ' + value);
        return;
    }

    const pot = +target.slice(3);
    if (typeof simSetPot === 'function') {
        simSetPot(pot, value / 127, {from: 'midi', defer: true});
    }
    midiDirty[pot] = true;
    midiNote('CC' + cc + ' \u2192 POT' + pot + ' \u00b7 ' +
        Math.round(value / 127 * 100) + '%');
    midiSchedule();
}

// CC102 carries the engage state, not the bypass state: 0-63 is bypassed and
// 64-127 is engaged, so the checkbox -- which asks the opposite question -- is
// the inverse of the high half.
function midiApplyBypass(value) {
    const el = document.getElementById('simBypass');
    if (!el) return;

    const bypass = value < 64;
    if (el.checked === bypass) return;
    el.checked = bypass;
    if (typeof simToggleBypass === 'function') simToggleBypass();
}

function midiSchedule() {
    if (midiFrame || midiHidden()) return;
    const raf = typeof requestAnimationFrame === 'function'
        ? requestAnimationFrame : (fn) => setTimeout(fn, 16);
    midiFrame = raf(() => {
        midiFrame = 0;
        midiFlushDisplay();
    });
}

// A hidden tab never paints, so a frame asked for there is not delivered until
// it is looked at again. Do not ask for one: mark the work and run it on the
// way back, otherwise the pending flag latches and the display stops updating
// for the rest of the session.
function midiHidden() {
    return typeof document !== 'undefined' && document.hidden;
}

function midiFlushDisplay() {
    for (let i = 0; i < midiDirty.length; i++) {
        if (!midiDirty[i]) continue;
        midiDirty[i] = false;
        if (typeof simRefreshPotDisplay === 'function') {
            simRefreshPotDisplay(i, 'midi');
        }
    }
    midiFlushNote();
}

// ---- display --------------------------------------------------------------

// One line carries both what the connection is doing and the last message that
// arrived. They never need to be read at the same time: before any traffic the
// connection state is the interesting thing, and once messages are flowing it
// is self-evidently connected.
function midiStatus(msg, kind) {
    const el = document.getElementById('midiLine');
    if (!el) return;
    el.textContent = msg;
    // The line is one row in a narrow panel, so anything long is clipped with
    // an ellipsis. Keep the whole text reachable on hover.
    el.title = msg;
    el.className = 'sim-status' + (kind ? ' sim-status-' + kind : '');
}

function midiSetConnected(on) {
    const btn = document.getElementById('midiConnectBtn');
    if (btn) btn.textContent = on ? 'Rescan Devices' : 'Enable MIDI';
    const sel = document.getElementById('midiDevice');
    if (sel) sel.disabled = !on;
}

// The last message, plus a blink of the activity dot. Pot messages go through
// the frame coalescer; a bypass press is rare enough to draw at once.
function midiNote(text) {
    midiPendingText = text;
    if (midiFrame || midiHidden()) return;
    midiFlushNote();
}

function midiFlushNote() {
    if (midiPendingText === null) return;
    midiStatus(midiPendingText, 'log');
    midiPendingText = null;

    const dot = document.getElementById('midiActivity');
    if (dot) {
        dot.classList.add('midi-activity-on');
        clearTimeout(midiFlashTimer);
        midiFlashTimer = setTimeout(() => dot.classList.remove('midi-activity-on'), 120);
    }
}

// ---- options and persistence ----------------------------------------------

function midiOnDeviceChange() {
    const sel = document.getElementById('midiDevice');
    midiDeviceName = sel ? sel.value : 'all';
    midiAttach();
    midiSavePrefs();
    if (midiDeviceName === 'all') midiStatus('Listening to all inputs', 'ok');
    else midiStatus('Listening to ' + midiDeviceName, 'ok');
}

function midiOnChannelChange() {
    const sel = document.getElementById('midiChannel');
    midiChannel = sel ? parseInt(sel.value, 10) || 0 : 0;
    midiSavePrefs();
}

function midiSavePrefs() {
    try {
        localStorage.setItem(MIDI_PREFS_KEY, JSON.stringify({
            device: midiDeviceName,
            channel: midiChannel
        }));
    } catch (e) { /* private browsing, or storage full */ }
}

function midiLoadPrefs() {
    let prefs = null;
    try {
        const saved = localStorage.getItem(MIDI_PREFS_KEY);
        if (saved) prefs = JSON.parse(saved);
    } catch (e) { /* fall through to defaults */ }
    if (!prefs || typeof prefs !== 'object') return;

    if (typeof prefs.device === 'string') midiDeviceName = prefs.device;
    if (typeof prefs.channel === 'number') midiChannel = prefs.channel;

    const chan = document.getElementById('midiChannel');
    if (chan) chan.value = String(midiChannel);
}

// ---- startup --------------------------------------------------------------

// Catch the display up the moment the tab is looked at again.
document.addEventListener('visibilitychange', () => {
    if (!document.hidden) midiFlushDisplay();
});

document.addEventListener('DOMContentLoaded', () => {
    midiLoadPrefs();

    const section = document.getElementById('midiSection');
    if (!midiSupported()) {
        // Safari has no Web MIDI at all. Leave the section visible but inert
        // rather than silently dropping a documented feature.
        midiSetConnected(false);
        const btn = document.getElementById('midiConnectBtn');
        if (btn) btn.disabled = true;
        midiStatus('No Web MIDI - use Chrome, Edge or Firefox', 'warn');
        if (section) section.classList.add('sim-unavailable');
        return;
    }

    midiSetConnected(false);
    midiStatus('Not connected', '');

    // Reconnect without a click if this origin already holds the permission.
    // Asking cold would raise a prompt with no user gesture behind it, which
    // Chrome may refuse outright.
    if (navigator.permissions && navigator.permissions.query) {
        navigator.permissions.query({name: 'midi', sysex: false}).then((s) => {
            if (s.state === 'granted') midiConnect();
        }).catch(() => { /* permission name unknown in this browser */ });
    }
});

// Test hook: lets a headless run inject messages without a controller.
window.midiHandleMessage = midiHandleMessage;
