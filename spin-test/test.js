const puppeteer = require('puppeteer');
const fs = require('fs').promises;
const path = require('path');

class FV1AssemblerTester {
    constructor() {
        this.browser = null;
        this.page = null;
        this.results = [];
    }

    async initialize() {
        this.browser = await puppeteer.launch({ 
            headless: false, // Set to true for headless mode
            defaultViewport: null,
            args: [
                '--no-sleep',
                '--disable-background-timer-throttling',
                '--disable-backgrounding-occluded-windows',
                '--disable-renderer-backgrounding'
            ]
        });
        this.page = await this.browser.newPage();
        
        // Prevent page from going idle
        await this.page.evaluateOnNewDocument(() => {
            // Keep page active
            setInterval(() => {
                console.log('Keeping page active...');
            }, 30000);
        });
        
        // Load local index.html from parent directory
        const localPath = path.resolve(__dirname, '../index.html');
        
        // Check if file exists
        try {
            await fs.access(localPath);
            console.log(`Loading local file: ${localPath}`);
        } catch (error) {
            throw new Error(`Cannot find index.html at ${localPath}. Please ensure the file exists.`);
        }
        
        const fileUrl = `file://${localPath}`;
        
        await this.page.goto(fileUrl, {
            waitUntil: 'networkidle0',
            timeout: 30000
        });
        
        // Wait for page to load
        await this.page.waitForSelector('textarea', { timeout: 15000 });
    }

    async reinitializePage() {
        try {
            console.log('Reinitializing page connection...');
            this.page = await this.browser.newPage();
            
            // Prevent page from going idle
            await this.page.evaluateOnNewDocument(() => {
                setInterval(() => {
                    console.log('Keeping page active...');
                }, 30000);
            });
            
            // Load local index.html from parent directory
            const localPath = path.resolve(__dirname, '../index.html');
            const fileUrl = `file://${localPath}`;
            
            await this.page.goto(fileUrl, {
                waitUntil: 'networkidle0',
                timeout: 30000
            });
            await this.page.waitForSelector('textarea', { timeout: 15000 });
        } catch (error) {
            console.error('Failed to reinitialize page:', error.message);
            throw error;
        }
    }

    async testProgram(programName, sourceCode) {
        let retryCount = 0;
        const maxRetries = 2;
        
        while (retryCount <= maxRetries) {
            try {
                console.log(`Testing program: ${programName}${retryCount > 0 ? ` (retry ${retryCount})` : ''}`);
                
                // Check if page is still attached, if not reinitialize
                try {
                    await this.page.evaluate(() => document.title);
                } catch (e) {
                    console.log('Page detached, reinitializing...');
                    await this.reinitializePage();
                }
                
                // Navigate to fresh page
                const localPath = path.resolve(__dirname, '../index.html');
                const fileUrl = `file://${localPath}`;
                
                await this.page.goto(fileUrl, { 
                    waitUntil: 'networkidle0',
                    timeout: 30000 
                });
                
                // Wait for textarea to be available
                await this.page.waitForSelector('textarea', { timeout: 15000 });
                
                // Clear any existing content
                try {
                    await this.page.click('button[onclick="clearAssembly()"]', { timeout: 5000 });
                } catch (e) {
                    console.log('Clear button not found or not clickable, continuing...');
                }
                
                await new Promise(resolve => setTimeout(resolve, 1000));
                
                // Find and clear the textarea, then input code
                const textarea = await this.page.$('textarea');
                if (!textarea) {
                    throw new Error('Textarea not found');
                }
                
                // Clear textarea completely
                await textarea.focus();
                await this.page.keyboard.down('Control');
                await this.page.keyboard.press('KeyA'); // Select all
                await this.page.keyboard.up('Control');
                await this.page.keyboard.press('Delete'); // Delete selected text
                
                // Wait a moment for clearing to complete
                await new Promise(resolve => setTimeout(resolve, 500));
                
                // Input the source code using evaluate to set value directly
                await this.page.evaluate((code) => {
                    const textarea = document.querySelector('textarea');
                    if (textarea) {
                        textarea.value = code;
                        // Trigger input event so the page knows content changed
                        textarea.dispatchEvent(new Event('input', { bubbles: true }));
                    }
                }, sourceCode);
                
                // Click assemble button
                await this.page.click('button[onclick="assemble()"]');
                
                // Wait for assembly to complete
                await new Promise(resolve => setTimeout(resolve, 4000));
                
                // Capture all text content from the page to look for errors
                const pageText = await this.page.evaluate(() => document.body.innerText);
                
                let hasErrors = false;
                let errorMessage = '';
                
                // Look for error indicators in the page text
                const errorPatterns = [
                    /error/i,
                    /syntax error/i,
                    /invalid/i,
                    /undefined/i,
                    /failed/i,
                    /exception/i,
                    /line \d+:/i,  // Line number errors
                    /expected/i,
                    /unexpected/i
                ];
                
                for (const pattern of errorPatterns) {
                    if (pattern.test(pageText)) {
                        hasErrors = true;
                        // Extract relevant error context
                        const lines = pageText.split('\n');
                        const errorLines = lines.filter(line => pattern.test(line));
                        errorMessage += errorLines.join(' | ') + ' ';
                        break;
                    }
                }
                
                // Check if HEX download button exists and is enabled (indicates successful assembly)
                let isHexButtonEnabled = false;
                try {
                    // Use xpath to find button containing "Download HEX" text
                    const hexButtons = await this.page.$x("//button[contains(text(), 'Download HEX')]");
                    if (hexButtons.length > 0) {
                        isHexButtonEnabled = await hexButtons[0].evaluate(el => !el.disabled && el.style.display !== 'none');
                    }
                } catch (e) {
                    console.log('Could not check HEX button status');
                }
                
                // Alternative check - look for successful assembly indicators in text
                const successIndicators = [
                    /assembly successful!/i,
                    /assembly complete/i,
                    /hex file/i,
                    /binary file/i,
                    /program size/i,
                    /:[\dA-F]+/i  // Hex output pattern like :0400000081400112A
                ];
                
                let hasSuccessIndicators = false;
                for (const pattern of successIndicators) {
                    if (pattern.test(pageText)) {
                        hasSuccessIndicators = true;
                        break;
                    }
                }
                
                // If no explicit errors found but no success indicators either, check for common issues
                if (!hasErrors && !hasSuccessIndicators && !isHexButtonEnabled) {
                    // Only flag as error if we don't see hex output or success message
                    if (!pageText.includes(':') || pageText.length < 100) {
                        hasErrors = true;
                        errorMessage = 'Assembly may have failed - no clear success or error output detected';
                    }
                }
                
                // Override error detection if we found clear success indicators
                if (hasSuccessIndicators) {
                    hasErrors = false;
                    errorMessage = '';
                }
                
                const result = {
                    programName: programName,
                    sourceCode: sourceCode.substring(0, 100) + (sourceCode.length > 100 ? '...' : ''),
                    hasErrors: hasErrors,
                    errorMessage: errorMessage.trim(),
                    assemblySuccessful: isHexButtonEnabled || hasSuccessIndicators,
                    rawOutput: pageText.substring(0, 500), // Store first 500 chars of output for debugging
                    timestamp: new Date().toISOString()
                };
                
                this.results.push(result);
                console.log(`Result: ${hasErrors ? 'ERROR' : 'SUCCESS'} - ${errorMessage || 'No errors detected'}`);
                
                return result;
                
            } catch (error) {
                retryCount++;
                console.error(`Error testing ${programName} (attempt ${retryCount}):`, error.message);
                
                if (retryCount > maxRetries) {
                    const result = {
                        programName: programName,
                        sourceCode: sourceCode.substring(0, 100) + (sourceCode.length > 100 ? '...' : ''),
                        hasErrors: true,
                        errorMessage: `Automation error after ${maxRetries} retries: ${error.message}`,
                        assemblySuccessful: false,
                        rawOutput: '',
                        timestamp: new Date().toISOString()
                    };
                    
                    this.results.push(result);
                    return result;
                }
                
                // Wait before retry
                await new Promise(resolve => setTimeout(resolve, 2000));
            }
        }
    }

    async testMultiplePrograms(programs) {
        for (const program of programs) {
            await this.testProgram(program.name, program.code);
            // Brief pause between tests - use compatible delay method
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
    }

    async saveResultsToCSV(filename = 'fv1_test_results.csv') {
        const csvHeader = 'Program Name,Has Errors,Error Message,Assembly Successful,Timestamp,Source Code Preview,Raw Output Preview\n';
        const csvRows = this.results.map(result => {
            return [
                `"${result.programName}"`,
                result.hasErrors,
                `"${result.errorMessage.replace(/"/g, '""')}"`,
                result.assemblySuccessful,
                result.timestamp,
                `"${result.sourceCode.replace(/"/g, '""')}"`,
                `"${(result.rawOutput || '').replace(/"/g, '""')}"`
            ].join(',');
        });
        
        const csvContent = csvHeader + csvRows.join('\n');
        await fs.writeFile(filename, csvContent, 'utf8');
        console.log(`Results saved to ${filename}`);
    }

    async cleanup() {
        if (this.browser) {
            await this.browser.close();
        }
    }
}

// Load test programs from directory
async function loadTestProgramsFromDirectory(directoryPath) {
    const programs = [];
    
    try {
        const files = await fs.readdir(directoryPath);
        
        // Filter for common assembly file extensions and ignore dotfiles
        const assemblyFiles = files.filter(file => {
            // Skip dotfiles (files starting with .) and common system files
            if (file.startsWith('.') || 
                file === 'Thumbs.db' || 
                file === 'desktop.ini' ||
                file.toLowerCase() === 'ds_store') {
                console.log(`Skipping system file: ${file}`);
                return false;
            }
            
            const ext = path.extname(file).toLowerCase();
            const hasValidExtension = ['.asm', '.s', '.txt', '.fv1', '.spn'].includes(ext) || !ext;
            
            if (!hasValidExtension) {
                console.log(`Skipping file with unsupported extension: ${file}`);
            }
            
            return hasValidExtension;
        });
        
        console.log(`Found ${assemblyFiles.length} potential assembly files`);
        
        for (const file of assemblyFiles) {
            const filePath = path.join(directoryPath, file);
            const stats = await fs.stat(filePath);
            
            if (stats.isFile()) {
                try {
                    const content = await fs.readFile(filePath, 'utf8');
                    const programName = path.basename(file, path.extname(file));
                    
                    programs.push({
                        name: programName,
                        code: content,
                        filename: file,
                        filepath: filePath
                    });
                    
                    console.log(`Loaded: ${file}`);
                } catch (readError) {
                    console.error(`Error reading file ${file}:`, readError.message);
                }
            }
        }
        
    } catch (error) {
        console.error('Error loading test programs from directory:', error);
    }
    
    return programs;
}

// Load test programs from a single file (JSON format)
async function loadTestProgramsFromFile(filename) {
    try {
        const content = await fs.readFile(filename, 'utf8');
        const programs = JSON.parse(content);
        return programs;
    } catch (error) {
        console.error('Error loading test programs:', error);
        return [];
    }
}

// Load test programs from a text file with delimiter format
async function loadTestProgramsFromTextFile(filename, delimiter = '---') {
    const programs = [];
    
    try {
        const content = await fs.readFile(filename, 'utf8');
        const sections = content.split(delimiter);
        
        for (let i = 0; i < sections.length; i++) {
            const section = sections[i].trim();
            if (section) {
                // Try to extract name from first line if it's a comment
                const lines = section.split('\n');
                let name = `Program_${i + 1}`;
                let code = section;
                
                if (lines[0].trim().startsWith(';')) {
                    name = lines[0].replace(/^;\s*/, '').trim() || name;
                }
                
                programs.push({
                    name: name,
                    code: code
                });
            }
        }
    } catch (error) {
        console.error('Error loading test programs from text file:', error);
    }
    
    return programs;
}

// Example usage with directory loading
async function runTestsFromDirectory(directoryPath) {
    const tester = new FV1AssemblerTester();
    
    try {
        console.log(`Loading test programs from: ${directoryPath}`);
        await tester.initialize();
        
        // Load all programs from directory
        const testPrograms = await loadTestProgramsFromDirectory(directoryPath);
        
        if (testPrograms.length === 0) {
            console.log('No test programs found in directory');
            return;
        }
        
        console.log(`Loaded ${testPrograms.length} test programs`);
        testPrograms.forEach(program => {
            console.log(`- ${program.name} (${program.filename})`);
        });
        
        await tester.testMultiplePrograms(testPrograms);
        
        // Save results with timestamp
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const resultsFile = `fv1_test_results_${timestamp}.csv`;
        await tester.saveResultsToCSV(resultsFile);
        
        // Print summary
        const totalTests = tester.results.length;
        const failedTests = tester.results.filter(r => r.hasErrors).length;
        const successfulTests = totalTests - failedTests;
        
        console.log('\n=== TEST SUMMARY ===');
        console.log(`Total tests: ${totalTests}`);
        console.log(`Successful: ${successfulTests}`);
        console.log(`Failed: ${failedTests}`);
        console.log(`Results saved to: ${resultsFile}`);
        
    } catch (error) {
        console.error('Test execution failed:', error);
    } finally {
        await tester.cleanup();
    }
}

// Example usage
async function runTests() {
    const tester = new FV1AssemblerTester();
    
    try {
        await tester.initialize();
        
        // Example test programs - replace with your actual test cases
        const testPrograms = [
            {
                name: "Simple Pass-through",
                code: `; Simple pass-through
rdax adcl, 1.0
wrax dacl, 0
rdax adcr, 1.0
wrax dacr, 0`
            },
            {
                name: "Invalid Syntax Test",
                code: `; This should cause an error
invalid_instruction
rdax adcl, 1.0
wrax dacl`
            },
            {
                name: "Simple Delay",
                code: `; Simple delay
mem del 1000
rdax adcl, 0.5
wra del, 0
rda del#, 0.5
wrax dacl, 0`
            }
        ];
        
        await tester.testMultiplePrograms(testPrograms);
        await tester.saveResultsToCSV();
        
    } catch (error) {
        console.error('Test execution failed:', error);
    } finally {
        await tester.cleanup();
    }
}

// Export for use as module
module.exports = { 
    FV1AssemblerTester, 
    runTests, 
    runTestsFromDirectory,
    loadTestProgramsFromFile,
    loadTestProgramsFromDirectory,
    loadTestProgramsFromTextFile
};

// Command line usage
if (require.main === module) {
    const args = process.argv.slice(2);
    
    if (args.length === 0) {
        console.log('Usage:');
        console.log('  node script.js <directory_path>  - Test all programs in directory');
        console.log('  node script.js --file <file.json>  - Test programs from JSON file');
        console.log('  node script.js --text <file.txt>  - Test programs from delimited text file');
        console.log('  node script.js --examples  - Run example tests');
        process.exit(1);
    }
    
    if (args[0] === '--examples') {
        runTests();
    } else if (args[0] === '--file' && args[1]) {
        // Load from JSON file
        (async () => {
            const tester = new FV1AssemblerTester();
            try {
                await tester.initialize();
                const programs = await loadTestProgramsFromFile(args[1]);
                await tester.testMultiplePrograms(programs);
                await tester.saveResultsToCSV();
            } finally {
                await tester.cleanup();
            }
        })();
    } else if (args[0] === '--text' && args[1]) {
        // Load from delimited text file
        (async () => {
            const tester = new FV1AssemblerTester();
            try {
                await tester.initialize();
                const programs = await loadTestProgramsFromTextFile(args[1]);
                await tester.testMultiplePrograms(programs);
                await tester.saveResultsToCSV();
            } finally {
                await tester.cleanup();
            }
        })();
    } else {
        // Assume it's a directory path
        runTestsFromDirectory(args[0]);
    }
}