import os
import time
import board
import busio
import digitalio
import supervisor
import random
import neopixel
import displayio
import i2cdisplaybus
import terminalio
import adafruit_displayio_ssd1306
from adafruit_display_text import label

# Release any previously configured displays
displayio.release_displays()

# Set up I2C bus on GP0 (SDA) and GP1 (SCL)
i2c = busio.I2C(scl=board.GP1, sda=board.GP0)

# Set up OLED display
display_bus = i2cdisplaybus.I2CDisplayBus(i2c, device_address=0x3C)
display = adafruit_displayio_ssd1306.SSD1306(display_bus, width=128, height=32)

# OLED display group - 2 lines on 128x32
oled_group = displayio.Group()
oled_line1 = label.Label(terminalio.FONT, text="", color=0xFFFFFF, x=0, y=6)
oled_line2 = label.Label(terminalio.FONT, text="", color=0xFFFFFF, x=0, y=22)
oled_group.append(oled_line1)
oled_group.append(oled_line2)
display.root_group = oled_group

# Screensaver display group - single label "FV-1 PROG"
# terminalio.FONT is 6x12 pixels. "FV-1 PROG" = 9 chars = 54px wide, ~12px tall
# Bounce area: x in [0, 74], y in [6, 26]
screensaver_group = displayio.Group()
screensaver_label = label.Label(terminalio.FONT, text="FV-1 PROG", color=0xFFFFFF, x=0, y=16)
screensaver_group.append(screensaver_label)

# Screensaver / inactivity tracking
SCREENSAVER_TIMEOUT = 20  # 5 minutes in seconds
SCREENSAVER_MOVE_INTERVAL = 2.0  # seconds between position changes
last_activity_time = time.monotonic()
screensaver_active = False
last_screensaver_move = 0

def exit_screensaver():
    """Switch from screensaver back to normal display"""
    global screensaver_active
    if screensaver_active:
        screensaver_active = False
        display.root_group = oled_group

def reset_activity():
    """Reset the inactivity timer and exit screensaver if active"""
    global last_activity_time
    last_activity_time = time.monotonic()
    exit_screensaver()

def oled_status(line1, line2=""):
    """Update the OLED with two lines of status"""
    reset_activity()
    oled_line1.text = str(line1)[:21]  # ~21 chars fit at 6px wide on 128px
    oled_line2.text = str(line2)[:21]

# Set up control pin (GP2) - keep HIGH by default, toggle LOW only during programming
control_pin = digitalio.DigitalInOut(board.GP2)
control_pin.direction = digitalio.Direction.OUTPUT
control_pin.value = True  # Keep high by default

# Set up button on GP3 - momentary, active low with pull-up
button_pin = digitalio.DigitalInOut(board.GP3)
button_pin.direction = digitalio.Direction.INPUT
button_pin.pull = digitalio.Pull.UP
button_last_state = True  # pull-up means idle = True

# Set up WS2812 RGB LED on GP16
pixel = neopixel.NeoPixel(board.GP16, 1, brightness=1.0, auto_write=True, pixel_order='GRB')

# RGB Color definitions - solid colors only
COLOR_OFF = (0, 0, 0)       # Off
COLOR_RED = (255, 0, 0)     # Red for uploading
COLOR_GREEN = (0, 255, 0)   # Green for success
COLOR_BLUE = (0, 0, 255)    # Blue for idle state
COLOR_DIM_BLUE = (0, 0, 8)  # Very dim blue for programming

# EEPROM address
EEPROM_ADDR = 0x50

# Test mode: set to True to simulate programming without EEPROM hardware.
# Full flow runs with fake writes and realistic timing delays.
TEST_MODE = False

# File to EEPROM address mapping - only explicit slot files
FILE_ADDRESS_MAP = {
    "0.hex": 0x0000,
    "1.hex": 0x0200,
    "2.hex": 0x0400,
    "3.hex": 0x0600,
    "4.hex": 0x0800,
    "5.hex": 0x0A00,
    "6.hex": 0x0C00,
    "7.hex": 0x0E00,
}

# Default start address for single-slot files with unrecognized names
DEFAULT_START_ADDR = 0x0600

# Size constants for classification
SINGLE_SLOT_LINES = 129
FULL_EEPROM_LINES = 1025
SINGLE_SLOT_MIN_ADDR = 0x000
SINGLE_SLOT_MAX_ADDR = 0x1FF
FULL_EEPROM_MIN_ADDR = 0x000
FULL_EEPROM_MAX_ADDR = 0xFFF

# We'll use the normal REPL for output
def print_serial(message):
    """Print to the REPL"""
    print(message)

def set_led_color(color):
    """Set the WS2812 LED color"""
    pixel[0] = color
    
def blink_led_once(color, duration=0.2):
    """Blink both LEDs once quickly with specified color"""
    set_led_color(color)
    time.sleep(duration)
    set_led_color(COLOR_OFF)
    time.sleep(duration)

def blink_led_pattern(color, on_time=0.1, off_time=0.1, count=3):
    """Blink both LEDs in a pattern with specified color"""
    for _ in range(count):
        set_led_color(color)
        time.sleep(on_time)
        set_led_color(COLOR_OFF)
        time.sleep(off_time)

def parse_hex_line(line):
    """Parse a single line of Intel HEX format"""
    if not line.startswith(':'):
        return None, None, None, []
    
    # Remove the leading ':' and strip whitespace/newlines
    data = line.strip()[1:]
    
    try:
        # Get basic parameters
        byte_count = int(data[0:2], 16)
        address = (int(data[2:4], 16) << 8) + int(data[4:6], 16)
        record_type = int(data[6:8], 16)
        
        # Extract the data bytes
        byte_data = []
        for i in range(byte_count):
            pos = 8 + (i * 2)
            if pos + 2 <= len(data):
                byte_data.append(int(data[pos:pos+2], 16))
        
        return byte_count, address, record_type, byte_data
    
    except Exception as e:
        print_serial("Error parsing line: " + str(e))
        return None, None, None, []

def write_eeprom_page(eeprom_address, page_address, data):
    """Write a page of data to the EEPROM (max 32 bytes per page)"""
    if TEST_MODE:
        # Simulate write cycle timing
        time.sleep(0.006)
        return True
    
    # Create the I2C write buffer
    buffer = bytearray(2 + len(data))
    buffer[0] = (page_address >> 8) & 0xFF  # High byte of address
    buffer[1] = page_address & 0xFF         # Low byte of address
    buffer[2:] = data                       # Data bytes
    
    # Write to the EEPROM
    try:
        i2c.try_lock()
        i2c.writeto(eeprom_address, buffer)
        i2c.unlock()
        # Wait for write cycle to complete (6ms is sufficient for 24LC32A)
        time.sleep(0.006)  # 6ms
        
        return True
    except Exception as e:
        print_serial("EEPROM write error: " + str(e))
        try:
            i2c.unlock()  # Make sure to unlock even if there's an error
        except:
            pass
        return False

def read_eeprom(eeprom_address, start_address, num_bytes):
    """Read bytes from the EEPROM"""
    if TEST_MODE:
        # Return dummy 0xFF bytes (simulates blank EEPROM)
        return bytearray([0xFF] * num_bytes)
    
    # Set the address pointer
    addr_buffer = bytearray(2)
    addr_buffer[0] = (start_address >> 8) & 0xFF  # High byte of address
    addr_buffer[1] = start_address & 0xFF         # Low byte of address
    
    try:
        i2c.try_lock()
        i2c.writeto(eeprom_address, addr_buffer)
        
        # Read the data
        result = bytearray(num_bytes)
        i2c.readfrom_into(eeprom_address, result)
        i2c.unlock()
        return result
    except Exception as e:
        print_serial("EEPROM read error: " + str(e))
        try:
            i2c.unlock()  # Make sure to unlock even if there's an error
        except:
            pass
        return None

def clear_entire_eeprom():
    """Clear the entire EEPROM by writing 0xFF to all locations"""
    print_serial("Clearing entire EEPROM (writing 0xFF to all locations)...")
    oled_status("Clearing EEPROM", "0xFF all pages...")
    
    # For 24LC32A: 4096 bytes (0x0000 to 0x0FFF)
    eeprom_size = 4096
    page_size = 32
    
    # Create a page of 0xFF bytes
    clear_data = bytearray([0xFF] * page_size)
    
    for addr in range(0, eeprom_size, page_size):
        print_serial("Clearing page at address 0x{:04X}".format(addr))
        result = write_eeprom_page(EEPROM_ADDR, addr, clear_data)
        
        if not result:
            print_serial("Error clearing page at address 0x{:04X}".format(addr))
            return False
    
    print_serial("EEPROM cleared successfully")
    return True

def process_and_program_hex_file(filename):
    """Process a HEX file and program the EEPROM.
    
    Determines programming mode by file content size:
    - 129 lines / 0x000-0x1FF: single slot (uses FILE_ADDRESS_MAP or DEFAULT_START_ADDR)
    - 1025 lines / 0x000-0xFFF: full EEPROM (clears first, writes to 0x0000)
    """
    all_bytes = []
    line_count = 0
    min_addr = None
    max_addr = None
    
    base_filename = filename.split('/')[-1]
    
    # Turn off LEDs while processing files
    set_led_color(COLOR_OFF)
    
    try:
        # First pass: count lines and track address range
        with open(filename, "r") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                line_count += 1
                
                byte_count, address, record_type, data = parse_hex_line(line)
                
                if byte_count is None:
                    continue
                
                if record_type == 0:
                    if min_addr is None:
                        min_addr = address
                        max_addr = address + len(data) - 1
                    else:
                        min_addr = min(min_addr, address)
                        max_addr = max(max_addr, address + len(data) - 1)
                elif record_type == 1:
                    break
        
        # Second pass: extract all data bytes
        with open(filename, "r") as f:
            for line in f:
                byte_count, address, record_type, data = parse_hex_line(line)
                
                if byte_count is None:
                    continue
                
                if record_type == 0:
                    all_bytes.extend(data)
                elif record_type == 1:
                    break
        
        # Skip zero-byte files
        if len(all_bytes) == 0:
            print_serial("Ignoring zero-byte hex file: {}".format(base_filename))
            set_led_color(COLOR_OFF)
            return True
        
        # Classify file by size: single-slot or full-EEPROM
        is_full_eeprom = False
        is_single_slot = False
        
        if line_count == FULL_EEPROM_LINES and min_addr == FULL_EEPROM_MIN_ADDR and max_addr == FULL_EEPROM_MAX_ADDR:
            is_full_eeprom = True
        elif line_count == SINGLE_SLOT_LINES and min_addr == SINGLE_SLOT_MIN_ADDR and max_addr == SINGLE_SLOT_MAX_ADDR:
            is_single_slot = True
        else:
            # Does not match either expected format
            print_serial("ERROR: {} has {} lines, addr range 0x{:03X}-0x{:03X}".format(
                base_filename, line_count, min_addr or 0, max_addr or 0))
            print_serial("Expected either {} lines/0x{:03X}-0x{:03X} (single slot) or {} lines/0x{:03X}-0x{:03X} (full EEPROM)".format(
                SINGLE_SLOT_LINES, SINGLE_SLOT_MIN_ADDR, SINGLE_SLOT_MAX_ADDR,
                FULL_EEPROM_LINES, FULL_EEPROM_MIN_ADDR, FULL_EEPROM_MAX_ADDR))
            oled_status("BAD FORMAT", base_filename[:21])
            set_led_color(COLOR_RED)
            return False
        
        if is_full_eeprom:
            print_serial("Classified as full EEPROM image: {} lines, 0x{:03X}-0x{:03X}".format(
                line_count, min_addr, max_addr))
            oled_status(base_filename[:21], "Full EEPROM image")
        else:
            print_serial("Classified as single slot: {} lines, 0x{:03X}-0x{:03X}".format(
                line_count, min_addr, max_addr))
            oled_status(base_filename[:21], "Single slot")
        
        # Determine start address
        if base_filename in FILE_ADDRESS_MAP:
            # Explicit slot mapping for 0-7.hex
            start_address = FILE_ADDRESS_MAP[base_filename]
        elif is_full_eeprom:
            start_address = 0x0000
        else:
            # Single-slot, non-numbered filename -> slot 3
            start_address = DEFAULT_START_ADDR
        
        print_serial("Using start address: 0x{:04X} for file: {}".format(start_address, base_filename))
        print_serial("File contains {} bytes of data".format(len(all_bytes)))
        
        # Full EEPROM: clear first
        if is_full_eeprom:
            print_serial("Full EEPROM mode - clearing EEPROM first")
            oled_status(base_filename[:21], "Clearing EEPROM...")
            if not clear_entire_eeprom():
                print_serial("Failed to clear EEPROM")
                oled_status("CLEAR FAILED", base_filename[:21])
                set_led_color(COLOR_RED)
                return False
        
        # Program the EEPROM in pages (32 bytes per page for 24LC32A)
        total_bytes = len(all_bytes)
        page_size = 32
        
        print_serial("Programming EEPROM with " + str(total_bytes) + " bytes")
        oled_status("Writing " + base_filename[:14], "0/{} bytes".format(total_bytes))
        
        # Start with dim blue LEDs during programming
        set_led_color(COLOR_DIM_BLUE)
        
        for i in range(0, total_bytes, page_size):
            page_end = min(i + page_size, total_bytes)
            page_data = all_bytes[i:page_end]
            eeprom_addr = start_address + i
            
            print_serial("Writing page at address 0x{:04X}".format(eeprom_addr))
            if i % (page_size * 8) == 0:
                pct = ((i + page_size) * 100) // total_bytes
                if pct > 100:
                    pct = 100
                oled_status("Writing " + base_filename[:14], "0x{:04X} {}%".format(eeprom_addr, pct))
            result = write_eeprom_page(EEPROM_ADDR, eeprom_addr, bytearray(page_data))
            
            if not result:
                print_serial("Error writing page at address 0x{:04X}".format(eeprom_addr))
                oled_status("WRITE ERROR", "0x{:04X}".format(eeprom_addr))
                set_led_color(COLOR_OFF)
                return False
        
        # Programming complete - exit programming mode
        if not TEST_MODE:
            control_pin.value = True
        time.sleep(0.1)
        print_serial("Programming mode deactivated (GP2 set high)")
        
        # Print summary
        filename_base = filename.split('/')[-1].split('.')[0]
        print_serial(filename_base + "[] = {")
        for i in range(0, len(all_bytes), 4):
            line = ""
            for j in range(min(4, len(all_bytes) - i)):
                byte = all_bytes[i + j]
                line += "0x{:02X}, ".format(byte)
            print_serial(line)
        print_serial("};")
        print_serial("Total bytes programmed: " + str(total_bytes))
        print_serial("Start address: 0x{:04X}".format(start_address))
        print_serial("End address: 0x{:04X}".format(start_address + total_bytes - 1))
        
        if is_full_eeprom:
            print_serial("ENTIRE EEPROM PROGRAMMED with " + base_filename)
        
        # Success: green LED, show filename on OLED
        set_led_color(COLOR_GREEN)
        oled_status("Done: " + base_filename[:15], str(total_bytes) + "B written OK")
        
        return True
    
    except Exception as e:
        print_serial("Error processing file: " + str(e))
        oled_status("FILE ERROR", str(e)[:21])
        set_led_color(COLOR_OFF)
        return False

# Track processed files to avoid reprocessing
processed_files = set()
programming_complete = False

# Main program
oled_status("EEPROM Programmer", "Starting...")
print_serial("HEX File to EEPROM Programmer")
if TEST_MODE:
    print_serial("*** TEST MODE - simulating EEPROM writes with timing delays ***")
print_serial("Running on: " + board.board_id)
print_serial("I2C EEPROM address: 0x{:02X}".format(EEPROM_ADDR))
print_serial("WS2812 RGB LED on GP16:")
print_serial("  OFF = idle/waiting")
print_serial("  DIM BLUE = writing file")
print_serial("  GREEN = file write successful")
print_serial("  RED blinking = error/failure")
print_serial("Place .HEX files in the root directory to program the EEPROM")
print_serial("File to address mapping:")
for file, addr in sorted(FILE_ADDRESS_MAP.items()):
    print_serial("  {} -> 0x{:04X} (single slot, {} lines)".format(file, addr, SINGLE_SLOT_LINES))
print_serial("  Other filenames: auto-detected by size")
print_serial("    Single slot ({} lines) -> 0x{:04X} (slot 3)".format(SINGLE_SLOT_LINES, DEFAULT_START_ADDR))
print_serial("    Full EEPROM ({} lines) -> 0x0000 (clears first)".format(FULL_EEPROM_LINES))

# Try to initialize I2C and detect EEPROM
if TEST_MODE:
    print_serial("*** TEST MODE ACTIVE - no EEPROM required ***")
    oled_status("TEST MODE", "No EEPROM needed")
    time.sleep(1)
else:
    try:
        if not i2c.try_lock():
            print_serial("Could not lock I2C bus")
            oled_status("I2C Error", "Bus locked")
            blink_led_pattern(COLOR_RED, 0.05, 0.05, 10)
        else:
            devices = i2c.scan()
            i2c.unlock()
            
            if EEPROM_ADDR in devices:
                print_serial("EEPROM detected at address 0x{:02X}".format(EEPROM_ADDR))
                oled_status("EEPROM found", "0x{:02X} Ready".format(EEPROM_ADDR))
            else:
                print_serial("WARNING: EEPROM not detected at address 0x{:02X}".format(EEPROM_ADDR))
                print_serial("Available I2C devices: " + ", ".join(["0x{:02X}".format(addr) for addr in devices]))
                oled_status("EEPROM not found!", "Check wiring")
                blink_led_pattern(COLOR_RED, 0.05, 0.05, 10)
    except Exception as e:
        print_serial("I2C initialization error: " + str(e))
        oled_status("I2C Init Error", str(e)[:21])
        try:
            i2c.unlock()
        except:
            pass
        blink_led_pattern(COLOR_RED, 0.05, 0.05, 10)

# Make sure control pin is HIGH at startup
control_pin.value = True
print_serial("Control pin set HIGH at startup")

# Set LEDs to OFF for startup
set_led_color(COLOR_OFF)

# EEPROM presence tracking
eeprom_present = False
last_scan_time = 0
SCAN_INTERVAL = 1.0  # seconds between scans

def scan_for_eeprom():
    """Check if EEPROM is present on I2C bus"""
    if TEST_MODE:
        return True
    try:
        if not i2c.try_lock():
            return None  # bus busy, skip
        devices = i2c.scan()
        i2c.unlock()
        return EEPROM_ADDR in devices
    except:
        try:
            i2c.unlock()
        except:
            pass
        return None

if TEST_MODE:
    oled_status("TEST MODE", "Waiting for .hex")
else:
    oled_status("No target", "Connect EEPROM")

while True:
    try:
        now = time.monotonic()
        
        # Check button (active low with pull-up)
        button_state = button_pin.value
        if not button_state and button_last_state:
            reset_activity()
            print_serial("Button pressed - screensaver reset")
        button_last_state = button_state
        
        # Screensaver logic
        if not screensaver_active and (now - last_activity_time >= SCREENSAVER_TIMEOUT):
            screensaver_active = True
            screensaver_label.x = random.randint(0, 74)
            screensaver_label.y = random.randint(6, 26)
            display.root_group = screensaver_group
            last_screensaver_move = now
            print_serial("Screensaver activated")
        elif screensaver_active and (now - last_screensaver_move >= SCREENSAVER_MOVE_INTERVAL):
            screensaver_label.x = random.randint(0, 74)
            screensaver_label.y = random.randint(6, 26)
            last_screensaver_move = now
        
        # Periodically scan for EEPROM
        if now - last_scan_time >= SCAN_INTERVAL:
            last_scan_time = now
            found = scan_for_eeprom()
            if found is not None:
                if found and not eeprom_present:
                    eeprom_present = True
                    processed_files.clear()
                    print_serial("EEPROM connected")
                    oled_status("EEPROM found", "Waiting for .hex")
                elif not found and eeprom_present:
                    eeprom_present = False
                    print_serial("EEPROM removed")
                    oled_status("No target", "Connect EEPROM")
                    set_led_color(COLOR_OFF)
        
        # Only process files if EEPROM is present
        if not eeprom_present:
            time.sleep(0.1)
            continue

        # Check for HEX files
        files = os.listdir("/")
        hex_files = [f for f in files if 
                    (f.lower().endswith(".hex") and 
                     not f.startswith(".") and 
                     f not in processed_files)]
        
        if hex_files:
            programming_complete = False
            actually_programmed = False
            
            # Unified processing for all hex files
            for hex_file in hex_files:
                print_serial("")
                print_serial("Found HEX file: " + hex_file)
                oled_status("Found: " + hex_file[:15], "Processing...")
                
                set_led_color(COLOR_OFF)
                
                success = process_and_program_hex_file("/" + hex_file)
                
                if success:
                    processed_files.add(hex_file)
                    print_serial("File marked as processed")
                    
                    # Check if we actually programmed data (not a zero-byte file)
                    try:
                        all_bytes_check = []
                        with open("/" + hex_file, "r") as f:
                            for line in f:
                                byte_count, address, record_type, data = parse_hex_line(line)
                                if record_type == 0:
                                    all_bytes_check.extend(data)
                        
                        if len(all_bytes_check) > 0:
                            print_serial("Successfully programmed EEPROM with " + hex_file)
                            actually_programmed = True
                            try:
                                with open("/" + hex_file + ".programmed", "w") as f:
                                    f.write("Programmed on " + str(time.monotonic()))
                            except:
                                pass
                            set_led_color(COLOR_GREEN)
                        else:
                            print_serial(hex_file + " was zero-byte file - no programming needed")
                    except:
                        actually_programmed = True
                        set_led_color(COLOR_GREEN)
                else:
                    oled_status(hex_file[:15] + " FAIL", "Check serial log")
                    set_led_color(COLOR_RED)
                    break
                
                # Brief delay between files
                if hex_file != hex_files[-1]:
                    set_led_color(COLOR_OFF)
                    time.sleep(0.05)
            
            # After all files written, toggle control pin once if we programmed anything
            if not programming_complete and actually_programmed:
                print_serial("")
                if TEST_MODE:
                    print_serial("TEST MODE: Skipping GP2 toggle")
                    oled_status("TEST: GP2 skip", "Simulated OK")
                else:
                    print_serial("All files written - toggling GP2...")
                    oled_status("GP2 toggle", "Programming target")
                    control_pin.value = False
                    time.sleep(0.01)  # 10ms delay
                    control_pin.value = True
                    print_serial("Programming mode complete (GP2 toggled)")
                programming_complete = True
                
                set_led_color(COLOR_DIM_BLUE)
                # Show the last programmed filename on OLED
                last_file = hex_files[-1] if hex_files else ""
                oled_status("Done: " + last_file[:15], "Waiting for .hex")
        
        time.sleep(0.1)
    
    except Exception as e:
        print_serial("Error in main loop: " + str(e))
        oled_status("LOOP ERROR", str(e)[:21])
        blink_led_pattern(COLOR_RED, 0.05, 0.05, 5)
        set_led_color(COLOR_OFF)
        oled_status("Error - retry", "in 5 seconds")
        time.sleep(5)
