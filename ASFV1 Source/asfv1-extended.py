#
# asfv1: Alternate FV-1 Assembler
# Copyright (C) 2017-2019 Nathan Fraser
#
# MODIFIED 2026 for the FV-2040 project: an extended instruction set,
# enabled per-source by a '#extended' line and otherwise dormant.  See
# README.md.  Modifications are released under the same licence.
#
# An alternate assembler for the Spin Semiconductor FV-1 DSP.
# For more information on the FV-1, refer to the Spin website:
#
#  Web Site: http://spinsemi.com/products.html
#  Datasheet: http://spinsemi.com/Products/datasheets/spn1001/FV-1.pdf
#  AN0001: http://spinsemi.com/Products/appnotes/spn1001/AN-0001.pdf
#
# Released under the MIT licence, as upstream is: see
# https://github.com/ndf-zz/asfv1 and ThirdPartyNotices.txt.  The copy this
# was forked
# from carried a GPL-3 block that upstream's own 1.2.7 does not have -- a
# stale header from an early revision, not the licence the code is under.

# Python 2 compatibility
from __future__ import division
from __future__ import print_function
from __future__ import unicode_literals
from __future__ import absolute_import
from builtins import range
from builtins import open
from builtins import str
from builtins import round
from builtins import int

# Imports
import argparse
import sys
import shlex
import struct

# Constants
VERSION = '1.2.7'
PROGLEN = 128
DELAYSIZE = 32767
DELAYSIZE_EXT = 65535	# extended: 16 bit delay addressing
MAXERR = 10	# abort assembly if too many errors found

# Fixed point reals SN_D with one sign bit (S),
# N integer bits and D fractional bits:
#
#	REF_... reference value at +1.0: 2**D
#	MIN_... smallest real number: -2**(N+D)/2**D == -2**N
#	MAX_... largest real number: (2**(N+D)-1)/REF
#
REF_S1_14 = 2.0**14			# 16384.0
MIN_S1_14 = -2.0**1			# -2.0
MAX_S1_14 = (2.0**(1+14)-1.0)/REF_S1_14	# 1.99993896484375

REF_S1_9 = 2.0**9			# 512.0
MIN_S1_9 = -2.0**1			# -2.0
MAX_S1_9 = (2.0**(1+9)-1.0)/REF_S1_9	# 1.998046875

REF_S_10 = 2.0**10			# 1024.0
MIN_S_10 = -2.0**0			# -1.0
MAX_S_10 = (2.0**(0+10)-1.0)/REF_S_10	# 0.9990234375

REF_S_15 = 2.0**15			# 32768.0
MIN_S_15 = -2.0**0			# -1.0
MAX_S_15 = (2.0**(0+15)-1.0)/REF_S_15	# 0.999969482421875

REF_S4_6 = 2.0**6			# 64.0
MIN_S4_6 = -2.0**4			# -16.0
MAX_S4_6 = (2.0**(4+6)-1.0)/REF_S4_6	# 15.984375

REF_S_23 = 2.0**23			# 8388608.0
MIN_S_23 = -2.0**0			# -1.0
MAX_S_23 = (2.0**(0+23)-1.0)/REF_S_23	# 0.9999998807907104

# Bit Masks
M1 = 0x01
M2 = 0x03
M3 = 0x07
M5 = 0x1f
M6 = 0x3f
M8 = 0xff
M9 = 0x1ff
M11 = 0x7ff
M14 = 0x3fff
M15 = 0x7fff
M16 = 0xffff
M24 = 0xffffff
M27 = 0x7ffffff
M32 = 0xffffffff

def quiet(msg):
    pass

def warning(msg):
    print(msg, file=sys.stderr)

def error(msg):
    print(msg, file=sys.stderr)

def bintoihex(buf, spos=0x0000, width=4):
    """Convert binary buffer to ihex and return as string."""
    c = 0
    olen = len(buf)
    ret = ""
    while(c < olen):
        rem = olen-c
        if rem > width:
            rem = width
        sum = rem
        adr = c + spos
        l = ':{0:02X}{1:04X}00'.format(rem,adr)   # rem < 0x10
        sum += ((adr>>8)&M8)+(adr&M8)
        for j in range(0,rem):
            nb = buf[c+j]
            l += '{0:02X}'.format(nb)
            sum = (sum + nb)&M8
        l += '{0:02X}'.format((~sum+1)&M8)
        ret += l + '\n'
        c += rem
    ret += ':00000001FF\n'        # EOF
    return ret

# Machine instruction table
op_tbl = {
        # mnemonic: [opcode, (arglen,left shift), ...]
        'RDA':  [0b00000, (M15,5),(M11,21)],
        'RMPA': [0b00001, (M11,21)],
        'WRA':  [0b00010, (M15,5),(M11,21)],
        'WRAP': [0b00011, (M15,5),(M11,21)],
        'RDAX': [0b00100, (M6,5),(M16,16)],
        'RDFX': [0b00101, (M6,5),(M16,16)],
        'LDAX':	[0b00101, (M6,5)], # psuedo: RDFX REG,0
        'WRAX': [0b00110, (M6,5),(M16,16)],
        'WRHX': [0b00111, (M6,5),(M16,16)],
        'WRLX': [0b01000, (M6,5),(M16,16)],
        'MAXX': [0b01001, (M6,5),(M16,16)],
        'ABSA':	[0b01001, ], # pseudo: MAXX 0,0
        'MULX': [0b01010, (M6,5)],
        'LOG':  [0b01011, (M16,16),(M11,5)],
        'EXP':  [0b01100, (M16,16),(M11,5)],
        'SOF':  [0b01101, (M16,16),(M11,5)],
        'AND':  [0b01110, (M24,8)],
        'CLR':	[0b01110, ], # pseudo: AND $0
        'OR' :  [0b01111, (M24,8)],
        'XOR':  [0b10000, (M24,8)],
        'NOT':	[0b10000, (M24,8)], # pseudo: XOR $ffffff
        'SKP':  [0b10001, (M5,27),(M6,21)],	# note 1
        'JMP':  [0b10001, (M5,27),(M6,21)],	# pseudo skp 0,...
        'NOP':	[0b10001, ], # pseudo: SKP 0,0 note 2
        'WLDS': [0b10010, (M1,29),(M9,20),(M15,5)],
        'WLDR': [0b10010, (M2,29),(M16,13),(M2,5)], # CHECK
        'JAM':  [0b10011, (M2,6)],
        'CHO':  [0b10100, (M2,30),(M2,21),(M6,24),(M16,5)], # CHECK
        'RAW':  [0b00000, (M32,0)],         # direct data insertion
        # Notes:
        # 1. In SpinASM IDE , condition flags expand to shifted values,
        # 2. NOP is not documented, but expands to SKP 0,0 in SpinASM
}

# Extended instruction table, enabled per-source by a '#extended' line.
#
# Bit 20 of RDA/WRA/WRAP is defined by nothing -- not the datasheet, not
# the table above -- and no program in the corpus sets it (341 bank slots,
# 43648 instructions checked).  It extends the delay address to 16 bits
# without moving a single existing field.
#
# RMPA encodes nothing but a coefficient at 31:21, leaving 20:5 free.
# RMPAX sets bit 5, which selects a pointer scale of ACC[22:7]: 16 address
# bits and 7 of interpolation fraction, instead of the FV-1's ACC[23:8]
# where the 16th bit is the accumulator's sign.  That is what makes the
# whole 64k tank reachable from a positive accumulator, so the ordinary
# 'wrax ADDR_PTR / rmpax' idiom sweeps end to end with no seam.  It costs
# one bit of interpolation fraction, which is the only place it can come
# from -- 24 bits have to hold both an address and a fraction.
#
# RAND takes an opcode of its own rather than a spare bit, because there
# is opcode space and there is no field to steal from: it needs a register
# and a coefficient, which is a full RDAX word.  The opcode field is five
# bits and the FV-1 assigns 0-20, so 0b10101 and everything above it is
# free -- and free without a corpus survey, unlike bit 20 above: no
# assembler emits an opcode it has no mnemonic for, and short programs are
# padded with SKP.
#
# Operands are RDAX's, field for field: register at 10:5, S1.14
# coefficient at 31:16.  The coefficient is the amplitude, so 'rand
# REG0,1.0' is full scale and 'rand REG0,0.002' is a dither, without
# spending a second instruction to scale it.
ext_op_tbl = {
        # mnemonic: [opcode, (arglen,left shift), ...]
        'RDA':  [0b00000, (M16,5),(M11,21)],
        'WRA':  [0b00010, (M16,5),(M11,21)],
        'WRAP': [0b00011, (M16,5),(M11,21)],
        'RMPAX':[0b00001, (M11,21),(M1,5)],
        'RAND': [0b10101, (M6,5),(M16,16)],
        # Four more LFOs -- SIN2, SIN3, RMP2, RMP3 -- each needing one
        # more select bit, and each instruction that names an LFO has
        # exactly one to spare that no assembled program has ever set.
        # CHO's select widens from bits 21-22 to 21-23: the datasheet
        # leaves 23 blank between N and the flags.  JAM's widens from
        # 6-7 to 6-8; it has nothing above.  Both carry the same code,
        # the FV-1's own with a third bit above it, so bit 1 still means
        # "ramp" and 0-3 still mean what they did.  WLDS and WLDR share
        # bit 31, the only bit WLDS has free (amplitude fills 5-19, rate
        # 20-28, select 29, kind 30); WLDR could have used 7-12 but the
        # same bit in both keeps the select one shape.
        'CHO':  [0b10100, (M2,30),(M3,21),(M6,24),(M16,5)],
        'JAM':  [0b10011, (M3,6)],
        'WLDS': [0b10010, (M1,29),(M9,20),(M15,5),(M1,31)],
        'WLDR': [0b10010, (M2,29),(M16,13),(M2,5),(M1,31)],
}

# LFO codes above the FV-1's four, as CHO and JAM carry them: bit 2 is
# the extension, bit 1 the kind, bit 0 the low select.  WLDS and WLDR
# take the low bit at 29 and the top bit at 31, which __lfo_bits__
# splits out.
EXT_LFO = {'SIN2': 0x04, 'SIN3': 0x05, 'RMP2': 0x06, 'RMP3': 0x07}
EXT_LFO_REGS = {
        'SIN2_RATE': 0x08, 'SIN2_RANGE': 0x09,
        'SIN3_RATE': 0x0a, 'SIN3_RANGE': 0x0b,
        'RMP2_RATE': 0x0c, 'RMP2_RANGE': 0x0d,
        'RMP3_RATE': 0x0e, 'RMP3_RANGE': 0x0f,
}

# Names that exist only under '#extended'.  They are recognised even when
# it is off, so that using one without the pragma says why: RMPAX would
# otherwise fail as a label three errors later ("Expected EQU or MEM but
# saw FLOAT"), which is true and tells you nothing.  Naming the cause is
# the whole job -- the assembly still fails, exactly as it did.
EXT_ONLY_OPS  = frozenset(['RMPAX', 'RAND'])
EXT_ONLY_REGS = frozenset(['POT3', 'POT4', 'POT5']
                          + list(EXT_LFO) + list(EXT_LFO_REGS))

def op_gen(mcode, tbl=None):
    """Generate a machine instruction using the op gen table."""
    gen = (tbl if tbl is not None else op_tbl)[mcode[0]]
    ret = gen[0]	# opcode
    nargs = len(gen)
    i = 1
    while i < nargs:
        if i < len(mcode):	# or assume they are same len
            ret |= (mcode[i]&gen[i][0]) << gen[i][1]
        i += 1
    return ret

class fv1parse(object):
    def __init__(self, source=None, clamp=True,
                 spinreals=False, wfunc=None, efunc=None):
        self.program = bytearray(512)
        self.doclamp = clamp
        self.spinreals = spinreals
        self.dowarn = wfunc
        self.doerror = efunc
        self.delaymem = 0
        self.prevline = 0	# line number for last accepted symbol
        self.sline = 0		# line number of current symbol
        self.icnt = 0
        self.sym = None
        self.ecount = 0
        self.source = source.split('\n')
        self.linebuf = []
        self.pl = []	# parse list
        self.mem = {}	# delay memory
        self.jmptbl = { # jump table for skips
        }
        self.symtbl = {	# symbol table
                'SIN0_RATE':	0x00,
                'SIN0_RANGE':	0x01,
                'SIN1_RATE':	0x02,
                'SIN1_RANGE':	0x03,
                'RMP0_RATE':	0x04,
                'RMP0_RANGE':	0x05,
                'RMP1_RATE':	0x06,
                'RMP1_RANGE':	0x07,
                'POT0':		0x10,
                'POT1':		0x11,
                'POT2':		0x12,
                'ADCL':		0x14,
                'ADCR':		0x15,
                'DACL':		0x16,
                'DACR':		0x17,
                'ADDR_PTR':	0x18,
                'REG0':		0x20,
                'REG1':		0x21,
                'REG2':		0x22,
                'REG3':		0x23,
                'REG4':		0x24,
                'REG5':		0x25,
                'REG6':		0x26,
                'REG7':		0x27,
                'REG8':		0x28,
                'REG9':		0x29,
                'REG10':	0x2a,
                'REG11':	0x2b,
                'REG12':	0x2c,
                'REG13':	0x2d,
                'REG14':	0x2e,
                'REG15':	0x2f,
                'REG16':	0x30,
                'REG17':	0x31,
                'REG18':	0x32,
                'REG19':	0x33,
                'REG20':	0x34,
                'REG21':	0x35,
                'REG22':	0x36,
                'REG23':	0x37,
                'REG24':	0x38,
                'REG25':	0x39,
                'REG26':	0x3a,
                'REG27':	0x3b,
                'REG28':	0x3c,
                'REG29':	0x3d,
                'REG30':	0x3e,
                'REG31':	0x3f,
                'SIN0':		0x00,
                'SIN1':		0x01,
                'RMP0':		0x02,
                'RMP1':		0x03,
                'RDA':		0x00,
                'SOF':		0x02,
                'RDAL':		0x03,
                'SIN':		0x00,
                'COS':		0x01,
                'REG':		0x02,
                'COMPC':	0x04,
                'COMPA':	0x08,
                'RPTR2':	0x10,
                'NA':		0x20,
                'RUN':		0x10,
                'ZRC':		0x08,
                'ZRO':		0x04,
                'GEZ':		0x02,
                'NEG':		0x01,
    }

        # Extended instruction set state.  These are the FV-1's own
        # limits until a '#extended' line in the source moves them.
        self.extended = False
        # The extension-only mnemonics are in the table either way, so
        # the scanner reads one as a mnemonic and its operands are
        # consumed normally; __instruction__ refuses it when the pragma
        # is off.  Encoding it is unreachable from there -- an error has
        # already been counted and nothing is written -- but the entries
        # are the real ones rather than stubs, so the two paths cannot
        # disagree about what RMPAX or RAND means.
        self.op_tbl = dict(op_tbl)
        for m in EXT_ONLY_OPS:
            self.op_tbl[m] = ext_op_tbl[m]
        self.delaysize = DELAYSIZE	# largest address MEM may allocate
        self.addrmax = M15		# largest literal delay address
        self.__pragma__()

    def __pragma__(self):
        """Scan the source for assembler pragmas before tokenising.

        A pragma is a line whose first non-blank character is '#'.  There
        is no ambiguity to resolve: '#' appears in FV-1 source only as a
        MEM label modifier and never leads a line, so the scanner would
        reject one as unrecognised input anyway.

        Matched lines are blanked rather than removed, so every line
        number in every later message is still the one in the file.  A
        pragma may sit anywhere -- what it changes is global to the
        assembly, and a rule about position would only be a rule to
        break.
        """
        for i, line in enumerate(self.source):
            body = line.split(';')[0].strip()
            if not body.startswith('#'):
                continue
            self.source[i] = ''
            if body[1:].strip().upper() == 'EXTENDED':
                self.__extend__()
            else:
                self.parseerror('Unknown pragma {}'.format(body), i+1)

    def __extend__(self):
        """Enable the extended instruction set for this source.

        16 bit delay addressing, POT3-POT5, RMPAX, RAND, and four more
        LFOs with their eight registers.  Everything is additive and
        copies rather than edits the FV-1 tables: a source
        without the pragma assembles through exactly the code it did
        before, which is the only reason it is safe to touch a tool the
        whole corpus depends on.
        """
        if self.extended:
            return
        self.extended = True
        self.op_tbl.update(ext_op_tbl)
        self.delaysize = DELAYSIZE_EXT
        self.addrmax = M16
        # Contiguous, and stopping short of 0x1f: a multiplexer gives
        # eight channels, so 0x1c-0x1f is left for POT6-POT9 rather than
        # taking the tidier-looking 0x13 next to POT2 and splitting the
        # run the firmware has to write.
        self.symtbl['POT3'] = 0x19
        self.symtbl['POT4'] = 0x1a
        self.symtbl['POT5'] = 0x1b
        # 0x08-0x0f is the gap the FV-1 leaves between RMP1_RANGE and
        # POT0: eight registers, four LFOs' worth, in the same pairs.
        self.symtbl.update(EXT_LFO)
        self.symtbl.update(EXT_LFO_REGS)
        self.dowarn('info: Extended instruction set enabled')

    def __mkopcodes__(self):
        """Convert the parse list into machine code for output."""
        proglen = len(self.pl)
        self.dowarn('info: Read {} instructions from input'.format(
                proglen))

        # pad free space with empty SKP instructions
        icnt = proglen
        while icnt < PROGLEN:
            self.pl.append({'cmd':['SKP',0x00,0x00],
                            'addr':icnt,
                            'target':None})
            icnt += 1
        
        # convert program to machine code and prepare for output
        oft = 0
        for i in self.pl:
            struct.pack_into('>I', self.program, oft,
                             op_gen(i['cmd'], self.op_tbl))
            oft += 4

    def __register__(self, mnemonic=''):
        """Fetch a register definition."""
        xtra = ''
        if mnemonic:
            xtra = ' for ' + mnemonic
        reg = self.__expression__()
        if int(reg) == reg:
            reg = int(reg)
            if reg < 0 or reg > 63:
                self.parseerror('Register {0:#x} out of range'.format(reg)
                                + xtra)
                reg = 0
        else:
            self.parseerror('Invalid register {}'.format(reg)
                            + xtra)
            reg = 0
        return reg

    def __d_15__(self,mnemonic=''):
        """Fetch a 15 bit delay address, preferring integer interpretation"""
        xtra = ''
        if mnemonic:
            xtra = ' for ' + mnemonic
        oft = self.__expression__()
        if oft < MIN_S_15 or oft > MAX_S_15:
            oft = int(round(oft))
            if oft < -0x8000 or oft > M15:
                if self.doclamp:
                    if oft < -0x8000:
                        oft = -0x8000
                    elif oft > M15:
                        oft = M15
                    self.parsewarn('Address clamped to {0:#x}'.format(oft)
                                   + xtra)
                else:
                    self.parseerror('Invalid address {0:#x}'.format(oft)
                                    + xtra)
                    oft = 0
        else:
            oft = int(round(oft * REF_S_15))
        return oft

    def __d_addr__(self, mnemonic=''):
        """Fetch a delay address, preferring integer interpretation.

        __d_15__ with the width in force, which '#extended' widens to 16
        bits.  Deliberately a separate method: WLDS reads its 15 bit sine
        amplitude through __d_15__, and that field must not follow the
        address width anywhere -- widening the shared one would let an
        out of range amplitude through to be masked off in op_gen, which
        is silent and wrong.

        The real-valued form is left at REF_S_15, so 'rda 0.5' still means
        address 16384 and not half of a bigger tank.  Porting a source by
        adding the pragma must not move an address that was already there.
        """
        xtra = ''
        if mnemonic:
            xtra = ' for ' + mnemonic
        oft = self.__expression__()
        if oft < MIN_S_15 or oft > MAX_S_15:
            oft = int(round(oft))
            if oft < -0x8000 or oft > self.addrmax:
                if self.doclamp:
                    if oft < -0x8000:
                        oft = -0x8000
                    elif oft > self.addrmax:
                        oft = self.addrmax
                    self.parsewarn('Address clamped to {0:#x}'.format(oft)
                                   + xtra)
                else:
                    self.parseerror('Invalid address {0:#x}'.format(oft)
                                    + xtra
                                    + self.__extra_hint__(
                                        'reaches 16 bit addresses', oft))
                    oft = 0
        else:
            oft = int(round(oft * REF_S_15))
        return oft

    def __extra_hint__(self, msg, val=None):
        """Say when the pragma is what stands between here and success.

        Only when it would actually help: for an address, one inside the
        extended range and outside the FV-1's.  A plain typo gets the
        plain message, because a hint on every out of range number is
        noise, and noise is how real messages get skipped.
        """
        if self.extended:
            return ''
        if val is not None and not (M15 < val <= M16):
            return ''
        return ' (#extended ' + msg + ')'

    def __offset__(self, mnemonic=''):
        """Fetch a skip offset definition."""
        xtra = ''
        if mnemonic:
            xtra = ' for ' + mnemonic
        oft = self.__expression__()
        if int(oft) == oft:
            oft = int(oft)
            if oft < 0 or oft > M6:
                self.parseerror('Offset {} out of range'.format(oft)
                                + xtra)
                oft = 0
        else:
            self.parseerror('Invalid offset {}'.format(oft)
                            + xtra)
            oft = 0
        return oft

    def __condition__(self, mnemonic=''):
        """Fetch a skip condition code."""
        xtra = ''
        if mnemonic:
            xtra = ' for ' + mnemonic
        cond = self.__expression__()
        if int(cond) == cond:
            cond = int(cond)
            if cond < 0 or cond > M5:
                self.parseerror('Condition {0:#x} out of range'.format(
                                cond) + xtra)
                cond = 0
        else:
            self.parseerror('Invalid condition {}'.format(cond) + xtra)
            cond = 0
        return cond

    def __chotype__(self):
        """Fetch CHO type code."""
        # this is not an operand - the symbol text is examined directly
        chotype = self.sym['stxt']
        self.__next__()
        if chotype in ['RDA','SOF','RDAL']:
            chotype = self.symtbl[chotype]
        else:
            self.parseerror('Invalid CHO type {}'.format(chotype))
            chotype = 0
        return chotype

    def __choflags__(self, lfo=None):
        """Fetch CHO condition flags."""
        flags = self.__expression__()
        if int(flags) == flags:
            flags = int(flags)
            if flags < 0 or flags > M6:
                self.parseerror('Invalid flags {0:#x} for CHO'.format(flags))
                flags = 0
        else:
            self.parseerror('Invalid flags {} for CHO'.format(flags))
            flags = 0
        oflags = flags
        if lfo&0x02: # RMP0/RMP1
            flags = oflags & 0x3e
            if oflags != flags:
                self.parsewarn('RMP flags set to {0:#x} for CHO'.format(
                                flags))
        else:
            flags = oflags & 0x0f
            if oflags != flags:
                self.parsewarn('SIN flags set to {0:#x} for CHO'.format(
                                flags))
        return flags

    def __s1_14__(self, mnemonic=''):
        """Fetch a 16 bit real argument."""
        xtra = ''
        if mnemonic:
            xtra = ' for ' + mnemonic
        arg = self.__expression__()
        if isinstance(arg, int):
            if arg < 0 or arg > M16:
                if self.doclamp:
                    if arg < 0:
                        arg = 0
                    elif arg > M16:
                        arg = M16
                    self.parsewarn('S1_14 arg clamped to {0:#x}'.format(arg)
                                   + xtra)
                else:
                    self.parseerror('S1_14 arg {0:#x} out of range'.format(
                                    arg) + xtra)
                    arg = 0
        else:
            if arg < MIN_S1_14 or arg > MAX_S1_14:
                if self.doclamp:
                    if arg < MIN_S1_14:
                        arg = MIN_S1_14
                    elif arg > MAX_S1_14:
                        arg = MAX_S1_14
                    self.parsewarn('S1_14 arg clamped to {}'.format(arg)
                                   + xtra)
                else:
                    self.parseerror('S1_14 arg {} out of range'.format(arg)
                                    + xtra)
                    arg = 0
            arg = int(round(arg * REF_S1_14))
        return arg

    def __s_10__(self, mnemonic=''):
        """Fetch an 11 bit S_10 real argument."""
        xtra = ''
        if mnemonic:
            xtra = ' for ' + mnemonic
        arg = self.__expression__()
        if isinstance(arg, int):
            if arg < 0 or arg > M11:
                if self.doclamp:
                    if arg < 0:
                        arg = 0
                    elif arg > M11:
                        arg = M11
                    self.parsewarn('S_10 arg clamped to {0:#x}'.format(
                                   arg) + xtra)
                else:
                    self.parseerror('S_10 arg {0:#x} out of range'.format(
                                    arg) + xtra)
                    arg = 0
        else:
            if arg < MIN_S_10 or arg > MAX_S_10:
                if self.doclamp:
                    if arg < MIN_S_10:
                        arg = MIN_S_10
                    elif arg > MAX_S_10:
                        arg = MAX_S_10
                    self.parsewarn('S_10 arg clamped to {}'.format(arg)
                                   + xtra)
                else:
                    self.parseerror('S_10 arg {} out of range'.format(arg)
                                    + xtra)
                    arg = 0
            arg = int(round(arg * REF_S_10))
        return arg

    def __s_15a__(self, mnemonic=''):
        """Fetch a 16 bit S_15 real address argument."""
        xtra = ''
        if mnemonic:
            xtra = ' for ' + mnemonic
        arg = self.__expression__()
        if self.spinreals and arg == int(arg):
            arg = int(arg)
        if isinstance(arg, int):
            if arg < 0 or arg > M16:
                if self.doclamp:
                    if arg < 0:
                        arg = 0
                    elif arg > M16:
                        arg = M16
                    self.parsewarn('S_15 arg clamped to {0:#x}'.format(
                                   arg) + xtra)
                else:
                    self.parseerror('S_15 arg {0:#x} out of range'.format(
                                    arg) + xtra)
                    arg = 0
        else:
            if arg < MIN_S_15 or arg > MAX_S_15:
                if self.doclamp:
                    if arg < MIN_S_15:
                        arg = MIN_S_15
                    elif arg > MAX_S_15:
                        arg = MAX_S_15
                    self.parsewarn('S_15 arg clamped to {}'.format(arg)
                                   + xtra)
                else:
                    self.parseerror('S_15 arg {} out of range'.format(arg)
                                    + xtra)
                    arg = 0
            arg = int(round(arg * REF_S_15))
        return arg

    def __u_32__(self, mnemonic=''):
        """Fetch a raw 32 bit data string."""
        xtra = ''
        if mnemonic:
            xtra = ' for ' + mnemonic
        arg = self.__expression__()
        if isinstance(arg, int):
            if arg < 0 or arg > M32:
                if self.doclamp:
                    if arg < 0:
                        arg = 0
                    elif arg > M32:
                        arg = M32
                    self.parsewarn('U_32 arg clamped to {0:#x}'.format(arg)
                                   + xtra)
                else:
                    self.parseerror('U_32 arg {0:#x} out of range'.format(
                                    arg) + xtra)
                    arg = 0
        else:
            self.parseerror('Invalid U_32 arg {}'.format(arg) + xtra)
            arg = 0
        return arg

    def __s_23__(self, mnemonic=''):
        """Fetch a 24 bit S_23 real or mask argument."""
        xtra = ''
        if mnemonic:
            xtra = ' for ' + mnemonic
        arg = self.__expression__()
        if isinstance(arg, int):
            if arg < 0 or arg > M24:
                if self.doclamp:
                    if arg < 0:
                        arg = 0
                    elif arg > M24:
                        arg = M24
                    self.parsewarn('S_23 arg clamped to {0:#x}'.format(
                                   arg) + xtra)
                else:
                    self.parseerror('S_23 arg {0:#x} out of range'.format(
                                    arg) + xtra)
                    arg = 0
        else:
            if arg < MIN_S_23 or arg > MAX_S_23:
                if self.doclamp:
                    if arg < MIN_S_23:
                        arg = MIN_S_23
                    elif arg > MAX_S_23:
                        arg = MAX_S_23
                    self.parsewarn('S_23 arg clamped to {}'.format(arg)
                                   + xtra)
                else:
                    self.parseerror('S_23 arg {} out of range'.format(arg)
                                    + xtra)
                    arg = 0
            arg = int(round(arg * REF_S_23))
        return arg

    def __s1_9__(self, mnemonic=''):
        """Fetch an 11 bit real argument."""
        xtra = ''
        if mnemonic:
            xtra = ' for ' + mnemonic
        arg = self.__expression__()
        if isinstance(arg, int):
            if arg < 0 or arg > M11:
                if self.doclamp:
                    if arg < 0:
                        arg = 0
                    elif arg > M11:
                        arg = M11
                    self.parsewarn('S1_9 arg clamped to {0:#x}'.format(
                                   arg) + xtra)
                else:
                    self.parseerror('S1_9 arg {0:#x} out of range'.format(
                                    arg) + xtra)
                    arg = 0
        else:
            if arg < MIN_S1_9 or arg > MAX_S1_9:
                if self.doclamp:
                    if arg < MIN_S1_9:
                        arg = MIN_S1_9
                    elif arg > MAX_S1_9:
                        arg = MAX_S1_9
                    self.parsewarn('S1_9 arg clamped to {}'.format(arg)
                                   + xtra)
                else:
                    self.parseerror('S1_9 arg {} out of range'.format(arg)
                                    + xtra)
                    arg = 0
            arg = int(round(arg * REF_S1_9))
        return arg

    def __s4_6__(self, mnemonic=''):
        """Fetch an 11 bit S4_6 argument."""
        xtra = ''
        if mnemonic:
            xtra = ' for ' + mnemonic
        arg = self.__expression__()
        if isinstance(arg, int):
            if arg < 0 or arg > M11:
                if self.doclamp:
                    if arg < 0:
                        arg = 0
                    elif arg > M11:
                        arg = M11
                    self.parsewarn('S4_6 arg clamped to {0:#x}'.format(
                                   arg) + xtra)
                else:
                    self.parseerror('S4_6 arg {0:#x} out of range'.format(
                                    arg) + xtra)
                    arg = 0
        else:
            if arg < MIN_S4_6 or arg > MAX_S4_6:
                if self.doclamp:
                    if arg < MIN_S4_6:
                        arg = MIN_S4_6
                    elif arg > MAX_S4_6:
                        arg = MAX_S4_6
                    self.parsewarn('S4_6 arg clamped to {}'.format(arg)
                                   + xtra)
                else:
                    self.parseerror('S4_6 arg {} out of range'.format(arg)
                                    + xtra)
                    arg = 0
            arg = int(round(arg * REF_S4_6))
        return arg

    def __lfo__(self, mnemonic=''):
        """Select an LFO."""
        # there is some ambiguity here - but it is resolved in
        # WLDS by clearing the MSB, and in WLDR by ORing with 0x2
        xtra = ''
        if mnemonic:
            xtra = ' for ' + mnemonic
        lfo = self.__expression__()
        lfomax = 7 if self.extended else 3
        if int(lfo) == lfo:
            lfo = int(lfo)
            if lfo < 0 or lfo > lfomax:
                self.parseerror('Invalid LFO {0:#x}'.format(lfo) + xtra)
                lfo = 0
        else:
            self.parseerror('Invalid LFO {}'.format(lfo) + xtra)
            lfo = 0
        return lfo

    def __lfo_bits__(self, lfo):
        """Split an LFO code for WLDS/WLDR: (bit 29 field, bit 31 field).

        The kind bit is not part of it -- WLDS clears it and WLDR sets
        it, as they always have -- so the low select is bit 0 of the
        code and the high select is bit 2.  Without #extended the code
        is at most 3 and the high bit is always zero; the stock tables
        have no field for it and op_gen ignores an argument past the
        last field, so an unextended source assembles to the byte.
        """
        return lfo & 0x01, (lfo >> 2) & 0x01

    def __lfo_sinfreq__(self, mnemonic=''):
        """Fetch a sine LFO frequency value."""
        xtra = ''
        if mnemonic:
            xtra = ' for ' + mnemonic
        freq = self.__expression__()
        if int(freq) == freq:
            freq = int(freq)
            if freq < 0 or freq > M9:
                if self.doclamp:
                    if freq < 0:
                        freq = 0
                    elif freq > M9:
                        freq = M9
                    self.parsewarn('Frequency clamped to {0:#x}'.format(freq)
                                    + xtra)
                else:
                    self.parseerror('Invalid frequency {0:#x}'.format(freq)
                                    + xtra)
                    freq = 0
        else:
            self.parseerror('Invalid frequency {}'.format(freq)
                            + xtra)
            freq = 0
        return freq

    def __lfo_rampfreq__(self, mnemonic=''):
        """Fetch a RMP LFO frequency value."""
        xtra = ''
        if mnemonic:
            xtra = ' for ' + mnemonic
        freq = self.__expression__()
        if freq < -0.5 or freq > MAX_S_15:	# not quite right
            freq = int(round(freq))
            if freq < -0x8000 or freq > M15:
                if self.doclamp:
                    if freq < -0x8000:
                        freq = -0x8000
                    elif freq > M15:
                        freq = M15
                    self.parsewarn('Frequency clamped to {0:#x}'.format(freq)
                                   + xtra)
                else:
                    self.parseerror('Invalid frequency {0:#x}'.format(freq)
                                    + xtra)
                    freq = 0
        else:
            freq = int(round(freq * REF_S_15))
        return freq

    def __lfo_rampamp__(self, mnemonic=''):
        """Fetch a RMP LFO amplitude value."""
        xtra = ''
        if mnemonic:
            xtra = ' for ' + mnemonic
        amp = self.__expression__()
        rampamps = {4096:0, 2048:1, 1024:2, 512:3, 0:0, 1:1, 2:2, 3:3}
        if int(amp) == amp:
            amp = int(amp)
            if amp in rampamps:
                amp = rampamps[amp]
            else:
                self.parseerror('Invalid amplitude {}'.format(amp)
                                + xtra)
                amp = 0
        else:
            self.parseerror('Invalid amplitude {}'.format(amp)
                            + xtra)
            amp = 0
        return amp

    def __next__(self):
        """Fetch next symbol."""
        # Scanner uses shlex to break up the input, then reassembles
        # tokens into one of:
        #
        #  EOF : end of input marker
        #  MNEMONIC : instruction mnemonic text
        #  ASSEMBLER : assembler directive 'EQU' or 'MEM'
        #  OPERATOR : expression operator | ^ & << >> + - * // / ~ + - **
        #  INTEGER : integer numeric literal
        #  FLOAT : real numeric literal
        #  TARGET : target address in assembled program
        #  LABEL : text label
        #  ARGSEP : operand delimiting character ,
        #
        # comments are stripped by shlex.
        self.sym = None
        self.prevline = self.sline	# line of last fetched symbol
        while self.sym is None:
            if len(self.linebuf) == 0:	# nothing in line buf yet
                if len(self.source) > 0:	# still some lines in source
                    self.sline += 1
                    llex = shlex.shlex(self.source.pop(0))
                    llex.commenters = ';'
                    self.linebuf = [t for t in llex]
                else:
                    self.sym = {'type': 'EOF', 'txt':None,
                                'stxt':None, 'val':None}
            if len(self.linebuf) > 0:
                stxt = self.linebuf[0].upper()
                if stxt in self.op_tbl:	# MNEMONIC
                    self.sym = {'type': 'MNEMONIC',
                                'txt': self.linebuf.pop(0),
                                'stxt': stxt,
                                'val': None}
                elif stxt in ['EQU', 'MEM']:
                    self.sym = {'type': 'ASSEMBLER',
                                'txt': self.linebuf.pop(0),
                                'stxt': stxt,
                                'val': None}
                elif stxt in ['<','>','*','/']:
                    optxt = self.linebuf.pop(0)
                    if len(self.linebuf) > 0:
                        if self.linebuf[0] == optxt: # **, //, <<, >>
                            optxt += self.linebuf.pop(0)
                        if optxt in ['<','>']:
                            self.scanerror('Invalid operator {}'.format(optxt))
                            optxt += optxt
                    self.sym = {'type': 'OPERATOR',
                                'txt': optxt,
                                'stxt': optxt,
                                'val': None}
                elif stxt in ['|','^','&','+','-','~','!','(',')','INT']:
                    self.sym = {'type': 'OPERATOR',
                                'txt': self.linebuf.pop(0),
                                'stxt': stxt,
                                'val': None}
                elif stxt[0] in ['%', '$']:
                    # SpinASM style integers
                    pref = self.linebuf.pop(0)
                    base = 2
                    if pref == '$':
                        base = 16
                    if len(self.linebuf) > 0:
                        ht = self.linebuf.pop(0)
                        ival = 0
                        try:
                            ival = int(ht.replace('_',''),base)
                        except:
                            self.scanerror('Invalid integer literal {}'.format(
                                           pref+ht))
                        self.sym = {'type': 'INTEGER',
                                        'txt': pref+ht,
                                        'stxt': pref+ht,
                                        'val': ival}
                    else:
                        self.scanerror('End of line scanning for integer')
                        self.sym = {'type': 'INTEGER',
                                        'txt': pref,
                                        'stxt': pref,
                                        'val': 0}
                elif stxt[0].isdigit(): # INTEGER or FLOAT
                    intpart = self.linebuf.pop(0).lower()
                    ival = 0.0
                    if len(self.linebuf) > 0 and self.linebuf[0] == '.':
                        self.linebuf.pop(0)
                        if len(self.linebuf) > 0:
                            frac = self.linebuf.pop(0)
                            if frac.endswith('e') and len(self.linebuf) > 0:
                                epart = self.linebuf.pop(0)
                                if epart in ['+','-'] and len(self.linebuf) > 0:
                                    epart += self.linebuf.pop(0)
                                frac = frac+epart
                            try:
                                ival = float(intpart+'.'+frac)
                            except:
                                self.scanerror(
                                 'Invalid numeric literal {}'.format(
                                               intpart+'.'+frac))
                            self.sym = {'type': 'FLOAT',
                                        'txt': intpart+'.'+frac,
                                        'stxt': intpart+'.'+frac,
                                        'val': ival}
                        else:
                            self.scanerror('Invalid numeric literal')
                            self.sym = {'type': 'FLOAT',
                                        'txt': intpart+'.0',
                                        'stxt': intpart+'.0',
                                        'val': ival}
                    elif self.spinreals and intpart in ['2', '1']:
                        ival = float(intpart)
                        self.sym = {'type': 'FLOAT',
                                    'stxt': intpart+'.0',
                                    'txt': intpart,
                                    'val': ival}
                    else:	# assume integer
                        ival = 0
                        base = 10
                        if intpart.startswith('0x'):
                            base = 16
                        elif intpart.startswith('0b'):
                            base = 2
                        try:
                            ival = int(intpart, base)
                        except:
                            self.scanerror('Invalid integer literal {}'.format(
                                           intpart))
                        self.sym = {'type': 'INTEGER',
                                    'txt': intpart,
                                    'stxt': intpart,
                                    'val': ival}

                elif stxt[0].isalpha(): # TARGET or LABEL
                    lbl = self.linebuf.pop(0)
                    if len(self.linebuf) > 0 and self.linebuf[0] == ':':
                        self.sym = {'type': 'TARGET',
                                    'txt': lbl,
                                    'stxt': stxt,
                                    'val': None}
                        self.linebuf.pop(0)
                    else:
                        mod = ''
                        if len(self.linebuf) > 0 and self.linebuf[0] in [
                                               '^','$','#']:
                            # is the label already defined as MEM?
                            if stxt+self.linebuf[0] in self.symtbl:
                                mod = self.linebuf.pop(0)
                            # else the modifier is ignored
                        self.sym = {'type': 'LABEL',
                                    'txt': lbl+mod,
                                    'stxt': stxt+mod,
                                    'val': None}
                elif stxt == ',':	# ARGSEP
                    self.sym = {'type': 'ARGSEP',
                                'txt': self.linebuf.pop(0),
                                'stxt': stxt,
                                'val': None}
                elif self.linebuf[0] == '\ufeff':
                    self.linebuf.pop(0) # ignore BOM
                else:
                    self.scanerror('Unrecognised input {}'.format(
                                   self.linebuf.pop(0)))

    def scanerror(self, msg):
        """Emit scan error."""
        self.doerror('scan error on line {}: '.format(self.sline) + msg)
        self.ecount += 1
        if self.ecount > MAXERR:
            self.doerror('too many errors, aborting.')
            sys.exit(-1)

    def parsewarn(self, msg, line=None):
        """Emit parse warning."""
        if line is None:
            line = self.prevline
        self.dowarn('warning on line {}:{}'.format(line, msg))

    def parseerror(self, msg, line=None):
        """Emit parse error."""
        if line is None:
            line = self.prevline
        self.doerror('parse error on line {}: {}'.format(line, msg))
        self.ecount += 1
        if self.ecount > MAXERR:
            self.doerror('too many errors, aborting.')
            sys.exit(-2)

    def __accept__(self,stype,message=None):
        """Accept the next symbol if type matches stype."""
        if self.sym['type'] == stype:
            self.__next__()
        else:
            if message is not None:
                self.parseerror(message)
            else:
                self.parseerror('Expected {} but saw {} {}'.format(
                             stype, self.sym['type'], self.sym['txt']),
                                 self.sline)

    def __instruction__(self):
        """Parse an instruction."""
        mnemonic = self.sym['stxt']
        opmsg = 'Missing required operand for '+mnemonic
        self.__accept__('MNEMONIC')
        if mnemonic in EXT_ONLY_OPS and not self.extended:
            self.parseerror('{} requires #extended'.format(mnemonic))
        if self.icnt >= PROGLEN:
            self.parseerror('Max program exceeded by {}'.format(mnemonic))
        if mnemonic in ['AND', 'OR', 'XOR', ]:
            mask = self.__s_23__(mnemonic)
            self.pl.append({'cmd':[mnemonic, mask],'addr':self.icnt})
            self.icnt += 1
        elif mnemonic in ['SOF', 'EXP', 'LOG', ]:
            mult = self.__s1_14__(mnemonic)
            self.__accept__('ARGSEP',opmsg)
            oft = self.__s_10__(mnemonic)
            self.pl.append({'cmd':[mnemonic, mult, oft], 'addr':self.icnt})
            self.icnt += 1
        elif mnemonic in ['RDAX', 'WRAX', 'MAXX', 'RDFX', 'WRLX', 'WRHX',
                          'RAND',]:
            reg = self.__register__(mnemonic)
            self.__accept__('ARGSEP',opmsg)
            mult = self.__s1_14__(mnemonic)
            self.pl.append({'cmd':[mnemonic, reg, mult], 'addr':self.icnt})
            self.icnt += 1
        elif mnemonic in ['MULX', ]:
            reg = self.__register__(mnemonic)
            self.pl.append({'cmd':[mnemonic, reg], 'addr':self.icnt})
            self.icnt += 1
        elif mnemonic in ['SKP','JMP']:
            condition = 0
            if mnemonic == 'SKP':
                condition = self.__condition__(mnemonic)
                self.__accept__('ARGSEP',opmsg)
            target = None
            offset = 0x00
            sourceline = self.sline
            if self.sym['type'] in ['LABEL','TARGET']:
                target = self.sym['stxt']
                self.__next__()
            else:
                offset = self.__offset__(mnemonic)
            self.pl.append({'cmd':['SKP', condition, offset],
                            'target':target,
                            'addr':self.icnt,
                            'line':sourceline})
            self.icnt += 1
        elif mnemonic in ['RDA', 'WRA', 'WRAP',] :
            addr = self.__d_addr__(mnemonic)
            self.__accept__('ARGSEP',opmsg)
            mult = self.__s1_9__(mnemonic)
            self.pl.append({'cmd':[mnemonic, addr, mult], 'addr':self.icnt})
            self.icnt += 1
        elif mnemonic in ['RMPA', 'RMPAX']:
            mult = self.__s1_9__(mnemonic)
            cmd = [mnemonic, mult]
            if mnemonic == 'RMPAX':
                cmd.append(1)		# pointer scale select, bit 5
            elif self.extended:
                # Not an error: RMPA still means what it has always
                # meant.  But in a 64k tank it reaches only the low half,
                # and finding that out by hearing a delay stop halfway is
                # worse than being told.
                self.parsewarn('RMPA reads ADDR_PTR as ACC[23:8] and '
                               'reaches only the low 32k of an extended '
                               'delay; RMPAX reads the whole tank')
            self.pl.append({'cmd':cmd, 'addr':self.icnt})
            self.icnt += 1
        elif mnemonic == 'WLDS':
            lo, hi = self.__lfo_bits__(self.__lfo__(mnemonic))
            self.__accept__('ARGSEP',opmsg)
            freq = self.__lfo_sinfreq__(mnemonic)
            self.__accept__('ARGSEP',opmsg)
            amp = self.__d_15__(mnemonic)
            self.pl.append({'cmd':[mnemonic, lo, freq, amp, hi],
                            'addr':self.icnt})
            self.icnt += 1
        elif mnemonic == 'WLDR':
            lo, hi = self.__lfo_bits__(self.__lfo__(mnemonic))
            self.__accept__('ARGSEP',opmsg)
            freq = self.__lfo_rampfreq__(mnemonic)
            self.__accept__('ARGSEP',opmsg)
            amp = self.__lfo_rampamp__(mnemonic)
            self.pl.append({'cmd':[mnemonic, lo|0x02, freq, amp, hi],
                            'addr':self.icnt})
            self.icnt += 1
        elif mnemonic == 'CHO':
            chotype = self.__chotype__()
            self.__accept__('ARGSEP',opmsg)
            lfo = self.__lfo__(mnemonic)
            flags = 0b000010
            arg = 0x00
            if chotype == 0x00:	# cho rda,lfo,flags,address
                self.__accept__('ARGSEP',opmsg)
                flags = self.__choflags__(lfo)
                self.__accept__('ARGSEP',opmsg)
                arg = self.__s_15a__(mnemonic)
            elif chotype == 0x02:	# cho sof,lfo,flags,offset
                self.__accept__('ARGSEP',opmsg)
                flags = self.__choflags__(lfo)
                self.__accept__('ARGSEP',opmsg)
                arg = self.__s_15a__(mnemonic)
            elif chotype == 0x3:	# cho rdal,lfo[,flags]
                if self.sym['type'] == 'ARGSEP':
                    self.__accept__('ARGSEP')
                    flags = self.__choflags__(lfo)
            self.pl.append({'cmd':['CHO', chotype, lfo, flags, arg],
                            'addr':self.icnt})
            self.icnt += 1
        elif mnemonic == 'JAM':
            lfo = self.__lfo__(mnemonic)|0x02
            self.pl.append({'cmd':[mnemonic, lfo], 'addr':self.icnt})
            self.icnt += 1
        elif mnemonic == 'CLR':
            # pseudo command
            self.pl.append({'cmd':['AND', 0x00],'addr':self.icnt})
            self.icnt += 1
        elif mnemonic == 'NOT':
            # pseudo command XOR
            self.pl.append({'cmd':['XOR', 0xffffff],'addr':self.icnt})
            self.icnt += 1
        elif mnemonic == 'NOP':
            # pseudo command SKP 0,0
            self.pl.append({'cmd':['NOP', 0x0],'addr':self.icnt})
            self.icnt += 1
        elif mnemonic == 'ABSA':
            # pseudo command MAXX 0,0
            self.pl.append({'cmd':['MAXX', 0x0, 0x0],'addr':self.icnt})
            self.icnt += 1
        elif mnemonic == 'LDAX':
            # pseudo command RDFX REG,0
            reg = self.__register__(mnemonic)
            self.pl.append({'cmd':['RDFX', reg, 0x0],'addr':self.icnt})
            self.icnt += 1
        elif mnemonic == 'RAW':
            # direct data insertion
            mark = self.__u_32__(mnemonic)
            self.pl.append({'cmd':['RAW', mark],'addr':self.icnt})
            self.icnt += 1
        else:
            self.parseerror('Unexpected instruction {}'.format(
                             self.sym['txt']))
            sys.exit(-4) # this is a major program error
        
        if self.sym['type'] == 'ARGSEP':
            self.parseerror('Excess operands skipped for ' + mnemonic)
            # skip to next checkpoint
            while self.sym['type'] not in ['EOF', 'MNEMONIC',
                                           'ASSEMBLER', 'LABEL']:
                self.__next__()


    def __deref__(self, label):
        """Return a value defined in the symbol table."""
        seen = set()
        look = label
        while True:
            if look in seen:
                self.parseerror('Circular definition of label '
                                 + label)
            if look in self.symtbl:
                look = self.symtbl[look]
                if not isinstance(look, str):
                    break
            else:
                self.parseerror('Value {} undefined for label {}'.format(
                                look,label))
            seen.add(label)
        return look

    def __expression__(self):
        """Parse an operand expression."""
        if self.spinreals and self.sym['type'] in ['ASSEMBLER','ARGSEP',
                                           'MNEMONIC','TARGET','EOF']:
            # assume the operand was omitted and replace with zero
            # but don't consume the token - hack for SpinASM compatibility
            self.parsewarn('Missing argument replaced with 0')
            return 0
        if self.sym['type'] in ['ASSEMBLER','EOF','MNEMONIC','TARGET']:
            self.parseerror('Unexpected {}'.format(self.sym['type']),
                            self.sline)
            return 0

        acc = 0
        try:
            acc = self.__or_expr__()
        except Exception as e:
            self.parseerror(str(e))

        # check type before proceeding
        if not isinstance(acc, (int, float)):
            self.parseerror('Expression result {} invalid type'.format(acc))
            acc = 0	# replace erroneous value with 0 and continue
        return acc

    def __or_expr__(self):
        """Parse an or expression."""
        acc = self.__xor_expr__()
        while self.sym['type'] == 'OPERATOR' and self.sym['stxt'] == '|':
            self.__next__()
            rarg = self.__xor_expr__()
            acc = acc | rarg
        return acc

    def __xor_expr__(self):
        """Parse an xor expression."""
        acc = self.__and_expr__()
        while self.sym['type'] == 'OPERATOR' and self.sym['stxt'] == '^':
            self.__next__()
            rarg = self.__and_expr__()
            acc = acc ^ rarg
        return acc

    def __and_expr__(self):
        """Parse an and expression."""
        acc = self.__shift_expr__()
        while self.sym['type'] == 'OPERATOR' and self.sym['stxt'] == '&':
            self.__next__()
            rarg = self.__shift_expr__()
            acc = acc & rarg
        return acc

    def __shift_expr__(self):
        """Parse a bitwise shift expression."""
        acc = self.__a_expr__()
        while self.sym['type']=='OPERATOR' and self.sym['stxt'] in ['<<','>>']:
            op = self.sym['stxt']
            self.__next__()
            rarg = self.__shift_expr__()
            if op == '<<':
                acc = acc << rarg
            else:
                acc = acc >> rarg
        return acc

    def __a_expr__(self):
        """Parse an addition expression."""
        acc = self.__m_expr__()
        while self.sym['type']=='OPERATOR' and self.sym['stxt'] in ['+','-']:
            op = self.sym['stxt']
            self.__next__()
            if op == '+':
                acc = acc + self.__m_expr__()
            else:
                acc = acc - self.__m_expr__()
        return acc

    def __m_expr__(self):
        """Parse a multiplicative expression."""
        acc = self.__u_expr__()
        while self.sym['type']=='OPERATOR' and self.sym['stxt'] in [
                                                          '*','//','/']:
            op = self.sym['stxt']
            self.__next__()
            rarg = self.__u_expr__()
            if op == '*':
                acc = acc * rarg
            elif op == '//':
                acc = acc // rarg
            else:
                acc = acc / rarg
        return acc

    def __u_expr__(self):
        """Parse a unary operator."""
        acc = 0
        if self.sym['type'] == 'OPERATOR' and self.sym['stxt'] in [
                                                     '+','-','~','!','INT']:
            op = self.sym['stxt']
            self.__next__()
            acc = self.__u_expr__()
            if op == '-':
                acc = -acc
            elif op == '~' or op == '!':
                acc = ~acc
            elif op == 'INT':
                acc = int(round(acc))
        else:
            acc = self.__power__()
        return acc

    def __power__(self):
        """Parse an exponent."""
        acc = self.__atom__()
        if self.sym['type'] == 'OPERATOR' and self.sym['stxt'] == '**':
            self.__next__()
            acc = acc ** self.__u_expr__()
        return acc

    def __atom__(self):
        """Parse an atom or start a new expression."""
        ret = 0
        if self.sym['type'] == 'OPERATOR' and self.sym['stxt'] == '(':
            self.__next__()
            ret = self.__expression__()
            if self.sym['type'] == 'OPERATOR' and self.sym['stxt'] == ')':
                self.__next__()
            else:
                self.parseerror("Expected ')' but saw {} {}".format(
                              self.sym['type'], self.sym['txt']),
                              self.sline)
        elif self.sym['type'] == 'LABEL':
            stxt = self.sym['stxt']
            if stxt in self.symtbl:
                ret = self.__deref__(stxt)
                self.__next__()
            elif stxt in EXT_ONLY_REGS and not self.extended:
                self.parseerror('{} requires #extended'.format(stxt),
                                 self.sline)
                self.__next__()
                ret = 0
            else:
                self.parseerror('Undefined label {}'.format(self.sym['txt']),
                                 self.sline)
                self.__next__() # accept and replace
                ret = 0
        elif self.sym['type'] in ['INTEGER', 'FLOAT']:
            ret = self.sym['val']
            self.__next__()
        else:
            self.parseerror('Unexpected {} {} in expression'.format(
                              self.sym['type'], self.sym['txt']),
                              self.sline)
            if self.sym['type'] not in ['ARGSEP', 'TARGET', 'MNEMONIC',
                                        'EOF', 'ASSEMBLER']:
                self.__next__()	# skip the problem
            ret = 0
        return ret

    def __target__(self):
        """Parse a target assignment."""
        lbl = self.sym['stxt']
        oft = self.icnt
        if lbl in self.jmptbl and oft != self.jmptbl[lbl]:
            self.parseerror('Target {} redefined'.format(lbl),
                            self.sline)
        if lbl in self.symtbl:
            self.parseerror('Target {} already assigned'.format(lbl),
                            self.sline)
        self.jmptbl[lbl] = oft
        self.__next__()

    def __assembler__(self):
        """Parse mem or equ statement."""
        typ = None
        arg1 = None
        arg2 = None
        if self.sym['type'] == 'LABEL':
            arg1 = self.sym['stxt']
            self.__next__()
        if self.sym['type'] == 'ASSEMBLER':
            typ = self.sym['stxt']
            self.__next__()
        else:
            self.parseerror('Expected EQU or MEM but saw {} {}'.format(
                             self.sym['type'], self.sym['txt']),
                             self.sline)
            return

        if arg1 is None:
            if self.sym['type'] == 'LABEL':
                arg1 = self.sym['stxt']
                self.__next__()
            else:
                self.parseerror('Expected LABEL but saw {} {}'.format(
                             self.sym['type'], self.sym['txt']))
                return

        # strip the modifier and check for re-definition
        arg1 = arg1.rstrip('^$#')
        if arg1 in ['RDAL','SOF','RDA']:	# disallowed re-assignments
            self.parseerror('Reserved label {} cannot be re-defined.'.format(
                            arg1))
            return
        if arg1 in self.symtbl:
            self.parsewarn('Label ' + arg1 + ' re-defined')

        # then fetch the second argument
        arg2 = self.__expression__()
         
        if typ == 'MEM':
            if int(arg2) == arg2:
                arg2 = int(arg2)
            else:
                self.parseerror('Memory {} length {} not integer'.format(
                                arg1, arg2))
                arg2 = 0
            # check memory and assign the extra labels
            baseval = self.delaymem
            if arg2 < 0 or arg2 > self.delaysize:	# not as in datasheet
                if self.doclamp:
                    if arg2 < 0:
                        arg2 = 0
                    elif arg2 > self.delaysize:
                        arg2 = self.delaysize
                else:
                    self.parseerror('Invalid memory size {}'.format(arg2)
                                    + self.__extra_hint__('has 65536 words',
                                                          arg2))
                    arg2 = 0
            top = self.delaymem + arg2	# top ptr goes to largest addr+1
            if self.delaymem > self.delaysize:
                self.parseerror('Delay memory exhausted.'
                                + self.__extra_hint__('has 65536 words'))
            elif top > self.delaysize:
                self.parseerror(
            'Delay exhausted: requested {} exceeds {} available'.format(
                          arg2, self.delaysize-self.delaymem)
                          + self.__extra_hint__('has 65536 words'))
            self.symtbl[arg1] = self.delaymem
            self.symtbl[arg1+'#'] = top
            # Midpoint under both spellings.  SPINAsm documents '$' and
            # this assembler has always used '^' -- almost certainly
            # because '$' is its own prefix for a hex literal.  As a
            # SUFFIX there is no collision to resolve: the scanner takes a
            # modifier only when label+modifier is already a defined
            # symbol, so '$' after a label cannot be read as the start of
            # an integer.  Both are accepted; neither is preferred.
            self.symtbl[arg1+'^'] = self.delaymem+arg2//2
            self.symtbl[arg1+'$'] = self.delaymem+arg2//2
            self.delaymem = top+1
        else:
            self.symtbl[arg1] = arg2	# re-assign symbol table entry

    def parse(self):
        """Parse input."""
        self.__next__()
        while self.sym['type'] != 'EOF':
            if self.sym['type'] == 'TARGET':
                self.__target__()
            elif self.sym['type'] == 'MNEMONIC':
                self.__instruction__()
            elif self.sym['type'] == 'LABEL' or self.sym['type'] == 'ASSEMBLER':
                self.__assembler__()
            else:
                self.parseerror('Unexpected {} {}'.format(
                                  self.sym['type'], self.sym['txt']),
                                  self.sline)
                while self.sym['type'] not in ['EOF', 'MNEMONIC',
                                           'ASSEMBLER', 'TARGET','LABEL']:
                    self.__next__()    # skip to next checkpoint
        # patch skip targets if required
        for i in self.pl:
            if i['cmd'][0] == 'SKP':
                if i['target'] is not None:
                    if i['target'] in self.jmptbl:
                        iloc = i['addr']
                        dest = self.jmptbl[i['target']]
                        if dest > iloc:
                            oft = dest - iloc - 1
                            if oft > M6:
                                self.parseerror(
                     'Offset from SKP to {0} ({1:#x}) too large'.format(
                                                i['target'],oft), i['line'])
                            else:
                                i['cmd'][2] = oft
                        else:
                            self.parseerror(
                     'Target {0} does not follow SKP'.format(i['target']),
                                                i['line'])
                    else:
                        self.parseerror('Undefined target {} for SKP'.format(
                                        i['target']), i['line'])
                else:
                    pass	# assume offset is immediate
        if self.ecount > 0:
            self.doerror('errors in input, assembly aborted')
            sys.exit(-3)
        self.__mkopcodes__()

def main():
    parser = argparse.ArgumentParser(
                description='Assemble a single FV-1 DSP program.')
    parser.add_argument('infile',
                        type=argparse.FileType('rb'),
                        help='program source file')
    parser.add_argument('outfile',
                        help='assembled output file')
    parser.add_argument('-q', '--quiet',
                        action='store_true',
                        help='suppress warnings')
    parser.add_argument('-v', '--version',
                        action='version',
                        help='print version',
                        version='%(prog)s ' + VERSION)
    parser.add_argument('-c', '--clamp',
                        action='store_true',
                        help='clamp out of range values without error')
    parser.add_argument('-s', '--spinreals',
                        action='store_true',
                        help="read literals 2,1 as float (SpinASM compatibility)")
    parser.add_argument('-p',
                        help='target program number',
                        type=int, choices=range(0,8))
    parser.add_argument('-b', '--binary',
                        action='store_true',
                        help='force binary output file')
    args = parser.parse_args()
    dowarn = warning
    if args.quiet:
        dowarn = quiet
    dowarn('FV-1 Assembler v' + VERSION)
    dowarn('info: Reading input from ' + args.infile.name)
    inbuf = args.infile.read()
    encoding = 'utf-8'
    # check for BOM
    if len(inbuf) > 2 and inbuf[0] == 0xFF and inbuf[1] == 0xFE:
        dowarn('info: Input encoding set to UTF-16LE by BOM')
        encoding = 'utf-16le'
    elif len(inbuf) > 2 and inbuf[0] == 0xFE and inbuf[1] == 0xFF:
        dowarn('info: Input encoding set to UTF-16BE by BOM')
        encoding = 'utf-16be'
    # or assume windows encoded 'ANSI'
    elif len(inbuf) > 7 and inbuf[7] == 0x00:
        dowarn('info: Input encoding set to UTF-16LE')
        encoding = 'utf-16le'

    # warn if spinreal option used
    if args.spinreals:
        dowarn('warning: SpinASM compatibility - literals 2,1 read as 2.0,1.0')

    fp = fv1parse(inbuf.decode(encoding,'replace'),
                  clamp=args.clamp, spinreals=args.spinreals,
                  wfunc=dowarn, efunc=error)
    fp.parse()
    
    ofile = None
    try:
        ofile = open(args.outfile, 'r+b')	# existing file
    except:
        try:
            ofile = open(args.outfile, 'w+b')	# create + truncate
        except Exception as e:
            error('error: writing output: ' + str(e))
            sys.exit(-1)
    ofile.seek(0)
    if not args.outfile.lower().endswith('hex'):
        args.binary = True
    if args.binary and ofile.isatty():	# superfluous now
        args.binary = False
        dowarn('warning: Terminal output forced to hex')
    if args.binary:
        dowarn('info: Writing binary output to ' + ofile.name)
        if args.p is not None:
            baseoft = args.p * 512
            ofile.seek(baseoft)
            dowarn('info: Selected program {0} at offset 0x{1:04X}'.format(
                    args.p, baseoft))
        else:
            ofile.truncate(0)
        ofile.write(fp.program)
    else:
        # HEX output - truncate and encode text 
        ofile.truncate(0)
        baseoft = 0
        if args.p is not None:
            baseoft = args.p * 512
            dowarn('info: Selected program {0} at offset 0x{1:04X}'.format(
                    args.p, baseoft))
        dowarn('info: Writing hex output to ' + ofile.name)
        ofile.write(bintoihex(fp.program, baseoft).encode('ASCII','ignore'))
    ofile.close()

if __name__ == '__main__':
    main()
