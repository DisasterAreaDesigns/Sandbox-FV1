    // <script>
    // line numbers

    // const textarea = document.getElementById('sourceCode');
    // const lineNumbers = document.getElementById('lineNumbers');

    // function updateLineNumbers() {
    //     const lines = textarea.value.split('\n');
    //     const lineHeight = 21; // Approximate line height in pixels (1.5 * 14px font)
    //     const visibleLines = Math.ceil(300 / lineHeight); // 300px is textarea height
    //     const scrollTop = textarea.scrollTop;
    //     const firstVisibleLine = Math.floor(scrollTop / lineHeight);

    //     let lineNumbersText = '';
    //     for (let i = 1; i <= lines.length; i++) {
    //         lineNumbersText += i + '\n';
    //     }
    //     lineNumbers.textContent = lineNumbersText;

    //     // Sync scroll
    //     lineNumbers.scrollTop = textarea.scrollTop;
    // }

    // textarea.addEventListener('input', updateLineNumbers);
    // textarea.addEventListener('scroll', () => {
    //     lineNumbers.scrollTop = textarea.scrollTop;
    // });

    // updateLineNumbers();

    // Example programs
    const examples = {
        passthrough: `; Simple Pass-through
; Use this for BYPASS 0.hex on Sandbox Pedal!

ldax    adcl        ; read in the left input
wrax    dacl, 0.0   ; write to left output and clear acc
ldax    adcr        ; read in right input
wrax    dacr, 0.0   ; write to right output and clear`,

        delay: `; Simple Delay Effect
; POT0: delay mix, POT1: delay time, POT2: delay repeats

mem     delay   24000

equ     feedback reg0
equ     dfil reg1
equ     delaybase reg2

equ     delaylen    24000

rdax    feedback, 0.8   ; read end of long delay
mulx    pot2            ; scale feedback
rdax    adcl, 0.8       ; mix input
wra     delay, 0.0      ; write to long delay

rdax    pot1, 0.8       ; read delay pot
sof     0.95, 0.05      ; scale to max min
rdfx    dfil, 0.0001    ; filter delay time
wrax    dfil, 0     ; and save

or      delay*256       ; put address of delay in acc
wrax    delaybase, 0    ; save

or      delaylen*256    ; put length of delay in acc
mulx    dfil            ; pick location on delay line
rdax    delaybase, 1    ; add start address
wrax    addr_ptr, 0     ; set pointer pos

rmpa    1           ; get delay from pointer
wrax    feedback, 1.0   ; save to long delay

mulx    pot0            ; scale by mix pot
rdax    adcl, 1.0       ; add input
wrax    dacl, 0.0       ; write both channels`,

        chorus: `; Simple Mono Chorus
; POT0: chorus rate, POT1: chorus intensity, POT2: not used

mem     chodel  2048

skp     run, start      ; set up LFOs
wlds    sin0, 12, 100

start:

rdax    adcl, 1.0   ; read input
wra     chodel, 1   ; write to chorus delay

rdax    pot0, 1.0   ; read pot0 for rate
mulx    pot0        ; make log
sof     0.3, 0.0    ; scale chorus rate
wrax    sin0_rate, 0    ; set LFO rate

rdax    pot1, 1.0   ; read pot1 for depth
sof     0.02, 0.004 ; total range from 0.01 to 0.02
wrax    sin0_range, 0   ; set sine range

cho     rda, sin0, sin|reg|compc, chodel+800 ; do chorus using sin0 LFO
cho     rda, sin0, sin, chodel+801      ; interpolate using LFO

rdax    adcl, 0.8
wrax    dacl, 0.8   ; sum chorus and dry
wrax    dacr, 0.0   ; then write to both outputs`
    };

    function toggleOutput() {
        const content = document.getElementById('outputContent');
        const toggle = document.getElementById('outputToggle');
        
        content.classList.toggle('collapsed');
        
        if (content.classList.contains('collapsed')) {
            toggle.textContent = '▶';
        } else {
            toggle.textContent = '▼';
        }
    }

      function loadExample() {
        const select = document.getElementById('exampleSelect');
        if (select.value && examples[select.value]) {
          editor.setValue(examples[select.value]);
          document.getElementById('output').value = '';
          document.getElementById('messages').innerHTML = '';
          document.getElementById('downloadHexBtn').disabled = true;
          document.getElementById('downloadBinBtn').disabled = true;
          assembledData = null;
          showMessage('Example loaded successfully', 'success');
        }
      }

      function toggleMinimap() {
  const showMinimap = document.getElementById('minimapToggle')?.checked || false;

  if (editor) {
    editor.updateOptions({
      minimap: { enabled: showMinimap }
    });
  }
}


    // function loadFile() {
    //   const fileInput = document.getElementById('fileInput');
    //   const file = fileInput.files[0];

    //   if (!file) return;

    //   const reader = new FileReader();
    //     reader.onload = function(e) {
    //       editor.setValue(e.target.result);
    //       document.getElementById('output').value = '';
    //       document.getElementById('messages').innerHTML = '';
    //       document.getElementById('downloadHexBtn').disabled = true;
    //       document.getElementById('downloadBinBtn').disabled = true;
    //       assembledData = null;
    //       showMessage('File loaded successfully', 'success');
    //       document.getElementById('exampleSelect').value = '';
    //     };
    //   reader.onerror = function() {
    //     showMessage('Error reading file', 'error');
    //   };
    //   reader.readAsText(file);
    // }


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
                    errorMsg += `<br><span style="color: #666; font-style: italic; margin-left: 20px;">    ${sourceText}</span>`;
                }
            }

            this.errors.push(errorMsg);
        }

        warn(msg, line = null) {
            const lineInfo = line !== null ? ` on line ${line}` : '';
            let warnMsg = `Warning${lineInfo}: ${msg}`;

            // Add the source line text if available
            if (line !== null && line > 0 && line <= this.source.length) {
                const sourceText = this.source[line - 1].trim();
                if (sourceText) {
                    warnMsg += `<br><span style="color: #666; font-style: italic; margin-left: 20px;">    ${sourceText}</span>`;
                }
            }

            this.warnings.push(warnMsg);
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
                    arg = Math.round(arg * this.REF_S1_14);
                } else {
                    if (this.clamp) {
                        arg = Math.max(this.MIN_S1_14, Math.min(this.MAX_S1_14, arg));
                        this.warn(`S1.14 arg clamped to ${arg} for ${mnemonic}`, this.sline);
                        arg = Math.round(arg * this.REF_S1_14);
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
                arg = Math.round(arg * this.REF_S1_14);
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
                        arg = Math.round(arg * this.REF_S1_9);
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
                arg = Math.round(arg * this.REF_S1_9);
            }
            return arg & 0x7FF;
        }

        parseS_10(mnemonic = '') {
            let arg = this.parseExpression();
            if (Number.isInteger(arg)) {
                if (arg >= -1 && arg <= 0) {
                    arg = Math.round(arg * this.REF_S_10);
                } else {
                    if (this.clamp) {
                        arg = Math.max(this.MIN_S_10, Math.min(this.MAX_S_10, arg));
                        this.warn(`S.10 arg clamped to ${arg} for ${mnemonic}`, this.sline);
                        arg = Math.round(arg * this.REF_S_10);
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
                arg = Math.round(arg * this.REF_S_10);
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
                arg = Math.round(arg * this.REF_S_15);
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
                arg = Math.round(arg * this.REF_S_23);
            }
            return arg & 0xFFFFFF;
        }

        parseS4_6(mnemonic = '') {
            let arg = this.parseExpression();
            if (Number.isInteger(arg)) {
                if (arg >= -16 && arg <= 15) {
                    arg = Math.round(arg * this.REF_S4_6);
                } else {
                    if (this.clamp) {
                        arg = Math.max(this.MIN_S4_6, Math.min(this.MAX_S4_6, arg));
                        this.warn(`S4.6 arg clamped to ${arg} for ${mnemonic}`, this.sline);
                        arg = Math.round(arg * this.REF_S4_6);
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
                arg = Math.round(arg * this.REF_S4_6);
            }
            return arg & 0x7FF;
        }

        parseDelayAddress(mnemonic = '') {
            let addr = this.parseExpression();
            if (addr < this.MIN_S_15 || addr > this.MAX_S_15) {
                addr = Math.round(addr);
                if (addr < -0x8000 || addr > 0x7FFF) {
                    if (this.clamp) {
                        addr = Math.max(-0x8000, Math.min(0x7FFF, addr));
                        this.warn(`Address clamped to 0x${(addr >>> 0).toString(16)} for ${mnemonic}`, this.sline);
                    } else {
                        this.error(`Invalid address 0x${(addr >>> 0).toString(16)} for ${mnemonic}`, this.sline);
                        addr = 0;
                    }
                }
            } else {
                addr = Math.round(addr * this.REF_S_15);
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
                this.delaymem = top + 1;
            } else { // EQU
                this.symtbl[baseName] = value;
            }
        }

        // Updated main parse loop to handle line boundaries
        parse() {
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

            // ... rest of parse method (resolve skip targets, pad with NOPs)
            return this.errors.length === 0;
        }

        generateMachineCode() {
            for (let i = 0; i < this.pl.length; i++) {
                const inst = this.pl[i];
                let machineCode = 0;

                const mnemonic = inst.cmd[0];

                if (mnemonic === 'RAW') {
                    machineCode = inst.cmd[1];
                } else {
                    const opcode = this.opcodes[mnemonic];
                    machineCode = opcode;

                    switch (mnemonic) {
                        case 'AND':
                        case 'OR':
                        case 'XOR':
                            machineCode |= (inst.cmd[1] & 0xFFFFFF) << 8;
                            break;

                        case 'SOF':
                        case 'EXP':
                            machineCode |= (inst.cmd[1] & 0xFFFF) << 16;
                            machineCode |= (inst.cmd[2] & 0x7FF) << 5;
                            break;

                        case 'LOG':
                            machineCode |= (inst.cmd[1] & 0xFFFF) << 16;
                            machineCode |= (inst.cmd[2] & 0x7FF) << 5;
                            break;

                        case 'RDAX':
                        case 'WRAX':
                        case 'RDFX':
                        case 'WRLX':
                        case 'WRHX':
                        case 'MAXX':
                            machineCode |= (inst.cmd[1] & 0x3F) << 5;
                            machineCode |= (inst.cmd[2] & 0xFFFF) << 16;
                            break;

                        case 'MULX':
                            machineCode |= (inst.cmd[1] & 0x3F) << 5;
                            break;

                        case 'RDA':
                        case 'WRA':
                        case 'WRAP':
                            machineCode |= (inst.cmd[1] & 0x7FFF) << 5;
                            machineCode |= (inst.cmd[2] & 0x7FF) << 21;
                            break;

                        case 'RMPA':
                            machineCode |= (inst.cmd[1] & 0x7FF) << 21;
                            break;

                        case 'SKP':
                            machineCode |= (inst.cmd[1] & 0x1F) << 27;
                            machineCode |= (inst.cmd[2] & 0x3F) << 21;
                            break;

                        case 'WLDS':
                            machineCode |= (inst.cmd[1] & 0x01) << 29;
                            machineCode |= (inst.cmd[2] & 0x1FF) << 20;
                            machineCode |= (inst.cmd[3] & 0x7FFF) << 5;
                            break;

                        case 'WLDR':
                            machineCode = 0b10010; // WLDR opcode
                            machineCode |= (inst.cmd[1] & 0x03) << 29;
                            machineCode |= (inst.cmd[2] & 0xFFFF) << 13;
                            machineCode |= (inst.cmd[3] & 0x03) << 5;
                            break;
                        case 'WLDR':
                            machineCode = 0b10010; // WLDR opcode  
                            machineCode |= (inst.cmd[1] & 0x03) << 29; // lfo type (bits 30-29)
                            machineCode |= (inst.cmd[2] & 0xFFFF) << 13; // frequency (bits 28-13)
                            machineCode |= (inst.cmd[3] & 0x03) << 5; // amplitude (bits 6-5)
                            break;

                        case 'JAM':
                            machineCode |= (inst.cmd[1] & 0x03) << 6;
                            break;

                        case 'CHO':
                            machineCode |= (inst.cmd[1] & 0x03) << 30; // type
                            machineCode |= (inst.cmd[2] & 0x03) << 21; // lfo
                            machineCode |= (inst.cmd[3] & 0x3F) << 24; // flags
                            machineCode |= (inst.cmd[4] & 0xFFFF) << 5; // arg
                            break;
                    }
                }

                // Write as big-endian 32-bit value
                const offset = i * 4;
                this.program[offset] = (machineCode >> 24) & 0xFF;
                this.program[offset + 1] = (machineCode >> 16) & 0xFF;
                this.program[offset + 2] = (machineCode >> 8) & 0xFF;
                this.program[offset + 3] = machineCode & 0xFF;
            }
        }

        toIntelHex() {
            let hex = '';
            const data = this.program.slice(0, 512); // 128 instructions * 4 bytes

            for (let i = 0; i < data.length; i += 4) { // Changed from 16 to 4
                const len = 4; // Changed to always 4 bytes per line
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
                hex += line + '\n';
            }

            hex += ':00000001FF\n'; // EOF
            return hex;
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
    }

    // UI Functions
    // UI Functions
    let assembledData = null;
    let outputDirectoryHandle = null;

    async function selectOutputDirectory() {
        try {
            if ('showDirectoryPicker' in window) {
                outputDirectoryHandle = await window.showDirectoryPicker();
                document.getElementById('outputDirDisplay').textContent = `Selected: ${outputDirectoryHandle.name}`;
                showMessage('Output directory selected successfully', 'success');
            } else {
                showMessage('Directory selection not supported in this browser', 'error');
            }
        } catch (err) {
            if (err.name !== 'AbortError') {
                showMessage('Error selecting directory: ' + err.message, 'error');
            }
        }
    }

    // function loadFile() {
    //     const fileInput = document.getElementById('fileInput');
    //     const file = fileInput.files[0];

    //     if (!file) {
    //         showMessage('Please select a file', 'error');
    //         return;
    //     }

    //     const reader = new FileReader();
    //     reader.onload = function(e) {
    //         // document.getElementById('sourceCode').value = e.target.result;
    //         editor.getValue() = e.target.result;
    //         updateLineNumbers(); // Add this line to update line numbers after loading
    //         showMessage('File loaded successfully', 'success');
    //     };
    //     reader.onerror = function() {
    //         showMessage('Error reading file', 'error');
    //     };
    //     reader.readAsText(file);
    // }

    function loadFile() {
      const fileInput = document.getElementById('fileInput');
      const file = fileInput.files[0];

      if (!file) return;

      const reader = new FileReader();
        reader.onload = function(e) {
          editor.setValue(e.target.result);
          document.getElementById('output').value = '';
          document.getElementById('messages').innerHTML = '';
          document.getElementById('downloadHexBtn').disabled = true;
          document.getElementById('downloadBinBtn').disabled = true;
          assembledData = null;
          showMessage('File loaded successfully', 'success');
          document.getElementById('exampleSelect').value = '';
        };
      reader.onerror = function() {
        showMessage('Error reading file', 'error');
      };
      reader.readAsText(file);
    }

    function assemble() {
        // const source = document.getElementById('sourceCode').value;
        const source = editor.getValue();
        const clamp = document.getElementById('clampOption').checked;
        const spinReals = document.getElementById('spinRealsOption').checked;

        if (!source.trim()) {
            showMessage('Please enter some assembly code', 'error');
            return;
        }

        const assembler = new FV1Assembler(source, {
            clamp,
            spinReals
        });
        const success = assembler.parse();

        // Display messages
        let messages = '';
        if (assembler.warnings.length > 0) {
            messages += '<div class="warning">Warnings:<br>' + assembler.warnings.join('<br>') + '</div>';
        }
        if (assembler.errors.length > 0) {
            messages += '<div class="error">Errors:<br>' + assembler.errors.join('<br>') + '</div>';
        }

        if (success) {
            assembler.generateMachineCode();
            assembledData = assembler.program;

            const hex = assembler.toIntelHex();
            document.getElementById('output').value = hex;

            // Get assembly statistics
            const stats = assembler.getAssemblyStats();

            // Auto-expand output section when assembly is successful
            // const outputContent = document.getElementById('outputContent');
            // const toggle = document.getElementById('outputToggle');
            // if (outputContent.classList.contains('collapsed')) {
            //     outputContent.classList.remove('collapsed');
            //     toggle.textContent = '▼';
            // }

            document.getElementById('downloadHexBtn').disabled = false;
            document.getElementById('downloadBinBtn').disabled = false;

            if (messages === '') {
                messages = '<div class="success">Assembly successful!</div>';
            }
            
            // Add assembly statistics
            messages += `<div class="info">Instructions: ${stats.nonNopInstructions} (${stats.totalInstructions} total including padding) | Checksum: 0x${stats.checksum.toString(16).toUpperCase().padStart(4, '0')}</div>`;
        } else {
            document.getElementById('output').value = '';
            document.getElementById('downloadHexBtn').disabled = true;
            document.getElementById('downloadBinBtn').disabled = true;
            assembledData = null;
        }

        document.getElementById('messages').innerHTML = messages;
    }

    // function clearAll() {
    //     document.getElementById('sourceCode').value = '';
    //     document.getElementById('output').value = '';
    //     document.getElementById('messages').innerHTML = '';
    //     document.getElementById('downloadHexBtn').disabled = true;
    //     document.getElementById('downloadBinBtn').disabled = true;
    //     assembledData = null;
    //     updateLineNumbers(); // Add this line
    // }

    function clearAssembly() {
        document.getElementById('output').value = '';
        document.getElementById('messages').innerHTML = '';
        document.getElementById('downloadHexBtn').disabled = true;
        document.getElementById('downloadBinBtn').disabled = true;
        assembledData = null;
        showMessage('Assembly output cleared', 'success');
    }

    function clearSource() {
        document.getElementById('sourceCode').value = '';
        updateLineNumbers();
        showMessage('Source code cleared', 'success');
    }

    function saveSource() {
      const source = editor.getValue();

      if (!source.trim()) {
        showMessage('Nothing to save', 'error');
        return;
      }

      // Create default filename based on date and time
      const now = new Date();
      const timestamp = now.toISOString().replace(/[:T]/g, '-').split('.')[0]; // "2025-08-04-14-37-00"
      const defaultFilename = `program_${timestamp}.spn`;

      // Prompt user for filename
      const filename = prompt('Enter filename to save:', defaultFilename);

      if (!filename) {
        showMessage('Save cancelled', 'info');
        return;
      }

      const blob = new Blob([source], { type: 'text/plain' });
      const url = URL.createObjectURL(blob);

      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.click();

      URL.revokeObjectURL(url);
      showMessage(`Source saved as ${filename}`, 'success');
    }



    function showMessage(msg, type) {
        const className = type === 'error' ? 'error' : 'success';
        document.getElementById('messages').innerHTML = `<div class="${className}">${msg}</div>`;
    }

    // function downloadHex() {
    //     const hex = document.getElementById('output').value;
    //     downloadFile('output.hex', hex, 'text/plain');
    // }

    // function downloadBinary() {
    //     if (!assembledData) return;

    //     const blob = new Blob([assembledData.slice(0, 512)], { type: 'application/octet-stream' });
    //     const url = URL.createObjectURL(blob);
    //     const a = document.createElement('a');
    //     a.href = url;
    //     a.download = 'output.bin';
    //     a.click();
    //     URL.revokeObjectURL(url);
    // }

    async function downloadHex() {
        const hex = document.getElementById('output').value;
        const filename = document.getElementById('filenameSelect').value;

        if (outputDirectoryHandle && 'showDirectoryPicker' in window) {
            try {
                const fileHandle = await outputDirectoryHandle.getFileHandle(filename, {
                    create: true
                });
                const writable = await fileHandle.createWritable();
                await writable.write(hex);
                await writable.close();
                showMessage(`File saved as ${filename} in selected directory`, 'success');
            } catch (err) {
                showMessage('Error saving to directory: ' + err.message, 'error');
                // Fallback to regular download
                downloadFile(filename, hex, 'text/plain');
            }
        } else {
            downloadFile(filename, hex, 'text/plain');
        }
    }

    function downloadBinary() {
        if (!assembledData) return;

        const filename = document.getElementById('filenameSelect').value.replace('.hex', '.bin');
        const blob = new Blob([assembledData.slice(0, 512)], {
            type: 'application/octet-stream'
        });

        if (outputDirectoryHandle && 'showDirectoryPicker' in window) {
            // For binary files, we'll use the regular download since File System Access API
            // is more complex with binary data
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = filename;
            a.click();
            URL.revokeObjectURL(url);
        } else {
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = filename;
            a.click();
            URL.revokeObjectURL(url);
        }
    }

    function downloadFile(filename, content, mimeType) {
        const blob = new Blob([content], {
            type: mimeType
        });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.click();
        URL.revokeObjectURL(url);
    }


    // </script>