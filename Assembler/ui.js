// UI Functions
let assembledData = null;
let outputDirectoryHandle = null;
let preferredStartDirectory = 'downloads';
let projectDirectoryHandle = null;
let selectedFilename = null;

async function selectOutputDirectory() {
    try {
        if ('showDirectoryPicker' in window) {
            outputDirectoryHandle = await window.showDirectoryPicker();
            document.getElementById('outputDirDisplay').textContent = `Selected: ${outputDirectoryHandle.name}`;
            const outputDirDisplay = document.getElementById('outputDirDisplay');
            outputDirDisplay.style.color = '#28a745'; // Green color for connected
            
            debugLog('Output directory selected successfully', 'success');

            
            // Update clear hardware button state
            updateClearHardwareButton();
            updateDownloadButtonStates();
            updateHardwareConnectionStatus();
            
            // Try to find and read the hardware identifier JSON file
            // Make sure we have the handle before calling this
            if (outputDirectoryHandle) {
                await readHardwareIdentifier();
            }
        } else {
            debugLog('Directory selection not supported in this browser', 'errors');
        }
    } catch (err) {
        if (err.name !== 'AbortError') {
            debugLog('Error selecting directory: ' + err.message, 'errors');
        }
    }
}

// update hardware connection on main page
function updateHardwareConnectionStatus() {
    const statusElement = document.getElementById('hardwareConnectionStatus');
    if (!statusElement) return;

    let statusText = 'No directory selected';
    let statusColor = '#666';

    const filenameWithoutExt = selectedFilename.slice(0, -4);
    const targetText = `Program Slot ${filenameWithoutExt}`;
    const serialConnected = document.getElementById('serialPortDisplay').textContent.includes('Connected');

    // Check file mode connection (output directory)
    if (outputDirectoryHandle) {
        statusText = `${outputDirectoryHandle.name}; ${targetText}; ${serialConnected ? 'Serial connected' : ''}`;
        statusColor = '#28a745'; // Green
    } else {
        statusText = `No directory selected; ${targetText}; ${serialConnected ? 'Serial connected' : ''}`;
        }

    statusElement.textContent = statusText;
    statusElement.style.color = statusColor;
}

function updateClearHardwareButton() {
    const clearHardwareBtn = document.getElementById('clearHardwareBtn');
    if (clearHardwareBtn) {
        clearHardwareBtn.disabled = !outputDirectoryHandle;
    }
}

async function selectProjectDirectory() {
    try {
        if ('showDirectoryPicker' in window) {
            // Show directory picker and get the handle
            projectDirectoryHandle = await window.showDirectoryPicker();

            document.getElementById('projectFolderLabel').textContent = `Selected: ${projectDirectoryHandle.name}`;
            const projectFolderLabel = document.getElementById('projectFolderLabel');
            projectFolderLabel.style.color = '#28a745'; // Green color for connected
            
            // Update the label with the folder name
            // updateProjectFolderButton(projectDirectoryHandle);
            
            debugLog('Project directory selected successfully', 'success');
            
        } else {
            debugLog('Directory selection not supported in this browser', 'errors');
        }
    } catch (err) {
        if (err.name !== 'AbortError') {
            debugLog('Error selecting project directory: ' + err.message, 'errors');
        }
    }
}

async function readHardwareIdentifier() {
    if (!outputDirectoryHandle) {
        debugLog('No output directory selected', 'errors');
        return;
    }

    try {
        // Try to find a hardware identifier JSON file
        const possibleFilenames = [
            'hardware_id.json',
            'device_info.json', 
            'device_id.json',
            'hardware_info.json',
            'config.json',
            'device.json'
        ];

        let hardwareInfo = null;
        let foundFilename = null;
        let debugInfo = [];

        // First, let's see what files are actually in the directory
        debugInfo.push('Scanning directory for files...');
        
        for (const filename of possibleFilenames) {
            try {
                debugInfo.push(`Trying to read: ${filename}`);
                const fileHandle = await outputDirectoryHandle.getFileHandle(filename);
                const file = await fileHandle.getFile();
                const content = await file.text();
                debugInfo.push(`Found file: ${filename}, size: ${content.length} bytes`);
                
                // Try to parse as JSON
                const jsonData = JSON.parse(content);
                debugInfo.push(`Parsed JSON successfully from ${filename}`);
                
                // Check if it looks like a hardware identifier file
                if (jsonData.device_type || jsonData.firmware_version || jsonData.device_id || jsonData.hardware_info) {
                    hardwareInfo = jsonData;
                    foundFilename = filename;
                    debugInfo.push(`Hardware info found in ${filename}`);
                    break;
                } else {
                    debugInfo.push(`${filename} doesn't appear to be a hardware identifier file`);
                }
            } catch (err) {
                debugInfo.push(`Error reading ${filename}: ${err.message}`);
                continue;
            }
        }

        if (hardwareInfo) {
            // Check if this is the expected hardware device
            const expectedDeviceType = "FV1 Sandbox"; // Change this to match your expected device
            
            if (hardwareInfo.device_type === expectedDeviceType) {
                displayHardwareInfo(hardwareInfo, foundFilename);
            } else {
                // Hardware device doesn't match - revert to default downloads
                revertToDefaultDirectory();
                debugLog('Hardware device not found, reverting to default directory', 'errors');
                return;
            }
        } else {
            // No hardware identifier found - revert to default downloads
            revertToDefaultDirectory();
            debugLog('Hardware device not found, reverting to default directory', 'errors');
            return;
        }
        
    } catch (err) {
        // Error reading hardware identifier - revert to default downloads
        revertToDefaultDirectory();
        debugLog('Hardware device not found, reverting to default directory', 'errors');
    }
}

function revertToDefaultDirectory() {
    // Clear the output directory handle to revert to normal browser downloads
    outputDirectoryHandle = null;
    
    // Update the UI to show no directory selected
    document.getElementById('outputDirDisplay').textContent = 'No directory selected, using default directory';
    document.getElementById('outputDirDisplay').style.color = '#666';
    
    // Update button states and hardware connection status
    updateDownloadButtonStates();
    updateHardwareConnectionStatus();
}

function displayHardwareInfo(hardwareInfo, filename) {
    let infoText = `Hardware Identifier Found (${filename}):\n`;
    
    if (hardwareInfo.device_type) {
        infoText += `Device Type: ${hardwareInfo.device_type}\n`;
    }
    
    if (hardwareInfo.firmware_version) {
        infoText += `Firmware Version: ${hardwareInfo.firmware_version}\n`;
    }
    
    if (hardwareInfo.device_id) {
        infoText += `Device ID: ${hardwareInfo.device_id}\n`;
    }
    
    if (hardwareInfo.hardware_info) {
        if (hardwareInfo.hardware_info.manufacturer) {
            infoText += `Manufacturer: ${hardwareInfo.hardware_info.manufacturer}\n`;
        }
        if (hardwareInfo.hardware_info.model) {
            infoText += `Model: ${hardwareInfo.hardware_info.model}\n`;
        }
        if (hardwareInfo.hardware_info.serial_number) {
            infoText += `Serial Number: ${hardwareInfo.hardware_info.serial_number}\n`;
        }
    }
    
    if (hardwareInfo.timestamp) {
        const date = new Date(hardwareInfo.timestamp);
        infoText += `Last Updated: ${date.toLocaleString()}\n`;
    }
    
    debugLog(infoText, 'success');
}

async function clearHardware() {
    // Check if directory is selected, if not do nothing
    if (!outputDirectoryHandle || !('showDirectoryPicker' in window)) {
        debugLog('No output directory selected - hardware clear cancelled', 'errors');
        return;
    }
    
    const emptyHex = ""; // Zero bytes - empty hex file
    
    // List of hex files to create for FV-1: 0.hex through 7.hex
    const hexFiles = [];
    
    // Add 0-7 for FV-1 (8 program slots)
    for (let i = 0; i <= 7; i++) {
        hexFiles.push(`${i}.hex`);
    }

    // add in all.hex
    hexFiles.push('all.hex');
    
    try {
        let successCount = 0;
        let errorCount = 0;
        let skippedCount = 0;
        
        // Check each file and only create empty versions if non-zero size files exist
        for (const filename of hexFiles) {
            try {
                // Check if file exists and get its size
                let shouldClear = false;
                try {
                    const existingFileHandle = await outputDirectoryHandle.getFileHandle(filename);
                    const existingFile = await existingFileHandle.getFile();
                    
                    // Only clear if file exists and has non-zero size
                    if (existingFile.size > 0) {
                        shouldClear = true;
                    }
                } catch (err) {
                    // File doesn't exist, skip it
                    skippedCount++;
                    continue;
                }
                
                if (shouldClear) {
                    const fileHandle = await outputDirectoryHandle.getFileHandle(filename, {
                        create: true
                    });
                    const writable = await fileHandle.createWritable();
                    await writable.write(emptyHex);
                    await writable.close();
                    successCount++;
                } else {
                    skippedCount++;
                }
                
            } catch (err) {
                debugLog(`Error processing ${filename}: ${err.message}`, 'errors');
                errorCount++;
            }
        }
        
        // Clear messages area
        document.getElementById('messages').innerHTML = '';
        
        // Report results
        if (errorCount === 0 && successCount > 0) {
            debugLog(`Successfully cleared ${successCount} hex files (${skippedCount} skipped) - hardware cleared`, 'success');
        } else if (successCount > 0) {
            debugLog(`Cleared ${successCount} hex files with ${errorCount} errors (${skippedCount} skipped) - hardware partially cleared`, 'success');
        } else if (skippedCount > 0) {
            debugLog(`No files needed clearing - ${skippedCount} files were empty or non-existent`, 'errors');
        } else {
            debugLog('No hex files found to clear', 'errors');
        }
        
    } catch (err) {
        debugLog('Error during hardware clear: ' + err.message, 'errors');
    }
}

async function serialConnect() {
    console.log('Serial connect initiated');
    try {
        const port = await navigator.serial.requestPort();
        await port.open({ baudRate: 115200 });
        debugLog("Serial port connected", "serial");
        
        
        // Update the display - simplified
        const portDisplay = document.getElementById('serialPortDisplay');
        portDisplay.textContent = 'Connected';
        portDisplay.style.color = '#28a745'; // Green color for connected
        updateHardwareConnectionStatus(); // fire this to catch the change
        
        const decoder = new TextDecoderStream();
        port.readable.pipeTo(decoder.writable);
        const reader = decoder.readable.getReader();
        
        // Buffer to accumulate partial lines
        let buffer = '';
        
        while (true) {
            const { value, done } = await reader.read();
            if (done) {
                debugLog("Serial reader closed", "serial");
                // Update display when disconnected
                portDisplay.textContent = 'Disconnected';
                portDisplay.style.color = '#dc3545'; // Red color for disconnected
                updateHardwareConnectionStatus(); // fire this to catch the change
                // Process any remaining data in buffer
                if (buffer.trim()) {
                    debugLog(buffer.trim(), "serial");
                }
                break;
            }
            
            if (value) {
                // Add new data to buffer
                buffer += value;
                
                // Process complete lines
                const lines = buffer.split('\n');
                
                // Keep the last incomplete line in the buffer
                buffer = lines.pop() || '';
                
                // Process all complete lines
                lines.forEach(line => {
                    const trimmedLine = line.replace(/\r$/, '').trim(); // Remove \r and whitespace
                    if (trimmedLine) {
                        debugLog(trimmedLine, "serial");
                    }
                });
            }
        }
    } catch (err) {
        debugLog(`Error opening serial port: ${err.message}`, "serial");
        
        // Update display on error
        const portDisplay = document.getElementById('serialPortDisplay');
        portDisplay.textContent = `Error: ${err.message}`;
        portDisplay.style.color = '#dc3545'; // Red color for error
        updateHardwareConnectionStatus(); // fire this to catch the change
    }


}



function selectFilename(btn) {
    // Deselect all buttons
    document.querySelectorAll('.filename-btn').forEach(b => b.classList.remove('selected'));

    // Mark the clicked one as selected
    btn.classList.add('selected');

    // Store the selected filename
    selectedFilename = btn.dataset.filename;

    // Update the visible label
    document.getElementById('filenameLabel').textContent = btn.textContent;

    // Update button states
    updateDownloadButtonStates();
    
    // Update hardware connection status to show selected slot
    updateHardwareConnectionStatus();
}

function updateDownloadButtonStates() {
    const hasAssembly = assembledData !== null && document.getElementById('output').value.trim() !== '';
    const hasFilename = selectedFilename !== null;
    const hasDirectory = outputDirectoryHandle !== null;
    
    // Plain download buttons (always use system file picker or browser download)
    document.getElementById('downloadPlainHexBtn').disabled = !hasAssembly;
    document.getElementById('downloadBinBtn').disabled = !hasAssembly;
    document.getElementById('downloadCHeaderBtn').disabled = !hasAssembly;
    
    // Hardware download button (requires directory AND filename AND assembly)
    document.getElementById('downloadHexBtn').disabled = !(hasDirectory && hasFilename && hasAssembly);
}

async function clearEditor() {
    if (hasEditorContent()) {
        const choice = await showThreeChoiceDialog(
            'Unsaved Changes',
            'You have unsaved changes in the editor. What would you like to do before clearing?'
        );

        if (choice === 'cancel') {
            return; // User cancelled
        } else if (choice === 'save') {
            const saveResult = await saveSource();
            if (saveResult === false) {
                return; // User cancelled the save dialog
            }
        }
        // If choice === 'discard', just proceed with clearing
    }

    if (window.resetEditorToPlaceholder) {
        window.resetEditorToPlaceholder();
    } else if (editor) {
        editor.setValue('');
    }
    
    // Clear assembly output and reset button states
    document.getElementById('output').value = '';
    document.getElementById('messages').innerHTML = '';
    assembledData = null;
    updateDownloadButtonStates();
}

function assemble() {
    const source = editor.getValue();
    const clamp = document.getElementById('clampOption').checked;
    const spinReals = document.getElementById('spinRealsOption').checked;

    if (!source.trim()) {
        debugLog('Please enter some assembly code', 'errors');
        return;
    }

    const assembler = new FV1Assembler(source, {
        clamp,
        spinReals
    });
    const success = assembler.parse();

    if (success) {
        assembler.generateMachineCode();
        assembler.printCodeListing(); // Add this line - only print listing after successful assembly
        assembledData = assembler.program;

        const hex = assembler.toIntelHex();
        document.getElementById('output').value = hex;

        // Get assembly statistics
        const stats = assembler.getAssemblyStats();

        // Update button states
        updateDownloadButtonStates();
        
        if (assembler.warnings.length === 0 && assembler.errors.length === 0) {
            debugLog('Assembly successful!', 'success');
        }

        // Add assembly statistics
        debugLog(`Instructions: ${stats.nonNopInstructions} (${stats.totalInstructions} total including padding) | Checksum: 0x${stats.checksum.toString(16).toUpperCase().padStart(4, '0')}`, 'success');
    } else {
        document.getElementById('output').value = '';
        assembledData = null;
        updateDownloadButtonStates();
    }
}

function clearAssembly() {
    document.getElementById('output').value = '';
    document.getElementById('messages').innerHTML = '';
    assembledData = null;
    updateDownloadButtonStates();
    debugLog('Assembly output cleared', 'success');
}

// Check if editor has content (this will be overridden by monaco.js)
function hasEditorContent() {
    if (window.hasEditorContent) {
        return window.hasEditorContent();
    }
    return editor && editor.getValue().trim().length > 0;
}


// User prompt functions
let modalResolve = null;

function showConfirmDialog(title, message) {
    return new Promise((resolve) => {
        document.getElementById('confirmTitle').textContent = title;
        document.getElementById('confirmMessage').textContent = message;
        document.getElementById('confirmModal').style.display = 'block';

        // Store the resolve function for this specific dialog
        const currentResolve = resolve;

        document.getElementById('confirmOkBtn').onclick = () => {
            closeModal('confirmModal');
            currentResolve(true);
        };

        // Override the modal resolve for cancel
        modalResolve = () => currentResolve(false);
    });
}

function showThreeChoiceDialog(title, message) {
    return new Promise((resolve) => {
        document.getElementById('threeChoiceTitle').textContent = title;
        document.getElementById('threeChoiceMessage').textContent = message;
        document.getElementById('threeChoiceModal').style.display = 'block';

        // Store the resolve function for this specific dialog
        const currentResolve = resolve;

        document.getElementById('threeChoiceCancelBtn').onclick = () => {
            closeModal('threeChoiceModal');
            currentResolve('cancel');
        };

        document.getElementById('threeChoiceDiscardBtn').onclick = () => {
            closeModal('threeChoiceModal');
            currentResolve('discard');
        };

        document.getElementById('threeChoiceSaveBtn').onclick = () => {
            closeModal('threeChoiceModal');
            currentResolve('save');
        };

        // Override the modal resolve for clicking outside
        modalResolve = () => currentResolve('cancel');
    });
}

function showInputDialog(title, label, placeholder = '', defaultValue = '') {
    return new Promise((resolve) => {
        document.getElementById('inputTitle').textContent = title;
        document.getElementById('inputLabel').textContent = label;
        const input = document.getElementById('modalInput');
        input.placeholder = placeholder;
        input.value = defaultValue;
        document.getElementById('inputModal').style.display = 'block';

        // Store the resolve function for this specific dialog
        const currentResolve = resolve;

        // Focus the input
        setTimeout(() => input.focus(), 100);

        document.getElementById('inputOkBtn').onclick = () => {
            const value = input.value.trim();
            closeModal('inputModal');
            currentResolve(value || null);
        };

        // Handle Enter key
        input.onkeydown = (e) => {
            if (e.key === 'Enter') {
                document.getElementById('inputOkBtn').click();
            }
        };

        // Override the modal resolve for cancel
        modalResolve = () => currentResolve(null);
    });
}

function closeModal(modalId) {
    document.getElementById(modalId).style.display = 'none';
    // Don't automatically resolve here - let the specific handlers do it
}

function toggleEditorHeight() {
    if (editor) {
        const editorContainer = editor.getDomNode().parentElement;
        if (editorContainer) {
            editorContainer.style.height = document.getElementById('editorHeightToggle').checked ?
                '800px' :
                '400px';
            editor.layout();
        }
    }
}

function toggleDebugPreset() {
    const debugEnabled = document.getElementById('debugToggle').checked;
    
    if (debugEnabled) {
        DEBUG.setPreset('basic');
        debugLog('Debug mode enabled - showing full build results', 'info');
    } else {
        // DEBUG.setPreset('clean');
        DEBUG.reset();
        debugLog('Debug mode disabled - showing minimal output', 'info');
    }
}

function toggleMinimap() {
    const showMinimap = document.getElementById('minimapToggle')?.checked || false;
    if (editor) {
        editor.updateOptions({
            minimap: {
                enabled: showMinimap
            }
        });
    }
}

function showMessage(msg, type) {
    const className = type === 'error' ? 'errors' : 'success';
    debugLog(msg, className);
}

async function downloadHex() {
    const hex = document.getElementById('output').value;

    if (!selectedFilename) {
        debugLog('Please select a filename first.', 'errors');
        return;
    }

    if (!outputDirectoryHandle) {
        debugLog('Please select an output directory first.', 'errors');
        return;
    }

    const filename = selectedFilename;

    try {
        const fileHandle = await outputDirectoryHandle.getFileHandle(filename, {
            create: true
        });
        const writable = await fileHandle.createWritable();
        await writable.write(hex);
        await writable.close();
        debugLog(`File saved as ${filename} to hardware directory`, 'success');
    } catch (err) {
        debugLog('Error saving to hardware directory: ' + err.message, 'errors');
    }
}

async function downloadHexToHardware() {
    const hex = document.getElementById('output').value;

    if (!selectedFilename) {
        debugLog('Please select a filename first.', 'errors');
        return;
    }

    if (!outputDirectoryHandle) {
        debugLog('Please select an output directory first.', 'errors');
        return;
    }

    const filename = selectedFilename;

    try {
        const fileHandle = await outputDirectoryHandle.getFileHandle(filename, {
            create: true
        });
        const writable = await fileHandle.createWritable();
        await writable.write(hex);
        await writable.close();
        debugLog(`File saved as ${filename} to hardware directory`, 'success');
    } catch (err) {
        debugLog('Error saving to hardware directory: ' + err.message, 'errors');
    }
}

async function downloadPlainHex() {
    const hex = document.getElementById('output').value;
    if (!hex) {
        await showConfirmDialog('Download Plain HEX', 'There is no hex output to save.');
        return false;
    }
    
    // Get current filename and determine default (like saveSource)
    let defaultFilename = 'fv1_program.hex'; // fallback default
    
    if (window.getCurrentFilename) {
        const currentName = window.getCurrentFilename();
        if (currentName) {
            // Replace extension with .hex
            defaultFilename = currentName.replace(/\.[^/.]+$/, '') + '.hex';
        }
    }
    
    const result = await downloadWithPicker(hex, defaultFilename, 'text/plain', 'Intel HEX files');
    
    if (result && result.success) {
        debugLog(`Plain HEX file saved as: ${result.filename}`, 'success');
        return true;
    }
    
    return false; // Save was cancelled or failed
}

async function downloadBinary() {
    if (!assembledData) {
        await showConfirmDialog('Download Binary', 'There is no assembled data to save.');
        return false;
    }
    
    // Get current filename and determine default (like saveSource)
    let defaultFilename = 'fv1_program.bin'; // fallback default
    
    if (window.getCurrentFilename) {
        const currentName = window.getCurrentFilename();
        if (currentName) {
            // Replace extension with .bin
            defaultFilename = currentName.replace(/\.[^/.]+$/, '') + '.bin';
        }
    }
    
    const binaryData = assembledData.slice(0, 512);
    
    const result = await downloadWithPicker(binaryData, defaultFilename, 'application/octet-stream', 'Binary files');
    
    if (result && result.success) {
        debugLog(`Binary file saved as: ${result.filename}`, 'success');
        return true;
    }
    
    return false; // Save was cancelled or failed
}

async function downloadCHeader() {
    if (!assembledData) {
        await showConfirmDialog('Download C Header', 'There is no assembled data to save.');
        return false;
    }
    
    // Get current filename and determine default (like saveSource)
    let defaultFilename = 'fv1_program.h'; // fallback default
    
    if (window.getCurrentFilename) {
        const currentName = window.getCurrentFilename();
        if (currentName) {
            // Replace extension with .h
            defaultFilename = currentName.replace(/\.[^/.]+$/, '') + '.h';
        }
    }
    
    const assembler = new FV1Assembler('', {}); // Create instance just for the toCHeader method
    assembler.program = assembledData; // Set the assembled data
    
    const arrayName = defaultFilename.replace(/\.[^/.]+$/, "").toUpperCase() + '_DATA';
    const cHeader = assembler.toCHeader(arrayName);
    
    const result = await downloadWithPicker(cHeader, defaultFilename, 'text/plain', 'C Header files');
    
    if (result && result.success) {
        debugLog(`C Header file saved as: ${result.filename}`, 'success');
        return true;
    }
    
    return false; // Save was cancelled or failed
}

// Modified downloadWithPicker function - returns filename when possible
async function downloadWithPicker(content, defaultFilename, mimeType, description) {
    // Try to use File System Access API first
    if ('showSaveFilePicker' in window) {
        try {
            const options = {
                suggestedName: defaultFilename,
                types: [{
                    description: description,
                    accept: {
                        [mimeType]: [defaultFilename.substring(defaultFilename.lastIndexOf('.'))]
                    }
                }]
            };
            
            // Use project directory if available, otherwise use default preference
            if (projectDirectoryHandle) {
                options.startIn = projectDirectoryHandle;
                debugLog(`Using project directory: ${projectDirectoryHandle.name}`, 'verbose');
            } else {
                options.startIn = preferredStartDirectory;
                debugLog(`Using default start directory: ${preferredStartDirectory}`, 'verbose');
            }
            
            const fileHandle = await window.showSaveFilePicker(options);
            
            const writable = await fileHandle.createWritable();
            if (content instanceof Uint8Array) {
                await writable.write(content);
            } else {
                await writable.write(content);
            }
            await writable.close();
            
            debugLog(`File saved: ${fileHandle.name}`, 'success');
            
            // Return an object with success status and filename
            return {
                success: true,
                filename: fileHandle.name,
                fileHandle: fileHandle
            };
            
        } catch (err) {
            if (err.name === 'AbortError') {
                return { success: false, cancelled: true }; // User cancelled
            } else {
                debugLog('Error saving with file picker: ' + err.message, 'errors');
                // Fall back to blob download
            }
        }
    }
    
    // Fallback for browsers that don't support File System Access API
    const browserSupported = await showConfirmDialog(
        'Download File', 
        'Your browser doesn\'t support the advanced file picker. The file will be downloaded to your default downloads folder. Continue?'
    );
    
    if (!browserSupported) return { success: false, cancelled: true };
    
    // Create blob and download
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = defaultFilename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    
    debugLog(`File downloaded as ${defaultFilename} to default downloads folder`, 'success');
    
    // Return success with the default filename (since we can't know what the browser actually saved it as)
    return {
        success: true,
        filename: defaultFilename,
        fallback: true
    };
}

function toggleOutput() {
    const content = document.getElementById('outputContent');
    const toggle = document.getElementById('outputToggle');

    content.classList.toggle('collapsed');

    if (content.classList.contains('collapsed')) {
        toggle.textContent = '▶';
    } else {
        toggle.textContent = '▼';
    }
}

// Toggle instructions function
function toggleInstructions() {
    const instructionsContent = document.getElementById('instructionsContent');
    const instructionsToggle = document.getElementById('instructionsToggle');

    if (instructionsContent.classList.contains('collapsed')) {
        instructionsContent.classList.remove('collapsed');
        instructionsToggle.textContent = '▼';
    } else {
        instructionsContent.classList.add('collapsed');
        instructionsToggle.textContent = '▶';
    }
}

async function loadExample(exampleName) {
    // Check for unsaved changes first
    if (window.hasUnsavedChanges && window.hasUnsavedChanges()) {
        const choice = await showThreeChoiceDialog(
            'Unsaved Changes',
            'You have unsaved changes in the editor. What would you like to do before loading an example?'
        );


        if (choice === 'cancel') {
            return; // User cancelled
        } else if (choice === 'save') {
            const saveResult = await saveSource();
            if (saveResult === false) {
                return; // User cancelled the save dialog
            }
        }
        // If choice === 'discard', proceed with loading
    }

    if (exampleName && examples[exampleName]) {
        if (window.setEditorContent) {
            // Mark as example with descriptive filename
            const exampleFilename = `example_${exampleName}.spn`;
            window.setEditorContent(examples[exampleName], exampleFilename, '');
        } else {
            editor.updateOptions({ readOnly: false }); // Fallback
            editor.setValue(examples[exampleName]);
        }
        editor.setScrollTop(0);
        editor.setScrollLeft(0);
        document.getElementById('output').value = '';
        document.getElementById('messages').innerHTML = '';
        assembledData = null;
        updateDownloadButtonStates();
        debugLog('Example loaded successfully', 'success');
    }
}

async function loadFile() {
    // Check for unsaved changes FIRST, before opening file picker
    if (window.hasUnsavedChanges && window.hasUnsavedChanges()) {
        const choice = await showThreeChoiceDialog(
            'Unsaved Changes',
            'You have unsaved changes in the editor. What would you like to do before loading a new file?'
        );
        if (choice === 'cancel') {
            return; // User cancelled - don't open file picker
        } else if (choice === 'save') {
            const saveResult = await saveSource();
            if (saveResult === false) {
                return; // User cancelled the save dialog - don't open file picker
            }
        }
        // If choice === 'discard', proceed with opening file picker
    }
    
    const fileInput = document.getElementById('fileInput');

    const options = {
        types: [{
            description: 'Assembly files',
            accept: {
                    'text/plain': ['.txt', '.asm', '.spn']
            }
        }]
    };
    
    // Use project directory if available, otherwise use default preference
    if (projectDirectoryHandle) {
        options.startIn = projectDirectoryHandle;
        debugLog(`Using project directory: ${projectDirectoryHandle.name}`, 'verbose');
    } else {
        options.startIn = preferredStartDirectory;
        debugLog(`Using default start directory: ${preferredStartDirectory}`, 'verbose');
    }
    
    // Try File System Access API first if project directory is available
    try {
        const [fileHandle] = await window.showOpenFilePicker(options);
        const file = await fileHandle.getFile();
        const fileContent = await file.text();
        
        // Process the file content directly (don't simulate file input)
        processFileContent(fileContent, file.name);
        
        debugLog('File loaded via File System Access API: ' + file.name, 'success');
        return;
    } catch (error) {
        if (error.name === 'AbortError') {
            return; // User cancelled
        }
        console.warn('File System Access failed, falling back to input:', error);
    }
    
    // Fallback to traditional file input
    fileInput.value = ''; // Clear any previous selection
    fileInput.click(); // This will trigger handleFileInputChange when user selects a file
}

// Extract the file processing logic into a separate function
function processFileContent(content, fileName) {
    // Update editor content
    if (editor && window.setEditorContent) {
        window.setEditorContent(content, fileName, 'Browser Upload');
    } else {
        editor.updateOptions({ readOnly: false });
        editor.setValue(content);
    }
    
    // Scroll to the top of the editor
    editor.setScrollTop(0);
    editor.setScrollLeft(0);
    
    // Clear assembly output and disable download button
    const outputElement = document.getElementById('output');
    if (outputElement) {
        outputElement.value = '';
    }
    document.getElementById('messages').innerHTML = '';
    assembledData = null;
    
    // Update all button states
    if (typeof updateBuildResultsButtons !== 'undefined') {
        updateBuildResultsButtons();
    }
    if (typeof updatePlainHexButton !== 'undefined') {
        updatePlainHexButton();
    }
    if (typeof updateDownloadButtonStates !== 'undefined') {
        updateDownloadButtonStates();
    }
    
    // // Clear C header data
    // if (typeof FXCoreAssembler !== 'undefined') {
    //     FXCoreAssembler.assembledCHeader = null;
    // }
    window.assembledCHeader = null;
}

// Update handleFileInputChange to use the shared processing function
async function handleFileInputChange() {
    const fileInput = document.getElementById('fileInput');
    const file = fileInput.files[0];
    
    if (!file) return;
    
    const reader = new FileReader();
    reader.onload = function(e) {
        processFileContent(e.target.result, file.name);
        debugLog('File loaded via traditional input: ' + file.name, 'success');
    };
    reader.readAsText(file);
}

async function saveSource() {
    if (!editor) return false;
    
    if (!hasEditorContent()) {
        await showConfirmDialog('Save Source', 'There is no content to save.');
        return false;
    }
    
    // Get current filename and determine default
    let defaultFilename = 'fv1_source.spn'; // fallback default
    
    if (window.getCurrentFilename) {
        const currentName = window.getCurrentFilename();
        if (currentName) {
            // Use the current filename if we have one
            defaultFilename = currentName;
        }
    }
    
    const sourceCode = editor.getValue();
    const result = await downloadWithPicker(sourceCode, defaultFilename, 'text/plain', 'Source code files');
    
    // Handle the new return format
    if (result && result.success) {
        // Update the current filename to the actual saved name
        if (window.setCurrentFile) {
            window.setCurrentFile(result.filename, '');
        }
        
        // Mark content as saved
        if (window.updateOriginalContent) {
            window.updateOriginalContent();
        }
        
        return true;
    }
    
    return false; // Save was cancelled or failed
}

// Close modal when clicking outside and add beforeunload handler
window.onclick = function(event) {
    if (event.target.classList.contains('modal')) {
        if (modalResolve) {
            modalResolve();
        }
        closeModal(event.target.id);
    }
};

// Prompt to save before leaving page
window.addEventListener('beforeunload', function(e) {
    if (hasEditorContent()) {
        e.preventDefault();
        e.returnValue = 'You have unsaved changes. Are you sure you want to leave?';
        return e.returnValue;
    }
});

// // Initialize UI when DOM is loaded
// document.addEventListener('DOMContentLoaded', function() {
//     // Initialize debug system
//     DEBUG.reset();
    
//     // Add event listener for file input change
//     // document.getElementById('fileInput').addEventListener('change', loadFile);

//     // Add hidden checkboxes that the assembler expects
//     const hiddenCheckboxes = document.createElement('div');
//     hiddenCheckboxes.style.display = 'none';
//     hiddenCheckboxes.innerHTML = `
//         <input type="checkbox" id="clampOption">
//         <input type="checkbox" id="spinRealsOption">
//     `;
//     document.body.appendChild(hiddenCheckboxes);

//     // Select "3.hex" by default
//     const defaultButton = document.querySelector('.filename-btn[data-filename="3.hex"]');
//     if (defaultButton) {
//         selectFilename(defaultButton);
//     }
    
//     updateHardwareConnectionStatus();
//     updateDownloadButtonStates();
// });