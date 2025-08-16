// User Preferences Storage System - FV-1 Editor (Editor Options Only)
class UserPreferences {
    constructor() {
        this.storageKey = 'fv1_editor_preferences';
        this.defaults = {
            // Editor Options Only
            editorHeight: false,        // Large editor window
            darkMode: 'system',        // Dark mode: 'dark', 'light', or 'system'
            minimap: false,            // Show editor mini-map
            debugMode: false           // Show full build results
        };
    }

    // Save current preferences to localStorage
    save() {
        try {
            const currentPrefs = {
                // Get current checkbox states
                editorHeight: document.getElementById('editorHeightToggle')?.checked || false,
                darkMode: this.getCurrentDarkModeSetting(),
                minimap: document.getElementById('minimapToggle')?.checked || false,
                debugMode: document.getElementById('debugToggle')?.checked || false
            };
            
            localStorage.setItem(this.storageKey, JSON.stringify(currentPrefs));
            debugLog('Preferences saved', 'info');
            return true;
        } catch (error) {
            debugLog('Failed to save preferences', 'errors');
            return false;
        }
    }

    // Load preferences from localStorage
    load() {
        try {
            const saved = localStorage.getItem(this.storageKey);
            if (saved) {
                const prefs = JSON.parse(saved);
                debugLog('Preferences loaded', 'info');
                return { ...this.defaults, ...prefs };
            }
            return this.defaults;
        } catch (error) {
            debugLog('Failed to load preferences', 'errors');
            return this.defaults;
        }
    }

    // Apply loaded preferences to the UI with proper timing
    apply() {
        const prefs = this.load();
        
        // Use requestAnimationFrame to ensure DOM is ready
        requestAnimationFrame(() => {
            this.applyEditorOptions(prefs);
        });
    }

    applyEditorOptions(prefs) {
        console.log('Applying editor options:', prefs);
        
        // Large editor window
        const editorHeightToggle = document.getElementById('editorHeightToggle');
        if (editorHeightToggle) {
            console.log('Setting editorHeight checkbox to:', prefs.editorHeight);
            editorHeightToggle.checked = prefs.editorHeight;
            if (prefs.editorHeight && typeof toggleEditorHeight === 'function') {
                toggleEditorHeight();
            }
        }

        // Dark mode - handle dropdown selection
        const darkModeSelect = document.getElementById('darkModeSelect');
        if (darkModeSelect) {
            console.log('Setting darkMode to:', prefs.darkMode);
            darkModeSelect.value = prefs.darkMode;
            this.applyDarkMode(prefs.darkMode);
        }

        // Minimap
        const minimapToggle = document.getElementById('minimapToggle');
        if (minimapToggle) {
            console.log('Setting minimap checkbox to:', prefs.minimap);
            minimapToggle.checked = prefs.minimap;
            if (prefs.minimap && typeof toggleMinimap === 'function') {
                toggleMinimap();
            }
        }

        // Debug mode - set checkbox first, then apply the setting
        const debugToggle = document.getElementById('debugToggle');
        if (debugToggle) {
            console.log('Setting debugMode checkbox to:', prefs.debugMode);
            debugToggle.checked = prefs.debugMode;
            
            // Apply debug preset based on saved preference
            if (prefs.debugMode) {
                console.log('Applying debug preset: basic');
                if (typeof DEBUG !== 'undefined' && DEBUG.setPreset) {
                    DEBUG.setPreset('basic');
                }
            } else {
                console.log('Resetting debug preset to default');
                if (typeof DEBUG !== 'undefined' && DEBUG.reset) {
                    DEBUG.reset();
                }
            }
        }
    }

    // Clear all saved preferences
    clear() {
        localStorage.removeItem(this.storageKey);
        debugLog('Preferences cleared', 'info');
    }

    // Helper method to get current dark mode setting
    getCurrentDarkModeSetting() {
        const darkModeSelect = document.getElementById('darkModeSelect');
        return darkModeSelect ? darkModeSelect.value : 'system';
    }

    // Apply dark mode based on preference
    applyDarkMode(setting) {
        const darkModeSelect = document.getElementById('darkModeSelect');
        if (!darkModeSelect) return;

        // Ensure setting is a string and has a valid value
        const validSetting = typeof setting === 'string' ? setting : 'system';
        const finalSetting = ['light', 'dark', 'system'].includes(validSetting) ? validSetting : 'system';

        // Set the dropdown value
        darkModeSelect.value = finalSetting;

        let shouldUseDark = false;
        
        switch (finalSetting) {
            case 'dark':
                shouldUseDark = true;
                break;
            case 'light':
                shouldUseDark = false;
                break;
            case 'system':
            default:
                // Follow system preference
                shouldUseDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
                break;
        }

        // Apply the theme - updated for FV-1 themes
        if (editor && typeof monaco !== 'undefined') {
            const theme = shouldUseDark ? 'spinDark' : 'spinTheme';
            monaco.editor.setTheme(theme);
        }
        document.body.classList.toggle('dark-mode', shouldUseDark);
    }

    // Get current preferences without saving
    getCurrent() {
        return {
            editorHeight: document.getElementById('editorHeightToggle')?.checked || false,
            darkMode: this.getCurrentDarkModeSetting(),
            minimap: document.getElementById('minimapToggle')?.checked || false,
            debugMode: document.getElementById('debugToggle')?.checked || false
        };
    }
}

// Create global instance
const userPrefs = new UserPreferences();

// Auto-save preferences when settings change
function setupAutoSave() {
    // Save when checkboxes change
    const checkboxes = [
        'editorHeightToggle',
        'minimapToggle',
        'debugToggle'
    ];
    
    checkboxes.forEach(id => {
        const element = document.getElementById(id);
        if (element) {
            element.addEventListener('change', () => {
                userPrefs.save();
            });
        }
    });

    // Save when dark mode dropdown changes
    const darkModeSelect = document.getElementById('darkModeSelect');
    if (darkModeSelect) {
        darkModeSelect.addEventListener('change', () => {
            userPrefs.applyDarkMode(darkModeSelect.value);
            userPrefs.save();
        });
    }
}

// Modified versions of your existing functions to include auto-save
function toggleEditorHeightWithSave() {
    if (typeof toggleEditorHeight === 'function') {
        toggleEditorHeight();
    }
    userPrefs.save();
}

function toggleMinimapWithSave() {
    if (typeof toggleMinimap === 'function') {
        toggleMinimap();
    }
    userPrefs.save();
}

function toggleDebugPresetWithSave() {
    if (typeof toggleDebugPreset === 'function') {
        toggleDebugPreset();
    }
    userPrefs.save();
}

// Initialize preferences system with better timing
function initializePreferences() {
    // Wait for DOM to be fully ready and other scripts to load
    setTimeout(() => {
        console.log('Initializing preferences system...');
        
        // Load and apply saved preferences
        userPrefs.apply();
        
        // Set up auto-save listeners after a short delay
        setTimeout(() => {
            setupAutoSave();
            setupSystemThemeListener();
        }, 200);
        
        debugLog('User preferences system initialized', 'info');
    }, 300); // Increased delay to ensure all scripts are loaded
}

// Listen for system theme changes and update if user has "system" selected
function setupSystemThemeListener() {
    if (window.matchMedia) {
        const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
        
        const handleSystemThemeChange = (e) => {
            const darkModeSelect = document.getElementById('darkModeSelect');
            if (darkModeSelect && darkModeSelect.value === 'system') {
                console.log('System theme changed, updating app theme');
                userPrefs.applyDarkMode('system');
                // No need to save here - the preference is still "system"
            }
        };
        
        // Listen for changes
        mediaQuery.addEventListener('change', handleSystemThemeChange);
        
        console.log('System theme change listener set up');
    }
}

// Export for use in other files
window.userPrefs = userPrefs;
window.initializePreferences = initializePreferences;