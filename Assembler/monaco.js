// Monaco editor for FV-1 Assembler
let editor; // global editor instance
require.config({
    paths: {
        'vs': 'https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.39.0/min/vs'
    }
});
require(['vs/editor/editor.main'], function() {
    // Register the SpinFV1 language
    monaco.languages.register({
        id: 'spin'
    });

    monaco.languages.setMonarchTokensProvider('spin', {
        ignoreCase: true,
        tokenizer: {
            root: [
                // Line Comments
                [/;.*/, 'comment'],
                [/%.*/, 'comment'],

                // Strings → enter string mode
                ['"', {
                    token: 'string.quote',
                    next: '@string'
                }],

                // Labels at start of line (must come early)
                [/^\s*([a-zA-Z_][\w]*):/, 'label'],

                // Declarations
                [/\b(equ|mem)\b/, 'keyword.declaration'],

                // Instructions - organized by category
                [/\b(rda|rmpa|wra|wrap)\b/, 'keyword'],
                [/\b(rdax|rdfx|ldax|wrax|wrhx|wrlx|maxx|absa|mulx)\b/, 'keyword'],
                [/\b(log|exp|sof|and|or|xor|not|clr)\b/, 'keyword'],
                [/\b(skp|jmp|nop)\b/, 'keyword'],
                [/\b(wlds|wldr|jam|cho)\b/, 'keyword'],

                // CHO sub-types and LFO names
                [/\b(sin0|sin1|cos0|cos1|rmp0|rmp1)\b/, 'constant'],
                [/\b(sin|cos|reg|compa|compc|rptr2|na)\b/, 'constant'],
                [/\b(run|zrc|zro|gez|neg)\b/, 'constant'],

                // Registers - specific patterns to avoid partial matches
                [/\breg([0-9]|[12][0-9]|3[01])\b/, 'variable'],
                [/\b(sin0_rate|sin0_range|sin1_rate|sin1_range)\b/, 'variable'],
                [/\b(rmp0_rate|rmp0_range|rmp1_rate|rmp1_range)\b/, 'variable'],
                [/\b(pot[0-2]|adcl|adcr|dacl|dacr|addr_ptr)\b/, 'variable'],

                // Hex Numbers
                [/\b0[xX][0-9A-Fa-f]+\b/, 'number.hex'],
                [/\$[0-9A-Fa-f]+\b/, 'number.hex'],

                // Binary Numbers  
                [/\b0[bB][01]+\b/, 'number.hex'],
                [/%[01]+\b/, 'number.hex'],

                // Decimal Numbers
                [/\b\d+(\.\d+)?\b/, 'number'],

                // Identifiers
                [/\b[a-zA-Z_][\w]*\b/, 'identifier'],
            ],

            // String mode → everything inside quotes
            string: [
                [/[^"]+/, 'string'],
                ['"', {
                    token: 'string.quote',
                    next: '@pop'
                }]
            ]
        }
    });

    monaco.editor.defineTheme('spinTheme', {
        base: 'vs', // or 'vs-dark'
        inherit: true,
        rules: [{
                token: 'keyword',
                foreground: 'aa00ff',
                fontStyle: 'bold'
            },
            {
                token: 'comment',
                foreground: '008000',
                fontStyle: 'italic'
            },
            {
                token: 'label',
                foreground: '0000ff'
            },
            {
                token: 'number',
                foreground: 'ff0000'
            },
            {
                token: 'number.hex',
                foreground: 'ff6600'
            },
            {
                token: 'string',
                foreground: 'a31515'
            }
        ],
        colors: {
            'editor.foreground': '#000000',
            'editor.background': '#ffffff',
            'editorLineNumber.foreground': '#999999',
            'editorCursor.foreground': '#000000',
            'editor.selectionBackground': '#BAD6FD',
            'editor.lineHighlightBackground': '#f0f8ff'
        }
    });

    monaco.editor.defineTheme('spinDark', {
        base: 'vs-dark',
        inherit: true,
        rules: [{
                token: 'keyword',
                foreground: 'd986ff',
                fontStyle: 'bold'
            },
            {
                token: 'comment',
                foreground: '6a9955',
                fontStyle: 'italic'
            },
            {
                token: 'label',
                foreground: '569cd6'
            },
            {
                token: 'number',
                foreground: 'f44747'
            },
            {
                token: 'number.hex',
                foreground: 'ff8800'
            },
            {
                token: 'string',
                foreground: 'ce9178'
            }
        ],
        colors: {
            'editor.foreground': '#d4d4d4',
            'editor.background': '#1e1e1e',
            'editorLineNumber.foreground': '#858585',
            'editorCursor.foreground': '#ffffff',
            'editor.selectionBackground': '#264f78',
            'editor.lineHighlightBackground': '#333333'
        }
    });

     function initializeMonacoEditor() {
        const placeholderText = "; Enter your SpinASM assembly code here, load a file, or select an example";
        
        // Create the editor with initial placeholder content
        editor = monaco.editor.create(document.getElementById('editor'), {
            value: placeholderText,
            language: 'spin',
            theme: 'spinTheme',
            readOnly: true, // Start as read-only
            automaticLayout: false,
            quickSuggestions: false,
            wordBasedSuggestions: false,
            selectOnLineNumbers: true,
            minimap: { enabled: false },
            scrollBeyondLastLine: false,
            wordWrap: 'on'
        });

        // Add event listener to make editor editable when user clicks or starts typing
        editor.onDidFocusEditorText(() => {
            if (editor.getValue() === placeholderText) {
                editor.updateOptions({ readOnly: false });
                editor.setValue(''); // Clear placeholder text
                editor.focus();
            }
        });

        // Also handle when user starts typing
        editor.onDidChangeModelContent(() => {
            if (editor.getOption(monaco.editor.EditorOption.readOnly) && 
                editor.getValue() !== placeholderText) {
                editor.updateOptions({ readOnly: false });
            }
        });

        // Function to reset to placeholder (call this when clearing editor)
        window.resetEditorToPlaceholder = function() {
            editor.setValue(placeholderText);
            editor.updateOptions({ readOnly: true });
        };

        // Function to check if editor has real content (not just placeholder)
        window.hasEditorContent = function() {
            const value = editor.getValue().trim();
            return value.length > 0 && value !== placeholderText;
        };
    }

    initializeMonacoEditor(); // start up editor

    // Apply system dark mode preference after editor is created
    setTimeout(() => {
        const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
        const darkModeToggle = document.getElementById('darkModeToggle');

        if (darkModeToggle) {
            darkModeToggle.checked = prefersDark;
            const theme = prefersDark ? 'spinDark' : 'spinTheme';
            monaco.editor.setTheme(theme);
            document.body.classList.toggle('dark-mode', prefersDark);
        }
    }, 100);

    // Disable browser autocorrect on Monaco's hidden textarea
    setTimeout(() => {
        const textAreas = document.querySelectorAll('textarea');
        textAreas.forEach(textArea => {
            textArea.setAttribute('spellcheck', 'false');
            textArea.setAttribute('autocorrect', 'off');
            textArea.setAttribute('autocomplete', 'off');
            textArea.setAttribute('autocapitalize', 'off');
        });
    }, 500);

        // Enable drag-and-drop file loading into Monaco
    document.getElementById('editor').addEventListener('dragover', (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
    });

    document.getElementById('editor').addEventListener('drop', (e) => {
        e.preventDefault();
        
        const file = e.dataTransfer.files[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = function(evt) {
            const content = evt.target.result;
            editor.setValue(content);
            editor.updateOptions({ readOnly: false }); // Make sure it's editable after drop
            editor.focus();
        };
        reader.readAsText(file);
    });

// Notify UI that editor is ready
    if (typeof setEditorReady === 'function') {
        setEditorReady(editor);
    } else {
        // Fallback: set a flag that UI can check
        window.editorReady = true;
        window.monacoEditor = editor;
    }

    console.log('Monaco Editor initialized successfully');
});