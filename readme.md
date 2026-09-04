# FV-1 Sandbox
FV-1 Sandbox is a self-contained open-source development platform for the Spin FV-1 digital signal processing (DSP) integrated circuit.  

## Background:
The Spin Semiconductor FV-1 IC was developed by Alesis alumni Keith Barr and Frank Thomson.  It features an integrated architecture with built-in analog-to-digital and digital-to-analog converters, memory, and processing core.  It requires only a few external components to operate, and can run user programs from an inexpensive serial EEPROM.  It has been used in hundreds of different pedals and devices, with many hundreds of thousands of units in service.

## Why Are We Doing This?
The FV-1 has seven built-in programs that cover a wide range of effects, but most designers leverage the custom code capabilities of the chip.  The Fv-1 is programmed in SpinASM, a proprietary assembly language.  Spin provided a free integrated development environment for Windows computers called SpinASM IDE.  This interfaces with a development board fitted with a Cypress PSoC microcontroller functioning as a USB interface.  The IDE allows for code editing, rapid auditioning of DSP algorithms on the development board, and production programming using multi-algorithm .SPJ Spin Project files.  No MacOS or Linux programming tools were made available, and SpinASM also had issues running on newer versions of Windows.  A patch was released to fix compatibility issues under Windows 7, and this version (1.1.31) works with most Windows 10 and Windows 11 systems.  The IDE does also run under Windows for ARM, but support for the PSoC-based development board is broken due to driver issues.

Our intention is to create a complete toolchain that can run on any modern computer that interfaces with a high-quality hardware platform for deploying algorithms.  To this end, we have created an open-source assembler that runs in a web browser and a hardware platform that interfaces with an inexpensive RP2040 microcontroller for programming.  The hardware platform may be assembled without the microcontroller for higher-quantity production use, and the RP2040 programmer may be used in conjunction with either a TagConnect programming cable or pin sockets on the PCB for production programming.

## What Did We Do?
We've been using [asfv1](https://github.com/ndf-zz/asfv1), an open-source assembler for FV-1 designed by Nathan Fraser.  It works great but requires a few steps to deploy as part of a larger toolchain.  It works with Sublime Text or Notepad++ to create a DIY development environment, but it's still a lot of work for a new user.  So we decided to build a one-stop shop!

We patched up some bugs we found, added some quality-of-life improvements, and ported the whole thing from Python to JavaScript so we could run it in a browser.  There's a pretty decent code editor using Monaco, an assembler, and a one-button deployment to the Sandbox hardware.

The hardware is very simple, incorporating a high-quality analog front-end that reduces out-of-band and clock noise from the FV-1.  It's full stereo, features three user potentiometer controls, and two toggle switches for selecting one of six possible algorithms.  It also uses program zero to bypass the effect, allowing stereo switching without any external hardware or relays, albeit at the cost of higher noise floor and a slight delay from the DSP ADC+DAC conversions.

Programming is accomplished using the aforementioned RP2040 board - we've used a Waveshare RP2040 Zero for its compact form factor and handy USB-C port, but clones of this part or other variations may also work.  the RP2040 code is implemented in CircuitPython for ease of deployment and modification.  To program a new algorithm on the Sandbox EEPROM, simply copy an assembled .HEX or .BIN file to the RP2040 CIRCUITPY or SANDBOX removable drive.  Name the program 0.HEX to program algorithm zero, 1.HEX for program 1, and so on.  Adding any other named .BIN or .HEX file will write program #3, which is the program accessed if no toggle switches are assembled to the Sandbox PCBA.

We've also added an FV-1 simulator to the web app.  The assembled program runs through a software model of the chip at its native 32.768 kHz, so you can audition an algorithm on a test tone, an audio file, or live input before you ever program the hardware.  The three pot controls are on screen, and each successful build reloads into the simulator while it plays.  The simulator models accumulator saturation and the FV-1's companded delay memory, and its LFO rates and depths follow the equations in Spin's application note AN-0001.  Chorus interpolation is approximated, so always confirm a design on real hardware.

The simulator can also be played from a MIDI controller plugged into your computer.  Press **Enable MIDI** in the simulator panel, allow the browser's MIDI prompt, and pick an input and channel.  `CC50`, `CC51` and `CC52` sweep POT0, POT1 and POT2, and `CC102` switches the effect, with `0-63` bypassed and `64-127` engaged.  MIDI moves the same controls the sliders do, at the full 128 steps a control change carries, so a program cannot tell the difference between a fader and a mouse.  Note that the Sandbox pedal itself has no MIDI input - this drives the simulator only.

So it's a web app and a pedal.  Hook 'em up and write some code!

## The Extended Instruction Set

The assembler and the simulator both understand an extended instruction set for the **FV-2040** - the FV-1 instruction set running on an RP2040, where the constraints that made sense in silicon in 1999 are off.  None of it exists unless a program contains a line reading `#extended`, and a program without that line assembles to exactly the bytes it always did: all 140 of the programs in `spin-test/files` that asfv1 accepts assemble byte-identical to what asfv1 produces.

|                | FV-1                    | `#extended`                                        |
| -------------- | ----------------------- | -------------------------------------------------- |
| Delay address  | 15 bits, 32768 words    | 16 bits, 65536 words                               |
| `MEM` pool     | 32767                   | 65535                                              |
| Pot registers  | POT0-POT2               | plus POT3-POT5 at `0x19`-`0x1b`                    |
| Indirect read  | `RMPA`, `ACC[23:8]`     | plus `RMPAX`, `ACC[22:7]`                          |
| Noise          | an LFSR you build       | `RAND`, opcode 21                                  |
| LFOs           | SIN0-SIN1, RMP0-RMP1    | plus SIN2-SIN3, RMP2-RMP3, registers `0x08`-`0x0f` |

`RMPAX` is the one worth explaining.  `ADDR_PTR` already carries sixteen address bits in `ACC[23:8]`, but the top one is the accumulator's *sign*, so in a 64K tank the upper half is reachable only through negative values and a sweep across the middle cannot be computed on an accumulator that saturates rather than wraps.  `RMPAX` moves the split to `ACC[22:7]`: sixteen address bits with the sign left clear, so the ordinary `wrax addr_ptr` / `rmpax` idiom sweeps end to end with no seam.  The price is one bit of interpolation fraction, and it is the only place that bit can come from - twenty-four bits have to hold both an address and a fraction.  Plain `RMPA` still means what it always meant, and warns that it reaches only the low 32K.

The **EXTENDED** section of the instruction reference and a matching section of the help appear as soon as the source carries the pragma, and go away again when the line is deleted.  The simulator runs all of it: sliders for POT3-POT5 appear when an extended program is loaded, `CC53`-`CC55` sweep them, and the clock panel reports the wider tank.

**An FV-1 does not implement any of this.**  It will not refuse an extended image; it will run it as something else.  Since the Sandbox pedal has an FV-1 in it, **Download to Hardware** asks for confirmation before writing an extended build.

The reference implementation is **asfv1-extended**, a fork of [asfv1](https://github.com/ndf-zz/asfv1) carrying the same extension.  It is vendored in `ASFV1 Source/` alongside upstream, so `npm run test:extended` assembles its whole test suite with both and compares the images without anything else installed.  Set `ASFV1_EXTENDED` to point at a working checkout instead, which is what you want while changing the fork itself.

## Running the Assembler Locally
The web app needs to be served over http - opening `Assembler/index.html` directly as a `file://` page will not work.  Browsers block the audio engine the simulator depends on from `file://` origins, and the directory and serial access used to talk to the hardware need a secure context too.  `localhost` counts as secure, so any static file server will do:

```
python3 -m http.server 8000 --directory Assembler
```

Then open <http://localhost:8000> in Chrome or Edge.  If you prefer Node, `npx serve Assembler` works the same way.

Chrome or Edge are required for programming hardware and selecting folders, since Firefox and Safari do not implement the File System Access and Web Serial APIs.  The simulator itself works in any browser with AudioWorklet support, and its MIDI control works in Chrome, Edge and Firefox - Safari has no Web MIDI.

## What's In This Repo?
* **ASFV1 Source:**  copies of the Python source for asfv1 and for asfv1-extended, the fork carrying the extended instruction set
* **Assembler:**  JavaScript Web Application for assembling FV-1 programs, including an in-browser FV-1 simulator (`fv1-emu.js` / `fv1-sim.js`) with MIDI control (`fv1-midi.js`)
* **Firmware**  CircuitPython code for the RP2040 Zero program module
* **spin-test**  Puppeteer scripts and sample FV-1 programs for testing the assembler: `npm run test:roundtrip` for the assembler and simulator as a pair, `npm run test:emu` for the DSP core, `npm run test:extended` for the extended instruction set, and `npm run test:midi` for the simulator's MIDI control
* **Hardware**  Schematic and PCB files for Sandbox pedal hardware

## What Can I Do With All This?
We've released this project and all associated tools under the [MIT License.](https://www.tldrlegal.com/license/mit-license)  This means that you can use the tools and information in this repository for anything you want, as long as you inform your users / customers / clients that you got it from us.  You can modify or change anything here to suit your purposes, and you can make products that you sell for profit.  You can even close your sources, so that what's in your product or project is private.  You just have to credit us as shown in our [license file.](https://github.com/DisasterAreaDesigns/Sandbox-FV1/blob/main/LICENSE)  An example of what that looks like can be found in our [Third Party Notices](https://github.com/DisasterAreaDesigns/Sandbox-FV1/blob/main/ThirdPartyNotices.txt) file.

Any projects you create with these tools belong to you.  If you write your own code to process audio with this project, that code is under your copyright and is yours to do with what you wish.  If you use someone else's DSP algorithms, that use will be subject to *their* license terms, and we're not able to help you sort that out.  TL:DR you can do whatever you want with this repo, just give us credit. 

