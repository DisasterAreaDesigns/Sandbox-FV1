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
// Literals and operand encoding. These are checked against asfv1's output for
// the same source: assembling the whole spin-test/files corpus with both and
// diffing the images is what turned each of them up.
// -------------------------------------------------------------------------

/** The first assembled instruction word. */
function firstWord(source) {
    const asm = new FV1Assembler(source, { clamp: true, spinReals: true });
    asm.parse();
    assert.equal(asm.errors.length, 0, `unexpected error: ${asm.errors[0]}`);
    asm.generateMachineCode();
    const b = asm.program;
    return ((b[0] << 24 | b[1] << 16 | b[2] << 8 | b[3]) >>> 0) >>> 0;
}

test('a hex literal containing E is a number, not an exponent', () => {
    // 'e' is a hex digit as well as a float exponent marker. Testing for it
    // before the radix prefix sent 0x0E down the float path, where parseFloat
    // stops at the 'x' and returns 0 -- silently, with no error. Real programs
    // in spin-test/files hit this: rom_chor_rev.spn's `cho RDA,SIN0,0x0E,...`
    // lost its flags and afx_reverse_delay.spn's `or 0xFFFE00` became `or 0`.
    assert.equal(firstWord('or 0xFFFE00\n'), firstWord('or $FFFE00\n'));
    assert.equal(firstWord('and 0x0E0000\n') >>> 8, 0x0E0000);
    assert.equal(firstWord('cho rda,sin0,0x0E,100\n') >>> 24, 0x0E);
    // The forms that already worked must keep working.
    assert.equal(firstWord('and 0x0F0000\n') >>> 8, 0x0F0000);
    assert.equal(firstWord('and %1111_0000_0000_0000_0000_0000\n') >>> 8, 0xF00000);
});

test('a malformed numeric literal is an error, not a zero', () => {
    // The scanner splits on the minus, so `1e-1` reaches parseFloat as `1e` and
    // used to come back as a zero coefficient with nothing said. asfv1 rejects
    // the exponent form too; the point is that it is rejected rather than
    // silently mis-assembled.
    for (const src of ['and 0xZZ\n', 'rdax adcl, 1e-1\n']) {
        const asm = new FV1Assembler(src, { clamp: true, spinReals: true });
        asm.parse();
        assert.ok(asm.errors.length > 0, `${src.trim()} assembled silently`);
    }
});

test('an omitted CHO flags field means no flags', () => {
    // `cho rda,rmp0,,addr` is the second half of the AN-0001 interpolation pair
    // and appears in thirteen of the corpus programs. A blank field used to
    // return REG for a ramp LFO, setting a bit the program never wrote and
    // disagreeing with an explicit 0 on the same instruction.
    assert.equal(firstWord('cho rda,rmp0,,100\n'), firstWord('cho rda,rmp0,0,100\n'));
    assert.equal(firstWord('cho rda,sin0,,100\n'), firstWord('cho rda,sin0,0,100\n'));
    assert.equal(firstWord('cho rda,rmp0,,100\n') >>> 24, 0, 'flags should be clear');
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
