// Assembler and simulator round-trip tests.
//
//   npm run test:roundtrip
//
// emu-test.js checks the simulator against hand-built instruction words. This
// checks the pair: source through assembler.js, run on fv1-emu.js, and confirm
// the value that comes out is the value that was written. A coefficient encoded
// one way and decoded another passes both halves separately and still gives the
// wrong answer, so it needs testing as a pair.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const FV1Core = require('../Assembler/fv1-emu.js');

// assembler.js is a browser global rather than a module, and calls a debugLog
// the page provides, so it is evaluated here with a stub.
const FV1Assembler = (() => {
    const code = fs.readFileSync(path.join(__dirname, '../Assembler/assembler.js'), 'utf8');
    return new Function('debugLog', `${code}\nreturn FV1Assembler;`)(() => {});
})();

function build(source) {
    // The web app enables clamping and SpinASM real compatibility; without them
    // an out-of-range integer becomes an error rather than a clamped value.
    const asm = new FV1Assembler(source, { clamp: true, spinReals: true });
    asm.parse();
    asm.generateMachineCode();
    const core = new FV1Core();
    assert.ok(core.setProgram(Uint8Array.from(asm.program)), 'setProgram rejected the program');
    return core;
}

/** Run a program and read DACL after it settles. */
function output(source, input = 0.5, samples = 8) {
    const core = build(source);
    for (let i = 0; i < samples; i++) core.run(input, input);
    return core.getDACL();
}

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

// -------------------------------------------------------------------------
// Offsets: SOF, LOG and EXP all carry an 11-bit S.10 field. If the assembler
// and the simulator disagree about its scale, a program says one thing and
// does another.
// -------------------------------------------------------------------------

for (const mnemonic of ['sof', 'log', 'exp']) {
    test(`${mnemonic} offset survives the round trip`, () => {
        for (const offset of [0.5, -0.5, 0.25, 0.1]) {
            // A zero multiplier leaves the offset alone in the accumulator.
            const out = output(`${mnemonic} 0, ${offset}\nwrax dacl, 0\n`);
            assert.ok(Math.abs(out - offset) < 2e-3,
                `${mnemonic} 0, ${offset} came out as ${out.toFixed(4)}`);
        }
    });
}

test('all three offsets agree with each other', () => {
    const at = (m) => output(`${m} 0, 0.375\nwrax dacl, 0\n`);
    assert.ok(Math.abs(at('sof') - at('log')) < 1e-3, 'sof and log disagree');
    assert.ok(Math.abs(at('sof') - at('exp')) < 1e-3, 'sof and exp disagree');
});

// -------------------------------------------------------------------------
// Coefficients
// -------------------------------------------------------------------------

test('a fractional coefficient survives the round trip', () => {
    for (const k of [0.5, 0.25, -0.75, 0.9]) {
        const out = output(`rdax adcl, ${k}\nwrax dacl, 0\n`);
        assert.ok(Math.abs(out - 0.5 * k) < 2e-3,
            `rdax adcl, ${k} on 0.5 gave ${out.toFixed(4)}, expected ${(0.5 * k).toFixed(4)}`);
    }
});

test('a bare 1 means unity, the way the SpinASM IDE reads it', () => {
    // SpinASM promotes a bare 1 or 2 to 1.0 and 2.0, which is how most .spn
    // source is written -- `rdax adcl,1` is unity gain, not a coefficient of
    // 1/16384. asfv1 calls this `spinreals` and has it off by default, so the
    // two assemblers disagree here unless the flag is set.
    const one = output('rdax adcl, 1\nwrax dacl, 0\n');
    const oneFloat = output('rdax adcl, 1.0\nwrax dacl, 0\n');
    assert.ok(Math.abs(one - 0.5) < 2e-3, `a bare 1 gave ${one}`);
    assert.ok(Math.abs(oneFloat - 0.5) < 2e-3, `1.0 gave ${oneFloat}`);
});

// -------------------------------------------------------------------------
// Delay memory
// -------------------------------------------------------------------------

test('a delay line delays by the length it was given', () => {
    const core = build([
        'mem del 5',
        'rdax adcl, 1.0',
        'wra del, 0',
        'rda del#, 1.0',
        'wrax dacl, 0',
    ].join('\n'));

    const seen = [];
    for (let n = 0; n < 12; n++) {
        core.run(n === 0 ? 0.5 : 0, 0);
        seen.push(core.getDACL());
    }
    const impulseAt = seen.findIndex((v) => Math.abs(v - 0.5) < 1e-3);
    assert.equal(impulseAt, 5, `impulse reappeared at ${impulseAt}, expected 5`);
});

test('one delay block does not overwrite the tail of the previous one', () => {
    // `mem x N` spans base..base+N inclusive -- N+1 locations, one more than the
    // declared length, so the block has room for a read and a write pointer.
    // The next block therefore starts one past the top, not at it. Without that,
    // x# and the next block's head are the same address.
    //
    // Here an impulse goes into block a while block b's head is written with a
    // constant every sample. If the two blocks overlap, reading a# returns b's
    // constant instead of the delayed impulse.
    const core = build([
        'mem a 4',
        'mem b 4',
        'rdax adcl, 1.0',
        'wra a, 0',            // the input at a's head
        'sof 0, 0.5',
        'wra b, 0',            // a constant at b's head
        'rda a#, 1.0',         // read a's tail
        'wrax dacl, 0',
    ].join('\n'));

    const seen = [];
    for (let n = 0; n < 8; n++) {
        core.run(n === 0 ? 0.5 : 0, 0);
        seen.push(core.getDACL());
    }
    const impulseAt = seen.findIndex((v) => Math.abs(v - 0.5) < 2e-3);
    assert.equal(impulseAt, 4,
        `impulse reappeared at ${impulseAt}, expected 4; saw ${seen.map((v) => v.toFixed(3))}`);
    for (const [n, v] of seen.entries()) {
        if (n !== 4) assert.ok(Math.abs(v) < 2e-3, `sample ${n} should be silent, was ${v.toFixed(3)}`);
    }
});

test('block symbols line up with asfv1', () => {
    const asm = new FV1Assembler('mem a 4\nmem b 4\nclr\n', { clamp: true, spinReals: true });
    asm.parse();
    const at = (name) => asm.symtbl[name.toUpperCase()] ?? asm.symtbl[name];
    assert.equal(at('a'), 0);
    assert.equal(at('a#'), 4);
    assert.equal(at('a^'), 2);
    assert.equal(at('b'), 5, 'the next block starts one past the previous top');
    assert.equal(at('b#'), 9);
});

// -------------------------------------------------------------------------
// Coefficient rounding
// -------------------------------------------------------------------------

/** The raw coefficient field of the first instruction. */
function firstCoefficient(source, shift, mask) {
    const asm = new FV1Assembler(source, { clamp: true, spinReals: true });
    asm.parse();
    asm.generateMachineCode();
    const b = asm.program;
    return (((b[0] << 24 | b[1] << 16 | b[2] << 8 | b[3]) >>> 0) >>> shift) & mask;
}

test('coefficients round to nearest rather than truncating', () => {
    // Truncating biases every fractional coefficient down by half an LSB on
    // average. These are the values asfv1 produces.
    const s1_9 = (src) => firstCoefficient(src, 21, 0x7FF);
    const s1_14 = (src) => firstCoefficient(src, 16, 0xFFFF);

    assert.equal(s1_9('rda 100, 0.55'), 282, '0.55 x 512 = 281.6');
    assert.equal(s1_9('rda 100, 0.4'), 205, '0.4 x 512 = 204.8');
    assert.equal(s1_9('rda 100, 0.6'), 307, '0.6 x 512 = 307.2');
    assert.equal(s1_14('rdax adcl, 0.13'), 2130, '0.13 x 16384 = 2129.92');
    assert.equal(s1_14('rdax adcl, -0.6'), 55706, 'negatives round too');
});

test('a tie rounds to even, as asfv1 does', () => {
    // Python's round() breaks ties to even and Math.round breaks them away from
    // zero, so these are the cases where the two would otherwise diverge.
    const s1_9 = (src) => firstCoefficient(src, 21, 0x7FF);
    assert.equal(s1_9('rda 100, 0.0009765625'), 0, 'exactly 0.5 of an LSB -> 0');
    assert.equal(s1_9('rda 100, 0.0029296875'), 2, 'exactly 1.5 -> 2');
    assert.equal(s1_9('rda 100, 0.0048828125'), 2, 'exactly 2.5 -> 2');
});

// -------------------------------------------------------------------------
// The extended instruction set
//
// Everything here needs `#extended` in the source. The encoding is a strict
// superset -- every addition lives in a bit, an opcode value or a register
// number no assembled FV-1 program sets -- so what has to be checked is that
// each addition lands where the spec says, and that nothing without the
// pragma changes. The first of those is a bit test on the assembled word: a
// select that decoded to the wrong LFO would still produce plausible audio,
// which is exactly the failure a listening test misses.
// -------------------------------------------------------------------------

/** The assembled word at slot `i`. */
function wordAt(source, i = 0) {
    const asm = new FV1Assembler(source, { clamp: true, spinReals: true });
    asm.parse();
    asm.generateMachineCode();
    assert.deepEqual(asm.errors, [], 'assembly failed');
    const b = asm.program;
    return ((b[i * 4] << 24 | b[i * 4 + 1] << 16 |
             b[i * 4 + 2] << 8 | b[i * 4 + 3]) >>> 0);
}

/** Assemble and load, declaring the pragma to the core the way the app does. */
function buildExt(source) {
    const asm = new FV1Assembler(source, { clamp: true, spinReals: true });
    asm.parse();
    asm.generateMachineCode();
    assert.deepEqual(asm.errors, [], 'assembly failed');
    const core = new FV1Core();
    assert.ok(core.setProgram(Uint8Array.from(asm.program), true));
    return core;
}

test('the extended names are refused by name without the pragma', () => {
    for (const src of ['rand reg0, 1.0\n', 'wlds SIN2, 26, 32767\n',
                       'jam RMP3\n', 'rdax POT3, 1.0\n',
                       'rdax SIN2_RATE, 1.0\n', 'cho rdal, RMP2\n']) {
        const asm = new FV1Assembler(src, { clamp: true, spinReals: true });
        asm.parse();
        assert.ok(asm.errors.length, `${src.trim()} assembled without #extended`);
        assert.ok(/requires #extended/.test(asm.errors[0]),
            `${src.trim()} failed with "${asm.errors[0].split('\n')[0]}"`);
    }
});

test('a numeric LFO above 3 needs the pragma too', () => {
    const asm = new FV1Assembler('cho rdal, 5\n', { clamp: true, spinReals: true });
    asm.parse();
    assert.ok(/Invalid LFO 5/.test(asm.errors[0] ?? ''), asm.errors[0]);
});

test('WLDS and WLDR carry the select as bit 31 : bit 30 : bit 29', () => {
    // Bit 29 the low select, bit 30 the kind, bit 31 the high select. A
    // legacy select is 0 or 1 within its kind, so bit 31 stays clear and the
    // word is the one the FV-1's own assembler would have written.
    const sel = (w) => ((w >>> 31) & 1) << 1 | ((w >>> 29) & 1);
    const kind = (w) => (w >>> 30) & 1;
    const wlds = (lfo) => wordAt(`#extended\nwlds ${lfo}, 26, 32767\n`);
    const wldr = (lfo) => wordAt(`#extended\nwldr ${lfo}, 16384, 4096\n`);

    for (const [i, name] of ['SIN0', 'SIN1', 'SIN2', 'SIN3'].entries()) {
        assert.equal(sel(wlds(name)), i, `wlds ${name} select`);
        assert.equal(kind(wlds(name)), 0, `wlds ${name} is a sine`);
    }
    for (const [i, name] of ['RMP0', 'RMP1', 'RMP2', 'RMP3'].entries()) {
        assert.equal(sel(wldr(name)), i, `wldr ${name} select`);
        assert.equal(kind(wldr(name)), 1, `wldr ${name} is a ramp`);
    }
    // Without the pragma the field is the FV-1's, bit 31 clear.
    assert.equal(wordAt('wlds SIN1, 26, 32767\n') >>> 31, 0);
});

test('CHO carries the LFO code at 21-23 and JAM at 6-8', () => {
    // Bit 1 is the kind, bit 0 the low select and bit 2 the high select, so
    // 0-3 mean what they always did. That ordering is what keeps the
    // assembler's `lfo & 2` flag check working on the new codes.
    const codes = { SIN0: 0, SIN1: 1, RMP0: 2, RMP1: 3,
                    SIN2: 4, SIN3: 5, RMP2: 6, RMP3: 7 };
    for (const [name, code] of Object.entries(codes)) {
        assert.equal((wordAt(`#extended\ncho rdal, ${name}\n`) >>> 21) & 0x07,
            code, `cho rdal, ${name}`);
    }
    // JAM forces the kind bit, as it does on the FV-1: `jam SIN2` is RMP2.
    assert.equal((wordAt('#extended\njam RMP2\n') >>> 6) & 0x07, 6);
    assert.equal((wordAt('#extended\njam RMP3\n') >>> 6) & 0x07, 7);
    assert.equal((wordAt('jam RMP1\n') >>> 6) & 0x07, 3, 'a legacy JAM is unchanged');
});

test('RAND is opcode 21 over a RDAX operand layout', () => {
    const w = wordAt('#extended\nrand reg5, 0.002\n');
    assert.equal(w & 0x1F, 21, 'opcode');
    assert.equal((w >>> 5) & 0x3F, 0x25, 'REG5 at bits 10:5');
    assert.equal((w >>> 16) & 0xFFFF, 33, '0.002 x 16384 = 32.768 -> 33, S1.14');
    assert.equal((w >>> 11) & 0x1F, 0, 'bits 15:11 unused');
});

test('each new LFO writes its own rate and range registers', () => {
    // 0x08-0x0f, the block the FV-1 leaves empty between RMP1_RANGE and POT0.
    // A select that landed on SIN0 would leave these zero and drive an LFO
    // the program never named.
    const core = buildExt('#extended\nwlds SIN2, 26, 32767\nwldr RMP3, 16384, 4096\n');
    core.run(0, 0);
    assert.ok(core.regs[0x08] > 0, 'SIN2_RATE');
    assert.ok(core.regs[0x09] > 0, 'SIN2_RANGE');
    assert.ok(core.regs[0x0e] > 0, 'RMP3_RATE');
    for (const r of [0x00, 0x02, 0x04, 0x06, 0x0a, 0x0c])
        assert.equal(core.regs[r], 0, `register 0x${r.toString(16)} was written`);
});

test('the new LFOs run, and JAM reaches the one it names', () => {
    // Four ramps at one rate, one of them jammed every sample. The rates are
    // set through WRAX rather than WLDR so that nothing is reloaded after the
    // first pass. RMP2 must read zero and the other three must not.
    const core = buildExt(`#extended
        skp     RUN, 9
        sof     0, 0.5
        wrax    RMP0_RATE, 1.0
        wrax    RMP1_RATE, 1.0
        wrax    RMP2_RATE, 1.0
        wrax    RMP3_RATE, 0
        sof     0, 0
        wrax    RMP0_RANGE, 0
        wrax    RMP1_RANGE, 0
        wrax    RMP2_RANGE, 0
        jam     RMP2
        cho     rdal, RMP0
        wrax    REG10, 0
        cho     rdal, RMP1
        wrax    REG11, 0
        cho     rdal, RMP2
        wrax    REG12, 0
        cho     rdal, RMP3
        wrax    REG13, 0
    `);
    for (let i = 0; i < 6; i++) core.run(0, 0);
    assert.equal(core.regs[0x2A + 2], 0, 'RMP2 was jammed and must read zero');
    for (const [n, name] of [[0, 'RMP0'], [1, 'RMP1'], [3, 'RMP3']])
        assert.ok(core.regs[0x2A + n] !== 0, `${name} was jammed instead`);
});

test('SIN2 and SIN3 advance at their own rates', () => {
    const core = buildExt(`#extended
        skp     RUN, 2
        wlds    SIN2, 4, 32767
        wlds    SIN3, 400, 32767
        cho     rdal, SIN2
        cho     rdal, SIN3
    `);
    for (let i = 0; i < 40; i++) core.run(0, 0);
    assert.equal(core.sinPhase[0], 0, 'SIN0 moved');
    assert.equal(core.sinPhase[1], 0, 'SIN1 moved');
    assert.ok(core.sinPhase[2] > 0, 'SIN2 did not move');
    assert.ok(core.sinPhase[3] > core.sinPhase[2] * 10, 'SIN3 is the faster one');
});

test('RAND fills a register and leaves ACC and PACC alone', () => {
    // The only register write in the instruction set that does not touch the
    // accumulator, which is what lets a RAND drop in between any two
    // instructions with nothing saved around it. WRHX reads PACC, so this
    // catches a RAND that latched it.
    const core = buildExt(`#extended
        rdax    adcl, 1.0
        rand    REG0, 1.0
        wrax    dacr, 1.0
        wrhx    REG1, 0
        wrax    dacl, 0
    `);
    core.run(0.5, 0.5);
    assert.ok(Math.abs(core.getDACR() - 0.5) < 2e-3, 'RAND disturbed ACC');
    assert.ok(Math.abs(core.getDACL() - 0.5) < 2e-3, 'RAND disturbed PACC');
});

test('RAND draws uniformly over [-1, 1), scaled by its coefficient', () => {
    const draws = (coeff, n) => {
        const core = buildExt(
            `#extended\nrand REG0, ${coeff}\nrdax REG0, 1.0\nwrax dacl, 0\n`);
        const out = [];
        for (let i = 0; i < n; i++) { core.run(0, 0); out.push(core.getDACL()); }
        return out;
    };
    const full = draws(1.0, 50000);
    const mean = full.reduce((a, b) => a + b, 0) / full.length;
    const absMean = full.reduce((a, b) => a + Math.abs(b), 0) / full.length;
    assert.ok(Math.abs(mean) < 0.02, `mean ${mean.toFixed(4)}, expected ~0`);
    assert.ok(Math.abs(absMean - 0.5) < 0.02, `E|U| ${absMean.toFixed(4)}, expected 0.5`);
    assert.ok(Math.min(...full) < -0.99 && Math.max(...full) > 0.99,
        'the draw does not span the accumulator');

    // The coefficient is the amplitude, which is the point of carrying one.
    const dither = draws(0.002, 20000);
    assert.ok(Math.max(...dither.map(Math.abs)) < 0.0021, 'a dither is not a dither');
});

test('the generator repeats from a reset, so two runs can be compared', () => {
    const five = () => {
        const core = buildExt('#extended\nrand REG0, 1.0\nrdax REG0, 1.0\nwrax dacl, 0\n');
        const out = [];
        for (let i = 0; i < 5; i++) { core.run(0, 0); out.push(core.getDACL()); }
        return out;
    };
    assert.deepEqual(five(), five());
});

// -------------------------------------------------------------------------

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
