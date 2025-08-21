import os
import time
import board
import busio
import digitalio
import supervisor
import neopixel

# Set up I2C bus on GP0 (SDA) and GP1 (SCL)
i2c = busio.I2C(scl=board.GP1, sda=board.GP0)

# Set up control pin (GP2) - keep HIGH by default, toggle LOW only during programming
control_pin = digitalio.DigitalInOut(board.GP2)
control_pin.direction = digitalio.Direction.OUTPUT
control_pin.value = True  # Keep high by default

# Set up WS2812 RGB LED on GP16
pixel = neopixel.NeoPixel(board.GP16, 1, brightness=1.0, auto_write=True, pixel_order='GRB')

# RGB Color definitions - solid colors only
COLOR_OFF = (0, 0, 0)       # Off
COLOR_RED = (255, 0, 0)     # Red for uploading
COLOR_GREEN = (0, 255, 0)   # Green for success
COLOR_BLUE = (0, 0, 255)    # Blue for idle state
COLOR_DIM_BLUE = (0, 0, 8)  # Very dim blue for programming
COLOR_YELLOW = (255, 255, 0) # Yellow for dumping EEPROM

# EEPROM address
EEPROM_ADDR = 0x50

# File to EEPROM address mapping
FILE_ADDRESS_MAP = {
    "0.hex": 0x0000,
    "1.hex": 0x0200,
    "2.hex": 0x0400,
    "3.hex": 0x0600,
    "4.hex": 0x0800,
    "5.hex": 0x0A00,
    "6.hex": 0x0C00,
    "7.hex": 0x0E00,
    "all.hex": 0x0000  # Special case: write entire EEPROM starting from beginning
}

# Default start address for other filenames
DEFAULT_START_ADDR = 0x0600

# We'll use the normal REPL for output
def print_serial(message):
    """Print to the REPL"""
    print(message)

def set_led_color(color):
    """Set the WS2812 LED color"""
    pixel[0] = color
    
def blink_led_once(color, duration=0.2):
    """Blink the LED once quickly with specified color"""
    set_led_color(color)
    time.sleep(duration)
    set_led_color(COLOR_OFF)
    time.sleep(duration)

def blink_led_pattern(color, on_time=0.1, off_time=0.1, count=3):
    """Blink the LED in a pattern with specified color"""
    for _ in range(count):
        set_led_color(color)
        time.sleep(on_time)
        set_led_color(COLOR_OFF)
        time.sleep(off_time)

def calculate_checksum(data_bytes):
    """Calculate Intel HEX checksum for a list of bytes"""
    checksum = sum(data_bytes) & 0xFF
    return ((~checksum) + 1) & 0xFF

def check_serial_input():
    """Check for serial input commands"""
    if supervisor.runtime.serial_bytes_available:
        try:
            # Read available bytes
            input_bytes = supervisor.runtime.serial_bytes_available
            if input_bytes > 0:
                # Read the input (this is a simplified approach)
                # In practice, you might need to buffer input until you get a complete command
                command = input().strip().lower()
                return command
        except:
            pass
    return None

def dump_eeprom_to_hex():
    """Read entire EEPROM and output in Intel HEX format"""
    print_serial("")
    print_serial("=== EEPROM DUMP START ===")
    print_serial("Dumping EEPROM contents in Intel HEX format...")
    
    # Set LED to yellow during dump operation
    set_led_color(COLOR_YELLOW)
    
    try:
        # For 24LC32A: 4096 bytes (0x0000 to 0x0FFF)
        eeprom_size = 4096
        bytes_per_line = 16  # Standard Intel HEX uses 16 bytes per line
        
        # Read and output the EEPROM in chunks
        for addr in range(0, eeprom_size, bytes_per_line):
            # Read a line's worth of data
            data = read_eeprom(EEPROM_ADDR, addr, bytes_per_line)
            
            if data is None:
                print_serial("Error reading EEPROM at address 0x{:04X}".format(addr))
                set_led_color(COLOR_RED)
                return False
            
            # Create Intel HEX line
            byte_count = len(data)
            address = addr
            record_type = 0x00  # Data record
            
            # Build the line data (without checksum yet)
            line_data = [byte_count, (address >> 8) & 0xFF, address & 0xFF, record_type]
            line_data.extend(data)
            
            # Calculate checksum
            checksum = calculate_checksum(line_data)
            
            # Format as Intel HEX line
            hex_line = ":"
            for byte_val in line_data:
                hex_line += "{:02X}".format(byte_val)
            hex_line += "{:02X}".format(checksum)
            
            print_serial(hex_line)
        
        # Add end-of-file record
        eof_line = ":00000001FF"
        print_serial(eof_line)
        
        print_serial("=== EEPROM DUMP COMPLETE ===")
        print_serial("Total bytes dumped: {}".format(eeprom_size))
        
        # Set LED to green to indicate successful dump
        set_led_color(COLOR_GREEN)
        return True
        
    except Exception as e:
        print_serial("Error during EEPROM dump: " + str(e))
        set_led_color(COLOR_RED)
        return False

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
    """Process a HEX file and program the EEPROM"""
    all_bytes = []
    line_count = 0
    min_addr = None
    max_addr = None
    
    # Turn on DIM BLUE LED while processing files
    set_led_color(COLOR_OFF)
    
    try:
        # Open and parse the HEX file - first pass to validate
        with open(filename, "r") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                line_count += 1
                
                byte_count, address, record_type, data = parse_hex_line(line)
                
                # Skip invalid lines
                if byte_count is None:
                    continue
                
                # Data record - track address range
                if record_type == 0:
                    if min_addr is None:
                        min_addr = address
                        max_addr = address + len(data) - 1
                    else:
                        min_addr = min(min_addr, address)
                        max_addr = max(max_addr, address + len(data) - 1)
                
                # End of file record
                elif record_type == 1:
                    break
        
        # Second pass - actually extract the data first to check for zero-byte files
        with open(filename, "r") as f:
            for line in f:
                byte_count, address, record_type, data = parse_hex_line(line)
                
                # Skip invalid lines
                if byte_count is None:
                    continue
                
                # Data record
                if record_type == 0:
                    all_bytes.extend(data)
                
                # End of file record
                elif record_type == 1:
                    break
        
        # Check if the hex file contained any data - do this BEFORE validation
        if len(all_bytes) == 0:
            print_serial("Ignoring zero-byte hex file: {}".format(filename))
            set_led_color(COLOR_OFF)
            return True  # Return True so file gets marked as processed
        
        # Determine expected parameters based on filename
        base_filename = filename.split('/')[-1]
        
        if base_filename == "all.hex":
            expected_lines = 1025
            expected_min_addr = 0x000
            expected_max_addr = 0xFFF
        else:
            expected_lines = 129
            expected_min_addr = 0x000
            expected_max_addr = 0x1FF
        
        # Validate line count
        if line_count != expected_lines:
            print_serial("ERROR: {} must have exactly {} lines, but has {} lines".format(base_filename, expected_lines, line_count))
            set_led_color(COLOR_RED)
            return False
        
        # Validate address range
        if min_addr != expected_min_addr or max_addr != expected_max_addr:
            print_serial("ERROR: {} must have address range 0x{:03X}-0x{:03X}, but has 0x{:03X}-0x{:03X}".format(
                base_filename, expected_min_addr, expected_max_addr, min_addr or 0, max_addr or 0))
            set_led_color(COLOR_RED)
            return False
        
        print_serial("Validation passed: {} lines, address range 0x{:03X}-0x{:03X}".format(line_count, min_addr, max_addr))
        
        # Determine start address based on filename
        if base_filename in FILE_ADDRESS_MAP:
            start_address = FILE_ADDRESS_MAP[base_filename]
        else:
            start_address = DEFAULT_START_ADDR
        
        print_serial("Using start address: 0x{:04X} for file: {}".format(start_address, base_filename))
        print_serial("File contains {} bytes of data".format(len(all_bytes)))
        
        # Special handling for all.hex - clear EEPROM first
        if base_filename == "all.hex":
            print_serial("Processing all.hex - will clear entire EEPROM first")
            if not clear_entire_eeprom():
                print_serial("Failed to clear EEPROM for all.hex")
                set_led_color(COLOR_RED)
                return False
        
        # Program the EEPROM in pages (32 bytes per page for 24LC32A)
        total_bytes = len(all_bytes)
        page_size = 32
        
        print_serial("Programming EEPROM with " + str(total_bytes) + " bytes")
        
        # Start with dim blue LED during programming
        set_led_color(COLOR_DIM_BLUE)
        
        for i in range(0, total_bytes, page_size):
            # Get the data for this page
            page_end = min(i + page_size, total_bytes)
            page_data = all_bytes[i:page_end]
            
            # Calculate the actual EEPROM address for this page
            eeprom_addr = start_address + i
            
            # Write the page
            print_serial("Writing page at address 0x{:04X}".format(eeprom_addr))
            result = write_eeprom_page(EEPROM_ADDR, eeprom_addr, bytearray(page_data))
            
            if not result:
                print_serial("Error writing page at address 0x{:04X}".format(eeprom_addr))
                set_led_color(COLOR_OFF)
                return False
        
        # Programming complete - exit programming mode
        control_pin.value = True
        time.sleep(0.1)
        print_serial("Programming mode deactivated (GP3 set high)")
        
        # Print summary to match the header format
        filename_base = filename.split('/')[-1].split('.')[0]
        print_serial(filename_base + "[] = {")
        
        # Print 4 bytes per line
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
        
        # Special message for all.hex
        if base_filename == "all.hex":
            print_serial("ENTIRE EEPROM PROGRAMMED with all.hex")
        
        # Indicate file programming success with GREEN LED
        set_led_color(COLOR_GREEN)
        
        return True
    
    except Exception as e:
        print_serial("Error processing file: " + str(e))
        set_led_color(COLOR_OFF)
        return False

# Track processed files to avoid reprocessing
processed_files = set()
programming_complete = False

# Main program
print_serial("HEX File to EEPROM Programmer")
print_serial("Running on: " + board.board_id)
print_serial("I2C EEPROM address: 0x{:02X}".format(EEPROM_ADDR))
print_serial("WS2812 RGB LED on GP16:")
print_serial("  OFF = idle/waiting")
print_serial("  DIM BLUE = writing file")
print_serial("  GREEN = file write successful")
print_serial("  RED blinking = error/failure")
print_serial("  YELLOW = dumping EEPROM")
print_serial("Place .HEX files in the root directory to program the EEPROM")
print_serial("Place dump.txt file to dump EEPROM contents in Intel HEX format")
print_serial("File to address mapping:")
# Sort files: numbered files first (0-7), then all.hex
sorted_files = sorted(FILE_ADDRESS_MAP.items(), key=lambda x: (x[0] != "all.hex", x[0]))
for file, addr in sorted_files:
    if file == "all.hex":
        print_serial("  {} -> 0x{:04X} (ENTIRE EEPROM - requires 1025 lines, 0x000-0xFFF)".format(file, addr))
    else:
        print_serial("  {} -> 0x{:04X} (requires 129 lines, 0x000-0x1FF)".format(file, addr))
print_serial("Default address for other files: 0x{:04X} (requires 129 lines, 0x000-0x1FF)".format(DEFAULT_START_ADDR))

# Try to initialize I2C and detect EEPROM
try:
    if not i2c.try_lock():
        print_serial("Could not lock I2C bus")
        # Blink RED to indicate I2C error
        blink_led_pattern(COLOR_RED, 0.05, 0.05, 10)
    else:
        devices = i2c.scan()
        i2c.unlock()
        
        if EEPROM_ADDR in devices:
            print_serial("EEPROM detected at address 0x{:02X}".format(EEPROM_ADDR))
        else:
            print_serial("WARNING: EEPROM not detected at address 0x{:02X}".format(EEPROM_ADDR))
            print_serial("Available I2C devices: " + ", ".join(["0x{:02X}".format(addr) for addr in devices]))
            # Blink RED to indicate EEPROM not found
            blink_led_pattern(COLOR_RED, 0.05, 0.05, 10)
except Exception as e:
    print_serial("I2C initialization error: " + str(e))
    try:
        i2c.unlock()  # Try to unlock in case it's already locked
    except:
        pass
    # Blink RED to indicate error
    blink_led_pattern(COLOR_RED, 0.05, 0.05, 10)

# Make sure control pin is HIGH at startup
control_pin.value = True
print_serial("Control pin set HIGH at startup")

# Set LED to OFF for startup
set_led_color(COLOR_OFF)

while True:
    try:

        # Check for serial commands first
        serial_command = check_serial_input()
        if serial_command == "dumpall":
            print_serial("Received dumpall command - starting EEPROM dump...")
            success = dump_eeprom_to_hex()
            
            if success:
                print_serial("EEPROM dump completed successfully")
            else:
                print_serial("EEPROM dump failed")
            
            # Brief delay after dump operation
            time.sleep(1)
            set_led_color(COLOR_OFF)
            continue

        files = os.listdir("/")
        
        # Check for HEX files
        # Only process files that end with .hex, don't start with a dot, and haven't been processed
        hex_files = [f for f in files if 
                    (f.lower().endswith(".hex") and 
                     not f.startswith(".") and 
                     f not in processed_files)]
        
        if hex_files:
            # Reset programming complete flag
            programming_complete = False
            actually_programmed = False  # Track if we actually programmed anything
            
            # Special handling: if all.hex is present, process it first and alone
            if "all.hex" in hex_files:
                print_serial("")
                print_serial("Found all.hex - processing as complete EEPROM image")
                
                # Switch to dim blue during processing
                set_led_color(COLOR_DIM_BLUE)
                
                # Process only the all.hex file
                success = process_and_program_hex_file("/all.hex")
                
                if success:
                    # Add to our processed files set
                    processed_files.add("all.hex")
                    print_serial("File marked as processed")
                    
                    # Optional: Create a small marker file to indicate processing
                    try:
                        with open("/all.hex.programmed", "w") as f:
                            f.write("Programmed entire EEPROM on " + str(time.monotonic()))
                    except:
                        pass
                    
                    # Check if we actually programmed data (not a zero-byte file)
                    # Re-open the file to check if it contained actual data
                    try:
                        all_bytes_check = []
                        with open("/all.hex", "r") as f:
                            for line in f:
                                byte_count, address, record_type, data = parse_hex_line(line)
                                if record_type == 0:  # Data record
                                    all_bytes_check.extend(data)
                        
                        if len(all_bytes_check) > 0:
                            print_serial("Successfully programmed entire EEPROM with all.hex")
                            actually_programmed = True
                            # LED stays green after successful write
                            set_led_color(COLOR_GREEN)
                        else:
                            print_serial("all.hex was zero-byte file - no programming needed")
                            set_led_color(COLOR_OFF)
                    except:
                        # If we can't re-check, assume it was programmed since success was True
                        actually_programmed = True
                        set_led_color(COLOR_GREEN)
                else:
                    # Turn off LED on error
                    set_led_color(COLOR_RED)
                
                # After all.hex processing, toggle control pin ONLY if we actually programmed
                if success and actually_programmed:
                    print_serial("")
                    print_serial("EEPROM fully programmed - entering programming mode...")
                    control_pin.value = False
                    time.sleep(0.01)  # 10ms delay
                    control_pin.value = True
                    print_serial("Programming mode complete (GP3 toggled)")
                    programming_complete = True
                    
                    # Return to dim blue after programming complete
                    set_led_color(COLOR_DIM_BLUE)
            
            else:
                # Process individual hex files normally
                for hex_file in hex_files:
                    print_serial("")
                    print_serial("Found HEX file: " + hex_file)
                    
                    # Switch to dim blue during processing
                    set_led_color(COLOR_OFF)
                    
                    # Process the file and program the EEPROM
                    success = process_and_program_hex_file("/" + hex_file)
                    
                    if success:
                        # Add to our processed files set
                        processed_files.add(hex_file)
                        print_serial("File marked as processed")
                        
                        # Check if we actually programmed data (not a zero-byte file)
                        try:
                            all_bytes_check = []
                            with open("/" + hex_file, "r") as f:
                                for line in f:
                                    byte_count, address, record_type, data = parse_hex_line(line)
                                    if record_type == 0:  # Data record
                                        all_bytes_check.extend(data)
                            
                            if len(all_bytes_check) > 0:
                                print_serial("Successfully programmed EEPROM with " + hex_file)
                                actually_programmed = True
                                # Optional: Create a small marker file to indicate processing
                                try:
                                    with open("/" + hex_file + ".programmed", "w") as f:
                                        f.write("Programmed on " + str(time.monotonic()))
                                except:
                                    pass
                                # LED stays green after successful write
                                set_led_color(COLOR_GREEN)
                            else:
                                print_serial(hex_file + " was zero-byte file - no programming needed")
                        except:
                            # If we can't re-check, assume it was programmed since success was True
                            actually_programmed = True
                            set_led_color(COLOR_GREEN)
                    else:
                        # Turn off LED on error
                        set_led_color(COLOR_RED)
                        break
                    
                    # Turn off LED between writes
                    if hex_file != hex_files[-1]:
                        set_led_color(COLOR_OFF)
                        time.sleep(0.05)  # Brief delay between files
                
                # After all files are written, toggle control pin once ONLY if we actually programmed
                if not programming_complete and actually_programmed:
                    print_serial("")
                    print_serial("All files written - entering programming mode...")
                    control_pin.value = False
                    time.sleep(0.01)  # 10ms delay
                    control_pin.value = True
                    print_serial("Programming mode complete (GP3 toggled)")
                    programming_complete = True
                    
                    # Return to dim blue after programming complete
                    set_led_color(COLOR_DIM_BLUE)
        
        # Delay before checking again
        time.sleep(0.1)
    
    except Exception as e:
        print_serial("Error in main loop: " + str(e))
        # Indicate error with RED blinking
        blink_led_pattern(COLOR_RED, 0.05, 0.05, 5)
        # Return to OFF idle state
        set_led_color(COLOR_OFF)
        time.sleep(5)  # Longer delay if there's an error