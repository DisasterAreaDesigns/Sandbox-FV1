// FV-1 DSP Core Emulator
//
// Executes assembled FV-1 machine code (the same 512-byte image that gets
// written to the EEPROM) one sample period at a time, so a program can be
// auditioned in the browser without hardware.
//
// Written from the FV-1 datasheet and the instruction encoding in
// assembler.js (generateMachineCode). ElmGen and SpinCAD-Designer are both
// GPL-3.0; no code from either project is used here, as this repo is MIT.
// They were consulted only to confirm two behaviours the datasheet leaves
// undocumented: that delay RAM stores a 14-bit floating point word, and that
// ACC is cleared at the start of each sample period.
//
// Arithmetic is integer-exact, not floating point approximation. ACC is a
// 24-bit signed integer where 0x7FFFFF == +1.0. Coefficient multiplies are
// done as (acc * coef) >> 14, and because a 24-bit x 16-bit product is at
// most 40 bits it fits exactly in a JS double -- so the results are
// bit-accurate without needing BigInt.
//
// Fidelity notes:
//   - ACC saturation, coefficient quantisation and delay RAM companding are
//     modelled exactly. These are what give the FV-1 its character.
//   - PACC is latched by every instruction that writes ACC, with the value ACC
//     held on entry, and becomes visible to the following instruction. Spin's
//     architecture overview calls it "the previous instruction's value", and
//     the RDFX -> WRLX / WRHX shelving idiom depends on it: RDFX puts the
//     filter input into PACC for the second instruction to work against.
//     SKP ZRC compares ACC against it to detect a zero crossing.
//   - LFO rates and amplitudes follow the equations in Spin's application
//     note AN-0001 (Basics of the LFOs in the FV-1) and are checked against
//     the worked examples in it, so sweep rates and depths match hardware.
//   - CHO interpolation is still behavioural. The fractional interpolation
//     between adjacent delay samples is only sketched in the documentation,
//     and ElmGen's own CHO simulation is marked unfinished. Chorus and
//     flange will sound right but may not be sample-identical.
//
// This class must stay self-contained (no references to anything outside
// itself) because fv1-sim.js stringifies it with toString() to build the
// AudioWorklet. That is what lets the simulator run from a file:// URL,
// where addModule() on a separate script file would be blocked by CORS.

class FV1Core {
    constructor() {
        this.PROG_LEN = 128;
        // The tank is always allocated at the extended size -- 128 KB, which is
        // nothing here -- and the mask is what decides how much of it a program
        // can see. An FV-1 program addresses 15 bits and wraps at 32768; one
        // built with '#extended' addresses 16 and wraps at 65536.
        this.DELAY_LEN = 65536;
        this.DELAY_MASK = 0x7FFF;        // the FV-1's, until setProgram says otherwise
        this.DELAY_MASK_EXT = 0xFFFF;
        this.extended = false;

        this.ACC_MAX = 0x7FFFFF;
        this.ACC_MIN = -0x800000;
        this.ONE = 0x800000;        // 1.0 in S.23

        // Register file addresses
        this.SIN0_RATE = 0x00; this.SIN0_RANGE = 0x01;
        this.SIN1_RATE = 0x02; this.SIN1_RANGE = 0x03;
        this.RMP0_RATE = 0x04; this.RMP0_RANGE = 0x05;
        this.RMP1_RATE = 0x06; this.RMP1_RANGE = 0x07;
        // SIN2/SIN3/RMP2/RMP3 fill 0x08-0x0f, the gap the FV-1 leaves between
        // RMP1_RANGE and POT0. Indexed by LFO number, so the four the chip has
        // and the four '#extended' adds are reached the same way.
        this.SIN_RATE = [0x00, 0x02, 0x08, 0x0a];
        this.SIN_RANGE = [0x01, 0x03, 0x09, 0x0b];
        this.RMP_RATE = [0x04, 0x06, 0x0c, 0x0e];
        this.RMP_RANGE = [0x05, 0x07, 0x0d, 0x0f];
        this.POT0 = 0x10; this.POT1 = 0x11; this.POT2 = 0x12;
        // Extended pots. Contiguous from 0x19, leaving 0x1c-0x1f for POT6-POT9.
        this.POT_REGS = [0x10, 0x11, 0x12, 0x19, 0x1a, 0x1b];
        this.ADCL = 0x14; this.ADCR = 0x15;
        // LED 1 and LED 2 read REG30 and REG31, the top two of the
        // general-purpose file. Nothing on the chip reserves them; this
        // follows the FV-2040, which drives two PWM lamps from the same pair.
        this.REG30 = 0x3E; this.REG31 = 0x3F;
        this.DACL = 0x16; this.DACR = 0x17;
        this.ADDR_PTR = 0x18;

        // Opcodes, matching the table in assembler.js
        this.OP_RDA = 0x00; this.OP_RMPA = 0x01; this.OP_WRA = 0x02;
        this.OP_WRAP = 0x03; this.OP_RDAX = 0x04; this.OP_RDFX = 0x05;
        this.OP_WRAX = 0x06; this.OP_WRHX = 0x07; this.OP_WRLX = 0x08;
        this.OP_MAXX = 0x09; this.OP_MULX = 0x0A; this.OP_LOG = 0x0B;
        this.OP_EXP = 0x0C; this.OP_SOF = 0x0D; this.OP_AND = 0x0E;
        this.OP_OR = 0x0F; this.OP_XOR = 0x10; this.OP_SKP = 0x11;
        this.OP_WLDX = 0x12; this.OP_JAM = 0x13; this.OP_CHO = 0x14;
        // Extended: the FV-1 assigns opcodes 0-20, so 21 up is unclaimed.
        this.OP_RAND = 0x15;
        // WLDS and WLDR share opcode 0x12. The decoder rewrites the ramp form
        // to this synthetic opcode so the two never have to be told apart by
        // a flag bit inside an operand field.
        this.OP_WLDR = 0x1F;

        // SKP condition flags
        this.SKP_RUN = 0x10; this.SKP_ZRC = 0x08; this.SKP_ZRO = 0x04;
        this.SKP_GEZ = 0x02; this.SKP_NEG = 0x01;

        // CHO flags
        this.CHO_COS = 0x01; this.CHO_REG = 0x02; this.CHO_COMPC = 0x04;
        this.CHO_COMPA = 0x08; this.CHO_RPTR2 = 0x10; this.CHO_NA = 0x20;

        this.SAMPLE_RATE = 32768;

        // Decoded program: parallel typed arrays keep the inner loop fast.
        this.iOp = new Int32Array(this.PROG_LEN);
        this.iA = new Int32Array(this.PROG_LEN);   // coefficient / mask
        this.iB = new Int32Array(this.PROG_LEN);   // address / register / offset
        this.iC = new Int32Array(this.PROG_LEN);   // flags / secondary operand
        this.iD = new Int32Array(this.PROG_LEN);   // CHO address / offset

        this.delay = new Int16Array(this.DELAY_LEN);  // holds compressed words
        this.regs = new Float64Array(64);
        this.hasProgram = false;

        this.reset();
    }

    // ---- helpers -------------------------------------------------------

    sext(value, bits) {
        const signBit = Math.pow(2, bits - 1);
        return (value & (signBit - 1)) - (value & signBit);
    }

    clamp24(v) {
        if (v > this.ACC_MAX) return this.ACC_MAX;
        if (v < this.ACC_MIN) return this.ACC_MIN;
        return v;
    }

    // ACC * S1.14 coefficient. Exact: the product never exceeds 2^40.
    mulS1_14(acc, coefRaw) {
        return this.clamp24(Math.floor(acc * this.sext(coefRaw, 16) / 16384));
    }

    // ACC * S1.9 coefficient (delay RAM instructions).
    mulS1_9(acc, coefRaw) {
        return this.clamp24(Math.floor(acc * this.sext(coefRaw, 11) / 512));
    }

    // ---- delay RAM companding -----------------------------------------
    //
    // Delay memory does not store linear 24-bit samples. Each word is a
    // 14-bit float: sign in bit 13, 4-bit exponent in bits 9-12, 9-bit
    // mantissa in bits 0-8. This is why long FV-1 delays and reverb tails
    // pick up their characteristic grain -- modelling it matters.

    compress(v) {
        // Clamp the magnitude rather than masking it. `& 0x7FFFFF` turned the
        // one value clamp24() produces on every negative overflow, -0x800000,
        // into a magnitude of zero, so a negatively clipped peak was stored as
        // silence instead of -1.0 -- an audible dropout wherever a delay line
        // or reverb tank is driven hard. 0x800000 still encodes cleanly, as
        // exponent 7 with a mantissa of 256.
        const mag = Math.min(Math.abs(v), this.ONE);
        if (mag === 0) return 0;
        // Shift so the mantissa occupies 9 bits with the MSB set.
        const bitLength = 32 - Math.clz32(mag);
        const shift = bitLength > 9 ? bitLength - 9 : 0;
        const exp = shift - 8;                       // -8..7, stored in 4 bits
        const mant = (mag >> shift) & 0x1FF;
        let word = ((exp & 0x0F) << 9) | mant;
        if (v < 0) word |= 0x2000;
        return word;
    }

    decompress(word) {
        const mant = word & 0x1FF;
        let exp = (word >> 9) & 0x0F;
        if (exp & 0x08) exp -= 16;                   // sign-extend 4 bits
        const mag = mant * Math.pow(2, exp + 8);
        return (word & 0x2000) ? -mag : mag;
    }

    // ---- program loading ----------------------------------------------

    // `resetState` false swaps the program in without clearing delay memory, so
    // a reverb tail carries across a hot reload while the source is edited.
    //
    // `extended` says the image was built with '#extended'. The 512 bytes carry
    // no pragma, so it has to be told: the assembler knows, and the simulator
    // passes it through. It widens the delay tank to 65536 words -- the only
    // thing that cannot be read out of the instruction words themselves, since
    // the extension only ever sets bits the FV-1 leaves at zero.
    setProgram(bytes, resetState = true, extended = false) {
        if (!bytes || bytes.length < 512) {
            this.hasProgram = false;
            return false;
        }
        this.extended = !!extended;
        this.DELAY_MASK = extended ? this.DELAY_MASK_EXT : 0x7FFF;
        for (let i = 0; i < this.PROG_LEN; i++) {
            const o = i * 4;
            // Big-endian, matching generateMachineCode()
            const word = ((bytes[o] << 24) | (bytes[o + 1] << 16) |
                          (bytes[o + 2] << 8) | bytes[o + 3]) >>> 0;
            this.decodeInstruction(i, word);
        }
        this.hasProgram = true;
        if (resetState) {
            this.reset();
        } else {
            // Keep the delay memory, but re-arm firstRun: the incoming program's
            // SKP RUN setup block has never executed, and would otherwise be
            // skipped for the rest of the session.
            this.firstRun = true;
        }
        return true;
    }

    decodeInstruction(i, word) {
        const op = word & 0x1F;
        this.iOp[i] = op;
        this.iA[i] = 0;
        this.iB[i] = 0;
        this.iC[i] = 0;

        switch (op) {
            case this.OP_RDA:
            case this.OP_WRA:
            case this.OP_WRAP:
                this.iA[i] = (word >>> 21) & 0x7FF;      // S1.9 coefficient
                // 16 bits unconditionally: bit 20 is the extension, and an
                // FV-1 program leaves it clear, so the same read serves both.
                this.iB[i] = (word >>> 5) & 0xFFFF;      // delay address
                break;

            case this.OP_RMPA:
                this.iA[i] = (word >>> 21) & 0x7FF;
                // Bit 5 is RMPAX: it reads ADDR_PTR as ACC[22:7] rather than
                // ACC[23:8], which keeps the sign bit out of the address.
                this.iB[i] = (word >>> 5) & 0x01;
                break;

            case this.OP_RAND:
                this.iA[i] = (word >>> 16) & 0xFFFF;     // S1.14 amplitude
                this.iB[i] = (word >>> 5) & 0x3F;        // destination register
                break;

            case this.OP_RDAX:
            case this.OP_RDFX:
            case this.OP_WRAX:
            case this.OP_WRHX:
            case this.OP_WRLX:
            case this.OP_MAXX:
                this.iA[i] = (word >>> 16) & 0xFFFF;     // S1.14 coefficient
                this.iB[i] = (word >>> 5) & 0x3F;        // register
                break;

            case this.OP_MULX:
                this.iB[i] = (word >>> 5) & 0x3F;
                break;

            case this.OP_SOF:
            case this.OP_EXP:
            case this.OP_LOG:
                this.iA[i] = (word >>> 16) & 0xFFFF;     // S1.14 multiplier
                this.iB[i] = (word >>> 5) & 0x7FF;       // S.10 (or S4.6) offset
                break;

            case this.OP_AND:
            case this.OP_OR:
            case this.OP_XOR:
                this.iA[i] = (word >>> 8) & 0xFFFFFF;    // 24-bit mask
                break;

            case this.OP_SKP:
                this.iA[i] = (word >>> 27) & 0x1F;       // condition mask
                this.iB[i] = (word >>> 21) & 0x3F;       // skip count
                break;

            case this.OP_WLDX:
                // WLDS and WLDR share opcode 0x12. The LFO select field tells
                // them apart: SIN0/SIN1 are 0b00/0b01 and RMP0/RMP1 are
                // 0b10/0b11, so bit 30 is set only for the ramp form.
                // The select is bit 29 with bit 31 above it, so 0-1 are the
                // FV-1's pair and 2-3 the two '#extended' adds. Bit 31 is clear
                // in every FV-1 program, so this read serves both.
                if ((word >>> 30) & 0x01) {
                    this.iOp[i] = this.OP_WLDR;
                    this.iA[i] = ((word >>> 29) & 0x01) |
                                 (((word >>> 31) & 0x01) << 1);  // ramp 0-3
                    this.iB[i] = (word >>> 13) & 0xFFFF;        // frequency
                    this.iC[i] = (word >>> 5) & 0x03;           // range code
                } else {
                    this.iA[i] = ((word >>> 29) & 0x01) |
                                 (((word >>> 31) & 0x01) << 1);  // sin 0-3
                    this.iB[i] = (word >>> 20) & 0x1FF;         // frequency
                    this.iC[i] = (word >>> 5) & 0x7FFF;         // amplitude
                }
                break;

            case this.OP_JAM:
                this.iA[i] = (word >>> 6) & 0x07;        // ramp LFO, 3 bits
                break;

            case this.OP_CHO:
                this.iA[i] = (word >>> 30) & 0x03;       // type
                this.iB[i] = (word >>> 21) & 0x07;       // LFO select, 3 bits
                this.iC[i] = (word >>> 24) & 0x3F;       // flags
                this.iD[i] = (word >>> 5) & 0xFFFF;      // address / offset
                break;

            default:
                break;
        }
    }

    // ---- state ---------------------------------------------------------

    reset() {
        this.acc = 0;
        this.pacc = 0;
        this.lr = 0;
        this.delayPtr = 0;
        this.firstRun = true;
        this.delay.fill(0);
        for (let i = 0; i < 64; i++) this.regs[i] = 0;

        // LFO phase / position. Rate and range live in the register file so
        // that programs can change them while running. Four of each: the FV-1
        // uses the first two, '#extended' the rest.
        this.sinPhase = [0, 0, 0, 0];
        this.rampPos = [0, 0, 0, 0];

        this.potSmooth = [0, 0, 0, 0, 0, 0];

        // RAND's source. Deterministic and seeded here, so a reset gives the
        // same noise again: the hardware draws from a ring oscillator, but a
        // simulator you can run twice and compare is worth more than one that
        // is unpredictable in the same way.
        this.randState = 0x2545F491;
    }

    // xorshift32, then taken as a uniform S.23 over [-1, 1).
    nextRandom() {
        let x = this.randState;
        x ^= x << 13; x >>>= 0;
        x ^= x >>> 17;
        x ^= x << 5;  x >>>= 0;
        this.randState = x;
        return (x >>> 8) - this.ONE;
    }

    // Pot inputs are heavily filtered on the real chip; smooth them so that
    // moving a control does not produce zipper noise. Takes an array so the
    // FV-1's three and the extended six are the same call.
    setPots(pots) {
        const k = 0.002;
        for (let i = 0; i < this.POT_REGS.length; i++) {
            const raw = pots.length > i ? pots[i] : 0;
            const target = Math.max(0, Math.min(1, raw));
            this.potSmooth[i] += (target - this.potSmooth[i]) * k;
            this.regs[this.POT_REGS[i]] = Math.floor(this.potSmooth[i] * this.ACC_MAX);
        }
    }

    // ---- LFOs ----------------------------------------------------------

    // Rate and range are read from the register file every sample rather than
    // latched when WLDS/WLDR runs. That matters: making an LFO pot-controlled
    // by writing SIN0_RATE or RMP0_RATE at runtime is a standard idiom, and
    // programs like flanger.spn declare WLDR with a rate of 0 and then drive
    // the rate register entirely from a pot.
    // Ka, the 15-bit amplitude coefficient. AN-0001: ACC[22:8] maps to the
    // amplitude field. Ka = N * 32767 / 16385 where N is the total delay
    // length, so the peak excursion either side of centre is Ka / 4 samples.
    // The app note's own example, wlds SIN0,5,16384, is documented as
    // "+/-4096 samples for a total delay requirement of 8193".
    // The range register as the S.23 number a sine LFO swings between, which
    // is Ka back in the accumulator's own units: 32767 reads as ~1.0, 16384
    // as 0.5. Both readings of a sine come from this one value, so the
    // amplitude can never be applied to one and not the other.
    sinRangeOf(i) {
        const ka = Math.floor(this.regs[this.SIN_RANGE[i]] / 256) & 0x7FFF;
        return ka * 256;
    }

    sinAmpOf(i) {
        // The delay-tap reading: the same range in delay samples, ten
        // fractional bits below it, which is Ka / 4 exactly.
        return this.sinRangeOf(i) / 1024;
    }

    rampAmpOf(i) {
        const code = this.regs[this.RMP_RANGE[i]];
        if (code === 3) return 512;
        if (code === 2) return 1024;
        if (code === 1) return 2048;
        return 4096;
    }

    // An LFO select code carries the kind in bit 1 and the extension in bit 2,
    // so 0-3 still mean what they did on the FV-1 and 4-7 are SIN2, SIN3, RMP2,
    // RMP3. These two turn a code into a kind and an index into the arrays
    // above.
    lfoIsSine(sel) { return (sel & 0x02) === 0; }
    lfoIndex(sel) { return (sel & 0x01) | ((sel >> 1) & 0x02); }

    updateLFOs() {
        for (let i = 0; i < 4; i++) {
            const rateReg = this.regs[this.SIN_RATE[i]];
            // AN-0001: ACC[22:14] maps to the 9-bit frequency field, and
            // Kf = 2^17 * (2*pi*f / R). Rearranged, the stored value is the
            // angular step in radians per sample divided by 2^17, giving
            // f = Kf * R / (2*pi * 2^17) - about 0 to 20 Hz over Kf 0..511.
            const freq = Math.floor(rateReg / 16384) & 0x1FF;
            this.sinPhase[i] += freq / 131072;
            if (this.sinPhase[i] > Math.PI * 2) this.sinPhase[i] -= Math.PI * 2;
            else if (this.sinPhase[i] < -Math.PI * 2) this.sinPhase[i] += Math.PI * 2;
        }

        for (let i = 0; i < 4; i++) {
            const rateReg = this.regs[this.RMP_RATE[i]];
            const amp = this.rampAmpOf(i);
            // The ramp carries 1024 sub-sample steps per sample of range.
            const step = Math.floor(rateReg / 256) / 16 / 1024;
            this.rampPos[i] -= step;
            if (amp > 0) {
                while (this.rampPos[i] >= amp) this.rampPos[i] -= amp;
                while (this.rampPos[i] < 0) this.rampPos[i] += amp;
            }
        }
    }

    // Returns the LFO output as a delay offset in samples (may be fractional)
    lfoOffset(sel, flags) {
        const n = this.lfoIndex(sel);
        if (this.lfoIsSine(sel)) {
            const phase = (flags & this.CHO_COS)
                ? this.sinPhase[n] + Math.PI / 2
                : this.sinPhase[n];
            let v = Math.sin(phase) * this.sinAmpOf(n);
            if (flags & this.CHO_COMPA) v = -v;
            return v;
        }
        const i = n;
        const amp = this.rampAmpOf(i);
        let pos = this.rampPos[i];
        if (flags & this.CHO_RPTR2) {
            pos = (pos + amp / 2) % amp;
        }
        if (flags & this.CHO_COMPA) pos = amp - pos;
        return pos;
    }

    // LFO value in S.23, used by CHO RDAL / CHO SOF. Neither kind is
    // normalised to full scale: both read out scaled by their range register.
    lfoValue(sel, flags) {
        const n = this.lfoIndex(sel);
        if (this.lfoIsSine(sel)) {
            const phase = (flags & this.CHO_COS)
                ? this.sinPhase[n] + Math.PI / 2
                : this.sinPhase[n];
            // Scaled by the amplitude register, not returned at full scale.
            // AN-0001's second example writes POT0 straight to SIN0_RANGE,
            // reads the oscillator with `cho rdal,SIN0` and sends it to DACL,
            // and describes POT0 as setting the amplitude of the wave seen on
            // a scope -- which a full-scale read makes impossible. The corpus
            // agrees: every program here that reads a sine this way declares
            // that LFO at 32767 and calls the result "+/-1", GA_DEMO_TREM
            // declares 16383 and calls it "+/-0.5", and pp-basic-wonky.spn
            // asks for "some small amount of wobble" from an amplitude of 15
            // and would otherwise get the whole delay line.
            return Math.floor(Math.sin(phase) * this.sinRangeOf(n));
        }
        // A ramp is not normalised to full scale. Its accumulator counts the
        // position in 1/1024 sample steps and CHO RDAL hands that raw count
        // straight to ACC, so the value read is position / 8192: a 4096
        // sample ramp reads 0 to 0.5, 2048 reads 0 to 0.25, and so on. Every
        // program that turns a ramp into a triangle relies on the 0 to 0.5
        // figure ("cho rdal,rmp0 / sof 1,-0.25 / absa"), and the servo idiom
        // that steers a ramp to a delay position relies on the same scale.
        return Math.floor(this.rampPos[n] * 1024);
    }

    // ---- delay RAM access ----------------------------------------------

    readDelay(addr) {
        const idx = (addr + this.delayPtr) & this.DELAY_MASK;
        const v = this.decompress(this.delay[idx]);
        this.lr = v;
        return v;
    }

    writeDelay(addr, value) {
        const idx = (addr + this.delayPtr) & this.DELAY_MASK;
        this.delay[idx] = this.compress(value);
    }

    // Crossfade coefficient supplied by a ramp LFO when the NA flag is set.
    // AN-0001: "the cross fade coefficient is 0 when read pointer one is at
    // the end of the delay and 1.0 when it is in the middle" - a triangle
    // across the ramp, not the ramp itself.
    xfadeCoef(sel) {
        if (this.lfoIsSine(sel)) return 0;      // NA is a ramp-only flag
        const i = this.lfoIndex(sel);
        const amp = this.rampAmpOf(i);
        if (amp <= 0) return 0;
        const norm = this.rampPos[i] / amp;     // 0..1 across the ramp
        return 1 - Math.abs(2 * norm - 1);
    }

    // ---- the sample loop ------------------------------------------------

    // Runs one full 128-instruction pass. adcL/adcR are floats in [-1, 1].
    // Returns nothing; read outputs with getDAC().
    run(adcL, adcR) {
        if (!this.hasProgram) return;

        // Round rather than truncate. This is a model boundary rather than chip
        // behaviour -- a real ADC hands over an integer and there is no float to
        // convert -- but flooring biases every input sample down by half an LSB,
        // where rounding leaves the error centred on zero. It also makes this
        // model agree bit for bit with an independent one.
        this.regs[this.ADCL] = this.clamp24(Math.round(adcL * this.ACC_MAX));
        this.regs[this.ADCR] = this.clamp24(Math.round(adcR * this.ACC_MAX));

        let pc = 0;
        let guard = 0;
        while (pc < this.PROG_LEN && guard++ < this.PROG_LEN * 2) {
            pc = this.step(pc);
        }

        // End of sample period. PACC is latched per instruction inside step()
        // and nothing clocks it at the sample boundary, so it is left alone
        // here; it carries the last latched value into the next pass.
        this.acc = 0;
        this.delayPtr = (this.delayPtr - 1) & this.DELAY_MASK;
        this.updateLFOs();
        this.firstRun = false;
    }

    getDACL() { return this.regs[this.DACL] / this.ACC_MAX; }
    getDACR() { return this.regs[this.DACR] / this.ACC_MAX; }

    // Lamp brightness, read the way the FV-2040 reads it: the register as
    // S1.23, 0 off and 1.0 full.
    //
    // Negative is off rather than rectified. Rectifying would double the rate
    // of anything bipolar and turn a sine into a triangle, silently, with no
    // way for a program to ask for the other behaviour. Clipping at zero is at
    // least predictable, and a program that wants the whole waveform folds it
    // itself -- `cho rdal,sin0 / sof 0.5,0.5 / wrax REG30,1.0`.
    //
    // The scale is linear for the same reason. An eye is not linear and a
    // gamma curve would look better on a first try, but then a program author
    // cannot predict what a value does; shaping a curve is two instructions
    // for a program that has a multiplier, so the simulator stays out of it.
    getLED(i) {
        const v = this.regs[i === 0 ? this.REG30 : this.REG31];
        if (!(v > 0)) return 0;
        return v > this.ACC_MAX ? 1 : v / this.ACC_MAX;
    }

    step(pc) {
        const op = this.iOp[pc];
        const a = this.iA[pc];
        const b = this.iB[pc];
        const c = this.iC[pc];

        // PACC holds the accumulator as it stood before the current
        // instruction. Latching happens at the end of the instruction, so the
        // value only becomes visible to the NEXT one -- which is what makes the
        // shelving pair work: RDFX leaves the filter input in PACC for the
        // following WRLX or WRHX to use. See the note above the class.
        const entryAcc = this.acc;

        switch (op) {
            case this.OP_SOF:
                this.acc = this.clamp24(this.mulS1_14(this.acc, a) +
                    this.sext(b, 11) * 8192);
                break;

            case this.OP_RDAX:
                this.acc = this.clamp24(this.acc + this.mulS1_14(this.regs[b], a));
                break;

            case this.OP_WRAX:
                this.regs[b] = this.acc;
                this.acc = this.mulS1_14(this.acc, a);
                break;

            case this.OP_RDFX: {
                // ACC = (ACC - REG) * C + REG
                const reg = this.regs[b];
                this.acc = this.clamp24(this.mulS1_14(this.clamp24(this.acc - reg), a) + reg);
                break;
            }

            case this.OP_WRHX: {
                // REG = ACC; ACC = ACC * C + PACC
                const prev = this.pacc;
                this.regs[b] = this.acc;
                this.acc = this.clamp24(this.mulS1_14(this.acc, a) + prev);
                break;
            }

            case this.OP_WRLX: {
                // REG = ACC; ACC = (PACC - ACC) * C + PACC
                const prev = this.pacc;
                this.regs[b] = this.acc;
                this.acc = this.clamp24(
                    this.mulS1_14(this.clamp24(prev - this.acc), a) + prev);
                break;
            }

            case this.OP_MAXX: {
                const scaled = Math.abs(this.mulS1_14(this.regs[b], a));
                this.acc = this.clamp24(Math.max(scaled, Math.abs(this.acc)));
                break;
            }

            case this.OP_MULX:
                // ACC = ACC * REG, both S.23
                this.acc = this.clamp24(
                    Math.floor(this.acc * this.regs[b] / this.ONE));
                break;

            case this.OP_RDA:
                this.acc = this.clamp24(this.acc + this.mulS1_9(this.readDelay(b), a));
                break;

            case this.OP_WRA:
                this.writeDelay(b, this.acc);
                this.acc = this.mulS1_9(this.acc, a);
                break;

            case this.OP_WRAP:
                this.writeDelay(b, this.acc);
                this.acc = this.clamp24(this.mulS1_9(this.acc, a) + this.lr);
                break;

            case this.OP_RMPA: {
                // RMPA takes the address from ACC[23:8]; RMPAX (bit 5) from
                // ACC[22:7], which leaves the accumulator's sign out of it so a
                // positive accumulator can reach the whole 64k tank. The price
                // is one bit of the interpolation fraction, which this model
                // discards either way.
                const scale = b ? 128 : 256;
                const addr = Math.floor(this.regs[this.ADDR_PTR] / scale) & this.DELAY_MASK;
                this.acc = this.clamp24(this.acc + this.mulS1_9(this.readDelay(addr), a));
                break;
            }

            case this.OP_RAND:
                // REG = a uniform sample scaled by the coefficient, which is
                // the amplitude. ACC is untouched.
                this.regs[b] = this.mulS1_14(this.nextRandom(), a);
                break;

            case this.OP_AND:
                this.acc = this.clamp24(this.sext((this.acc & a) & 0xFFFFFF, 24));
                break;

            case this.OP_OR:
                this.acc = this.clamp24(this.sext((this.acc | a) & 0xFFFFFF, 24));
                break;

            case this.OP_XOR:
                this.acc = this.clamp24(this.sext((this.acc ^ a) & 0xFFFFFF, 24));
                break;

            case this.OP_LOG: {
                // ACC = C * log2(|ACC|)/16 + D
                //
                // D is S.10, the same field SOF and EXP use, so it scales by
                // 2^13. It is not S4.6: that reading spans +/-16 while the
                // accumulator only holds +/-1, so 1921 of the 2048 codes would
                // saturate on arrival. asfv1 encodes all three offsets with its
                // S.10 parser and Spin's reference gives this constant as
                // -1.0 to +0.999.
                const mag = Math.abs(this.acc) / this.ONE;
                const lg = mag > 0 ? Math.log2(mag) / 16 : -1;
                const scaled = this.mulS1_14(Math.floor(lg * this.ONE), a);
                this.acc = this.clamp24(scaled + this.sext(b, 11) * 8192);
                break;
            }

            case this.OP_EXP: {
                // Inverse of LOG: ACC = C * 2^(ACC*16) + D  (D is S.10)
                const x = this.acc / this.ONE;
                const ex = Math.pow(2, x * 16);
                const scaled = this.mulS1_14(
                    this.clamp24(Math.floor(ex * this.ACC_MAX)), a);
                this.acc = this.clamp24(scaled + this.sext(b, 11) * 8192);
                break;
            }

            case this.OP_SKP: {
                let doSkip = false;
                if (a & this.SKP_RUN) doSkip = !this.firstRun;
                if (a & this.SKP_ZRC) {
                    doSkip = doSkip || ((this.acc < 0) !== (this.pacc < 0));
                }
                if (a & this.SKP_ZRO) doSkip = doSkip || (this.acc === 0);
                if (a & this.SKP_GEZ) doSkip = doSkip || (this.acc >= 0);
                if (a & this.SKP_NEG) doSkip = doSkip || (this.acc < 0);
                if (a === 0) doSkip = false;             // NOP / plain JMP
                if (a === 0 && b > 0) doSkip = true;     // JMP is SKP 0, n
                return pc + 1 + (doSkip ? b : 0);
            }

            // WLDS and WLDR write the rate and range registers and nothing
            // else. They do NOT reset the LFO phase. SPINAsm's own tables say
            // which instruction zeroes what: JAM's operation is written
            // "0 -> RAMP LFO N", while WLDS and WLDR have "See Description"
            // and describe themselves only as loading "frequency and
            // amplitude control values". A reset inside WLDR would make JAM
            // dead silicon, and there is no JAM at all for the sines, so a
            // reset hiding inside WLDS would be the one way to zero a sine
            // and would not have gone undocumented. The manual's SKP RUN
            // pairing is hedged as "typically", which it could not be if an
            // unguarded WLD pinned the LFO at zero.
            //
            // Invisible to the usual idiom: every program in spin-test/files
            // that loads an LFO guards it behind SKP RUN, so the WLD runs once
            // and a reset there is the same as no reset. Total for a program
            // that runs them unguarded -- pinned at zero versus free-running.
            case this.OP_WLDX: {
                // WLDS: load sine LFO rate and range into the registers.
                // AN-0001: ACC[22:14] holds Kf and ACC[22:8] holds Ka.
                const sel = a & 0x03;
                this.regs[this.SIN_RATE[sel]] = (b & 0x1FF) * 16384;
                this.regs[this.SIN_RANGE[sel]] = (c & 0x7FFF) * 256;
                break;
            }

            case this.OP_WLDR: {
                // WLDR: load ramp LFO rate and range into the registers
                const sel = a & 0x03;
                const rate = this.sext(b, 16);
                let rateReg = (Math.abs(rate) & 0x7FFF) * 256;
                if (rate < 0) rateReg = -rateReg;
                this.regs[this.RMP_RATE[sel]] = rateReg;
                this.regs[this.RMP_RANGE[sel]] = c & 0x03;
                break;
            }

            // The only instruction that zeroes a phase, and ramps only.
            case this.OP_JAM:
                this.rampPos[this.lfoIndex(a)] = 0;
                break;

            case this.OP_CHO: {
                const type = a;
                const sel = b;
                const flags = c;
                const arg = this.iD[pc];

                if (type === 0x00) {
                    // CHO RDA reads a SINGLE delay sample and scales it by a
                    // coefficient. The chip does not interpolate internally:
                    // a program issues two of these, at addr and addr+1 with
                    // COMPC on one of them, and the pair performs the linear
                    // interpolation described in AN-0001.
                    let addr, coef;
                    if (flags & this.CHO_NA) {
                        // Address used unmodified; the ramp supplies the
                        // crossfade coefficient instead of an offset.
                        addr = arg & 0xFFFF;
                        coef = this.xfadeCoef(sel);
                    } else {
                        const off = this.lfoOffset(sel, flags);
                        const base = Math.floor(off);
                        // 16 bits, unsigned: CHO's address field is already
                        // wide enough for the extended tank, and an FV-1
                        // program never sets the top bit.
                        addr = (arg & 0xFFFF) + base;
                        coef = off - base;              // fractional bits
                    }
                    if (flags & this.CHO_COMPC) coef = 1 - coef;
                    const sample = this.readDelay(addr & this.DELAY_MASK);
                    this.acc = this.clamp24(this.acc + Math.floor(sample * coef));
                } else if (type === 0x02) {
                    // CHO SOF: ACC = ACC * coefficient + D
                    let coef = (flags & this.CHO_NA)
                        ? this.xfadeCoef(sel)
                        : this.lfoValue(sel, flags) / this.ONE;
                    if (flags & this.CHO_COMPC) coef = 1 - coef;
                    this.acc = this.clamp24(
                        Math.floor(this.acc * coef) + this.sext(arg & 0x7FFF, 15) * 256);
                } else if (type === 0x03) {
                    // CHO RDAL: read LFO value into ACC
                    this.acc = this.clamp24(this.lfoValue(sel, flags));
                }
                break;
            }

            default:
                break;
        }

        // Every instruction that writes ACC latches PACC. SKP returns from
        // inside the switch above; WLDS, WLDR and JAM only touch the LFO
        // registers, and RAND only its destination register, so none of them
        // disturb it.
        if (op !== this.OP_WLDX && op !== this.OP_WLDR && op !== this.OP_JAM &&
            op !== this.OP_RAND) {
            this.pacc = entryAcc;
        }

        return pc + 1;
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = FV1Core;
}
