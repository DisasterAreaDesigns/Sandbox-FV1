// FV-1 Assembler JavaScript Port
class FV1Assembler {
    constructor(source, options = {}) {
        this.source = source.split('\n');
        this.clamp = options.clamp || false;
        this.spinReals = options.spinReals || false;

        // Constants
        this.PROGLEN = 128;
        this.DELAYSIZE = 32767;

        // Fixed point constants
        this.REF_S1_14 = Math.pow(2, 14);
        this.MIN_S1_14 = -2.0;
        this.MAX_S1_14 = (Math.pow(2, 15) - 1) / this.REF_S1_14;

        this.REF_S1_9 = Math.pow(2, 9);
        this.MIN_S1_9 = -2.0;
        this.MAX_S1_9 = (Math.pow(2, 10) - 1) / this.REF_S1_9;

        this.REF_S_10 = Math.pow(2, 10);
        this.MIN_S_10 = -1.0;
        this.MAX_S_10 = (Math.pow(2, 10) - 1) / this.REF_S_10;

        this.REF_S_15 = Math.pow(2, 15);
        this.MIN_S_15 = -1.0;
        this.MAX_S_15 = (Math.pow(2, 15) - 1) / this.REF_S_15;

        this.REF_S_23 = Math.pow(2, 23);
        this.MIN_S_23 = -1.0;
        this.MAX_S_23 = (Math.pow(2, 23) - 1) / this.REF_S_23;

        this.REF_S4_6 = Math.pow(2, 6); // 64
        this.MIN_S4_6 = -16.0; // S4.6 has 4 integer bits, so -2^4 = -16
        this.MAX_S4_6 = (Math.pow(2, 10) - 1) / this.REF_S4_6; // 1023/64 = 15.984375

        // Initialize state
        this.program = new Uint8Array(512);
        this.delaymem = 0;
        this.icnt = 0;
        this.errors = [];
        this.warnings = [];
        this.pl = [];
        this.symtbl = this.initSymbolTable();
        this.jmptbl = {};
        this.linebuf = [];
        this.sline = 0;
        this.sym = null;
        this.lastLfoName = null;

        // Instruction opcodes
        this.opcodes = {
            'RDA': 0b00000,
            'RMPA': 0b00001,
            'WRA': 0b00010,
            'WRAP': 0b00011,
            'RDAX': 0b00100,
            'RDFX': 0b00101,
            'LDAX': 0b00101,
            'WRAX': 0b00110,
            'WRHX': 0b00111,
            'WRLX': 0b01000,
            'MAXX': 0b01001,
            'ABSA': 0b01001,
            'MULX': 0b01010,
            'LOG': 0b01011,
            'EXP': 0b01100,
            'SOF': 0b01101,
            'AND': 0b01110,
            'CLR': 0b01110,
            'OR': 0b01111,
            'XOR': 0b10000,
            'NOT': 0b10000,
            'SKP': 0b10001,
            'JMP': 0b10001,
            'NOP': 0b10001,
            'WLDS': 0b10010,
            'WLDR': 0b10010,
            'JAM': 0b10011,
            'CHO': 0b10100,
            'RAW': 0b00000
        };
    }

    initSymbolTable() {
        return {
            'SIN0_RATE': 0x00,
            'SIN0_RANGE': 0x01,
            'SIN1_RATE': 0x02,
            'SIN1_RANGE': 0x03,
            'RMP0_RATE': 0x04,
            'RMP0_RANGE': 0x05,
            'RMP1_RATE': 0x06,
            'RMP1_RANGE': 0x07,
            'POT0': 0x10,
            'POT1': 0x11,
            'POT2': 0x12,
            'ADCL': 0x14,
            'ADCR': 0x15,
            'DACL': 0x16,
            'DACR': 0x17,
            'ADDR_PTR': 0x18,
            // Registers
            ...Array.from({
                length: 32
            }, (_, i) => [`REG${i}`, 0x20 + i]).reduce((a, [k, v]) => ({
                ...a,
                [k]: v
            }), {}),
            // Special values
            'SIN0': 0x00,
            'SIN1': 0x01,
            'RMP0': 0x02,
            'RMP1': 0x03,
            'COS0': 0x00,
            'COS1': 0x01, // added cosine, missing in original python ver
            'RDA': 0x00,
            'SOF': 0x02,
            'RDAL': 0x03,
            'SIN': 0x00,
            'COS': 0x01,
            'REG': 0x02,
            'COMPC': 0x04,
            'COMPA': 0x08,
            'RPTR2': 0x10,
            'NA': 0x20,
            'RUN': 0x10,
            'ZRC': 0x08,
            'ZRO': 0x04,
            'GEZ': 0x02,
            'NEG': 0x01
        };
    }

    error(msg, line = null) {
        const lineInfo = line !== null ? ` on line ${line}` : '';
        let errorMsg = `Error${lineInfo}: ${msg}`;

        // Add the source line text if available
        if (line !== null && line > 0 && line <= this.source.length) {
            const sourceText = this.source[line - 1].trim();
            if (sourceText) {
                errorMsg += `\n    ${sourceText}`;
            }
        }

        this.errors.push(errorMsg);
        debugLog(errorMsg, 'errors');
    }

    warn(msg, line = null) {
        const lineInfo = line !== null ? ` on line ${line}` : '';
        let warnMsg = `Warning${lineInfo}: ${msg}`;

        // Add the source line text if available
        if (line !== null && line > 0 && line <= this.source.length) {
            const sourceText = this.source[line - 1].trim();
            if (sourceText) {
                warnMsg += `\n    ${sourceText}`;
            }
        }

        this.warnings.push(warnMsg);
        debugLog(warnMsg, 'warnings');
    }

    // Replace the tokenize method with this corrected version:

    tokenize(line) {
        const tokens = [];
        let current = '';
        let inString = false;
        let i = 0;

        // Remove comments
        const commentIndex = line.indexOf(';');
        if (commentIndex >= 0) {
            line = line.substring(0, commentIndex);
        }

        while (i < line.length) {
            const char = line[i];

            if (inString) {
                current += char;
                if (char === '"' || char === "'") {
                    inString = false;
                    tokens.push(current);
                    current = '';
                }
            } else if (char === '"' || char === "'") {
                if (current) tokens.push(current);
                current = char;
                inString = true;
            } else if (/\s/.test(char)) {
                if (current) {
                    tokens.push(current);
                    current = '';
                }
            } else if (',:()+-*/&|^~!<>'.includes(char)) {
                // Always push current token before operator
                if (current) {
                    tokens.push(current);
                    current = '';
                }

                // Handle multi-char operators
                if (i + 1 < line.length) {
                    const next = line[i + 1];
                    if ((char === '<' && next === '<') ||
                        (char === '>' && next === '>') ||
                        (char === '*' && next === '*') ||
                        (char === '/' && next === '/')) {
                        tokens.push(char + next);
                        i += 2; // Skip both characters
                        continue;
                    }
                }

                // Push single character operator
                tokens.push(char);
            } else if (char === '.' && current === '' &&
                i + 1 < line.length && /\d/.test(line[i + 1])) {
                // This is a decimal number starting with .
                current = char;
            } else {
                current += char;
            }
            i++;
        }

        if (current) tokens.push(current);
        return tokens;
    }

    // Fixed nextSymbol function to handle each line independently
    nextSymbol() {
        this.sym = null;

        // If current line buffer is empty, move to next line
        if (this.linebuf.length === 0) {
            if (this.sline < this.source.length) {
                this.sline++;
                this.linebuf = this.tokenize(this.source[this.sline - 1]);
                // If the new line is also empty (no tokens), signal end of statement
                if (this.linebuf.length === 0) {
                    this.sym = {
                        type: 'EOL',
                        text: null,
                        value: 0
                    };
                    return;
                }
            } else {
                this.sym = {
                    type: 'EOF',
                    text: null,
                    value: 0
                };
                return;
            }
        }

        // Process tokens from current line only
        if (this.linebuf.length > 0) {
            const text = this.linebuf.shift();
            const upper = text.toUpperCase();

            if (this.opcodes.hasOwnProperty(upper)) {
                this.sym = {
                    type: 'MNEMONIC',
                    text,
                    upper,
                    value: 0
                };
            } else if (upper === 'EQU' || upper === 'MEM') {
                this.sym = {
                    type: 'ASSEMBLER',
                    text,
                    upper,
                    value: 0
                };
            } else if (',:()+-*/&|^~!<>'.includes(text) || text === '<<' || text === '>>' || text === '**' || text === '//' || text === '<' || text === '>') {
                this.sym = {
                    type: 'OPERATOR',
                    text,
                    upper: text,
                    value: 0
                };
            } else if (text.startsWith('$')) {
                // Hex number
                const hex = text.substring(1).replace(/_/g, '');
                const value = parseInt(hex, 16) || 0;
                this.sym = {
                    type: 'INTEGER',
                    text,
                    upper: text,
                    value
                };
            } else if (text.startsWith('%')) {
                // Binary number
                const bin = text.substring(1).replace(/_/g, '');
                const value = parseInt(bin, 2) || 0;
                this.sym = {
                    type: 'INTEGER',
                    text,
                    upper: text,
                    value
                };
            } else if (/^-?\d/.test(text) || text.startsWith('.')) {
                // Number (int or float) - handle negative numbers and decimals starting with .
                if (text.includes('.') || text.toLowerCase().includes('e') || text.startsWith('.')) {
                    const value = parseFloat(text) || 0;
                    this.sym = {
                        type: 'FLOAT',
                        text,
                        upper: text,
                        value
                    };
                } else if (this.spinReals && (text === '1' || text === '2')) {
                    // SpinASM compatibility
                    const value = parseFloat(text);
                    this.sym = {
                        type: 'FLOAT',
                        text,
                        upper: text,
                        value
                    };
                } else {
                    let value = 0;
                    if (text.startsWith('0x')) {
                        value = parseInt(text, 16) || 0;
                    } else if (text.startsWith('0b')) {
                        value = parseInt(text.substring(2), 2) || 0;
                    } else {
                        value = parseInt(text, 10) || 0;
                    }
                    this.sym = {
                        type: 'INTEGER',
                        text,
                        upper: text,
                        value
                    };
                }
            } else if (/^[A-Za-z_]/.test(text)) {
                // Label or name - check if next token is ':'
                if (this.linebuf.length > 0 && this.linebuf[0] === ':') {
                    this.linebuf.shift(); // consume the ':'
                    this.sym = {
                        type: 'LABEL',
                        text,
                        upper,
                        value: null
                    };
                } else {
                    let modifier = '';
                    if (this.linebuf.length > 0 && (this.linebuf[0] === '^' || this.linebuf[0] === '#')) {
                        const nextSym = upper + this.linebuf[0];
                        if (this.symtbl.hasOwnProperty(nextSym)) {
                            modifier = this.linebuf.shift();
                        }
                    }
                    this.sym = {
                        type: 'NAME',
                        text: text + modifier,
                        upper: upper + modifier,
                        value: 0
                    };
                }
            }
        }

        // If we still don't have a symbol and the line buffer is empty, signal end of line
        if (!this.sym && this.linebuf.length === 0) {
            this.sym = {
                type: 'EOL',
                text: null,
                value: 0
            };
        }
    }

    // Updated accept method to handle EOL tokens
    accept(type, message = null) {
        if (type === 'OPERATOR' && this.sym.type === 'OPERATOR' && this.sym.text === ',') {
            this.nextSymbol();
        } else if (this.sym.type === type) {
            this.nextSymbol();
        } else {
            if (message) {
                this.error(message, this.sline);
            } else {
                // Handle case where we hit end of line unexpectedly
                if (this.sym.type === 'EOL') {
                    this.error(`Unexpected end of line, expected ${type}`, this.sline);
                } else {
                    this.error(`Expected ${type} but got ${this.sym.type} "${this.sym.text}"`, this.sline);
                }
            }
        }
    }

    // Updated parseExpression to handle EOL tokens
    parseExpression() {
        // Handle missing operands (SpinASM compatibility and CHO blank arguments)
        if (this.sym.type === 'OPERATOR' && this.sym.text === ',') {
            this.warn('Missing argument replaced with 0', this.sline);
            return 0;
        }
        if (['ASSEMBLER', 'EOF', 'EOL', 'MNEMONIC', 'LABEL'].includes(this.sym.type)) {
            if (this.sym.type === 'EOL') {
                this.error('Unexpected end of line in expression', this.sline);
            } else {
                this.error(`Unexpected ${this.sym.type}`, this.sline);
            }
            return 0;
        }
        return this.parseOrExpr();
    }

    parseOrExpr() {
        let left = this.parseXorExpr();
        while (this.sym.type === 'OPERATOR' && this.sym.text === '|') {
            this.nextSymbol();
            const right = this.parseXorExpr();
            left = (left | right) >>> 0;
        }
        return left;
    }

    parseXorExpr() {
        let left = this.parseAndExpr();
        while (this.sym.type === 'OPERATOR' && this.sym.text === '^') {
            this.nextSymbol();
            const right = this.parseAndExpr();
            left = (left ^ right) >>> 0;
        }
        return left;
    }

    parseAndExpr() {
        let left = this.parseShiftExpr();
        while (this.sym.type === 'OPERATOR' && this.sym.text === '&') {
            this.nextSymbol();
            const right = this.parseShiftExpr();
            left = (left & right) >>> 0;
        }
        return left;
    }

    parseShiftExpr() {
        let left = this.parseAddExpr();
        while (this.sym.type === 'OPERATOR' && (this.sym.text === '<<' || this.sym.text === '>>' || this.sym.text === '<' || this.sym.text === '>')) {
            const op = this.sym.text;
            this.nextSymbol();
            const right = this.parseAddExpr();
            if (op === '<<' || op === '<') {
                left = (left << right) >>> 0;
            } else {
                left = (left >>> right);
            }
        }
        return left;
    }

    parseAddExpr() {
        let left = this.parseMulExpr();
        while (this.sym.type === 'OPERATOR' && (this.sym.text === '+' || this.sym.text === '-')) {
            const op = this.sym.text;
            this.nextSymbol();
            const right = this.parseMulExpr();
            if (op === '+') {
                left = left + right;
            } else {
                left = left - right;
            }
        }
        return left;
    }

    parseMulExpr() {
        let left = this.parseUnaryExpr();
        while (this.sym.type === 'OPERATOR' && (this.sym.text === '*' || this.sym.text === '/' || this.sym.text === '//')) {
            const op = this.sym.text;
            this.nextSymbol();
            const right = this.parseUnaryExpr();
            if (op === '*') {
                left = left * right;
            } else if (op === '//') {
                left = Math.floor(left / right);
            } else {
                left = left / right;
            }
        }
        return left;
    }

    parseUnaryExpr() {
        if (this.sym.type === 'OPERATOR' && (this.sym.text === '+' || this.sym.text === '-' || this.sym.text === '~' || this.sym.text === '!')) {
            const op = this.sym.text;
            this.nextSymbol();
            const value = this.parseUnaryExpr();
            if (op === '-') {
                return -value;
            } else if (op === '~' || op === '!') {
                return (~value) >>> 0;
            }
            return value;
        } else if (this.sym.upper === 'INT') {
            this.nextSymbol();
            return Math.round(this.parseUnaryExpr());
        }
        return this.parsePowerExpr();
    }

    parsePowerExpr() {
        let left = this.parseAtom();
        if (this.sym.type === 'OPERATOR' && this.sym.text === '**') {
            this.nextSymbol();
            const right = this.parseUnaryExpr();
            return Math.pow(left, right);
        }
        return left;
    }

    parseAtom() {
        if (this.sym.type === 'INTEGER' || this.sym.type === 'FLOAT') {
            const value = this.sym.value;
            this.nextSymbol();
            return value;
        } else if (this.sym.type === 'NAME') {
            const fullName = this.sym.upper;
            let baseName = fullName.replace(/[#^]$/, ''); // Remove modifiers for lookup
            let value = 0;

            // First check if the full name (with modifier) exists
            if (this.symtbl.hasOwnProperty(fullName)) {
                value = this.symtbl[fullName];
            } else if (this.symtbl.hasOwnProperty(baseName)) {
                // Check base name
                value = this.symtbl[baseName];
                // Apply modifiers if they exist in symbol table
                if (fullName.endsWith('#') && this.symtbl.hasOwnProperty(baseName + '#')) {
                    value = this.symtbl[baseName + '#'];
                } else if (fullName.endsWith('^') && this.symtbl.hasOwnProperty(baseName + '^')) {
                    value = this.symtbl[baseName + '^'];
                }
            } else {
                this.error(`Undefined symbol: ${this.sym.text}`, this.sline);
                this.nextSymbol();
                return 0;
            }

            // Handle symbol dereferencing - if value is a string, resolve it recursively
            const seen = new Set();
            while (typeof value === 'string') {
                if (seen.has(value)) {
                    this.error(`Circular definition of symbol ${fullName}`, this.sline);
                    this.nextSymbol();
                    return 0;
                }
                seen.add(value);
                if (this.symtbl.hasOwnProperty(value)) {
                    value = this.symtbl[value];
                } else {
                    this.error(`Undefined symbol in chain: ${value}`, this.sline);
                    this.nextSymbol();
                    return 0;
                }
            }

            this.nextSymbol();
            return value;
        } else if (this.sym.type === 'OPERATOR' && this.sym.text === '(') {
            this.nextSymbol();
            const value = this.parseExpression();
            if (this.sym.type === 'OPERATOR' && this.sym.text === ')') {
                this.nextSymbol();
            } else {
                this.error('Expected closing parenthesis', this.sline);
            }
            return value;
        }

        this.error(`Invalid expression starting with ${this.sym.type} "${this.sym.text}"`, this.sline);
        return 0;
    }

    parseRegister(mnemonic = '') {
        const reg = Math.floor(this.parseExpression());
        if (reg < 0 || reg > 63) {
            this.error(`Register ${reg} out of range for ${mnemonic}`, this.sline);
            return 0;
        }
        return reg;
    }


    parseS1_14(mnemonic = '') {
        let arg = this.parseExpression();
        if (Number.isInteger(arg)) {
            if (arg >= -2 && arg <= 1) {
                arg = Math.floor(arg * this.REF_S1_14);
            } else {
                if (this.clamp) {
                    arg = Math.max(this.MIN_S1_14, Math.min(this.MAX_S1_14, arg));
                    this.warn(`S1.14 arg clamped to ${arg} for ${mnemonic}`, this.sline);
                    arg = Math.floor(arg * this.REF_S1_14);
                } else {
                    this.error(`S1.14 arg ${arg} out of range (-2 to ${this.MAX_S1_14}) for ${mnemonic}`, this.sline);
                    arg = 0;
                }
            }
        } else {
            if (arg < this.MIN_S1_14 || arg > this.MAX_S1_14) {
                if (this.clamp) {
                    arg = Math.max(this.MIN_S1_14, Math.min(this.MAX_S1_14, arg));
                    this.warn(`S1.14 arg clamped to ${arg} for ${mnemonic}`, this.sline);
                } else {
                    this.error(`S1.14 arg ${arg} out of range for ${mnemonic}`, this.sline);
                    arg = 0;
                }
            }
            arg = Math.floor(arg * this.REF_S1_14);
        }
        return arg & 0xFFFF;
    }

    parseS1_9(mnemonic = '') {
        let arg = this.parseExpression();
        if (Number.isInteger(arg)) {
            if (arg >= -2 && arg <= 1) {
                arg = Math.round(arg * this.REF_S1_9);
            } else {
                if (this.clamp) {
                    arg = Math.max(this.MIN_S1_9, Math.min(this.MAX_S1_9, arg));
                    this.warn(`S1.9 arg clamped to ${arg} for ${mnemonic}`, this.sline);
                    arg = Math.floor(arg * this.REF_S1_9);
                } else {
                    this.error(`S1.9 arg ${arg} out of range (-2 to ${this.MAX_S1_9}) for ${mnemonic}`, this.sline);
                    arg = 0;
                }
            }
        } else {
            if (arg < this.MIN_S1_9 || arg > this.MAX_S1_9) {
                if (this.clamp) {
                    arg = Math.max(this.MIN_S1_9, Math.min(this.MAX_S1_9, arg));
                    this.warn(`S1.9 arg clamped to ${arg} for ${mnemonic}`, this.sline);
                } else {
                    this.error(`S1.9 arg ${arg} out of range for ${mnemonic}`, this.sline);
                    arg = 0;
                }
            }
            arg = Math.floor(arg * this.REF_S1_9);
        }
        return arg & 0x7FF;
    }

    parseS_10(mnemonic = '') {
        let arg = this.parseExpression();
        if (Number.isInteger(arg)) {
            if (arg >= -1 && arg <= 0) {
                arg = Math.floor(arg * this.REF_S_10);
            } else {
                if (this.clamp) {
                    arg = Math.max(this.MIN_S_10, Math.min(this.MAX_S_10, arg));
                    this.warn(`S.10 arg clamped to ${arg} for ${mnemonic}`, this.sline);
                    arg = Math.floor(arg * this.REF_S_10);
                } else {
                    this.error(`S.10 arg ${arg} out of range (-1 to ${this.MAX_S_10}) for ${mnemonic}`, this.sline);
                    arg = 0;
                }
            }
        } else {
            if (arg < this.MIN_S_10 || arg > this.MAX_S_10) {
                if (this.clamp) {
                    arg = Math.max(this.MIN_S_10, Math.min(this.MAX_S_10, arg));
                    this.warn(`S.10 arg clamped to ${arg} for ${mnemonic}`, this.sline);
                } else {
                    this.error(`S.10 arg ${arg} out of range for ${mnemonic}`, this.sline);
                    arg = 0;
                }
            }
            arg = Math.floor(arg * this.REF_S_10);
        }
        return arg & 0x7FF;
    }

    parseS_15(mnemonic = '') {
        let arg = this.parseExpression();
        if (Number.isInteger(arg)) {
            // For integers, check if they're delay addresses or need conversion
            if (arg >= 0 && arg <= 32767) {
                // Treat as delay address, no conversion needed
                return arg & 0xFFFF;
            } else if (arg >= -32768 && arg <= 32767) {
                // Treat as signed integer delay address
                return arg & 0xFFFF;
            } else {
                // Out of range integer
                if (this.clamp) {
                    arg = Math.max(-32768, Math.min(32767, arg));
                    this.warn(`S.15 arg clamped to ${arg} for ${mnemonic}`, this.sline);
                    return arg & 0xFFFF;
                } else {
                    this.error(`S.15 arg ${arg} out of range for ${mnemonic}`, this.sline);
                    return 0;
                }
            }
        } else {
            // For floats, use the fractional conversion
            if (arg < this.MIN_S_15 || arg > this.MAX_S_15) {
                if (this.clamp) {
                    arg = Math.max(this.MIN_S_15, Math.min(this.MAX_S_15, arg));
                    this.warn(`S.15 arg clamped to ${arg} for ${mnemonic}`, this.sline);
                } else {
                    this.error(`S.15 arg ${arg} out of range for ${mnemonic}`, this.sline);
                    arg = 0;
                }
            }
            arg = Math.floor(arg * this.REF_S_15);
            return arg & 0xFFFF;
        }
    }

    parseS_23(mnemonic = '') {
        let arg = this.parseExpression();
        if (Number.isInteger(arg)) {
            // For integers, check against 24-bit mask range
            if (arg < 0 || arg > 0xFFFFFF) {
                if (this.clamp) {
                    arg = Math.max(0, Math.min(0xFFFFFF, arg));
                    this.warn(`S.23 arg clamped to 0x${arg.toString(16)} for ${mnemonic}`, this.sline);
                } else {
                    this.error(`S.23 arg 0x${arg.toString(16)} out of range for ${mnemonic}`, this.sline);
                    arg = 0;
                }
            }
            // Integer values are used directly as masks
        } else {
            // For floats, check against fractional range and convert
            if (arg < this.MIN_S_23 || arg > this.MAX_S_23) {
                if (this.clamp) {
                    arg = Math.max(this.MIN_S_23, Math.min(this.MAX_S_23, arg));
                    this.warn(`S.23 arg clamped to ${arg} for ${mnemonic}`, this.sline);
                } else {
                    this.error(`S.23 arg ${arg} out of range for ${mnemonic}`, this.sline);
                    arg = 0;
                }
            }
            arg = Math.floor(arg * this.REF_S_23);
        }
        return arg & 0xFFFFFF;
    }

    parseS4_6(mnemonic = '') {
        let arg = this.parseExpression();
        if (Number.isInteger(arg)) {
            if (arg >= -16 && arg <= 15) {
                arg = Math.floor(arg * this.REF_S4_6);
            } else {
                if (this.clamp) {
                    arg = Math.max(this.MIN_S4_6, Math.min(this.MAX_S4_6, arg));
                    this.warn(`S4.6 arg clamped to ${arg} for ${mnemonic}`, this.sline);
                    arg = Math.floor(arg * this.REF_S4_6);
                } else {
                    this.error(`S4.6 arg ${arg} out of range (-16 to ${this.MAX_S4_6}) for ${mnemonic}`, this.sline);
                    arg = 0;
                }
            }
        } else {
            if (arg < this.MIN_S4_6 || arg > this.MAX_S4_6) {
                if (this.clamp) {
                    arg = Math.max(this.MIN_S4_6, Math.min(this.MAX_S4_6, arg));
                    this.warn(`S4.6 arg clamped to ${arg} for ${mnemonic}`, this.sline);
                } else {
                    this.error(`S4.6 arg ${arg} out of range for ${mnemonic}`, this.sline);
                    arg = 0;
                }
            }
            arg = Math.floor(arg * this.REF_S4_6);
        }
        return arg & 0x7FF;
    }

    parseDelayAddress(mnemonic = '') {
        let addr = this.parseExpression();
        
        // Check if this is a fractional value that should be converted
        if (addr >= this.MIN_S_15 && addr <= this.MAX_S_15) {
            // This is a fractional value, convert it
            addr = Math.round(addr * this.REF_S_15);
        } else {
            // This is an integer delay address, use as-is but validate range
            addr = Math.round(addr);
            if (addr < -0x8000 || addr > 0x7FFF) {
                if (this.clamp) {
                    addr = Math.max(-0x8000, Math.min(0x7FFF, addr));
                    this.warn(`Address clamped to 0x${(addr & 0xFFFF).toString(16)} for ${mnemonic}`, this.sline);
                } else {
                    this.error(`Invalid address 0x${(addr & 0xFFFF).toString(16)} for ${mnemonic}`, this.sline);
                    addr = 0;
                }
            }
        }
        return addr & 0x7FFF;
    }

    parseOffset(mnemonic = '') {
        const offset = Math.floor(this.parseExpression());
        if (offset < 0 || offset > 0x3F) {
            this.error(`Offset ${offset} out of range for ${mnemonic}`, this.sline);
            return 0;
        }
        return offset;
    }

    parseCondition(mnemonic = '') {
        const cond = Math.floor(this.parseExpression());
        if (cond < 0 || cond > 0x1F) {
            this.error(`Condition 0x${cond.toString(16)} out of range for ${mnemonic}`, this.sline);
            return 0;
        }
        return cond;
    }

    parseLFO(mnemonic = '') {
        const lfoName = this.sym.upper;
        this.lastLfoName = lfoName; // Store for CHO RDAL flag determination

        let lfo = Math.floor(this.parseExpression());

        // Handle special case: COS0 and COS1 map to SIN0 and SIN1 LFO numbers
        if (lfoName === 'COS0') {
            lfo = 0;
        } else if (lfoName === 'COS1') {
            lfo = 1;
        }

        // Allow 0-3 for normal LFOs, and 8-9 for COS LFOs in CHO RDAL
        if ((lfo >= 0 && lfo <= 3) || (mnemonic === 'CHO' && (lfo === 8 || lfo === 9))) {
            return lfo;
        } else {
            this.error(`Invalid LFO ${lfo} for ${mnemonic}`, this.sline);
            return 0;
        }
    }

    getChoRdalFlags(lfo) {
        // For CHO RDAL, determine flags based on the LFO name used or numeric value
        const lfoName = this.lastLfoName;
        if (lfoName === 'COS0' || lfoName === 'COS1' || lfo === 8 || lfo === 9) {
            return 0x03; // COS flag (0x01) + base RDAL flag (0x02)
        } else {
            return 0x02; // Default SIN flag (0x00) + base RDAL flag (0x02)  
        }
    }

    parseInstruction() {
        const mnemonic = this.sym.upper;
        this.accept('MNEMONIC');

        if (this.icnt >= this.PROGLEN) {
            this.error(`Max program length exceeded by ${mnemonic}`, this.sline);
            return;
        }

        switch (mnemonic) {
            case 'AND':
            case 'OR':
            case 'XOR': {
                const mask = this.parseS_23(mnemonic);
                this.pl.push({
                    cmd: [mnemonic, mask],
                    addr: this.icnt
                });
                this.icnt++;
                break;
            }

            case 'SOF': {
                const mult = this.parseS1_14(mnemonic);
                this.accept('OPERATOR', 'Expected comma');
                const offset = this.parseS_10(mnemonic);
                this.pl.push({
                    cmd: [mnemonic, mult, offset],
                    addr: this.icnt
                });
                this.icnt++;
                break;
            }

            case 'EXP': {
                const mult = this.parseS1_14(mnemonic);
                this.accept('OPERATOR', 'Expected comma');
                const offset = this.parseS_10(mnemonic);
                this.pl.push({
                    cmd: [mnemonic, mult, offset],
                    addr: this.icnt
                });
                this.icnt++;
                break;
            }

            case 'LOG': {
                const mult = this.parseS1_14(mnemonic);
                this.accept('OPERATOR', 'Expected comma');
                const offset = this.parseS4_6(mnemonic);
                this.pl.push({
                    cmd: [mnemonic, mult, offset],
                    addr: this.icnt
                });
                this.icnt++;
                break;
            }

            case 'RDAX':
            case 'WRAX':
            case 'MAXX':
            case 'RDFX':
            case 'WRLX':
            case 'WRHX': {
                const reg = this.parseRegister(mnemonic);
                this.accept('OPERATOR', 'Expected comma');
                const mult = this.parseS1_14(mnemonic);
                this.pl.push({
                    cmd: [mnemonic, reg, mult],
                    addr: this.icnt
                });
                this.icnt++;
                break;
            }

            case 'MULX': {
                const reg = this.parseRegister(mnemonic);
                this.pl.push({
                    cmd: [mnemonic, reg],
                    addr: this.icnt
                });
                this.icnt++;
                break;
            }

            case 'RDA':
            case 'WRA':
            case 'WRAP': {
                const addr = this.parseDelayAddress(mnemonic);
                this.accept('OPERATOR', 'Expected comma');
                const mult = this.parseS1_9(mnemonic);
                this.pl.push({
                    cmd: [mnemonic, addr, mult],
                    addr: this.icnt
                });
                this.icnt++;
                break;
            }

            case 'RMPA': {
                const mult = this.parseS1_9(mnemonic);
                this.pl.push({
                    cmd: [mnemonic, mult],
                    addr: this.icnt
                });
                this.icnt++;
                break;
            }

            case 'SKP': {
                const condition = this.parseCondition(mnemonic);
                this.accept('OPERATOR', 'Expected comma');
                let target = null;
                let offset = 0;
                const sourceLine = this.sline;

                if (this.sym.type === 'NAME') {
                    target = this.sym.upper;
                    this.accept('NAME');
                } else {
                    offset = this.parseOffset(mnemonic);
                }

                this.pl.push({
                    cmd: ['SKP', condition, offset],
                    target: target,
                    addr: this.icnt,
                    line: sourceLine
                });
                this.icnt++;
                break;
            }

            case 'WLDS': {
                const lfo = this.parseLFO(mnemonic) & 0x01;
                this.accept('OPERATOR', 'Expected comma');
                const freq = Math.floor(this.parseExpression()) & 0x1FF;
                this.accept('OPERATOR', 'Expected comma');
                const amp = this.parseDelayAddress(mnemonic);
                this.pl.push({
                    cmd: [mnemonic, lfo, freq, amp],
                    addr: this.icnt
                });
                this.icnt++;
                break;
            }

            case 'WLDR': {
                const lfo = this.parseLFO(mnemonic) | 0x02;
                this.accept('OPERATOR', 'Expected comma');
                const freq = this.parseRampFreq(mnemonic); // Use dedicated ramp freq parser
                this.accept('OPERATOR', 'Expected comma');
                const ampMap = {
                    4096: 0,
                    2048: 1,
                    1024: 2,
                    512: 3,
                    0: 0,
                    1: 1,
                    2: 2,
                    3: 3
                };
                const ampVal = Math.floor(this.parseExpression());
                const amp = ampMap[ampVal] !== undefined ? ampMap[ampVal] : 0;
                if (ampMap[ampVal] === undefined) {
                    this.error(`Invalid amplitude ${ampVal} for ${mnemonic}`, this.sline);
                }
                this.pl.push({
                    cmd: [mnemonic, lfo, freq, amp],
                    addr: this.icnt
                });
                this.icnt++;
                break;
            }

            case 'CHO': {
                const choType = this.parseChoType();
                this.accept('OPERATOR', 'Expected comma');
                const lfo = this.parseLFO(mnemonic);
                let flags = 0b000010;
                let arg = 0;

                if (choType === 0x00) { // CHO RDA
                    this.accept('OPERATOR', 'Expected comma');
                    flags = this.parseChoFlags(lfo);
                    this.accept('OPERATOR', 'Expected comma');
                    // Use parseDelayAddress instead of parseS_15 for proper expression handling
                    arg = this.parseDelayAddress(mnemonic);
                } else if (choType === 0x02) { // CHO SOF
                    this.accept('OPERATOR', 'Expected comma');
                    flags = this.parseChoFlags(lfo);
                    this.accept('OPERATOR', 'Expected comma');
                    // Use parseDelayAddress instead of parseS_15 for proper expression handling
                    arg = this.parseDelayAddress(mnemonic);
                } else if (choType === 0x03) { // CHO RDAL
                    if (this.sym.type === 'OPERATOR' && this.sym.text === ',') {
                        this.accept('OPERATOR');
                        flags = this.parseChoFlags(lfo);
                    } else {
                        // CHO RDAL with just LFO - check if LFO is COS0/COS1
                        flags = this.getChoRdalFlags(lfo);
                    }
                }

                this.pl.push({
                    cmd: ['CHO', choType, lfo, flags, arg],
                    addr: this.icnt
                });
                this.icnt++;
                break;
            }

            case 'JAM': {
                const lfo = this.parseLFO(mnemonic) | 0x02;
                this.pl.push({
                    cmd: [mnemonic, lfo],
                    addr: this.icnt
                });
                this.icnt++;
                break;
            }

            case 'RAW': {
                const data = this.parseExpression() & 0xFFFFFFFF;
                this.pl.push({
                    cmd: ['RAW', data],
                    addr: this.icnt
                });
                this.icnt++;
                break;
            }

            case 'JMP': {
                // Pseudo instruction: JMP target -> SKP 0, target
                let target = null;
                let offset = 0;
                const sourceLine = this.sline;

                if (this.sym.type === 'NAME') {
                    target = this.sym.upper;
                    this.accept('NAME');
                } else {
                    offset = this.parseOffset(mnemonic);
                }

                this.pl.push({
                    cmd: ['SKP', 0, offset],
                    target: target,
                    addr: this.icnt,
                    line: sourceLine
                });
                this.icnt++;
                break;
            }

            case 'LDAX': {
                // Pseudo instruction: RDFX reg, 0
                const reg = this.parseRegister(mnemonic);
                this.pl.push({
                    cmd: ['RDFX', reg, 0],
                    addr: this.icnt
                });
                this.icnt++;
                break;
            }

            case 'CLR': {
                // Pseudo instruction: AND 0
                this.pl.push({
                    cmd: ['AND', 0],
                    addr: this.icnt
                });
                this.icnt++;
                break;
            }

            case 'NOT': {
                // Pseudo instruction: XOR 0xFFFFFF
                this.pl.push({
                    cmd: ['XOR', 0xFFFFFF],
                    addr: this.icnt
                });
                this.icnt++;
                break;
            }

            case 'NOP': {
                // Pseudo instruction: SKP 0, 0
                this.pl.push({
                    cmd: ['SKP', 0, 0],
                    addr: this.icnt
                });
                this.icnt++;
                break;
            }

            case 'ABSA': {
                // Pseudo instruction: MAXX 0, 0
                this.pl.push({
                    cmd: ['MAXX', 0, 0],
                    addr: this.icnt
                });
                this.icnt++;
                break;
            }

            default:
                this.error(`Unhandled instruction: ${mnemonic}`, this.sline);
        }

        // Skip excess operands
        if (this.sym.type === 'OPERATOR' && this.sym.text === ',') {
            this.error(`Excess operands for ${mnemonic}`, this.sline);
            while (this.sym.type !== 'EOF' && this.sym.type !== 'MNEMONIC' &&
                this.sym.type !== 'ASSEMBLER' && this.sym.type !== 'LABEL') {
                this.nextSymbol();
            }
        }
    }

    parseRampFreq(mnemonic = '') {
        let freq = this.parseExpression();

        // Handle both integer and float values like Python version
        if (freq < -0.5 || freq > this.MAX_S_15) {
            // Treat as integer (delay address format)
            freq = Math.round(freq);
            if (freq < -0x8000 || freq > 0x7FFF) {
                if (this.clamp) {
                    freq = Math.max(-0x8000, Math.min(0x7FFF, freq));
                    this.warn(`Frequency clamped to 0x${(freq & 0xFFFF).toString(16)} for ${mnemonic}`, this.sline);
                } else {
                    this.error(`Invalid frequency 0x${(freq & 0xFFFF).toString(16)} for ${mnemonic}`, this.sline);
                    freq = 0;
                }
            }
        } else {
            // Treat as fractional value
            freq = Math.round(freq * this.REF_S_15);
        }

        return freq & 0xFFFF;
    }

    parseChoType() {
        const choType = this.sym.upper;
        this.nextSymbol();

        if (choType === 'RDA' || choType === 'SOF' || choType === 'RDAL') {
            return this.symtbl[choType];
        } else {
            this.error(`Invalid CHO type ${choType}`, this.sline);
            return 0;
        }
    }

    parseChoFlags(lfo) {
        // Handle empty flags (just comma with nothing after)
        if (this.sym.type === 'OPERATOR' && this.sym.text === ',') {
            // Empty flags, return default
            return lfo & 0x02 ? 0x02 : 0x00; // Default flags based on LFO type
        }

        let flags = Math.floor(this.parseExpression());
        if (flags < 0 || flags > 0x3F) {
            this.error(`Invalid flags 0x${flags.toString(16)} for CHO`, this.sline);
            flags = 0;
        }

        // Adjust flags based on LFO type
        if (lfo & 0x02) { // RMP0/RMP1
            const newFlags = flags & 0x3E;
            if (flags !== newFlags) {
                this.warn(`RMP flags set to 0x${newFlags.toString(16)} for CHO`, this.sline);
            }
            flags = newFlags;
        } else { // SIN0/SIN1
            const newFlags = flags & 0x0F;
            if (flags !== newFlags) {
                this.warn(`SIN flags set to 0x${newFlags.toString(16)} for CHO`, this.sline);
            }
            flags = newFlags;
        }

        return flags;
    }

    parseAssemblerDirective() {
        let name = null;
        let directive = null;

        if (this.sym.type === 'NAME') {
            name = this.sym.upper;
            this.nextSymbol();
        }

        if (this.sym.type === 'ASSEMBLER') {
            directive = this.sym.upper;
            this.nextSymbol();
        } else {
            this.error(`Expected EQU or MEM but got ${this.sym.type} "${this.sym.text}"`, this.sline);
            return;
        }

        if (!name) {
            if (this.sym.type === 'NAME') {
                name = this.sym.upper;
                this.nextSymbol();
            } else {
                this.error(`Expected NAME but got ${this.sym.type} "${this.sym.text}"`, this.sline);
                return;
            }
        }

        // Remove modifiers
        const baseName = name.replace(/[#^]$/, '');

        if (['RDAL', 'SOF', 'RDA'].includes(baseName)) {
            this.error(`Reserved label ${baseName} cannot be redefined`, this.sline);
            return;
        }

        if (this.symtbl[baseName] !== undefined) {
            this.warn(`Label ${baseName} redefined`, this.sline);
        }

        const value = this.parseExpression();

        if (directive === 'MEM') {
            const size = Math.floor(value);
            if (size < 0 || size > this.DELAYSIZE) {
                this.error(`Invalid memory size ${size}`, this.sline);
                return;
            }

            const base = this.delaymem;
            const top = base + size;

            if (top > this.DELAYSIZE) {
                this.error(`Delay memory exhausted: requested ${size} exceeds ${this.DELAYSIZE - this.delaymem} available`, this.sline);
                return;
            }
            
            this.symtbl[baseName] = base;
            this.symtbl[baseName + '#'] = top;
            this.symtbl[baseName + '^'] = base + Math.floor(size / 2);
            
            // Fix: should be top, not top + 1
            this.delaymem = top;
        } else { // EQU
            this.symtbl[baseName] = value;
        }
    }

    // Updated main parse loop to handle line boundaries
    parse() {
        debugLog('Start assembly', 'info');
        
        this.nextSymbol();
        while (this.sym.type !== 'EOF') {
            if (this.sym.type === 'EOL') {
                // Skip empty lines
                this.nextSymbol();
                continue;
            }
            if (this.sym.type === 'LABEL') {
                const label = this.sym.upper;
                const addr = this.icnt;
                if (this.jmptbl[label] && this.jmptbl[label] !== addr) {
                    this.error(`Label ${label} redefined`, this.sline);
                }
                this.jmptbl[label] = addr;
                debugLog(`Found label: "${label}" at PC ${addr}`, 'info');
                this.nextSymbol();
                // After a label, we might have EOL, which is fine
                if (this.sym.type === 'EOL') {
                    this.nextSymbol();
                    continue;
                }
            } else if (this.sym.type === 'MNEMONIC') {
                this.parseInstruction();
                // After instruction, we should be at EOL or EOF
                if (this.sym.type === 'EOL') {
                    this.nextSymbol();
                    continue;
                } else if (this.sym.type !== 'EOF' && this.sym.type !== 'LABEL' &&
                    this.sym.type !== 'MNEMONIC' && this.sym.type !== 'ASSEMBLER') {
                    this.error(`Unexpected tokens after instruction: ${this.sym.type} "${this.sym.text}"`, this.sline);
                    // Skip to next line
                    while (this.sym.type !== 'EOL' && this.sym.type !== 'EOF') {
                        this.nextSymbol();
                    }
                }
            } else if (this.sym.type === 'ASSEMBLER') {
                this.parseAssemblerDirective();
                // After directive, we should be at EOL or EOF
                if (this.sym.type === 'EOL') {
                    this.nextSymbol();
                    continue;
                } else if (this.sym.type !== 'EOF' && this.sym.type !== 'LABEL' &&
                    this.sym.type !== 'MNEMONIC' && this.sym.type !== 'ASSEMBLER') {
                    this.error(`Unexpected tokens after directive: ${this.sym.type} "${this.sym.text}"`, this.sline);
                    // Skip to next line
                    while (this.sym.type !== 'EOL' && this.sym.type !== 'EOF') {
                        this.nextSymbol();
                    }
                }
            } else if (this.sym.type === 'NAME') {
                // Check if this is really an assembler directive by looking ahead
                const savedSym = this.sym;
                const savedLinebuf = [...this.linebuf];
                const savedSline = this.sline;
                this.nextSymbol();
                if (this.sym.type === 'ASSEMBLER') {
                    // This is "NAME ASSEMBLER" pattern, parse as directive
                    // Restore and reparse
                    this.sym = savedSym;
                    this.linebuf = savedLinebuf;
                    this.sline = savedSline;
                    this.parseAssemblerDirective();
                    // After directive, handle EOL
                    if (this.sym.type === 'EOL') {
                        this.nextSymbol();
                        continue;
                    }
                } else {
                    // This is just a stray NAME, skip it with error
                    this.error(`Unexpected NAME "${savedSym.text}"`, savedSline);
                    // Skip to next line
                    while (this.sym.type !== 'EOL' && this.sym.type !== 'EOF') {
                        this.nextSymbol();
                    }
                }
            } else {
                this.error(`Unexpected ${this.sym.type} "${this.sym.text}"`, this.sline);
                this.nextSymbol();
            }
        }

        debugLog('Simple parameter resolution:', 'info');
        debugLog('Done', 'info');
        
        debugLog('Symbolic, label and complex parameter resolution:', 'info');
        
        // Resolve SKP targets
        for (let i = 0; i < this.pl.length; i++) {
            const inst = this.pl[i];
            if (inst.cmd[0] === 'SKP' && inst.target !== null) {
                if (this.jmptbl.hasOwnProperty(inst.target)) {
                    const iloc = inst.addr;
                    const dest = this.jmptbl[inst.target];
                    if (dest > iloc) {
                        const offset = dest - iloc - 1;
                        if (offset > 0x3F) {
                            this.error(`Offset from SKP to ${inst.target} (${offset}) too large`, inst.line);
                        } else {
                            inst.cmd[2] = offset;  // Update the offset in the instruction
                        }
                    } else {
                        this.error(`Target ${inst.target} does not follow SKP`, inst.line);
                    }
                } else {
                    this.error(`Undefined target ${inst.target} for SKP`, inst.line);
                }
            }
        }
        
        debugLog('Done', 'info');

        // Print label table
        debugLog('Label table', 'info');
        Object.keys(this.jmptbl).forEach(label => {
            debugLog(`${label} : ${this.jmptbl[label].toString().padStart(4, '0')}`, 'info');
        });
        debugLog('End label table', 'info');

        return this.errors.length === 0;
    }

    generateMachineCode() {
        // debugLog('Code Listing', 'info');
        // debugLog('Line    PC     Binary    Source', 'info');
        
        // First, pad the program list with NOP instructions to reach PROGLEN
        while (this.pl.length < this.PROGLEN) {
            this.pl.push({
                cmd: ['SKP', 0x00, 0x00],
                addr: this.pl.length,
                target: null
            });
        }

        // Convert program to machine code
        for (let i = 0; i < this.pl.length; i++) {
            const inst = this.pl[i];
            let machineCode = 0;
            const mnemonic = inst.cmd[0];

            if (mnemonic === 'RAW') {
                machineCode = inst.cmd[1] & 0xFFFFFFFF;
            } else {
                const opcode = this.opcodes[mnemonic];
                machineCode = opcode;

                switch (mnemonic) {
                    case 'AND':
                    case 'OR':
                    case 'XOR':
                        // 24-bit mask at bits 8-31
                        machineCode |= (inst.cmd[1] & 0xFFFFFF) << 8;
                        break;

                    case 'SOF':
                    case 'EXP':
                        // S1.14 multiplier at bits 16-31, S.10 offset at bits 5-15
                        machineCode |= (inst.cmd[1] & 0xFFFF) << 16;
                        machineCode |= (inst.cmd[2] & 0x7FF) << 5;
                        break;

                    case 'LOG':
                        // S1.14 multiplier at bits 16-31, S4.6 offset at bits 5-15
                        machineCode |= (inst.cmd[1] & 0xFFFF) << 16;
                        machineCode |= (inst.cmd[2] & 0x7FF) << 5;
                        break;

                    case 'RDAX':
                    case 'WRAX':
                    case 'RDFX':
                    case 'WRLX':
                    case 'WRHX':
                    case 'MAXX':
                        // Use the raw register value from symbol table (0x20-0x3F range)
                        const regValue = inst.cmd[1] & 0x3F;
                        machineCode |= (inst.cmd[2] & 0xFFFF) << 16;  // 16-bit constant
                        machineCode |= (regValue & 0x3F) << 5;        // 6-bit register (raw value)
                        break;

                    case 'MULX':
                        // Use the raw register value from symbol table (0x20-0x3F range)
                        const mulxRegValue = inst.cmd[1] & 0x3F;
                        machineCode |= (mulxRegValue & 0x3F) << 5;
                        break;

                    case 'RDA':
                    case 'WRA':
                    case 'WRAP':
                        // 15-bit address at bits 5-19, 11-bit multiplier at bits 21-31
                        machineCode |= (inst.cmd[1] & 0x7FFF) << 5;
                        machineCode |= (inst.cmd[2] & 0x7FF) << 21;
                        break;

                    case 'RMPA':
                        // 11-bit multiplier at bits 21-31
                        machineCode |= (inst.cmd[1] & 0x7FF) << 21;
                        break;

                    case 'SKP':
                        // 5-bit condition at bits 27-31, 6-bit offset at bits 21-26
                        machineCode |= (inst.cmd[1] & 0x1F) << 27;
                        machineCode |= (inst.cmd[2] & 0x3F) << 21;
                        break;

                    case 'WLDS':
                        // 1-bit LFO select at bit 29, 9-bit frequency at bits 20-28, 15-bit amplitude at bits 5-19
                        machineCode |= (inst.cmd[1] & 0x01) << 29;
                        machineCode |= (inst.cmd[2] & 0x1FF) << 20;
                        machineCode |= (inst.cmd[3] & 0x7FFF) << 5;
                        break;

                    case 'WLDR':
                        // 2-bit LFO select at bits 29-30, 16-bit frequency at bits 13-28, 2-bit amplitude at bits 5-6
                        machineCode |= (inst.cmd[1] & 0x03) << 29;
                        machineCode |= (inst.cmd[2] & 0xFFFF) << 13;
                        machineCode |= (inst.cmd[3] & 0x03) << 5;
                        break;

                    case 'JAM':
                        // 2-bit LFO select at bits 6-7
                        machineCode |= (inst.cmd[1] & 0x03) << 6;
                        break;

                    case 'CHO':
                        // 2-bit type at bits 30-31, 2-bit LFO at bits 21-22, 6-bit flags at bits 24-29, 16-bit arg at bits 5-20
                        machineCode |= (inst.cmd[1] & 0x03) << 30;
                        machineCode |= (inst.cmd[2] & 0x03) << 21;
                        machineCode |= (inst.cmd[3] & 0x3F) << 24;
                        machineCode |= (inst.cmd[4] & 0xFFFF) << 5;
                        break;

                    case 'NOP':
                        // NOP is SKP 0,0 - no additional fields needed
                        break;

                    default:
                        // This shouldn't happen if opcodes table is complete
                        this.error(`Unknown instruction in machine code generation: ${mnemonic}`);
                        break;
                }
            }

            // Write as big-endian 32-bit value to program buffer
            const offset = i * 4;
            this.program[offset] = (machineCode >> 24) & 0xFF;
            this.program[offset + 1] = (machineCode >> 16) & 0xFF;
            this.program[offset + 2] = (machineCode >> 8) & 0xFF;
            this.program[offset + 3] = machineCode & 0xFF;

            // Generate listing output similar to FXCore version
            const lineStr = '0000';  // FV-1 doesn't track original line numbers the same way
            const pcStr = inst.addr.toString().padStart(4, '0');
            const binaryStr = machineCode.toString(16).toUpperCase().padStart(8, '0');
            
            // Check if there's a label for this address
            let labelStr = '';
            for (const [labelName, labelAddr] of Object.entries(this.jmptbl)) {
                if (labelAddr === inst.addr) {
                    labelStr = labelName + ': ';
                    break;
                }
            }
            
            // Reconstruct source line
            let sourceLine = `${labelStr}${mnemonic}`;
            if (inst.cmd.length > 1) {
                const params = inst.cmd.slice(1).map(param => {
                    if (typeof param === 'number') {
                        return `0x${param.toString(16).toUpperCase().padStart(4, '0')}`;
                    }
                    return param;
                });
                sourceLine += '   ' + params.join(' ');
            }
            
            // debugLog(`${lineStr} : ${pcStr} : ${binaryStr} : ${sourceLine}`, 'info');
        }
        
        // debugLog(`\nTotal instructions: ${this.pl.length}`, 'info');
    }

    toIntelHex() {
        let hex = '';
        const data = this.program.slice(0, 512); // 128 instructions * 4 bytes

        for (let i = 0; i < data.length; i += 4) {
            const len = 4;
            let line = ':';
            line += len.toString(16).padStart(2, '0').toUpperCase();
            line += i.toString(16).padStart(4, '0').toUpperCase();
            line += '00'; // Data record

            let checksum = len + ((i >> 8) & 0xFF) + (i & 0xFF);

            for (let j = 0; j < len; j++) {
                const byte = data[i + j];
                line += byte.toString(16).padStart(2, '0').toUpperCase();
                checksum += byte;
            }

            checksum = (~checksum + 1) & 0xFF;
            line += checksum.toString(16).padStart(2, '0').toUpperCase();
            hex += line + '\r\n'; // Changed from '\n' to '\r\n'
        }

        hex += ':00000001FF\r\n'; // EOF with CRLF
        return hex;
    }

    toCHeader(arrayName = 'ASSEMBLED_PROGRAM') {
        let header = `${arrayName}[] = {\n`;
        const data = this.program.slice(0, 512); // 128 instructions * 4 bytes
        
        for (let i = 0; i < data.length; i += 4) {
            header += '0x' + data[i].toString(16).padStart(2, '0').toUpperCase() + ',';
            header += '0x' + data[i + 1].toString(16).padStart(2, '0').toUpperCase() + ',';
            header += '0x' + data[i + 2].toString(16).padStart(2, '0').toUpperCase() + ',';
            header += '0x' + data[i + 3].toString(16).padStart(2, '0').toUpperCase();
            
            if (i < data.length - 4) {
                header += ',';
            }
            header += '\n';
        }
        
        header += '};\n';
        return header;
    }

    getAssemblyStats() {
        // Count non-NOP instructions
        let nonNopCount = 0;
        let checksum = 0;

        for (let i = 0; i < this.pl.length; i++) {
            const inst = this.pl[i];
            // Count as non-NOP if it's not a SKP 0,0 instruction
            if (!(inst.cmd[0] === 'SKP' && inst.cmd[1] === 0 && inst.cmd[2] === 0)) {
                nonNopCount++;
            }
        }

        // Calculate checksum of the actual program data (512 bytes)
        for (let i = 0; i < 512; i++) {
            checksum = (checksum + this.program[i]) & 0xFFFF;
        }

        return {
            nonNopInstructions: nonNopCount,
            totalInstructions: this.pl.length,
            checksum: checksum
        };
    }

    printCodeListing() {
        debugLog('Code Listing', 'info');
        debugLog('Line    PC     Binary    Source', 'info');
        
        // Only show actual instructions, not padding
        const actualInstructions = this.icnt; // Use icnt instead of this.pl.length
        
        for (let i = 0; i < actualInstructions; i++) {
            const inst = this.pl[i];
            
            // Calculate machine code for display
            let machineCode = 0;
            const mnemonic = inst.cmd[0];
            
            if (mnemonic === 'RAW') {
                machineCode = inst.cmd[1] & 0xFFFFFFFF;
            } else {
                const opcode = this.opcodes[mnemonic];
                machineCode = opcode;
                // ... same machine code calculation as in generateMachineCode
            }
            
            // Generate listing output
            const lineStr = '0000';
            const pcStr = inst.addr.toString().padStart(4, '0');
            const binaryStr = machineCode.toString(16).toUpperCase().padStart(8, '0');
            
            // Check if there's a label for this address
            let labelStr = '';
            for (const [labelName, labelAddr] of Object.entries(this.jmptbl)) {
                if (labelAddr === inst.addr) {
                    labelStr = labelName + ': ';
                    break;
                }
            }
            
            // Reconstruct source line
            let sourceLine = `${labelStr}${mnemonic}`;
            if (inst.cmd.length > 1) {
                const params = inst.cmd.slice(1).map(param => {
                    if (typeof param === 'number') {
                        return `0x${param.toString(16).toUpperCase().padStart(4, '0')}`;
                    }
                    return param;
                });
                sourceLine += '   ' + params.join(' ');
            }
            
            debugLog(`${lineStr} : ${pcStr} : ${binaryStr} : ${sourceLine}`, 'info');
        }
        
        debugLog(`\nTotal instructions: ${actualInstructions}`, 'info'); // Use actualInstructions instead of this.pl.length
    }
}