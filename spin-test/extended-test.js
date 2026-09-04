// The '#extended' instruction set: what it does, and what it refuses to do
// without being asked.
//
//   npm run test:extended
//
// A port of asfv1-extended's tests/test_extended.py, which is the reference
// this assembler follows. Every case asserts on the encoded word rather than on
// "it assembled", because each bug worth catching here produces code that runs
// and is quietly wrong: an address one bit short, a pot register off by one.
//
// If a copy of asfv1-extended is reachable -- ASFV1_EXTENDED, or the checkout
// this project is developed alongside -- every source below is also assembled
// with it and the images compared. That is the real check; the assertions are
// what runs when it is not installed.
//
// Not ported: the '$' spelling of the MEM midpoint suffix. asfv1-extended
// accepts it beside '^'; nothing in spin-test/files uses it, and '$' is this
// assembler's hex literal prefix, so it is left alone.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const FV1Core = require('../Assembler/fv1-emu.js');

const FV1Assembler = (() => {
    const code = fs.readFileSync(path.join(__dirname, '../Assembler/assembler.js'), 'utf8');
    return new Function('debugLog', `${code}\nreturn FV1Assembler;`)(() => {});
})();

const EXT = '#extended\n';

// Where a reference copy might be. Nothing is vendored: asfv1 is GPL-3 and this
// repo is MIT, so the fork stays a checkout you point at.
const REFERENCE = process.env.ASFV1_EXTENDED || path.join(os.homedir(),
    'Library/CloudStorage/Dropbox/Arduino/asfv1-extended/asfv1.py');
const haveReference = fs.existsSync(REFERENCE);

// ---- assembling -----------------------------------------------------------

const sources = [];   // every source this file assembles, for the diff pass
let recording = true; // ...except the diff pass itself, which re-assembles them

/** Assemble with assembler.js; return {ok, errors, warnings, words}. */
function build(source, opts = {}) {
    if (recording && !sources.includes(source)) sources.push(source);
    const asm = new FV1Assembler(source, { clamp: false, spinReals: true, ...opts });
    asm.parse();
    asm.generateMachineCode();
    const words = [];
    for (let i = 0; i < 128; i++) {
        const o = i * 4;
        words.push(((asm.program[o] << 24 | asm.program[o + 1] << 16 |
            asm.program[o + 2] << 8 | asm.program[o + 3]) >>> 0));
    }
    return {
        ok: asm.errors.length === 0,
        errors: asm.errors.join('\n'),
        warnings: asm.warnings.join('\n'),
        words,
        asm,
    };
}

// Field accessors, by the encoding in asfv1-extended's README.
const addr = (w) => (w >>> 5) & 0xFFFF;          // RDA/WRA/WRAP, and CHO's
const bit = (w, n) => (w >>> n) & 1;
const reg = (w) => (w >>> 5) & 0x3F;
const op = (w) => w & 0x1F;
const lfoCho = (w) => (w >>> 21) & 7;
const lfoJam = (w) => (w >>> 6) & 7;
const lfoWld = (w) => bit(w, 29) | (bit(w, 31) << 1);

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

// ---- encoding -------------------------------------------------------------

test('an address above 32767 sets bit 20', () => {
    const r = build(EXT + 'rda 40000, 1.0\nwra 65535, 0.0\nwrap 33000, 0.5\n');
    assert.ok(r.ok, r.errors);
    assert.deepEqual(r.words.slice(0, 3).map((w) => bit(w, 20)), [1, 1, 1]);
    assert.deepEqual(r.words.slice(0, 3).map(addr), [40000, 65535, 33000]);
    assert.equal((r.words[0] >>> 21) & 0x7FF, 512, 'the coefficient moved');
});

test('CHO RDA carries a 16 bit address', () => {
    const r = build(EXT + 'cho rda, SIN0, REG|COMPC, 40000\n');
    assert.ok(r.ok, r.errors);
    assert.equal(op(r.words[0]), 0x14);
    assert.equal(addr(r.words[0]), 40000);
});

test('RMPAX sets the pointer scale bit and RMPA does not', () => {
    const r = build(EXT + 'rmpax 1.0\nrmpa 1.0\n');
    assert.ok(r.ok, r.errors);
    assert.equal(bit(r.words[0], 5), 1);
    assert.equal(bit(r.words[1], 5), 0);
    assert.equal((r.words[0] >>> 21) & 0x7FF, 512, 'RMPAX lost its coefficient');
    assert.match(r.warnings, /RMPAX/, 'plain RMPA in an extended source should warn');
});

test('RAND takes opcode 21 and RDAX operands', () => {
    const r = build(EXT + 'rand REG0, 1.0\nrand REG31, -0.5\nrdax REG0, 1.0\n');
    assert.ok(r.ok, r.errors);
    assert.equal(op(r.words[0]), 0b10101);
    assert.equal(op(r.words[2]), 0b00100, 'RAND must not be RDAX');
    assert.deepEqual(r.words.slice(0, 2).map(reg), [0x20, 0x3F]);
    assert.equal((r.words[0] >>> 16) & 0xFFFF, 16384);
    assert.equal((r.words[1] >>> 16) & 0xFFFF, 0x10000 - 8192);
    // 15:11 is clear in every RDAX-shaped word.
    assert.equal((r.words[0] >>> 11) & 0x1F, 0);
});

test('POT3 to POT5 are 0x19 to 0x1b', () => {
    const r = build(EXT + 'rdax POT3, 1.0\nrdax POT4, 1.0\nrdax POT5, 1.0\n');
    assert.ok(r.ok, r.errors);
    assert.deepEqual(r.words.slice(0, 3).map(reg), [0x19, 0x1a, 0x1b]);
});

// ---- four more LFOs -------------------------------------------------------

test('CHO carries the LFO code in bits 21-23', () => {
    const r = build(EXT + ['SIN0', 'SIN1', 'RMP0', 'RMP1', 'SIN2', 'SIN3', 'RMP2', 'RMP3']
        .map((n) => `cho rdal, ${n}\n`).join(''));
    assert.ok(r.ok, r.errors);
    assert.deepEqual(r.words.slice(0, 8).map(lfoCho), [0, 1, 2, 3, 4, 5, 6, 7]);
    // The first four are the FV-1's own words, bit for bit.
    assert.deepEqual(r.words.slice(0, 8).map((w) => bit(w, 23)), [0, 0, 0, 0, 1, 1, 1, 1]);
    // Bit 1 of the code still says "ramp".
    assert.deepEqual(r.words.slice(0, 8).map((w) => bit(w, 22)), [0, 0, 1, 1, 0, 0, 1, 1]);
});

test('CHO flags are checked against the kind, not the number', () => {
    const ok = build(EXT + 'cho rda, RMP2, REG|COMPC, 100\ncho rda, SIN3, REG|COS, 100\n');
    assert.ok(ok.ok, ok.errors);
    assert.equal(ok.warnings, '', ok.warnings);
    // RPTR2 is a ramp flag, so it is dropped on a sine however new the sine is.
    const bad = build(EXT + 'cho rda, SIN2, REG|RPTR2, 100\n');
    assert.match(bad.warnings, /SIN flags/, bad.warnings);
});

test('JAM carries the same code in bits 6-8', () => {
    const r = build(EXT + 'jam RMP0\njam RMP1\njam RMP2\njam RMP3\n');
    assert.ok(r.ok, r.errors);
    assert.deepEqual(r.words.slice(0, 4).map(lfoJam), [2, 3, 6, 7]);
});

test('WLDS selects with bit 29 low and bit 31 high', () => {
    const r = build(EXT + ['SIN0', 'SIN1', 'SIN2', 'SIN3']
        .map((n) => `wlds ${n}, 10, 100\n`).join(''));
    assert.ok(r.ok, r.errors);
    assert.deepEqual(r.words.slice(0, 4).map(lfoWld), [0, 1, 2, 3]);
    assert.deepEqual(r.words.slice(0, 4).map((w) => bit(w, 30)), [0, 0, 0, 0]);
    for (const w of r.words.slice(0, 4)) {
        assert.equal((w >>> 20) & 0x1FF, 10, 'rate moved');
        assert.equal((w >>> 5) & 0x7FFF, 100, 'amplitude moved');
    }
});

test('WLDR selects the same way with bit 30 set', () => {
    const r = build(EXT + ['RMP0', 'RMP1', 'RMP2', 'RMP3']
        .map((n) => `wldr ${n}, 16384, 4096\n`).join(''));
    assert.ok(r.ok, r.errors);
    assert.deepEqual(r.words.slice(0, 4).map(lfoWld), [0, 1, 2, 3]);
    assert.deepEqual(r.words.slice(0, 4).map((w) => bit(w, 30)), [1, 1, 1, 1]);
    for (const w of r.words.slice(0, 4)) {
        assert.equal((w >>> 13) & 0xFFFF, 16384, 'rate moved');
        assert.equal((w >>> 5) & 3, 0, 'amplitude moved');
        assert.equal((w >>> 7) & 0x3F, 0, 'bits 7-12 should stay clear');
    }
});

test('the eight new LFO registers fill 0x08 to 0x0f in order', () => {
    const r = build(EXT + ['SIN2_RATE', 'SIN2_RANGE', 'SIN3_RATE', 'SIN3_RANGE',
        'RMP2_RATE', 'RMP2_RANGE', 'RMP3_RATE', 'RMP3_RANGE']
        .map((n) => `rdax ${n}, 1.0\n`).join(''));
    assert.ok(r.ok, r.errors);
    assert.deepEqual(r.words.slice(0, 8).map(reg), [8, 9, 10, 11, 12, 13, 14, 15]);
});

test('a numeric LFO may reach 7', () => {
    const ok = build(EXT + 'cho rdal, 7\n');
    assert.ok(ok.ok, ok.errors);
    assert.equal(lfoCho(ok.words[0]), 7);
    // 8 and 9 are this assembler's COS0 and COS1 aliases, which asfv1 does not
    // have -- it is why nineteen of the corpus programs assemble here and not
    // there. 10 is past everything either of us knows about.
    assert.match(build(EXT + 'cho rdal, 10\n').errors, /Invalid LFO/);
    assert.match(build('cho rdal, 5\n').errors, /Invalid LFO/,
        'without the pragma the numeric range is still 0-3');
});

// ---- delay pool -----------------------------------------------------------

test('the extended delay pool is 65536 words', () => {
    assert.ok(build(EXT + 'l MEM 32767\nr MEM 32767\nclr\n').ok,
        'two 32768-word blocks should fill the tank exactly');
    assert.match(build(EXT + 'l MEM 32767\nr MEM 32768\nclr\n').errors, /exhausted/i,
        'one word more should be refused');
});

test('MEM start, midpoint and end resolve in an extended source', () => {
    const r = build(EXT + 'd MEM 1000\nrda d, 0\nrda d^, 0\nrda d#, 0\n');
    assert.ok(r.ok, r.errors);
    assert.deepEqual(r.words.slice(0, 3).map(addr), [0, 500, 1000]);
});

// ---- refused without the pragma -------------------------------------------

test('an extension-only mnemonic names the pragma, once', () => {
    for (const [src, name] of [['rmpax 1.0\n', 'RMPAX'], ['rand REG0, 1.0\n', 'RAND']]) {
        const r = build(src);
        assert.match(r.errors, new RegExp(`${name} requires #extended`), r.errors);
        assert.equal(r.errors.split('\n').filter((l) => l.startsWith('Error')).length, 1,
            `${name} cascaded onto its operands:\n${r.errors}`);
    }
});

test('an extension-only register names the pragma', () => {
    assert.match(build('rdax POT3, 1.0\n').errors, /POT3 requires #extended/);
    assert.match(build('cho rdal, SIN2\n').errors, /SIN2 requires #extended/);
    assert.match(build('wrax RMP3_RATE, 0\n').errors, /RMP3_RATE requires #extended/);
    assert.match(build('cho rdal, 5\n').errors, /Invalid LFO/);
});

test('unextended LFO words leave bits 31, 8 and 23 clear', () => {
    const r = build('wlds SIN1, 10, 100\nwldr RMP1, 16384, 4096\njam RMP1\ncho rdal, RMP1\n');
    assert.ok(r.ok, r.errors);
    assert.equal(bit(r.words[0], 31), 0);
    assert.equal(bit(r.words[1], 31), 0);
    assert.equal(bit(r.words[2], 8), 0);
    assert.equal(bit(r.words[3], 23), 0);
});

test('the hint appears only where the pragma would help', () => {
    assert.match(build('rda 40000, 1.0\n').errors, /#extended/,
        'an address only the pragma could reach should hint at it');
    assert.doesNotMatch(build('rda 99999, 1.0\n').errors, /#extended/,
        'a plain out of range address should not');
    assert.match(build('l MEM 40000\nclr\n').errors, /#extended/,
        'an oversized MEM should hint at it');
});

// ---- the pragma itself ----------------------------------------------------

test('the pragma is a line of its own, and may carry a comment', () => {
    assert.match(build('; #extended\nrdax POT3, 1.0\n').errors, /POT3 requires/,
        'a commented pragma should not enable anything');
    assert.match(build('#extendedd\nclr\n').errors, /Unknown pragma/);
    const withComment = build('#extended   ; with a trailing comment\nrdax POT5, 1.0\n');
    assert.ok(withComment.ok, withComment.errors);
    assert.equal(reg(withComment.words[0]), 0x1b);
    assert.ok(build('sof 1.0, 0\n'.repeat(3) + '#extended\nrda 40000, 1.0\n').ok,
        'the pragma should work below the first instruction');
});

test('line numbers survive the pragma being blanked', () => {
    assert.match(build(EXT + 'rda 99999, 1.0\n').errors, /line 2/);
});

// ---- running it -----------------------------------------------------------
//
// The assembler and the core have to agree, and only running the pair shows it:
// a select bit read one way and written another passes both halves separately.

/** Assemble and load into a core, with the extension flag the source implies. */
function core(source) {
    const r = build(source);
    assert.ok(r.ok, r.errors);
    const c = new FV1Core();
    assert.ok(c.setProgram(r.asm.program, true, r.asm.extended), 'setProgram refused it');
    return c;
}

/** Run `n` samples of a constant input and collect DACL. */
function outputs(c, n, input = 0) {
    const seen = [];
    for (let i = 0; i < n; i++) {
        c.run(input, input);
        seen.push(c.getDACL());
    }
    return seen;
}

test('a delay past 32768 words needs the extended tank', () => {
    const src = EXT + 'mem d 40000\nrdax adcl, 1.0\nwra d, 0\nrda d#, 1.0\nwrax dacl, 0\n';
    const image = build(src).asm.program;

    const wide = new FV1Core();
    wide.setProgram(image, true, true);
    wide.run(0.5, 0);                       // the impulse goes in on sample 0
    for (let n = 1; n <= 40000; n++) wide.run(0, 0);
    assert.ok(Math.abs(wide.getDACL() - 0.5) < 2e-3,
        `expected the impulse back at 40000 samples, got ${wide.getDACL()}`);

    // The same image on a 15 bit tank: 40000 wraps to 7232, so it cannot come
    // back where it was written. This is the one thing the flag has to carry --
    // everything else about the extension reads out of the instruction words.
    const narrow = new FV1Core();
    narrow.setProgram(image, true, false);
    narrow.run(0.5, 0);
    for (let n = 1; n <= 40000; n++) narrow.run(0, 0);
    assert.ok(Math.abs(narrow.getDACL()) < 2e-3,
        `a 15 bit tank should not deliver it, got ${narrow.getDACL()}`);
});

test('RMPAX reaches the whole tank from a positive accumulator', () => {
    // RMPAX reads ADDR_PTR as ACC[22:7], so address 40000 is ACC = 40000 * 128
    // = 5120000 -- inside the accumulator's positive range. RMPA's ACC[23:8]
    // would need 10240000, which is past +1.0 and only writable as a negative
    // number: that is the seam RMPAX exists to remove.
    const marker = Math.floor(0x800000 / 2);
    for (const [mnemonic, expected] of [['rmpax', 40000], ['rmpa', 20000]]) {
        const c = core(EXT + `${mnemonic} 1.0\nwrax dacl, 0\n`);
        // delayPtr is 0 on the first sample, so a cell written here is the cell
        // the address names.
        c.delay[expected] = c.compress(marker);
        c.regs[c.ADDR_PTR] = 40000 * 128;
        c.run(0, 0);
        assert.ok(Math.abs(c.getDACL() - 0.5) < 0.01,
            `${mnemonic} should have read address ${expected}, got ${c.getDACL()}`);
    }
});

test('RAND fills a register without touching ACC', () => {
    // The accumulator carries the input past a RAND and comes out unchanged.
    const passthrough = core(EXT + 'rdax adcl, 1.0\nrand reg0, 1.0\nwrax dacl, 0\n');
    for (const v of outputs(passthrough, 8, 0.5)) {
        assert.ok(Math.abs(v - 0.5) < 1e-4, `RAND disturbed ACC: ${v}`);
    }

    const noise = outputs(core(EXT + 'rand reg0, 1.0\nrdax reg0, 1.0\nwrax dacl, 0\n'), 2000);
    assert.ok(noise.every((v) => v >= -1 && v < 1), 'RAND left the full scale range');
    assert.ok(new Set(noise).size > 1900, 'RAND repeated itself');
    const mean = noise.reduce((a, b) => a + b, 0) / noise.length;
    assert.ok(Math.abs(mean) < 0.05, `RAND is not centred: mean ${mean.toFixed(4)}`);

    // The coefficient is the amplitude, so a dither stays a dither.
    const dither = outputs(core(EXT + 'rand reg0, 0.002\nrdax reg0, 1.0\nwrax dacl, 0\n'), 500);
    assert.ok(dither.every((v) => Math.abs(v) <= 0.0021),
        `the coefficient did not scale it: peak ${Math.max(...dither.map(Math.abs))}`);

    // Deterministic: two fresh cores give the same sequence, so a run can be
    // compared against a previous one.
    assert.deepEqual(
        outputs(core(EXT + 'rand reg0, 1.0\nrdax reg0, 1.0\nwrax dacl, 0\n'), 16),
        noise.slice(0, 16));
});

test('an LFO above the FV-1\'s four runs, and only that one', () => {
    const sweep = (read) => outputs(core(
        EXT + `skp run, 1\nwlds sin2, 100, 16384\ncho rdal, ${read}\nwrax dacl, 0\n`), 12000);
    // At rate 100 the phase advances 100/131072 radians a sample, so a whole
    // cycle takes about 8200 -- long enough to see both halves of it.

    const own = sweep('sin2');
    assert.ok(Math.max(...own) > 0.9 && Math.min(...own) < -0.9,
        `SIN2 did not sweep: ${Math.min(...own).toFixed(3)} to ${Math.max(...own).toFixed(3)}`);

    // Loading SIN2 must not have written SIN0's registers -- they are eight
    // apart in the file, and reading the wrong one is the mistake worth
    // catching here.
    assert.ok(sweep('sin0').every((v) => v === 0), 'SIN2 drove SIN0');
});

test('a ramp above the FV-1\'s two runs on its own registers', () => {
    const ramp = (read) => outputs(core(
        EXT + `skp run, 1\nwldr rmp3, 16384, 4096\ncho rdal, ${read}\nwrax dacl, 0\n`), 3000);
    assert.ok(Math.max(...ramp('rmp3')) > 0.4, 'RMP3 did not run');
    assert.ok(ramp('rmp0').every((v) => v === 0), 'RMP3 drove RMP0');
});

test('POT3 to POT5 reach the core', () => {
    for (const [name, index] of [['pot3', 3], ['pot4', 4], ['pot5', 5]]) {
        const c = core(EXT + `rdax ${name}, 1.0\nwrax dacl, 0\n`);
        const pots = [0, 0, 0, 0, 0, 0];
        pots[index] = 1;
        // The pot filter is a one-pole at k = 0.002, so give it time to settle.
        for (let n = 0; n < 6000; n++) { c.setPots(pots); c.run(0, 0); }
        assert.ok(c.getDACL() > 0.99, `${name} read ${c.getDACL()}`);

        const other = new FV1Core();
        other.setProgram(build(EXT + `rdax ${name}, 1.0\nwrax dacl, 0\n`).asm.program, true, true);
        for (let n = 0; n < 6000; n++) { other.setPots([1, 1, 1, 0, 0, 0]); other.run(0, 0); }
        assert.ok(Math.abs(other.getDACL()) < 0.01,
            `${name} picked up one of POT0-POT2: ${other.getDACL()}`);
    }
});

// ---- the reference --------------------------------------------------------

test('every source above assembles the same as asfv1-extended', () => {
    if (!haveReference) {
        console.log(`      (skipped: no asfv1-extended at ${REFERENCE})`);
        return;
    }
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fv1ext-'));
    const spn = path.join(tmp, 't.spn');
    const bin = path.join(tmp, 't.bin');
    // A local copy: the reference usually lives in cloud storage, where reading
    // it once per source is most of the runtime.
    const asfv1 = path.join(tmp, 'asfv1.py');
    fs.copyFileSync(REFERENCE, asfv1);
    let compared = 0;
    const differ = [];

    recording = false;
    for (const source of sources) {
        fs.writeFileSync(spn, source);
        if (fs.existsSync(bin)) fs.unlinkSync(bin);
        const r = cp.spawnSync('python3', [asfv1, '-q', '-s', '-b', spn, bin],
            { encoding: 'utf8' });

        const mine = build(source);
        // Only images are comparable: a source either assembler rejects has
        // none, and the two disagree about wording, not about code.
        if (r.status !== 0 || !fs.existsSync(bin)) {
            if (mine.ok) differ.push([source, 'asfv1-extended rejected it, we did not']);
            continue;
        }
        if (!mine.ok) { differ.push([source, `we rejected it: ${mine.errors}`]); continue; }

        const ref = fs.readFileSync(bin);
        compared++;
        for (let i = 0; i < 128; i++) {
            const w = ref.readUInt32BE(i * 4);
            if (w !== mine.words[i]) {
                differ.push([source, `instruction ${i}: ` +
                    `${mine.words[i].toString(16).padStart(8, '0')} vs ` +
                    `${w.toString(16).padStart(8, '0')}`]);
                break;
            }
        }
    }
    fs.rmSync(tmp, { recursive: true, force: true });
    recording = true;

    assert.equal(differ.length, 0,
        differ.map(([s, d]) => `  ${JSON.stringify(s)}\n    ${d}`).join('\n'));
    console.log(`      (${compared} sources byte-identical to asfv1-extended)`);
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
