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

test('a second delay block starts past the end of the first', () => {
    // Blocks need room for a read and a write pointer, so the next base is the
    // previous top plus one. Writing to one block must not disturb the other.
    const core = build([
        'mem a 4',
        'mem b 4',
        'rdax adcl, 1.0',
        'wra a, 0',
        'rda b#, 1.0',
        'wrax dacl, 0',
    ].join('\n'));
    for (let n = 0; n < 20; n++) core.run(n === 0 ? 0.5 : 0, 0);
    assert.ok(Math.abs(core.getDACL()) < 1e-3,
        'reading block b should not see what was written to block a');
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
