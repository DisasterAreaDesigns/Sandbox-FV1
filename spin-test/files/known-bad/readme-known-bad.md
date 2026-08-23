# Known bad programs

These are not assembler bugs. Both programs contain invalid SpinASM and
will not assemble with any FV-1 assembler. They are kept here for
reference and moved out of `files/` so they do not show up as failures
in the test run - `loadTestProgramsFromDirectory()` in `spin-test/test.js`
does not recurse into subdirectories.

## faux-phaser.spn

Line 23:

    CHO RDAL,4

The FV-1 has four LFOs, selected as 0-3 (SIN0, SIN1, RMP0, RMP1). There
is no LFO 4. Line 20 of the same program correctly uses `CHO RDAL,0`.

## shimmer-2.spn

Line 139, and again at 156, 166, 201 and 217:

    mulx kd

`kd` is declared on line 36 as a coefficient, not a register:

    equ kd -0.5

`MULX` multiplies the accumulator by the contents of a register and takes
a register address (0-63) as its operand. Passing -0.5 truncates to -1,
which is out of range. Multiplying by a constant is `SOF -0.5, 0`.
