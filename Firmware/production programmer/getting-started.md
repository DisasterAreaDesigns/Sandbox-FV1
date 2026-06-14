# Sandbox-FV1 EEPROM Programmer — Getting Started

This device is a CircuitPython-based programmer for the 24LC32A I2C EEPROM used in
Spin FV-1 effects platforms. You program it by **dragging Intel HEX files onto the
board's USB drive** — no separate software required.

Two files run automatically on the microcontroller:

- `boot.py` — runs once at power-on, sets up the USB drive and device identity.
- `code.py` — the main program, runs continuously after boot.

---

## How `boot.py` works

`boot.py` executes a single time, before `code.py`, each time the board powers up or
resets. It configures how the board appears to your computer:

1. Temporarily remounts the filesystem writable to set the drive label to `SANDBOX-FV1`,
   then remounts it read-only.
2. Enables the USB mass-storage drive so the board shows up as a removable disk.
3. Sets the USB identity to manufacturer **Disaster Area Designs**, product
   **SandboxFV1** (VID `0x1209`, PID `0x3811`).
4. Prints `[SUCCESS] Sandbox-FV1 Boot` to the serial console.

You don't interact with `boot.py` directly. Just know that the drive that appears on
your computer labeled `SANDBOX-FV1` is where your HEX files go.

> Note: because the filesystem is set read-only to the board's own code after boot,
> the *computer* retains write access to the drive — that's what lets you drop files on.

---

## How `code.py` works

`code.py` is an event loop that watches for an EEPROM on the I2C bus and for HEX files
on the drive, then programs the chip. Hardware it drives:

| Pin / Device | Role |
|---|---|
| GP0 (SDA) / GP1 (SCL) | I2C bus to the EEPROM and OLED |
| EEPROM at `0x50` | The 24LC32A target chip (4096 bytes) |
| SSD1306 OLED at `0x3C` | 128×32 two-line status display |
| GP16 WS2812 RGB LED | Status color indicator |
| GP2 | Control/"program" pin, normally HIGH, pulsed LOW after a successful write |
| GP3 | Momentary button (active-low), wakes the OLED screensaver |

### LED status colors

| Color | Meaning |
|---|---|
| Off | Idle / waiting |
| Dim blue | Writing / programming in progress |
| Green | Write successful |
| Red (blinking) | Error or failure |

### What the loop does

1. **Scans for the EEPROM** about once per second. When a chip appears, the OLED shows
   `EEPROM found / Waiting for .hex` and the list of already-processed files is cleared
   so they can be re-flashed. When removed, it shows `No target / Connect EEPROM`.
2. **Looks for `.hex` files** in the drive's root directory (ignoring dotfiles and files
   it has already processed in this session).
3. **Programs each file** it finds, validates it, and writes it to the correct EEPROM
   address.
4. After a successful real write, **pulses GP2 LOW for ~10 ms** to signal the FV-1 to
   reload, then returns to idle.
5. After ~20 seconds of inactivity, a **screensaver** displays a bouncing "FV-1 PROG"
   label on the OLED. Pressing the GP3 button (or any new activity) dismisses it.

> The `SCREENSAVER_TIMEOUT` constant is set to `20` seconds despite a code comment
> that says "5 minutes" — the comment is stale; the actual value is 20 seconds.

---

## HEX file rules (important)

The programmer is strict about file format. Each file is validated before it's written;
if it fails, the OLED shows the reason and the LED goes red.

### Single-slot files

Files **other than `all.hex`** are treated as one FV-1 program slot:

- Must be exactly **129 lines**.
- Must cover address range **0x000–0x1FF** (512 bytes).

The destination address in the EEPROM is chosen by filename:

| Filename | EEPROM start address |
|---|---|
| `0.hex` | `0x0000` |
| `1.hex` | `0x0200` |
| `2.hex` | `0x0400` |
| `3.hex` | `0x0600` |
| `4.hex` | `0x0800` |
| `5.hex` | `0x0A00` |
| `6.hex` | `0x0C00` |
| `7.hex` | `0x0E00` |
| any other name | `0x0600` (default) |

### Full-image file

`all.hex` is a special case that rewrites the whole chip:

- Must be exactly **1025 lines**.
- Must cover address range **0x000–0xFFF** (4096 bytes).
- The entire EEPROM is **cleared to `0xFF` first**, then written from `0x0000`.
- If present, `all.hex` is processed **first and alone** — other HEX files in the same
  drop are skipped that cycle.

### Other behavior

- A **zero-byte HEX file** (no data records) is ignored but still marked as processed —
  no write happens.
- After a successful write, a marker file (e.g. `0.hex.programmed`) is created. This is
  cosmetic; it records that the file was handled.

---

## Quick start

1. Plug the board into USB. A drive labeled **SANDBOX-FV1** appears.
2. Connect the target 24LC32A EEPROM to the I2C pins. The OLED should change from
   `Connect EEPROM` to `EEPROM found / Waiting for .hex`.
3. Drop a correctly-formatted HEX file onto the drive:
   - A single program → name it `0.hex` through `7.hex` for the slot you want.
   - A complete EEPROM image → name it `all.hex`.
4. Watch the OLED and RGB LED:
   - Dim blue = writing, green = done, red = error (check the serial console for detail).
5. On success, GP2 pulses to tell the FV-1 to reload, and the OLED returns to
   `Complete / Waiting for .hex`.

### Seeing serial output

For detailed logs (validation results, byte dumps, errors), open the board's serial
REPL with a terminal such as `screen`, `tio`, PuTTY, or the Mu editor. Every action the
loop takes is printed there.

---

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| OLED says `Connect EEPROM` and stays there | EEPROM not detected on I2C — check wiring/address `0x50` |
| `BAD LINE COUNT` | File isn't 129 lines (single) or 1025 lines (`all.hex`) |
| `BAD ADDR RANGE` | HEX address range doesn't match the expected slot/full ranges |
| Red blinking at startup | I2C bus locked or no EEPROM found during initial scan |
| File dropped but nothing happens | File is a dotfile, zero-byte, or already processed this session (remove/replug EEPROM to reset) |
| OLED shows bouncing "FV-1 PROG" | Screensaver — press the GP3 button to dismiss |
