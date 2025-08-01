# FV-1 DSP Assembler Web App Guide

## Overview

This web application is a JavaScript port of an assembler for the Spin Semiconductor FV-1 digital signal processor (DSP). The FV-1 is a specialized chip commonly used in guitar effects pedals and audio processing applications. This assembler converts human-readable assembly code into machine code that can run on the FV-1 chip.

## Architecture

The application consists of three main components:

### 1. User Interface (HTML/CSS)
- **Code Editor**: A textarea with line numbers for writing assembly code
- **Options Panel**: Checkboxes for assembly options (clamping, SpinASM compatibility)
- **Control Buttons**: Assemble, Clear, Load File, Download outputs
- **Output Display**: Shows assembled machine code in Intel HEX format
- **Message Area**: Displays warnings and errors

### 2. FV1Assembler Class (JavaScript)
The core assembler implemented as a JavaScript class that handles:
- **Tokenization**: Breaking source code into meaningful symbols
- **Parsing**: Converting tokens into an abstract syntax tree
- **Code Generation**: Converting parsed instructions into machine code
- **Error Handling**: Tracking and reporting syntax/semantic errors

### 3. File I/O System
- **Input**: Load assembly files (.asm, .txt)
- **Output**: Download as Intel HEX (.hex) or binary (.bin) files

## How the Assembler Works

### Phase 1: Tokenization

The `tokenize()` method breaks source code into tokens:

```javascript
// Example: "LDAX ADCL" becomes ["LDAX", "ADCL"]
// "SOF 0.5, -0.2" becomes ["SOF", "0.5", ",", "-0.2"]
```

**Token Types:**
- `MNEMONIC`: Instruction names (LDAX, WRAX, SOF, etc.)
- `ASSEMBLER`: Directives (EQU, MEM)
- `NAME`: Labels and symbols
- `INTEGER`: Whole numbers (decimal, hex with $, binary with %)
- `FLOAT`: Decimal numbers
- `OPERATOR`: Arithmetic and punctuation (+, -, *, /, ,, etc.)
- `LABEL`: Names followed by colons

### Phase 2: Symbol Table Initialization

The assembler pre-populates a symbol table with:
- **Hardware registers**: POT0-POT2, ADCL, ADCR, DACL, DACR
- **General registers**: REG0-REG31
- **LFO references**: SIN0, SIN1, RMP0, RMP1
- **CHO operation types**: RDA, SOF, RDAL
- **Condition codes**: RUN, ZRC, ZRO, GEZ, NEG

### Phase 3: Parsing

The parser uses recursive descent to handle:

#### Expression Parsing
Supports full arithmetic with operator precedence:
- **Bitwise**: `|` (OR), `^` (XOR), `&` (AND)
- **Shift**: `<<`, `>>`
- **Arithmetic**: `+`, `-`, `*`, `/`, `//` (integer division)
- **Power**: `**`
- **Unary**: `-`, `~`, `!`

#### Fixed-Point Number Formats
The FV-1 uses various fixed-point formats:

- **S.10** (11-bit): 1 sign + 10 fractional bits, range -1.0 to ~0.999
- **S.15** (16-bit): 1 sign + 15 fractional bits, range -1.0 to ~0.999
- **S.23** (24-bit): 1 sign + 23 fractional bits, range -1.0 to ~0.999
- **S1.9** (11-bit): 1 sign + 1 integer + 9 fractional bits, range -2.0 to ~1.999
- **S1.14** (16-bit): 1 sign + 1 integer + 14 fractional bits, range -2.0 to ~1.999
- **S4.6** (11-bit): 1 sign + 4 integer + 6 fractional bits, range -16.0 to ~15.98

#### Instruction Parsing
Each instruction type has specific parsing rules:

**Memory Operations:**
```assembly
RDA DELAY, 0.5     ; Read from delay memory with coefficient
WRA DELAY, 0.8     ; Write to delay memory with coefficient
```

**Register Operations:**
```assembly
RDAX POT0, 0.5     ; Read register with multiplication
WRAX DACL, 1.0     ; Write to register with multiplication
```

**Mathematical Operations:**
```assembly
SOF 0.5, 0.1       ; Scale and offset: ACC = ACC * 0.5 + 0.1
LOG 0.8, 0.2       ; Logarithm with scaling
EXP 1.0, 0.0       ; Exponential with scaling
```

### Phase 4: Memory Management

#### Delay Memory Allocation
The `MEM` directive allocates delay memory:
```assembly
MEM DELAY 1024     ; Allocate 1024 samples
; Creates symbols:
;   DELAY   = base address
;   DELAY#  = end address (base + size)
;   DELAY^  = middle address (base + size/2)
```

#### Program Memory
- Maximum 128 instructions (4 bytes each = 512 bytes total)
- Instructions automatically padded to 128 with NOPs

### Phase 5: Code Generation

Each instruction is converted to a 32-bit machine code word:

```javascript
// Example: SOF 0.5, 0.1
// Opcode: 0b01101 (SOF)
// Multiplier: 0.5 * 2^14 = 8192 (S1.14 format)  
// Offset: 0.1 * 2^10 = 102 (S.10 format)
machineCode = 0b01101 | (8192 << 16) | (102 << 5);
```

**Bit Field Layout varies by instruction:**
- Bits 0-4: Opcode
- Bits 5-31: Operands (register addresses, coefficients, etc.)

## Supported Instructions

### Core Instructions

**Accumulator Operations:**
- `LDAX reg` - Load register to accumulator (pseudo for RDFX reg, 0)
- `CLR` - Clear accumulator (pseudo for AND 0)

**Arithmetic:**
- `SOF coeff, offset` - Scale and offset
- `MULX reg` - Multiply by register
- `LOG coeff, offset` - Logarithm
- `EXP coeff, offset` - Exponential

**Logic:**
- `AND mask` - Bitwise AND
- `OR mask` - Bitwise OR  
- `XOR mask` - Bitwise XOR
- `NOT` - Bitwise NOT (pseudo for XOR 0xFFFFFF)

**Register I/O:**
- `RDAX reg, coeff` - Read register with coefficient
- `WRAX reg, coeff` - Write to register with coefficient
- `RDFX reg, coeff` - Read register with coefficient (filtered)
- `WRLX reg, coeff` - Write to register (low shelf)
- `WRHX reg, coeff` - Write to register (high shelf)

**Memory I/O:**
- `RDA addr, coeff` - Read delay memory
- `WRA addr, coeff` - Write delay memory
- `WRAP addr, coeff` - Write delay memory with wrap
- `RMPA coeff` - Ramp delay address

**Control Flow:**
- `SKP condition, target` - Skip instructions conditionally
- `NOP` - No operation (pseudo for SKP 0, 0)

**LFO Control:**
- `WLDS lfo, freq, amp` - Write LFO sine
- `WLDR lfo, freq, amp` - Write LFO ramp
- `CHO type, lfo, flags, coeff` - Chorus/LFO operations
- `JAM lfo` - Reset LFO

### Pseudo-Instructions

Some instructions are implemented as combinations of others:
- `LDAX reg` → `RDFX reg, 0`
- `CLR` → `AND 0`  
- `NOT` → `XOR 0xFFFFFF`
- `NOP` → `SKP 0, 0`
- `ABSA` → `MAXX 0, 0`

## Assembly Options

### Clamp Out-of-Range Values
When enabled, values exceeding format ranges are automatically clamped rather than causing errors:
```javascript
// S.10 range: -1.0 to 0.999
// Input: 1.5 → Clamped to 0.999
// Input: -2.0 → Clamped to -1.0
```

### SpinASM Reals Compatibility
Makes integer literals 1 and 2 treated as floating-point (1.0, 2.0) for compatibility with the original SpinASM assembler.

## Error Handling

The assembler provides detailed error reporting:

### Syntax Errors
- Undefined symbols
- Invalid instruction formats
- Missing operands
- Type mismatches

### Semantic Errors  
- Register numbers out of range (0-63)
- Memory addresses exceeding chip limits
- Skip offsets too large (max 63)
- Delay memory exhaustion

### Warnings
- Value clamping when enabled
- Label redefinition
- Invalid flag combinations

## Output Formats

### Intel HEX Format
Standard format for programming microcontrollers:
```
:04000000018001000E2
:04000400028002000C4
:00000001FF
```
- Each line contains 4 bytes (1 instruction)
- Includes address and checksum
- Terminated with EOF record

### Binary Format
Raw 512-byte binary file containing machine code directly loadable to FV-1.

## Example Programs

### Simple Pass-Through
```assembly
LDAX ADCL        ; Load left input
WRAX DACL, 0     ; Write to left output
LDAX ADCR        ; Load right input  
WRAX DACR, 0     ; Write to right output
```

### Basic Delay/Reverb
```assembly
MEM DELAY 8192   ; Allocate delay memory
LDAX ADCL        ; Load input
WRA DELAY, 0.5   ; Write to delay with feedback
RDA DELAY#, 0.6  ; Read from end of delay
WRAX DACL, 0     ; Output delayed signal
```

### Tremolo Effect
```assembly
WLDS SIN0, 10, 32767    ; Set up LFO
LDAX ADCL               ; Load input
MULX POT0               ; Scale by pot
CHO SOF, SIN0, SIN|REG|COMPC, 0  ; Apply tremolo
WRAX DACR, 0            ; Output
```

## Technical Details

### Memory Layout
- **Program Memory**: 128 × 32-bit instructions (512 bytes)
- **Delay Memory**: 32,767 samples maximum
- **Registers**: 32 general-purpose + special I/O registers

### Number Formats
The assembler automatically converts between decimal and fixed-point:
```javascript
// Input: 0.5
// S1.14: 0.5 × 2^14 = 8192 = 0x2000
// S.10:  0.5 × 2^10 = 512  = 0x200
```

### Symbol Resolution
Two-pass assembly resolves forward references:
1. **First pass**: Parse instructions, build symbol table
2. **Second pass**: Resolve labels, generate machine code

This web application provides a complete development environment for FV-1 programming, making it accessible to create custom audio effects without requiring specialized software installation.