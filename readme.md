# FV-1 Sandbox
FV-1 Sandbox is a self-contained open-source development platform for the Spin FV-1 digital signal processing (DSP) integrated circuit.  

## Background:
The Spin Semiconductor FV-1 IC was developed by Alesis alumni Keith Barr and Frank Thomson.  It features an integrated architecture with built-in analog-to-digital and digital-to-analog converters, memory, and processing core.  It requires only a few external components to operate, and can run user programs from an inexpensive serial EEPROM.  It has been used in hundreds of different pedals and devices, totalling many hundreds of thousands of units in service.

## Why Are We Doing This?

The FV-1 has seven built-in programs that cover a wide range of effects, but most designers leverage the custom code capabilities of the chip.  The Fv-1 is programmed in SpinASM, a proprietary assembly language.  Spin provided a free integrated development environment for Windows computers called SpinASM IDE.  This interfaces with a development board fitted with a Cypress PSoC microcontroller functioning as a USB interface.  The IDE allows for code editing, rapid auditioning of DSP algorithms on the development board, and production programming using multi-algorithm .SPJ Spin Project files.  No MacOS or Linux programming tools were made available, and SpinASM also had issues running on newer versions of Windows.  A patch was released to fix compatibility issues under Windows 7, and this version (1.1.31) works with most Windows 10 and Windows 11 systems.  The IDE does also run under Windows for ARM, but support for the PSoC-based development board is broken due to driver issues.

Our intention is to create a complete toolchain that can run on any modern computer that interfaces with a high-quality hardware platform for deploying algorithms.  To this end, we have created an open-source assembler that runs in a web browser and a hardware platform that interfaces with an inexpensive RP2040 microcontroller for programming.  The hardware platform may be assembled without the microcontroller for higher-quantity production use, and the RP2040 programmer may be used in conjunction with either a TagConnect programming cable or pin sockets on the PCB for production programming.

## What Did We Do?

We've been [asfv1](https://github.com/ndf-zz/asfv1), an open-source assembler for FV-1 designed by Nathan Fraser.  It works great but requires a few steps to depoloy as part of a larger toolchain.  It works with Sublime Text or Notepad++ to create a DIY development environmant, but it's still a lot of work for a new user.  So we decided to build a one-stop shop!

We patched up some bugs we found, added some quality-of-life improvements, and ported the whole thing from Python to JavaScript so we could run it in a browser.  There's a (very) basic text editor, an assembler, and a one-button deployment to the Sandbox hardware.

The hardware is very simple, incorporating a high-quality analog front-end that reduces out-of-band and clock noise from the FV-1.  It's full stereo, features three user potentiometer controls, and two toggle switches for selecting one of six possible algorithms.  It also uses program zero to bypass the effect, allowing stereo switching without any external hardware or relays, albeit at the cost of higher noise floor and a slight delay from the DSP ADC+DAC conversions.

Progamming is implemented using the aforementioned RP2040 board - we've used a Waveshare RP2040 Zero for its compact form factor and handy USB-C port, but clones of this part or other variations may also work.  the RP2040 code is programmed in CircuitPython for ease of deployment and modification.  To program a new algorithm on the Sandbox EEPROM, simply copy an assembled .HEX or .BIN file to the RP2040 CIRCUITPY or SANDBOX removable drive.  Name the program 0.HEX to program algorithm zero, 1.HEX for program 1, and so on.  Adding any other named file will write program #3, which is the program accessed if no toggle switches are assembled to the Sandbox PCBA.

So it's a web app and a pedal.  Hook 'em up and write some code!

## What's In This Repo?
* **ASFV1 Source:**  copy of the Python source for asfv1
* **Assembler:**  JavaScript Web Application for assembling FV-1 programs
* **Firmware**  CircuitPython code for the RP2040 Zero program module
* **spin-test**  Puppeteer scripts and sample FV-1 programs for testing the assembler
* **Hardware**  Schematic and PCB files for Sandbox pedal hardware

