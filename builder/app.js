class FV1EEPROMBuilder {
    constructor() {
        this.files = [];
        this.maxFiles = 8;
        this.init();
    }

    init() {
        this.setupEventListeners();
        this.createInitialFileInputs();
    }

    setupEventListeners() {
        document.getElementById('addFileBtn').addEventListener('click', () => this.addFileInput());
        document.getElementById('buildBtn').addEventListener('click', () => this.buildEEPROM());
        document.getElementById('downloadBtn').addEventListener('click', () => this.downloadFile());
        
        // Setup drag and drop for reordering
        this.setupDragAndDrop();
    }

    setupDragAndDrop() {
        const container = document.getElementById('fileInputs');
        
        container.addEventListener('dragover', (e) => {
            e.preventDefault();
            const dragging = document.querySelector('.dragging');
            const afterElement = this.getDragAfterElement(container, e.clientY);
            
            if (afterElement == null) {
                container.appendChild(dragging);
            } else {
                container.insertBefore(dragging, afterElement);
            }
        });
    }

    getDragAfterElement(container, y) {
        const draggableElements = [...container.querySelectorAll('.file-input-row:not(.dragging)')];
        
        return draggableElements.reduce((closest, child) => {
            const box = child.getBoundingClientRect();
            const offset = y - box.top - box.height / 2;
            
            if (offset < 0 && offset > closest.offset) {
                return { offset: offset, element: child };
            } else {
                return closest;
            }
        }, { offset: Number.NEGATIVE_INFINITY }).element;
    }

    createInitialFileInputs() {
        // Start with 2 file inputs
        this.addFileInput();
        this.addFileInput();
    }

    addFileInput() {
        const container = document.getElementById('fileInputs');
        const currentInputs = container.children.length;
        
        if (currentInputs >= this.maxFiles) {
            this.showStatus('Maximum 8 files allowed', 'error');
            return;
        }

        const row = document.createElement('div');
        row.className = 'file-input-row';
        row.draggable = true;
        row.innerHTML = `
            <span class="drag-handle"></span>
            <span class="file-label">File ${currentInputs}:</span>
            <input type="file" class="file-input" accept=".hex" data-index="${currentInputs}">
            <span class="file-info">No file selected</span>
            <button type="button" class="remove-btn" onclick="hexBuilder.removeFileInput(this)">Remove</button>
        `;

        const fileInput = row.querySelector('.file-input');
        fileInput.addEventListener('change', (e) => this.handleFileSelect(e));

        // Add drag event listeners
        row.addEventListener('dragstart', (e) => {
            row.classList.add('dragging');
        });

        row.addEventListener('dragend', (e) => {
            row.classList.remove('dragging');
            this.updateFileLabels(); // Update labels after reorder
        });

        container.appendChild(row);
        this.updateAddButton();
    }

    removeFileInput(button) {
        const row = button.parentElement;
        const fileInput = row.querySelector('.file-input');
        const index = parseInt(fileInput.dataset.index);
        
        // Remove from files array
        if (this.files[index]) {
            delete this.files[index];
        }

        row.remove();
        this.updateFileLabels();
        this.updateAddButton();
    }

    updateFileLabels() {
        const rows = document.querySelectorAll('.file-input-row');
        rows.forEach((row, index) => {
            const label = row.querySelector('.file-label');
            const input = row.querySelector('.file-input');
            label.textContent = `File ${index + 1}:`;
            input.dataset.index = index;
        });
    }

    updateAddButton() {
        const addBtn = document.getElementById('addFileBtn');
        const currentInputs = document.getElementById('fileInputs').children.length;
        addBtn.style.display = currentInputs >= this.maxFiles ? 'none' : 'inline-block';
    }

    async handleFileSelect(event) {
        const file = event.target.files[0];
        const index = parseInt(event.target.dataset.index);
        const row = event.target.parentElement;
        const infoSpan = row.querySelector('.file-info');

        if (!file) {
            delete this.files[index];
            infoSpan.textContent = 'No file selected';
            infoSpan.className = 'file-info';
            row.className = 'file-input-row';
            return;
        }

        try {
            const content = await this.readFile(file);
            const validation = this.validateHexFile(content);
            
            if (validation.valid) {
                this.files[index] = {
                    name: file.name,
                    content: content,
                    lines: validation.lines
                };
                infoSpan.textContent = `${validation.lines} lines, ${file.size} bytes`;
                infoSpan.className = 'file-info success';
                row.className = 'file-input-row has-file';
            } else {
                delete this.files[index];
                infoSpan.textContent = validation.error;
                infoSpan.className = 'file-info error';
                row.className = 'file-input-row error';
            }
        } catch (error) {
            delete this.files[index];
            infoSpan.textContent = 'Error reading file';
            infoSpan.className = 'file-info error';
            row.className = 'file-input-row error';
        }
    }

    readFile(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = e => resolve(e.target.result);
            reader.onerror = e => reject(e);
            reader.readAsText(file);
        });
    }

    validateHexFile(content) {
        const lines = content.trim().split('\n');
        
        if (lines.length !== 129) {
            return {
                valid: false,
                error: `Expected 129 lines, got ${lines.length}`
            };
        }

        // Validate Intel HEX format
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            
            // Skip empty lines
            if (!line) continue;
            
            // Each line should start with ':'
            if (!line.startsWith(':')) {
                return {
                    valid: false,
                    error: `Line ${i + 1}: Invalid format, should start with ':'`
                };
            }
            
            // Check if it's valid hex (basic check)
            const hexPart = line.substring(1);
            if (!/^[0-9A-Fa-f]*$/.test(hexPart)) {
                return {
                    valid: false,
                    error: `Line ${i + 1}: Invalid hex characters`
                };
            }
        }

        return {
            valid: true,
            lines: lines.length
        };
    }

    buildEEPROM() {
        try {
            const combinedHex = this.buildFullEEPROM();
            this.showOutput(combinedHex);
            
            const fileCount = this.getOrderedFiles().length;
            if (fileCount > 0) {
                this.showStatus(`Successfully built EEPROM with ${fileCount} files (1025 lines total)`, 'success');
            } else {
                this.showStatus('Built empty EEPROM with 0x11 padding (1025 lines total)', 'info');
            }
        } catch (error) {
            this.showStatus(`Error building EEPROM: ${error.message}`, 'error');
        }
    }

    getOrderedFiles() {
        // Get files in the order they appear in the DOM
        const rows = document.querySelectorAll('.file-input-row');
        const orderedFiles = [];
        
        rows.forEach((row, index) => {
            const input = row.querySelector('.file-input');
            const originalIndex = parseInt(input.dataset.index);
            
            if (this.files[originalIndex]) {
                orderedFiles.push({
                    ...this.files[originalIndex],
                    position: index
                });
            }
        });
        
        return orderedFiles;
    }

    buildFullEEPROM() {
        // Build complete 4KB EEPROM (1024 lines of data + 1 EOF = 1025 total)
        const totalBytes = 4096; // 4KB
        const bytesPerLine = 4;
        const totalDataLines = totalBytes / bytesPerLine; // 1024 lines
        
        // Initialize with padding pattern: first 3 bytes as 0x00, last byte as 0x11
        const eepromData = new Array(totalBytes);
        for (let i = 0; i < totalBytes; i++) {
            // For each group of 4 bytes, set the last one to 0x11, others to 0x00
            eepromData[i] = (i % 4 === 3) ? 0x11 : 0x00;
        }
        
        // Get files in display order
        const orderedFiles = this.getOrderedFiles();
        
        // Fill in user data
        orderedFiles.forEach((file, index) => {
            const startAddress = index * 0x200; // 512 bytes per slot
            if (startAddress >= totalBytes) return; // Skip if beyond EEPROM size
            
            const hexData = this.parseHexFileData(file.content);
            
            // Copy user data into EEPROM array
            hexData.forEach((byte, offset) => {
                const address = startAddress + offset;
                if (address < totalBytes) {
                    eepromData[address] = byte;
                }
            });
        });
        
        // Convert to Intel HEX format
        const hexLines = [];
        
        for (let i = 0; i < totalDataLines; i++) {
            const address = i * bytesPerLine;
            const dataBytes = eepromData.slice(address, address + bytesPerLine);
            
            const hexLine = this.createHexLine(address, dataBytes);
            hexLines.push(hexLine);
        }
        
        // Add EOF record
        hexLines.push(':00000001FF');
        
        return hexLines.join('\n');
    }

    parseHexFileData(hexContent) {
        const lines = hexContent.trim().split('\n');
        const data = [];
        
        lines.forEach(line => {
            line = line.trim();
            if (!line || !line.startsWith(':')) return;
            
            // Skip EOF records (type 01)
            const recordType = parseInt(line.substring(7, 9), 16);
            if (recordType === 0x01) return; // Skip EOF lines
            
            const byteCount = parseInt(line.substring(1, 3), 16);
            
            if (recordType === 0x00) { // Data record
                const dataStart = 9;
                for (let i = 0; i < byteCount; i++) {
                    const bytePos = dataStart + (i * 2);
                    const byte = parseInt(line.substring(bytePos, bytePos + 2), 16);
                    data.push(byte);
                }
            }
        });
        
        return data;
    }

    createHexLine(address, dataBytes) {
        const byteCount = dataBytes.length;
        const recordType = 0x00;
        
        let line = ':' + 
                   byteCount.toString(16).toUpperCase().padStart(2, '0') +
                   address.toString(16).toUpperCase().padStart(4, '0') +
                   recordType.toString(16).toUpperCase().padStart(2, '0');
        
        // Add data bytes
        dataBytes.forEach(byte => {
            line += byte.toString(16).toUpperCase().padStart(2, '0');
        });
        
        // Calculate checksum
        let sum = byteCount + ((address >> 8) & 0xFF) + (address & 0xFF) + recordType;
        dataBytes.forEach(byte => sum += byte);
        
        const checksum = (0x100 - (sum & 0xFF)) & 0xFF;
        line += checksum.toString(16).toUpperCase().padStart(2, '0');
        
        return line;
    }

    combineHexFiles(files) {
        // This method is now replaced by buildFullEEPROM()
        // Keeping for backward compatibility but not used
        let combinedLines = [];
        
        files.forEach((file, index) => {
            const baseAddress = index * 0x200; // 512 bytes per file (0x200 hex)
            const lines = file.content.trim().split('\n');
            
            lines.forEach(line => {
                line = line.trim();
                if (!line || line === ':00000001FF') return; // Skip empty lines and EOF
                
                if (line.startsWith(':')) {
                    // Parse Intel HEX record
                    const byteCount = parseInt(line.substring(1, 3), 16);
                    const address = parseInt(line.substring(3, 7), 16);
                    const recordType = parseInt(line.substring(7, 9), 16);
                    
                    if (recordType === 0x00) { // Data record
                        const newAddress = address + baseAddress;
                        const newAddressHex = newAddress.toString(16).toUpperCase().padStart(4, '0');
                        
                        // Rebuild the line with new address
                        let newLine = ':' + 
                                     byteCount.toString(16).toUpperCase().padStart(2, '0') + 
                                     newAddressHex + 
                                     line.substring(7); // Keep record type and data
                        
                        // Recalculate checksum
                        newLine = this.recalculateChecksum(newLine);
                        combinedLines.push(newLine);
                    }
                }
            });
        });

        // Add EOF record
        combinedLines.push(':00000001FF');
        
        return combinedLines.join('\n');
    }

    recalculateChecksum(hexLine) {
        // Remove the old checksum (last 2 characters)
        const lineWithoutChecksum = hexLine.substring(0, hexLine.length - 2);
        
        let sum = 0;
        // Sum all bytes (skip the ':' at the beginning)
        for (let i = 1; i < lineWithoutChecksum.length; i += 2) {
            sum += parseInt(lineWithoutChecksum.substring(i, i + 2), 16);
        }
        
        // Two's complement checksum
        const checksum = (0x100 - (sum & 0xFF)) & 0xFF;
        
        return lineWithoutChecksum + checksum.toString(16).toUpperCase().padStart(2, '0');
    }

    showOutput(content) {
        const preview = document.getElementById('outputPreview');
        const textarea = document.getElementById('outputContent');
        
        textarea.value = content;
        preview.style.display = 'block';
        
        // Scroll to output
        preview.scrollIntoView({ behavior: 'smooth' });
    }

    showStatus(message, type) {
        const status = document.getElementById('status');
        status.textContent = message;
        status.className = `status ${type}`;
        
        // Auto-hide success/info messages after 5 seconds
        if (type === 'success' || type === 'info') {
            setTimeout(() => {
                status.style.display = 'none';
            }, 5000);
        }
    }

    downloadFile() {
        const content = document.getElementById('outputContent').value;
        const filename = document.getElementById('outputFilename').value || 'all.hex';
        
        if (!content) {
            this.showStatus('No content to download', 'error');
            return;
        }

        const blob = new Blob([content], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        
        URL.revokeObjectURL(url);
        this.showStatus(`Downloaded ${filename}`, 'success');
    }
}

// Initialize the application
const hexBuilder = new FV1EEPROMBuilder();