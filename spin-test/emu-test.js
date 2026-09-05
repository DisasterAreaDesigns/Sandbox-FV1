// Regression tests for the FV-1 core model.
//
//   npm run test:emu
//
// Programs are hand-assembled here rather than run through the assembler, so a
// failure points at fv1-emu.js and nothing else.

const assert = require('node:assert/strict');
const FV1Core = require('../Assembler/fv1-emu.js');

const OP = {
    RDA: 0x00, WRA: 0x02,
    RDAX: 0x04, RDFX: 0x05, WRAX: 0x06, WRHX: 0x07, WRLX: 0x08,
    MULX: 0x0A, LOG: 0x0B, EXP: 0x0C, SOF: 0x0D, SKP: 0x11,
    WLDX: 0x12, JAM: 0x13, CHO: 0x14,
};
const REG = { ADCL: 0x14, ADCR: 0x15, DACL: 0x16, DACR: 0x17, REG0: 0x20, REG1: 0x21 };

const word = (coef, reg, op) =>
    (((coef & 0xFFFF) << 16) | ((reg & 0x3F) << 5) | (op & 0x1F)) >>> 0;

/** SOF, LOG and EXP: a 16-bit S1.14 multiplier and an 11-bit S.10 offset. */
const wordOff = (coef, off, op) =>
    (((coef & 0xFFFF) << 16) | ((off & 0x7FF) << 5) | (op & 0x1F)) >>> 0;

const S_10 = (v) => Math.round(v * 1024) & 0x7FF;

const S1_14 = (v) => Math.round(v * 16384) & 0xFFFF;

/** RDA, WRA and WRAP: an 11-bit S1.9 coefficient and a 15-bit delay address. */
const wordDel = (coef, addr, op) =>
    (((coef & 0x7FF) << 21) | ((addr & 0x7FFF) << 5) | (op & 0x1F)) >>> 0;

const S1_9 = (v) => Math.round(v * 512) & 0x7FF;

function image(program) {
    const bytes = new Uint8Array(512);
    for (let i = 0; i < 128; i++) {
        const w = program[i] ?? word(0, 0, OP.SKP);        // skp 0,0 is the nop
        bytes[i * 4] = (w >>> 24) & 0xFF;
        bytes[i * 4 + 1] = (w >>> 16) & 0xFF;
        bytes[i * 4 + 2] = (w >>> 8) & 0xFF;
        bytes[i * 4 + 3] = w & 0xFF;
    }
    return bytes;
}

function load(program) {
    const core = new FV1Core();
    assert.ok(core.setProgram(image(program)), 'setProgram rejected the program');
    return core;
}

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

// -------------------------------------------------------------------------
// PACC holds the accumulator from before the *previous instruction*, not from
// the previous sample period. Spin's architecture overview calls it "the
// previous instruction's value" and the shelving idiom depends on it.
// -------------------------------------------------------------------------

test('PACC is latched per instruction, not per sample', () => {
    // rdax adcl,1.0   acc = in            latches pacc = acc before rdax
    // sof  0.5,0      acc = in * 0.5      latches pacc = in
    // wrhx reg0,0     reg0 = acc; acc = acc*0 + pacc  ->  pacc
    // wrax dacl,0     out = acc
    const core = load([
        word(S1_14(1.0), REG.ADCL, OP.RDAX),
        word(S1_14(0.5), 0, OP.SOF),
        word(0, REG.REG0, OP.WRHX),
        word(0, REG.DACL, OP.WRAX),
    ]);
    for (let i = 0; i < 4; i++) core.run(0.5, 0.5);
    // Per-instruction: the accumulator as it stood before `sof`, i.e. the input.
    // Per-sample it would be the previous pass's final accumulator, here 0.
    assert.ok(Math.abs(core.getDACL() - 0.5) < 1e-4,
        `expected 0.5, got ${core.getDACL()}`);
});

test('RDFX then WRLX gives the documented -6 dB shelf', () => {
    // A partial shelf, not an infinite one: with ksh = -1.0 the PACC terms
    // cancel algebraically ((pacc-acc)*-1 + pacc == acc), so that case cannot
    // tell a correct PACC from a broken one. At -0.5:
    //   acc = (pacc - lp) * -0.5 + pacc  =  0.5*pacc + 0.5*lp
    // which is unity at DC and -6 dB at Nyquist, exactly as Spin documents.
    const core = load([
        word(S1_14(1.0), REG.ADCL, OP.RDAX),
        word(S1_14(0.02), REG.REG0, OP.RDFX),
        word(S1_14(-0.5), REG.REG0, OP.WRLX),
        word(0, REG.DACL, OP.WRAX),
    ]);
    for (let i = 0; i < 3000; i++) core.run(0.5, 0.5);
    assert.ok(Math.abs(core.getDACL() - 0.5) < 0.01,
        `shelf should pass DC at unity, got ${core.getDACL()}`);

    let peak = 0;
    for (let i = 0; i < 3000; i++) {
        core.run(i % 2 ? 0.5 : -0.5, 0);
        if (i > 2500) peak = Math.max(peak, Math.abs(core.getDACL()));
    }
    assert.ok(Math.abs(peak - 0.25) < 0.02,
        `shelf should hold Nyquist at -6 dB (0.25 of 0.5), got ${peak}`);
});

test('SKP, WLDS and JAM leave PACC alone', () => {
    for (const [name, filler] of [
        ['skp', word(0, 0, OP.SKP)],
        ['wlds', word(0, 0, OP.WLDX)],
        ['jam', word(0, 0, OP.JAM)],
    ]) {
        // Same as the first test, with a non-ACC instruction wedged in before
        // the WRHX. It must not disturb the PACC that `sof` latched.
        const core = load([
            word(S1_14(1.0), REG.ADCL, OP.RDAX),
            word(S1_14(0.5), 0, OP.SOF),
            filler,
            word(0, REG.REG0, OP.WRHX),
            word(0, REG.DACL, OP.WRAX),
        ]);
        for (let i = 0; i < 4; i++) core.run(0.5, 0.5);
        assert.ok(Math.abs(core.getDACL() - 0.5) < 1e-4,
            `${name} disturbed PACC: expected 0.5, got ${core.getDACL()}`);
    }
});

test('SKP ZRC compares against the previous instruction, not the previous sample', () => {
    // 0 rdax adcl,1.0   acc = +in    latches pacc = 0
    // 1 sof  1.0,0      acc = +in    latches pacc = +in
    // 2 skp  zrc,1      correct: acc and pacc are both positive -> no skip
    // 3 sof  0,0        acc = 0      (runs only when the skip does not fire)
    // 4 wrax dacl,0     out = acc
    // 5 rdax adcl,-1.0  leaves the sample ending on a NEGATIVE accumulator, so
    //                   a per-sample PACC would differ in sign from acc at 2
    //                   and would wrongly take the skip.
    const SKP_ZRC = 0x08;
    const skp = (((SKP_ZRC & 0x1F) << 27) | ((1 & 0x3F) << 21) | OP.SKP) >>> 0;
    const core = load([
        word(S1_14(1.0), REG.ADCL, OP.RDAX),
        word(S1_14(1.0), 0, OP.SOF),
        skp,
        word(S1_14(0), 0, OP.SOF),
        word(0, REG.DACL, OP.WRAX),
        word(S1_14(-1.0), REG.ADCL, OP.RDAX),
    ]);
    for (let i = 0; i < 8; i++) core.run(0.5, 0.5);
    assert.ok(Math.abs(core.getDACL()) < 1e-3,
        `ZRC should not have fired; expected 0, got ${core.getDACL()}`);
});

// -------------------------------------------------------------------------

test('the accumulator is cleared at the start of each sample', () => {
    const core = load([word(0, REG.DACL, OP.WRAX)]);   // out = acc, with nothing read
    for (let i = 0; i < 4; i++) core.run(0.9, 0.9);
    assert.equal(core.getDACL(), 0);
});

test('SOF, LOG and EXP all take an S.10 offset', () => {
    // Each program leaves the offset alone in the accumulator: the multiplier is
    // zero, so the output is the offset by itself. All three must agree.
    for (const [name, op, setup] of [
        ['sof', OP.SOF, []],
        ['log', OP.LOG, []],
        ['exp', OP.EXP, []],
    ]) {
        for (const offset of [0.5, -0.5, 0.25]) {
            const core = load([
                ...setup,
                wordOff(S1_14(0), S_10(offset), op),
                word(0, REG.DACL, OP.WRAX),
            ]);
            for (let i = 0; i < 4; i++) core.run(0.5, 0.5);
            assert.ok(Math.abs(core.getDACL() - offset) < 2e-3,
                `${name} offset ${offset} came out as ${core.getDACL()}`);
        }
    }
});

test('a LOG offset is not scaled sixteen times too far', () => {
    // The S4.6 reading would turn -0.5 into -8.0, which saturates to -1.0.
    const core = load([
        wordOff(S1_14(0), S_10(-0.5), OP.LOG),
        word(0, REG.DACL, OP.WRAX),
    ]);
    for (let i = 0; i < 4; i++) core.run(0.5, 0.5);
    assert.ok(core.getDACL() < -0.4 && core.getDACL() > -0.6,
        `expected about -0.5, got ${core.getDACL()}`);
});

test('the ADC input rounds rather than truncating', () => {
    // A pass-through, so the output is whatever the input converted to.
    // Truncating biases every sample down by up to one LSB; rounding leaves the
    // error centred, and half an LSB either way is the best achievable.
    const core = load([
        word(S1_14(1.0), REG.ADCL, OP.RDAX),
        word(0, REG.DACL, OP.WRAX),
    ]);
    const LSB = 1 / 0x7FFFFF;
    let sum = 0;
    let worst = 0;
    const samples = 400;
    for (let n = 0; n < samples; n++) {
        // values chosen to land between codes as often as possible
        const input = -0.9 + (1.8 * n) / samples + 1e-7;
        core.run(input, input);
        const error = core.getDACL() - input;
        sum += error;
        worst = Math.max(worst, Math.abs(error));
    }
    assert.ok(worst <= LSB, `worst error ${(worst / LSB).toFixed(2)} LSB`);
    const bias = Math.abs(sum / samples) / LSB;
    assert.ok(bias < 0.1, `mean error ${bias.toFixed(3)} LSB: truncation biases, rounding should not`);
});

// -------------------------------------------------------------------------
// Delay memory
// -------------------------------------------------------------------------

test('a full-scale negative sample survives delay memory', () => {
    // clamp24() returns exactly -0x800000 on every negative overflow, so this is
    // the value a hard-driven delay or reverb writes constantly. Masking the
    // magnitude with 0x7FFFFF turned it into zero, which reads as a dropout
    // rather than a clip.
    const core = new FV1Core();
    const roundTrip = (v) => core.decompress(core.compress(v));

    assert.equal(roundTrip(-0x800000), -0x800000, 'full-scale negative was lost');
    // The 9-bit mantissa is the only loss anywhere else: better than 1 part
    // in 256 for every magnitude, and exact where the mantissa fits.
    for (const v of [0, 1, -1, 0x400000, -0x400000, 0x7FFFFF]) {
        const back = roundTrip(v);
        assert.ok(Math.abs(back - v) <= Math.abs(v) / 256,
            `${v} came back as ${back}`);
    }
});

test('a program can be swapped in without clearing delay memory', () => {
    // What the simulator's "Reset on assemble" checkbox chooses. Unticked, a
    // re-assemble takes effect but the tail already in the tank keeps ringing;
    // the core used to clear it either way, so the checkbox did nothing.
    //
    // A five sample delay: the input is written at the head and read back five
    // samples later. The reload lands while the impulse is still in flight.
    const bytes = image([
        word(S1_14(1.0), REG.ADCL, OP.RDAX),
        wordDel(S1_9(0), 0, OP.WRA),        // head, and leave ACC at zero
        wordDel(S1_9(1.0), 5, OP.RDA),      // tail, five samples back
        word(0, REG.DACL, OP.WRAX),
    ]);

    const afterReload = (resetState) => {
        const core = new FV1Core();
        assert.ok(core.setProgram(bytes));
        core.run(0.5, 0);                            // the impulse goes in
        for (let n = 1; n < 3; n++) core.run(0, 0);
        core.setProgram(bytes, resetState);          // re-assemble mid-flight
        const seen = [];
        for (let n = 3; n < 8; n++) {
            core.run(0, 0);
            seen.push(core.getDACL());
        }
        return seen;
    };

    const kept = afterReload(false);
    assert.ok(kept.some((v) => Math.abs(v - 0.5) < 2e-3),
        `the tail should have survived: ${kept.map((v) => v.toFixed(3))}`);

    const cleared = afterReload(true);
    assert.ok(cleared.every((v) => Math.abs(v) < 2e-3),
        `a resetting load should have emptied the tank: ${cleared.map((v) => v.toFixed(3))}`);
});


// -------------------------------------------------------------------------
// WLDS and WLDR load the rate and range registers and leave the phase alone.
// JAM is the only instruction that zeroes a phase, and only for a ramp.
//
// SPINAsm gives JAM the operation "0 -> RAMP LFO N" and describes it as
// resetting "the selected RAMP LFO to its starting point"; WLDS and WLDR have
// "See Description" for an operation and describe themselves only as loading
// "frequency and amplitude control values". A reset inside WLDR would make JAM
// dead silicon, and there is no JAM at all for the sines. The manual's pairing
// with SKP RUN is advice about cost ("typically", "in most cases"), which it
// could not be if an unguarded WLD pinned the LFO at zero.
//
// Every program in spin-test/files puts its WLD behind SKP RUN, so this is
// invisible there and only an unguarded WLD can tell the two models apart.
// -------------------------------------------------------------------------

const wlds = (n, f, a) =>
    ((((n & 1) << 29) | ((f & 0x1FF) << 20) | ((a & 0x7FFF) << 5) | OP.WLDX) >>> 0);

const wldr = (n, f, c) =>
    (((1 << 30) | ((n & 1) << 29) | ((f & 0xFFFF) << 13) | ((c & 3) << 5) | OP.WLDX) >>> 0);

// The ramp kind bit sits at 7 and the select at 6, so the field the decoder
// reads is the LFO code 2 or 3 rather than a bare 0 or 1.
const jam = (n) => (((1 << 7) | ((n & 1) << 6) | OP.JAM) >>> 0);

const cho = (type, sel, flags, arg) =>
    (((((type & 3) << 30) | ((flags & 0x3F) << 24) | ((sel & 3) << 21)
       | ((arg & 0xFFFF) << 5) | OP.CHO)) >>> 0);

const CHO_RDAL = 0x03;
const RMP0 = 2, RMP1 = 3, SIN0 = 0;

test('an unguarded WLDR leaves the ramp running; only JAM resets it', () => {
    // The reference core's tests/ops/ext_lfo_rmp.spn in its legacy RMP0/RMP1
    // form. Rate 16384 at range 4096 advances the ramp exactly one sample per
    // tick, and CHO RDAL hands back position/8192, so after a single tick the
    // wrapped position 4095 reads as 0.5 less one LSB of the ramp domain.
    //
    // Nothing here is behind SKP RUN: both WLDRs and the JAM run every sample.
    // RMP0 is jammed so it must read zero, and the jam must land on RMP0 and
    // not RMP1. RMP1 is only ever loaded, so it must free-run.
    const core = load([
        wldr(0, 16384, 0),                      // range code 0 is 4096
        wldr(1, 16384, 0),
        jam(0),
        cho(CHO_RDAL, RMP0, 0, 0),
        word(0, REG.DACR, OP.WRAX),
        cho(CHO_RDAL, RMP1, 0, 0),
        word(0, REG.DACL, OP.WRAX),
    ]);
    core.run(0, 0);                             // sample 1 only loads the rates
    core.run(0, 0);
    assert.equal(core.getDACR(), 0, 'JAM should hold RMP0 at its starting point');
    assert.ok(Math.abs(core.getDACL() - 0.5) < 1 / 4096,
        `RMP1 should have ticked to just under 0.5, got ${core.getDACL()}`);
});

test('an unguarded WLDS leaves the sine phase running', () => {
    // Kf 100 is a phase step of 100/131072 radians a sample, so a quarter
    // cycle is 2059 samples and CHO RDAL should be at the positive peak. If
    // WLDS reset the phase the reading would be zero forever.
    const core = load([
        wlds(0, 100, 32767),
        cho(CHO_RDAL, SIN0, 0, 0),
        word(0, REG.DACL, OP.WRAX),
    ]);
    for (let i = 0; i < 2059; i++) core.run(0, 0);
    assert.ok(core.getDACL() > 0.99,
        `sine should be at its peak after a quarter cycle, got ${core.getDACL()}`);
});

// -------------------------------------------------------------------------
// Sine amplitude.
//
// CHO RDAL does not read a sine at full scale: it reads it scaled by that
// LFO's range register. AN-0001's second example is the authority -- it
// writes POT0 straight to SIN0_RANGE, reads the oscillator with
// `cho rdal,SIN0` and sends it to DACL, and describes POT0 as setting the
// amplitude of the wave seen on a scope, which a full-scale read would make
// impossible. The corpus agrees without being asked: every program in
// spin-test/files that reads a sine this way declares that LFO at 32767 and
// calls the result "+/-1", GA_DEMO_TREM declares 16383 and calls it "+/-0.5",
// and tremolo-shapes.spn turns a 16384 sine into a 0..1 sweep with
// `sof 1,0.5` -- which clips if the sine is +/-1.
// -------------------------------------------------------------------------

const F_COS = 0x01, F_REG = 0x02;       // CHO flags
const SIN1 = 1;
const SIN0_RANGE = 0x01, POT0 = 0x10;   // register file addresses

test('CHO RDAL reads a sine scaled by its range register', () => {
    // A rate of zero parks the phase at 0, so a COS read returns the range
    // itself and nothing has to be timed. Half the range in, half out.
    for (const [amp, want] of [[32767, 0.99997], [16384, 0.5], [8192, 0.25]]) {
        const core = load([
            wlds(0, 0, amp),
            cho(CHO_RDAL, SIN0, F_REG | F_COS, 0),
            word(0, REG.DACL, OP.WRAX),
        ]);
        core.run(0, 0);
        assert.ok(Math.abs(core.getDACL() - want) < 1e-4,
            `range ${amp}: expected ${want}, got ${core.getDACL()}`);
    }
});

test('a sine range is applied once, not twice', () => {
    // The delay-tap reading and the CHO RDAL reading are one number in two
    // units -- delay samples, and delay samples with ten fractional bits below
    // them -- so applying the range to each separately would square it. The
    // reference core keeps a single value for both readings for that reason.
    const core = load([
        wlds(1, 40, 16384),
        cho(CHO_RDAL, SIN1, F_REG, 0),
    ]);
    for (let i = 0; i < 25; i++) {
        core.run(0, 0);
        const offset = core.lfoOffset(1, 0);    // delay samples
        const value = core.lfoValue(1, 0);      // S.23
        // Equal but for the floor: the value IS the tap, ten bits further over.
        assert.ok(Math.abs(offset * 1024 - value) < 2,
            `tap ${offset} and value ${value} disagree about the range`);
    }
    assert.ok(core.sinPhase[1] > 0, 'SIN1 never moved, so nothing was compared');
});

test('a pot written to SIN0_RANGE sets the amplitude, as AN-0001 says', () => {
    // The app note's own second example, with the pot read straight across.
    const core = load([
        wlds(0, 0, 32767),
        word(S1_14(1.0), POT0, OP.RDAX),
        word(0, SIN0_RANGE, OP.WRAX),
        cho(CHO_RDAL, SIN0, F_REG | F_COS, 0),
        word(0, REG.DACL, OP.WRAX),
    ]);
    const settle = (pot) => {
        // setPots advances the chip's pot filter one step per call.
        for (let i = 0; i < 8000; i++) { core.setPots([pot, 0, 0]); core.run(0, 0); }
        return core.getDACL();
    };
    const half = settle(0.5), full = settle(1.0);
    assert.ok(Math.abs(half - 0.5) < 0.01, `pot at half gave ${half}`);
    assert.ok(Math.abs(full - 1.0) < 0.01, `pot at full gave ${full}`);
});

let failed = 0;
for (const [name, fn] of tests) {
    try {
        fn();
        console.log(`ok    ${name}`);
    } catch (err) {
        failed++;
        console.log(`FAIL  ${name}\n      ${err.message}`);
    }
}
console.log(`\n${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
