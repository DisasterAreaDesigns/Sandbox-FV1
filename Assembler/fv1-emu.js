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
//   - LFO rates and CHO interpolation are behavioural rather than bit-exact.
//     ElmGen's own CHO simulation is marked unfinished; the datasheet does
//     not fully specify the interpolation. Chorus/flange sweeps will sound
//     right but may not be sample-identical to hardware.
//
// This class must stay self-contained (no references to anything outside
// itself) because fv1-sim.js stringifies it with toString() to build the
// AudioWorklet. That is what lets the simulator run from a file:// URL,
// where addModule() on a separate script file would be blocked by CORS.

class FV1Core {
    constructor() {
        this.PROG_LEN = 128;
        this.DELAY_LEN = 32768;
        this.DELAY_MASK = 0x7FFF;

        this.ACC_MAX = 0x7FFFFF;
        this.ACC_MIN = -0x800000;
        this.ONE = 0x800000;        // 1.0 in S.23

        // Register file addresses
        this.SIN0_RATE = 0x00; this.SIN0_RANGE = 0x01;
        this.SIN1_RATE = 0x02; this.SIN1_RANGE = 0x03;
        this.RMP0_RATE = 0x04; this.RMP0_RANGE = 0x05;
        this.RMP1_RATE = 0x06; this.RMP1_RANGE = 0x07;
        this.POT0 = 0x10; this.POT1 = 0x11; this.POT2 = 0x12;
        this.ADCL = 0x14; this.ADCR = 0x15;
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
        const mag = Math.abs(v) & 0x7FFFFF;
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

    setProgram(bytes) {
        if (!bytes || bytes.length < 512) {
            this.hasProgram = false;
            return false;
        }
        for (let i = 0; i < this.PROG_LEN; i++) {
            const o = i * 4;
            // Big-endian, matching generateMachineCode()
            const word = ((bytes[o] << 24) | (bytes[o + 1] << 16) |
                          (bytes[o + 2] << 8) | bytes[o + 3]) >>> 0;
            this.decodeInstruction(i, word);
        }
        this.hasProgram = true;
        this.reset();
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
                this.iB[i] = (word >>> 5) & 0x7FFF;      // delay address
                break;

            case this.OP_RMPA:
                this.iA[i] = (word >>> 21) & 0x7FF;
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
                if ((word >>> 30) & 0x01) {
                    this.iA[i] = (word >>> 29) & 0x01;          // ramp 0 or 1
                    this.iB[i] = (word >>> 13) & 0xFFFF;        // frequency
                    this.iC[i] = 0x100 | ((word >>> 5) & 0x03); // 0x100 marks WLDR
                } else {
                    this.iA[i] = (word >>> 29) & 0x01;          // sin 0 or 1
                    this.iB[i] = (word >>> 20) & 0x1FF;         // frequency
                    this.iC[i] = (word >>> 5) & 0x7FFF;         // amplitude
                }
                break;

            case this.OP_JAM:
                this.iA[i] = (word >>> 6) & 0x03;
                break;

            case this.OP_CHO:
                this.iA[i] = (word >>> 30) & 0x03;       // type
                this.iB[i] = (word >>> 21) & 0x03;       // LFO select
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
        // that programs can change them while running.
        this.sinPhase = [0, 0];
        this.rampPos = [0, 0];

        this.potSmooth = [0, 0, 0];
    }

    // Pot inputs are heavily filtered on the real chip; smooth them so that
    // moving a control does not produce zipper noise.
    setPots(p0, p1, p2) {
        const targets = [p0, p1, p2];
        const k = 0.002;
        for (let i = 0; i < 3; i++) {
            const target = Math.max(0, Math.min(1, targets[i]));
            this.potSmooth[i] += (target - this.potSmooth[i]) * k;
            this.regs[this.POT0 + i] = Math.floor(this.potSmooth[i] * this.ACC_MAX);
        }
    }

    // ---- LFOs ----------------------------------------------------------

    // Rate and range are read from the register file every sample rather than
    // latched when WLDS/WLDR runs. That matters: making an LFO pot-controlled
    // by writing SIN0_RATE or RMP0_RATE at runtime is a standard idiom, and
    // programs like flanger.spn declare WLDR with a rate of 0 and then drive
    // the rate register entirely from a pot.
    sinAmpOf(i) {
        return Math.floor(this.regs[i === 0 ? this.SIN0_RANGE : this.SIN1_RANGE] / 256);
    }

    rampAmpOf(i) {
        const code = this.regs[i === 0 ? this.RMP0_RANGE : this.RMP1_RANGE];
        if (code === 3) return 512;
        if (code === 2) return 1024;
        if (code === 1) return 2048;
        return 4096;
    }

    updateLFOs() {
        for (let i = 0; i < 2; i++) {
            const rateReg = this.regs[i === 0 ? this.SIN0_RATE : this.SIN1_RATE];
            const freq = Math.floor(rateReg / 16384);            // >> 14
            this.sinPhase[i] += freq * 2 * Math.PI / 131072;
            if (this.sinPhase[i] > Math.PI * 2) this.sinPhase[i] -= Math.PI * 2;
            else if (this.sinPhase[i] < -Math.PI * 2) this.sinPhase[i] += Math.PI * 2;
        }

        for (let i = 0; i < 2; i++) {
            const rateReg = this.regs[i === 0 ? this.RMP0_RATE : this.RMP1_RATE];
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
        if (sel === 0 || sel === 1) {
            const phase = (flags & this.CHO_COS)
                ? this.sinPhase[sel] + Math.PI / 2
                : this.sinPhase[sel];
            let v = Math.sin(phase) * this.sinAmpOf(sel);
            if (flags & this.CHO_COMPA) v = -v;
            return v;
        }
        const i = sel - 2;
        const amp = this.rampAmpOf(i);
        let pos = this.rampPos[i];
        if (flags & this.CHO_RPTR2) {
            pos = (pos + amp / 2) % amp;
        }
        if (flags & this.CHO_COMPA) pos = amp - pos;
        return pos;
    }

    // Normalised LFO value in S.23, used by CHO RDAL / CHO SOF
    lfoValue(sel, flags) {
        if (sel === 0 || sel === 1) {
            const phase = (flags & this.CHO_COS)
                ? this.sinPhase[sel] + Math.PI / 2
                : this.sinPhase[sel];
            return Math.floor(Math.sin(phase) * this.ACC_MAX);
        }
        const i = sel - 2;
        const amp = this.rampAmpOf(i);
        const norm = amp > 0 ? this.rampPos[i] / amp : 0;
        return Math.floor(norm * this.ACC_MAX);
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

    // Fractionally interpolated read, for CHO RDA
    readDelayInterp(addr, frac) {
        const a = this.readDelay(addr);
        const b = this.readDelay(addr + 1);
        return Math.floor(a + (b - a) * frac);
    }

    // ---- the sample loop ------------------------------------------------

    // Runs one full 128-instruction pass. adcL/adcR are floats in [-1, 1].
    // Returns nothing; read outputs with getDAC().
    run(adcL, adcR) {
        if (!this.hasProgram) return;

        this.regs[this.ADCL] = this.clamp24(Math.floor(adcL * this.ACC_MAX));
        this.regs[this.ADCR] = this.clamp24(Math.floor(adcR * this.ACC_MAX));

        let pc = 0;
        let guard = 0;
        while (pc < this.PROG_LEN && guard++ < this.PROG_LEN * 2) {
            pc = this.step(pc);
        }

        // End of sample period
        this.pacc = this.acc;
        this.acc = 0;
        this.delayPtr = (this.delayPtr - 1) & this.DELAY_MASK;
        this.updateLFOs();
        this.firstRun = false;
    }

    getDACL() { return this.regs[this.DACL] / this.ACC_MAX; }
    getDACR() { return this.regs[this.DACR] / this.ACC_MAX; }

    step(pc) {
        const op = this.iOp[pc];
        const a = this.iA[pc];
        const b = this.iB[pc];
        const c = this.iC[pc];

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
                const addr = Math.floor(this.regs[this.ADDR_PTR] / 256) & this.DELAY_MASK;
                this.acc = this.clamp24(this.acc + this.mulS1_9(this.readDelay(addr), a));
                break;
            }

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
                // ACC = C * log2(|ACC|)/16 + D  (D is S4.6)
                const mag = Math.abs(this.acc) / this.ONE;
                const lg = mag > 0 ? Math.log2(mag) / 16 : -1;
                const scaled = this.mulS1_14(Math.floor(lg * this.ONE), a);
                this.acc = this.clamp24(scaled + this.sext(b, 11) * 131072);
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

            case this.OP_WLDX:
                if (c & 0x100) {
                    // WLDR: load ramp LFO rate and range into the registers
                    const sel = a & 0x01;
                    let rateReg = (this.sext(b, 16) & 0x7FFF) * 256;
                    if (this.sext(b, 16) < 0) rateReg = -rateReg;
                    this.regs[sel === 0 ? this.RMP0_RATE : this.RMP1_RATE] = rateReg;
                    this.regs[sel === 0 ? this.RMP0_RANGE : this.RMP1_RANGE] = c & 0x03;
                    this.rampPos[sel] = 0;
                } else {
                    // WLDS: load sine LFO rate and range into the registers
                    const sel = a & 0x01;
                    this.regs[sel === 0 ? this.SIN0_RATE : this.SIN1_RATE] = (b & 0x1FF) * 16384;
                    this.regs[sel === 0 ? this.SIN0_RANGE : this.SIN1_RANGE] = (c & 0x7FFF) * 256;
                    this.sinPhase[sel] = 0;
                }
                break;

            case this.OP_JAM:
                this.rampPos[a & 0x01] = 0;
                break;

            case this.OP_CHO: {
                const type = a;
                const sel = b;
                const flags = c;
                const arg = this.iD[pc];

                if (type === 0x00) {
                    // CHO RDA: interpolated delay read at LFO-modulated address
                    const off = this.lfoOffset(sel, flags);
                    const base = (arg & 0x7FFF) + Math.floor(off);
                    let frac = off - Math.floor(off);
                    if (flags & this.CHO_COMPC) frac = 1 - frac;
                    const sample = this.readDelayInterp(base & this.DELAY_MASK, frac);
                    this.acc = this.clamp24(this.acc + Math.floor(sample * frac));
                } else if (type === 0x02) {
                    // CHO SOF: ACC = ACC * lfo + D
                    let lfo = this.lfoValue(sel, flags) / this.ONE;
                    if (flags & this.CHO_COMPC) lfo = 1 - lfo;
                    this.acc = this.clamp24(
                        Math.floor(this.acc * lfo) + this.sext(arg & 0x7FFF, 15) * 256);
                } else if (type === 0x03) {
                    // CHO RDAL: read LFO value into ACC
                    this.acc = this.clamp24(this.lfoValue(sel, flags));
                }
                break;
            }

            default:
                break;
        }

        return pc + 1;
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = FV1Core;
}
