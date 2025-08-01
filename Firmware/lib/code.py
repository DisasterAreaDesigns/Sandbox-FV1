import os
import time
import board
import busio
import digitalio
import supervisor
import neopixel

# Set up I2C bus on GP4 (SDA) and GP5 (SCL)
i2c = busio.I2C(scl=board.GP1, sda=board.GP0)

# Set up control pin (GP3) - keep HIGH by default, toggle LOW only during programming
control_pin = digitalio.DigitalInOut(board.GP2)
control_pin.direction = digitalio.Direction.OUTPUT
control_pin.value = True  # Keep high by default

# Set up WS2812 RGB LED on GP16
pixel = neopixel.NeoPixel(board.GP16, 1, brightness=1.0, auto_write=True, pixel_order='RGB')

# RGB Color definitions - solid colors only
COLOR_OFF = (0, 0, 0)       # Off
COLOR_RED = (255, 0, 0)     # Red for uploading
COLOR_GREEN = (0, 255, 0)   # Green for success
COLOR_BLUE = (0, 0, 255)    # Blue for idle state

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
    "7.hex": 0x0E00
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
        # Wait for write cycle to complete (max 5ms for 24LC32A)
        time.sleep(0.01)  # 10ms to be safe
        
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

def process_and_program_hex_file(filename):
    """Process a HEX file and program the EEPROM"""
    all_bytes = []
    
    # Turn on RED LED while processing files
    set_led_color(COLOR_RED)
    
    try:
        # Open and parse the HEX file
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
        
        # Determine start address based on filename
        base_filename = filename.split('/')[-1]
        if base_filename in FILE_ADDRESS_MAP:
            start_address = FILE_ADDRESS_MAP[base_filename]
        else:
            start_address = DEFAULT_START_ADDR
        
        print_serial("Using start address: 0x{:04X} for file: {}".format(start_address, base_filename))
        
        # Toggle control pin LOW for programming, then back HIGH after completion
        print_serial("Entering programming mode...")
        control_pin.value = False
        time.sleep(0.01)  # 10ms delay
        print_serial("Programming mode activated (GP3 set low)")
        
        # Program the EEPROM in pages (32 bytes per page for 24LC32A)
        total_bytes = len(all_bytes)
        page_size = 32
        
        print_serial("Programming EEPROM with " + str(total_bytes) + " bytes")
        
        # Solid RED LED during programming
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
                
                # Exit programming mode
                control_pin.value = True
                time.sleep(0.1)
                
                # Indicate error with red blinking
                blink_led_pattern(COLOR_RED, 0.05, 0.05, 10)
                set_led_color(COLOR_OFF)
                return False
        
        # Verify the EEPROM contents
        print_serial("Verifying EEPROM contents...")
        
        # Keep solid RED on during verification
        for i in range(0, total_bytes, page_size):
            # Calculate the actual EEPROM address for this page
            eeprom_addr = start_address + i
            
            # Read data from EEPROM
            page_end = min(i + page_size, total_bytes)
            page_length = page_end - i
            
            read_data = read_eeprom(EEPROM_ADDR, eeprom_addr, page_length)
            
            if read_data is None:
                print_serial("Error reading page at address 0x{:04X}".format(eeprom_addr))
                
                # Exit programming mode
                control_pin.value = True
                time.sleep(0.1)
                
                # Indicate error with red blinking
                blink_led_pattern(COLOR_RED, 0.05, 0.05, 10)
                set_led_color(COLOR_OFF)
                return False
            
            # Compare with expected data
            expected_data = all_bytes[i:page_end]
            if list(read_data) != expected_data:
                print_serial("Verification failed at address 0x{:04X}".format(eeprom_addr))
                print_serial("Expected: " + ", ".join(["0x{:02X}".format(b) for b in expected_data]))
                print_serial("Read: " + ", ".join(["0x{:02X}".format(b) for b in read_data]))
                
                # Exit programming mode
                control_pin.value = True
                time.sleep(0.1)
                
                # Indicate error with red blinking
                blink_led_pattern(COLOR_RED, 0.05, 0.05, 10)
                set_led_color(COLOR_OFF)
                return False
        
        # Programming and verification complete - exit programming mode
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
        
        # Indicate success with GREEN blinks
        blink_led_pattern(COLOR_GREEN, 0.3, 0.3, 3)
        
        return True
    
    except Exception as e:
        print_serial("Error processing file: " + str(e))
        
        # Make sure to exit programming mode
        control_pin.value = True
        time.sleep(0.1)
        
        # Indicate error with red blinking
        blink_led_pattern(COLOR_RED, 0.05, 0.05, 10)
        set_led_color(COLOR_OFF)
        return False

# Track processed files to avoid reprocessing
processed_files = set()

# Main program
print_serial("HEX File to EEPROM Programmer")
print_serial("Running on: " + board.board_id)
print_serial("I2C EEPROM address: 0x{:02X}".format(EEPROM_ADDR))
print_serial("WS2812 RGB LED on GP16:")
print_serial("  BLUE solid = idle/waiting")
print_serial("  RED solid = uploading/programming")
print_serial("  GREEN blinking = success")
print_serial("  RED blinking = error/failure")
print_serial("Place .HEX files in the root directory to program the EEPROM")
print_serial("File to address mapping:")
for file, addr in FILE_ADDRESS_MAP.items():
    print_serial("  {} -> 0x{:04X}".format(file, addr))
print_serial("Default address for other files: 0x{:04X}".format(DEFAULT_START_ADDR))

# Try to initialize I2C and detect EEPROM
try:
    if not i2c.try_lock():
        print_serial("Could not lock I2C bus")
    else:
        devices = i2c.scan()
        i2c.unlock()
        
        if EEPROM_ADDR in devices:
            print_serial("EEPROM detected at address 0x{:02X}".format(EEPROM_ADDR))
            # Blink GREEN to indicate EEPROM detected
            blink_led_pattern(COLOR_GREEN, 0.2, 0.2, 3)
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

# Set LED to solid BLUE for idle state
set_led_color(COLOR_BLUE)

while True:
    try:
        # Check for HEX files
        files = os.listdir("/")
        # Only process files that end with .hex, don't start with a dot, and haven't been processed
        hex_files = [f for f in files if 
                    (f.lower().endswith(".hex") and 
                     not f.startswith(".") and 
                     f not in processed_files)]
        
        if hex_files:
            for hex_file in hex_files:
                print_serial("")
                print_serial("Found HEX file: " + hex_file)
                
                # Switch to solid RED during processing
                set_led_color(COLOR_RED)
                
                # Process the file and program the EEPROM
                success = process_and_program_hex_file("/" + hex_file)
                
                if success:
                    print_serial("Successfully programmed EEPROM with " + hex_file)
                    # Add to our processed files set
                    processed_files.add(hex_file)
                    print_serial("File marked as processed")
                    
                    # Optional: Create a small marker file to indicate processing
                    try:
                        with open("/" + hex_file + ".programmed", "w") as f:
                            f.write("Programmed on " + str(time.monotonic()))
                    except:
                        pass
                
                # Return to solid BLUE idle state
                set_led_color(COLOR_BLUE)
        
        # Delay before checking again
        time.sleep(0.1)
    
    except Exception as e:
        print_serial("Error in main loop: " + str(e))
        # Indicate error with RED blinking
        blink_led_pattern(COLOR_RED, 0.05, 0.05, 5)
        # Return to idle state
        set_led_color(COLOR_BLUE)
        time.sleep(5)  # Longer delay if there's an error