// UI Functions
let assembledData = null;
let outputDirectoryHandle = null;

async function selectOutputDirectory() {
    try {
        if ('showDirectoryPicker' in window) {
            outputDirectoryHandle = await window.showDirectoryPicker();
            document.getElementById('outputDirDisplay').textContent = `Selected: ${outputDirectoryHandle.name}`;
            
            showMessage('Output directory selected successfully', 'success');
            
            // Try to find and read the hardware identifier JSON file
            // Make sure we have the handle before calling this
            if (outputDirectoryHandle) {
                await readHardwareIdentifier();
            }
        } else {
            showMessage('Directory selection not supported in this browser', 'error');
        }
    } catch (err) {
        if (err.name !== 'AbortError') {
            showMessage('Error selecting directory: ' + err.message, 'error');
        }
    }
}

async function readHardwareIdentifier() {
    if (!outputDirectoryHandle) {
        const messages = document.getElementById('messages');
        const existingContent = messages.innerHTML;
        const errorDiv = '<div class="error">No output directory selected</div>';
        messages.innerHTML = existingContent + errorDiv;
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
                const messages = document.getElementById('messages');
                const errorDiv = '<div class="error">Hardware device not found, reverting to default directory</div>';
                messages.innerHTML = errorDiv;
                return;
            }
        } else {
            // No hardware identifier found - revert to default downloads
            revertToDefaultDirectory();
            const messages = document.getElementById('messages');
            const errorDiv = '<div class="error">Hardware device not found, reverting to default directory</div>';
            messages.innerHTML = errorDiv;
            return;
        }
        
    } catch (err) {
        // Error reading hardware identifier - revert to default downloads
        revertToDefaultDirectory();
        const messages = document.getElementById('messages');
        const errorDiv = `<div class="error">Hardware device not found, reverting to default directory</div>`;
        messages.innerHTML = errorDiv;
    }
}

function revertToDefaultDirectory() {
    // Clear the output directory handle to revert to normal browser downloads
    outputDirectoryHandle = null;
    
    // Update the UI to show no directory selected
    document.getElementById('outputDirDisplay').textContent = 'No directory selected, using default directory';
    
    // Disable the download buttons since we need a filename selected
    document.getElementById('downloadHexBtn').disabled = true;
    document.getElementById('downloadBinBtn').disabled = true;
}

function displayHardwareInfo(hardwareInfo, filename) {
    const messages = document.getElementById('messages');
    const existingContent = messages.innerHTML;
    
    let infoHtml = '<div class="success hardware-info">';
    infoHtml += `<strong>Hardware Identifier Found (${filename}):</strong><br>`;
    
    if (hardwareInfo.device_type) {
        infoHtml += `Device Type: <strong>${hardwareInfo.device_type}</strong><br>`;
    }
    
    if (hardwareInfo.firmware_version) {
        infoHtml += `Firmware Version: <strong>${hardwareInfo.firmware_version}</strong><br>`;
    }
    
    if (hardwareInfo.device_id) {
        infoHtml += `Device ID: <strong>${hardwareInfo.device_id}</strong><br>`;
    }
    
    if (hardwareInfo.hardware_info) {
        if (hardwareInfo.hardware_info.manufacturer) {
            infoHtml += `Manufacturer: <strong>${hardwareInfo.hardware_info.manufacturer}</strong><br>`;
        }
        if (hardwareInfo.hardware_info.model) {
            infoHtml += `Model: <strong>${hardwareInfo.hardware_info.model}</strong><br>`;
        }
        if (hardwareInfo.hardware_info.serial_number) {
            infoHtml += `Serial Number: <strong>${hardwareInfo.hardware_info.serial_number}</strong><br>`;
        }
    }
    
    if (hardwareInfo.timestamp) {
        const date = new Date(hardwareInfo.timestamp);
        infoHtml += `Last Updated: <strong>${date.toLocaleString()}</strong><br>`;
    }
    
    infoHtml += '</div>';
    
    messages.innerHTML = existingContent + infoHtml;
}

let selectedFilename = null;

function selectFilename(btn) {
    // Deselect all buttons
    document.querySelectorAll('.filename-btn').forEach(b => b.classList.remove('selected'));

    // Mark the clicked one as selected
    btn.classList.add('selected');

    // Store the selected filename
    selectedFilename = btn.dataset.filename;

    // Update the visible label
    document.getElementById('filenameLabel').textContent = btn.textContent;

    // Enable download buttons if we have assembled data (regardless of directory selection)
    const hasAssembly = assembledData !== null && document.getElementById('output').value.trim() !== '';
    document.getElementById('downloadHexBtn').disabled = !hasAssembly;
    document.getElementById('downloadBinBtn').disabled = !hasAssembly;
}

// New function to clear editor content with three-choice prompt
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

    if (editor) {
        editor.setValue('');
    }
    
    // Clear assembly output and disable download buttons
    document.getElementById('output').value = '';
    document.getElementById('messages').innerHTML = '';
    document.getElementById('downloadHexBtn').disabled = true;
    document.getElementById('downloadBinBtn').disabled = true;
    assembledData = null;
}

function clearSource() {
    document.getElementById('sourceCode').value = '';
    // updateLineNumbers();
    
    // Clear assembly output and disable download buttons
    document.getElementById('output').value = '';
    document.getElementById('messages').innerHTML = '';
    document.getElementById('downloadHexBtn').disabled = true;
    document.getElementById('downloadBinBtn').disabled = true;
    assembledData = null;
    
    showMessage('Source code cleared', 'success');
}

function assemble() {
    // const source = document.getElementById('sourceCode').value;
    const source = editor.getValue();
    const clamp = document.getElementById('clampOption').checked;
    const spinReals = document.getElementById('spinRealsOption').checked;

    if (!source.trim()) {
        showMessage('Please enter some assembly code', 'error');
        return;
    }

    const assembler = new FV1Assembler(source, {
        clamp,
        spinReals
    });
    const success = assembler.parse();

    // Display messages
    let messages = '';
    if (assembler.warnings.length > 0) {
        messages += '<div class="warning">Warnings:<br>' + assembler.warnings.join('<br>') + '</div>';
    }
    if (assembler.errors.length > 0) {
        messages += '<div class="error">Errors:<br>' + assembler.errors.join('<br>') + '</div>';
    }

    if (success) {
        assembler.generateMachineCode();
        assembledData = assembler.program;

        const hex = assembler.toIntelHex();
        document.getElementById('output').value = hex;

        // Get assembly statistics
        const stats = assembler.getAssemblyStats();

        // Enable download buttons if we have assembled data and a filename is selected
        const hasFilename = selectedFilename !== null;
        const hasAssembly = assembledData !== null && hex.trim() !== '';
        document.getElementById('downloadHexBtn').disabled = !(hasFilename && hasAssembly);
        document.getElementById('downloadBinBtn').disabled = !(hasFilename && hasAssembly);

        if (messages === '') {
            messages = '<div class="success">Assembly successful!</div>';
        }

        // Add assembly statistics
        messages += `<div class="info">Instructions: ${stats.nonNopInstructions} (${stats.totalInstructions} total including padding) | Checksum: 0x${stats.checksum.toString(16).toUpperCase().padStart(4, '0')}</div>`;
    } else {
        document.getElementById('output').value = '';
        document.getElementById('downloadHexBtn').disabled = true;
        document.getElementById('downloadBinBtn').disabled = true;
        assembledData = null;
    }

    document.getElementById('messages').innerHTML = messages;
}

function clearAssembly() {
    document.getElementById('output').value = '';
    document.getElementById('messages').innerHTML = '';
    document.getElementById('downloadHexBtn').disabled = true;
    document.getElementById('downloadBinBtn').disabled = true;
    assembledData = null;
    showMessage('Assembly output cleared', 'success');
}

// Check if editor has content
function hasEditorContent() {
    return editor && editor.getValue().trim().length > 0;
}

// Handle file load button click with confirmation
async function handleFileLoad() {
    if (hasEditorContent()) {
        const choice = await showThreeChoiceDialog(
            'Unsaved Changes',
            'You have unsaved changes in the editor. What would you like to do before loading a new file?'
        );

        if (choice === 'cancel') {
            return; // User cancelled
        } else if (choice === 'save') {
            const saveResult = await saveSource();
            if (saveResult === false) {
                return; // User cancelled the save dialog
            }
        }
        // If choice === 'discard', proceed with file selection
    }

    // Trigger file selection
    document.getElementById('fileInput').click();
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

function toggleDarkMode() {
    const darkModeEnabled = document.getElementById('darkModeToggle').checked;

    // Toggle Monaco editor theme
    if (editor) {
        const theme = darkModeEnabled ? 'spinDark' : 'spinTheme';
        monaco.editor.setTheme(theme);
    }

    // Toggle body class for page theme
    document.body.classList.toggle('dark-mode', darkModeEnabled);
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

function showMessage(msg, type) {
    const className = type === 'error' ? 'error' : 'success';
    document.getElementById('messages').innerHTML = `<div class="${className}">${msg}</div>`;
}

async function downloadHex() {
    const hex = document.getElementById('output').value;

    if (!selectedFilename) {
        showMessage('Please select a filename first.', 'error');
        return;
    }

    const filename = selectedFilename;

    if (outputDirectoryHandle && 'showDirectoryPicker' in window) {
        try {
            const fileHandle = await outputDirectoryHandle.getFileHandle(filename, {
                create: true
            });
            const writable = await fileHandle.createWritable();
            await writable.write(hex);
            await writable.close();
            showMessage(`File saved as ${filename} in selected directory`, 'success');
        } catch (err) {
            showMessage('Error saving to directory: ' + err.message, 'error');
            // Fallback to regular download
            downloadFile(filename, hex, 'text/plain');
        }
    } else {
        // No directory selected, use normal browser download
        downloadFile(filename, hex, 'text/plain');
        showMessage(`File downloaded as ${filename} to default downloads folder`, 'success');
    }
}


function downloadBinary() {
    if (!assembledData) return;

    const filename = document.getElementById('filenameSelect').value.replace('.hex', '.bin');
    const blob = new Blob([assembledData.slice(0, 512)], {
        type: 'application/octet-stream'
    });

    if (outputDirectoryHandle && 'showDirectoryPicker' in window) {
        // For binary files, we'll use the regular download since File System Access API
        // is more complex with binary data
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.click();
        URL.revokeObjectURL(url);
    } else {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.click();
        URL.revokeObjectURL(url);
    }
}

function downloadFile(filename, content, mimeType) {
    const blob = new Blob([content], {
        type: mimeType
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
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
    if (hasEditorContent()) {
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
        editor.setValue(examples[exampleName]);
        editor.setScrollTop(0);
        editor.setScrollLeft(0);
        document.getElementById('output').value = '';
        document.getElementById('messages').innerHTML = '';
        document.getElementById('downloadHexBtn').disabled = true;
        document.getElementById('downloadBinBtn').disabled = true;
        assembledData = null;
        showMessage('Example loaded successfully', 'success');
    }
}

async function loadFile() {
    const fileInput = document.getElementById('fileInput');
    const file = fileInput.files[0];

    if (!file) return;

    const reader = new FileReader();
    reader.onload = function(e) {
        editor.setValue(e.target.result);
        editor.setScrollTop(0);
        editor.setScrollLeft(0);
        document.getElementById('output').value = '';
        document.getElementById('messages').innerHTML = '';
        document.getElementById('downloadHexBtn').disabled = true;
        document.getElementById('downloadBinBtn').disabled = true;
        assembledData = null;
        showMessage('File loaded successfully', 'success');
        document.getElementById('exampleSelect').value = '';
    };
    reader.onerror = function() {
        showMessage('Error reading file', 'error');
    };
    reader.readAsText(file);
}

async function saveSource() {
    if (!editor) return false;

    if (!hasEditorContent()) {
        await showConfirmDialog('Save Source', 'There is no content to save.');
        return false;
    }

    const filename = await showInputDialog(
        'Save Source Code',
        'Enter filename:',
        'Enter filename (e.g., my_program.spn)',
        'fv1_source.spn'
    );

    if (!filename) return false; // User cancelled

    const sourceCode = editor.getValue();
    const blob = new Blob([sourceCode], {
        type: 'text/plain'
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    return true; // Save completed successfully
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

// Add this function to detect and apply system dark mode preference
function applySystemDarkMode() {
    const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    const darkModeToggle = document.getElementById('darkModeToggle');

    if (darkModeToggle && editor) {
        darkModeToggle.checked = prefersDark;
        const theme = prefersDark ? 'spinDark' : 'spinTheme';
        monaco.editor.setTheme(theme);
    }
}

// Add listener for system dark mode changes
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
    const darkModeToggle = document.getElementById('darkModeToggle');
    if (darkModeToggle && editor) {
        darkModeToggle.checked = e.matches;
        const theme = e.matches ? 'spinDark' : 'spinTheme';
        monaco.editor.setTheme(theme);
        document.body.classList.toggle('dark-mode', e.matches);
    }
});

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

// Initialize hidden checkboxes and file input handler
document.addEventListener('DOMContentLoaded', function() {
    // Add event listener for file input change
    document.getElementById('fileInput').addEventListener('change', loadFile);

    // Add hidden checkboxes that the assembler expects
    const hiddenCheckboxes = document.createElement('div');
    hiddenCheckboxes.style.display = 'none';
    hiddenCheckboxes.innerHTML = `
        <input type="checkbox" id="clampOption">
        <input type="checkbox" id="spinRealsOption">
    `;
    document.body.appendChild(hiddenCheckboxes);

        // Select "3.hex" by default
    const defaultButton = document.querySelector('.filename-btn[data-filename="3.hex"]');
    if (defaultButton) {
        selectFilename(defaultButton);
    }
});