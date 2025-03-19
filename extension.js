const vscode = require('vscode');
const Groq = require('groq-sdk');

// Initialize Groq client
const groq = new Groq({
    apiKey: "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"
});

let currentPanel = undefined;
let currentHighlightTimeout = null;
let currentSettings = {
    highlightColor: 'rgba(100, 149, 237, 0.3)',
    sectionColor: 'var(--vscode-button-background)'
};

// Cache for analysis results across all files (key: document URI)
const analysisCache = new Map();
// To debounce updates on document changes.
const analysisDebounceTimers = new Map();
// Threshold for minimum changed characters before sending a new query.
const CHANGE_THRESHOLD = 100;

function createDecorationTypes(color) {
    return {
        initial: vscode.window.createTextEditorDecorationType({
            backgroundColor: color,
            border: `2px solid ${color.replace('0.3', '0.5')}`,
            borderRadius: '5px',
            isWholeLine: true,
            light: {
                backgroundColor: color.replace('0.3', '0.25'),
                border: `2px solid ${color.replace('0.3', '0.4')}`,
            },
            dark: {
                backgroundColor: color.replace('0.3', '0.2'),
                border: `2px solid ${color.replace('0.3', '0.35')}`,
            }
        }),
        fadeOut1: vscode.window.createTextEditorDecorationType({
            backgroundColor: color.replace('0.3', '0.2'),
            borderRadius: '5px',
            isWholeLine: true,
        }),
        fadeOut2: vscode.window.createTextEditorDecorationType({
            backgroundColor: color.replace('0.3', '0.1'),
            borderRadius: '5px',
            isWholeLine: true,
        })
    };
}

let highlightDecorationTypes = createDecorationTypes(currentSettings.highlightColor);

function activate(context) {
    // Register settings command.
    let settingsCommand = vscode.commands.registerCommand('luminous.settings', () => {
        showSettingsMenu();
    });
    context.subscriptions.push(settingsCommand);

    // Only register the webview (sidebar) provider so that heavy work is deferred.
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider('luminous.view', {
            resolveWebviewView(webviewView) {
                currentPanel = webviewView;
                webviewView.webview.options = { enableScripts: true };
                // Do a full analysis once the sidebar is visible.
                updateWebviewContent(webviewView, true);

                webviewView.webview.onDidReceiveMessage(
                    message => handleWebviewMessage(message, context),
                    undefined,
                    context.subscriptions
                );

                // Listen for active editor changes.
                const activeEditorListener = vscode.window.onDidChangeActiveTextEditor(() => {
                    updateWebviewContent(webviewView, true);
                });
                // On document changes, schedule a partial re-analysis.
                const textDocChangeListener = vscode.workspace.onDidChangeTextDocument((e) => {
                    const docUri = e.document.uri.toString();
                    // Schedule a debounce update for this document.
                    if (analysisDebounceTimers.has(docUri)) {
                        clearTimeout(analysisDebounceTimers.get(docUri));
                    }
                    analysisDebounceTimers.set(docUri, setTimeout(() => {
                        schedulePartialUpdate(e.document);
                        analysisDebounceTimers.delete(docUri);
                    }, 1000)); // wait 1 second after last change
                });
                context.subscriptions.push(activeEditorListener, textDocChangeListener);
            }
        })
    );
}

async function handleWebviewMessage(message, context) {
    switch (message.command) {
        case 'jumpToLine':
            highlightAndJumpToSection(message.line, message.endLine);
            break;
        case 'openSettings':
            showSettingsMenu();
            break;
        case 'jumpToSubsection':
            highlightAndJumpToSection(message.line, message.endLine);
            break;
    }
}

async function showSettingsMenu() {
    const colorOptions = [
        'Blue (Default)',
        'Green',
        'Purple',
        'Orange',
        'Custom...'
    ];

    const selectedColor = await vscode.window.showQuickPick(colorOptions, {
        placeHolder: 'Select highlight color'
    });
    if (!selectedColor) return;

    let newColor;
    if (selectedColor === 'Custom...') {
        const input = await vscode.window.showInputBox({
            placeHolder: 'Enter RGBA color (e.g., rgba(100, 149, 237, 0.3))',
            value: currentSettings.highlightColor
        });
        if (!input) return;
        newColor = input;
    } else {
        const colorMap = {
            'Blue (Default)': 'rgba(100, 149, 237, 0.3)',
            'Green': 'rgba(75, 181, 67, 0.3)',
            'Purple': 'rgba(147, 112, 219, 0.3)',
            'Orange': 'rgba(255, 165, 0, 0.3)'
        };
        newColor = colorMap[selectedColor];
    }

    currentSettings.highlightColor = newColor;
    highlightDecorationTypes = createDecorationTypes(newColor);
    if (currentPanel) {
        updateWebviewContent(currentPanel);
    }
}

// For full analysis (when no cache exists) or when first opening the sidebar.
async function updateWebviewContent(webviewView, showLoading = false) {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        webviewView.webview.html = getWebviewContent({ title: '', sections: [] }, showLoading);
        return;
    }
    if (showLoading) {
        webviewView.webview.html = getWebviewContent({ title: '', sections: [] }, true);
    }
    const code = editor.document.getText();
    const docUri = editor.document.uri.toString();

    // If a full analysis was previously done and code unchanged, reuse it.
    if (analysisCache.has(docUri)) {
        const cached = analysisCache.get(docUri);
        if (cached.code === code && cached.analysis) {
            webviewView.webview.html = getWebviewContent(cached.analysis, false);
            return;
        }
    }
    // Otherwise, run a full analysis.
    const analysis = await analyzeCode(code);
    analysisCache.set(docUri, { code, analysis });
    console.log(analysis);
    webviewView.webview.html = getWebviewContent(analysis, false);
}

/* 
   schedulePartialUpdate() is called after a debounce when a document changes.
   It computes the differences between the new code and the cached version.
   If the change exceeds a threshold, it queries only the changed blocks,
   merges the new analysis with the cached analysis, updates the cache and then updates the sidebar.
*/
async function schedulePartialUpdate(document) {
    const docUri = document.uri.toString();
    const newCode = document.getText();
    let cached = analysisCache.get(docUri);
    // If no cached analysis exists, run a full analysis.
    if (!cached) {
        const fullAnalysis = await analyzeCode(newCode);
        analysisCache.set(docUri, { code: newCode, analysis: fullAnalysis });
        if (currentPanel) {
            currentPanel.webview.html = getWebviewContent(fullAnalysis, false);
        }
        return;
    }
    const oldCode = cached.code;
    // If the overall difference is less than the threshold, do nothing.
    if (Math.abs(newCode.length - oldCode.length) < CHANGE_THRESHOLD) {
        return;
    }
    const oldLines = oldCode.split('\n');
    const newLines = newCode.split('\n');
    // Compute changed blocks (line ranges in newLines).
    const changedBlocks = computeChangedBlocks(oldLines, newLines);
    if (changedBlocks.length === 0) {
        // No block found; update cache code and exit.
        cached.code = newCode;
        return;
    }
    // For each changed block, run analysis on just that block.
    let newSections = [];
    for (let block of changedBlocks) {
        const blockLines = newLines.slice(block.start, block.end + 1);
        // Use the block's starting line number as offset.
        const blockAnalysis = await analyzeCodeBlock(blockLines, block.start);
        if (blockAnalysis.sections) {
            newSections = newSections.concat(blockAnalysis.sections);
        }
    }
    // Merge new sections with the cached analysis.
    const mergedSections = mergeSections(cached.analysis.sections, newSections, changedBlocks);
    // Update the cache.
    const newAnalysis = { title: cached.analysis.title, sections: mergedSections };
    analysisCache.set(docUri, { code: newCode, analysis: newAnalysis });
    // Now update the sidebar with the new merged analysis.
    if (currentPanel) {
        currentPanel.webview.html = getWebviewContent(newAnalysis, false);
    }
}

/*
  computeChangedBlocks compares oldLines and newLines line-by-line and returns
  an array of blocks where changes occurred. Each block is an object {start, end} (0-indexed).
*/
function computeChangedBlocks(oldLines, newLines) {
    const blocks = [];
    const maxLen = Math.max(oldLines.length, newLines.length);
    let blockStart = null;
    for (let i = 0; i < maxLen; i++) {
        const oldLine = oldLines[i] || "";
        const newLine = newLines[i] || "";
        if (oldLine !== newLine) {
            if (blockStart === null) {
                blockStart = i;
            }
        } else {
            if (blockStart !== null) {
                blocks.push({ start: blockStart, end: i - 1 });
                blockStart = null;
            }
        }
    }
    if (blockStart !== null) {
        blocks.push({ start: blockStart, end: maxLen - 1 });
    }
    return blocks;
}

/*
  analyzeCodeBlock() is similar to analyzeCode(), but it processes only a block
  of lines. The offset is added so that the line numbers in the results reflect the full file.
*/
async function analyzeCodeBlock(blockLines, offset) {
    if (!blockLines.length) return { title: '', sections: [] };
    const BATCH_SIZE = 100; // can be adjusted
    let aggregatedSections = [];
    let overallTitle = "Code Analysis (Partial)";
    let lastError = null;

    const models = [
        'llama-3.2-90b-vision-preview',
        'llama-3.3-70b-specdec',
        'llama-3.3-70b-versatile',
        'llama3-70b-8192',
        'mixtral-8x7b-32768', 
        'qwen-2.5-32b',
        'llama-3.2-11b-vision-preview', 
        'gemma2-9b-it',         
        'llama-3.1-8b-instant',
        'llama-guard-3-8b',            
        'llama3-8b-8192',    
        'llama-3.2-3b-preview',      
        'llama-3.2-1b-preview'
    ];

    // Process the block in batches.
    for (let i = 0; i < blockLines.length; i += BATCH_SIZE) {
        let batchLines = blockLines.slice(i, i + BATCH_SIZE);
        let batchStart = offset + i;
        let batchEnd = offset + Math.min(i + BATCH_SIZE, blockLines.length) - 1;
        let numberedBatch = batchLines.map((line, idx) => `${batchStart + idx + 1}: ${line}`).join('\n');
        let prompt = `Analyze this code snippet from lines ${batchStart + 1} to ${batchEnd + 1} and return JSON with format {"title": string, "sections": [{title: string, lineNumber: number, endLine: number, subsections: [{title: string, lineNumber: number, endLine: number}]}]}. The title should describe the main purpose of this code snippet:\n\n${numberedBatch}\n\nReturn only the JSON result. Don't include the code in backticks or any extra text.`;

        let batchAnalysis = null;
        for (let model of models) {
            try {
                const chatCompletion = await groq.chat.completions.create({
                    messages: [{ role: "user", content: prompt }],
                    model: model,
                    temperature: 0.1,
                    max_tokens: 4096,
                    top_p: 1,
                    stream: false,
                    stop: null
                });
                let content = chatCompletion.choices[0].message.content;
                console.log(`(Partial) Model ${model} succeeded for batch ${batchStart + 1}-${batchEnd + 1}.`);
                batchAnalysis = JSON.parse(content);
                break;
            } catch (error) {
                console.log(`(Partial) Model ${model} failed with error: ${error.message} for batch ${batchStart + 1}-${batchEnd + 1}.`);
                lastError = error;
            }
        }
        if (batchAnalysis && batchAnalysis.sections) {
            aggregatedSections = aggregatedSections.concat(batchAnalysis.sections);
        } else {
            console.log(`(Partial) Analysis failed for batch ${batchStart + 1}-${batchEnd + 1}.`);
        }
    }

    if (aggregatedSections.length === 0 && lastError) {
        vscode.window.showErrorMessage(`Partial analysis error: ${lastError.message}`);
    }
    return { title: overallTitle, sections: aggregatedSections };
}

/*
  analyzeCode() processes the full code (for initial load).
*/
async function analyzeCode(code) {
    if (!code) return { title: '', sections: [] };

    const lines = code.split('\n');
    const BATCH_SIZE = 100; // adjust as needed
    let aggregatedSections = [];
    let overallTitle = "Code Analysis";
    let lastError = null;

    const models = [
        'llama-3.2-90b-vision-preview',
        'llama-3.3-70b-specdec',
        'llama-3.3-70b-versatile',
        'llama3-70b-8192',
        'mixtral-8x7b-32768', 
        'qwen-2.5-32b',
        'llama-3.2-11b-vision-preview', 
        'gemma2-9b-it',         
        'llama-3.1-8b-instant',
        'llama-guard-3-8b',            
        'llama3-8b-8192',    
        'llama-3.2-3b-preview',      
        'llama-3.2-1b-preview'
    ];

    // Process the code in batches.
    for (let i = 0; i < lines.length; i += BATCH_SIZE) {
        let batchLines = lines.slice(i, i + BATCH_SIZE);
        let batchStart = i;
        let batchEnd = Math.min(i + BATCH_SIZE, lines.length);
        let numberedBatch = batchLines.map((line, idx) => `${batchStart + idx + 1}: ${line}`).join('\n');
        let prompt = `Analyze this code snippet from lines ${batchStart + 1} to ${batchEnd} and return JSON with format {"title": string, "sections": [{title: string, lineNumber: number, endLine: number, subsections: [{title: string, lineNumber: number, endLine: number}]}]}. The title should describe the main purpose of this code snippet:\n\n${numberedBatch}\n\nReturn only the JSON result. Don't include the code in backticks or any extra text.`;

        let batchAnalysis = null;
        for (let model of models) {
            try {
                const chatCompletion = await groq.chat.completions.create({
                    messages: [{ role: "user", content: prompt }],
                    model: model,
                    temperature: 0.1,
                    max_tokens: 4096,
                    top_p: 1,
                    stream: false,
                    stop: null
                });
                let content = chatCompletion.choices[0].message.content;
                console.log(`Model ${model} succeeded for batch ${batchStart + 1}-${batchEnd}.`);
                batchAnalysis = JSON.parse(content);
                break;
            } catch (error) {
                console.log(`Model ${model} failed with error: ${error.message} for batch ${batchStart + 1}-${batchEnd}.`);
                lastError = error;
            }
        }
        if (batchAnalysis && batchAnalysis.sections) {
            aggregatedSections = aggregatedSections.concat(batchAnalysis.sections);
        } else {
            console.log(`Analysis failed for batch ${batchStart + 1}-${batchEnd}.`);
        }
    }

    if (aggregatedSections.length === 0 && lastError) {
        vscode.window.showErrorMessage(`Analysis error: ${lastError.message}`);
    }

    return { title: overallTitle, sections: aggregatedSections };
}

/*
  mergeSections() takes the previously cached sections and the newly analyzed sections (from the changed blocks)
  along with the changed blocks (array of {start, end}) and replaces any sections whose line numbers fall inside any changed block.
  Finally, it sorts all sections by their starting line number.
*/
function mergeSections(oldSections, newSections, changedBlocks) {
    // Filter out any old sections that intersect any changed block.
    const filtered = oldSections.filter(section => {
        for (let block of changedBlocks) {
            // If the section's range overlaps the block range, remove it.
            if (section.lineNumber - 1 <= block.end && section.endLine - 1 >= block.start) {
                return false;
            }
        }
        return true;
    });
    const merged = filtered.concat(newSections);
    // Sort by starting line number.
    merged.sort((a, b) => a.lineNumber - b.lineNumber);
    return merged;
}

function highlightAndJumpToSection(startLine, endLine) {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;

    const document = editor.document;
    if (startLine < 1 || endLine > document.lineCount || startLine > endLine) return;

    clearHighlights();

    const range = new vscode.Range(
        new vscode.Position(startLine - 1, 0),
        new vscode.Position(endLine - 1, Number.MAX_VALUE)
    );

    editor.setDecorations(highlightDecorationTypes.initial, [range]);

    const position = new vscode.Position(startLine - 1, 0);
    editor.selection = new vscode.Selection(position, position);
    editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);

    startHighlightFadeout(editor, range);
}

function startHighlightFadeout(editor, range) {
    if (currentHighlightTimeout) clearTimeout(currentHighlightTimeout);

    currentHighlightTimeout = setTimeout(() => {
        editor.setDecorations(highlightDecorationTypes.initial, []);
        editor.setDecorations(highlightDecorationTypes.fadeOut1, [range]);

        currentHighlightTimeout = setTimeout(() => {
            editor.setDecorations(highlightDecorationTypes.fadeOut1, []);
            editor.setDecorations(highlightDecorationTypes.fadeOut2, [range]);

            currentHighlightTimeout = setTimeout(() => {
                clearHighlights();
            }, 800);
        }, 800);
    }, 1200);
}

function clearHighlights() {
    const editor = vscode.window.activeTextEditor;
    if (editor) {
        Object.values(highlightDecorationTypes).forEach(decorationType => {
            editor.setDecorations(decorationType, []);
        });
    }
}

function getWebviewContent(analysis, isLoading) {
    return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Luminous</title>
  <style>
    :root {
      --transition-duration: 0.3s;
      --border-radius: 8px;
      --spacing-unit: 10px;
      --section-bg: var(--vscode-editor-background);
      --section-border: var(--vscode-widget-border);
      --section-title-bg: var(--vscode-button-background);
      --section-title-color: var(--vscode-button-foreground);
      --subsection-bg: var(--vscode-editor-background);
      --subsection-border: var(--vscode-button-border);
    }
    body {
      font-family: var(--vscode-font-family);
      padding: var(--spacing-unit);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
    }
    .header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: calc(var(--spacing-unit) * 1.5);
      background: var(--vscode-editor-background);
      border: 1px solid var(--section-border);
      border-radius: var(--border-radius);
      margin-bottom: var(--spacing-unit);
    }
    .header .title {
      font-size: 18px;
      font-weight: bold;
      margin: 0;
    }
    .settings-button {
      padding: calc(var(--spacing-unit) * 0.8);
      background: var(--section-title-bg);
      border: none;
      border-radius: var(--border-radius);
      color: var(--section-title-color);
      cursor: pointer;
      display: flex;
      align-items: center;
      transition: background var(--transition-duration);
    }
    .settings-button:hover {
      background: var(--vscode-button-hoverBackground);
    }
    .settings-button svg {
      margin-right: 5px;
      transition: transform 0.5s;
    }
    .settings-button svg:hover {
      transform: rotate(360deg);
    }
    #sections {
      display: flex;
      flex-direction: column;
      gap: var(--spacing-unit);
    }
    .section {
      background: var(--section-bg);
      border: 1px solid var(--section-border);
      border-radius: var(--border-radius);
      overflow: hidden;
      box-shadow: 0 2px 4px rgba(0,0,0,0.1);
    }
    .section-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: calc(var(--spacing-unit) * 1);
      background: var(--section-title-bg);
      color: var(--section-title-color);
      cursor: pointer;
      user-select: none;
    }
    .section-header .title-btn {
      background: none;
      border: none;
      color: inherit;
      font-size: 15px;
      text-align: left;
      cursor: pointer;
      flex-grow: 1;
    }
    .toggle-btn {
      background: none;
      border: none;
      color: inherit;
      font-size: 16px;
      width: 30px;
      cursor: pointer;
    }
    .subsections {
      padding: calc(var(--spacing-unit) * 0.8);
      display: block;
      transition: max-height var(--transition-duration) ease;
    }
    .subsection {
      background: var(--subsection-bg);
      border: 1px solid var(--subsection-border);
      border-radius: var(--border-radius);
      padding: calc(var(--spacing-unit) * 0.8);
      margin-bottom: var(--spacing-unit);
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .subsection:last-child {
      margin-bottom: 0;
    }
    .subsection .sub-title-btn {
      background: none;
      border: none;
      font-size: 14px;
      color: var(--vscode-foreground);
      cursor: pointer;
      flex-grow: 1;
      text-align: left;
    }
    .collapsed {
      display: none;
    }
    .loading-spinner {
      display: flex;
      justify-content: center;
      align-items: center;
      padding: calc(var(--spacing-unit) * 2);
    }
    .spinner {
      border: 4px solid var(--vscode-button-background);
      border-top: 4px solid var(--vscode-button-foreground);
      border-radius: 50%;
      width: 40px;
      height: 40px;
      animation: spin 1s linear infinite;
    }
    @keyframes spin {
      0% { transform: rotate(0deg); }
      100% { transform: rotate(360deg); }
    }
  </style>
</head>
<body>
  <div class="header">
    <h1 class="title">${analysis.title || 'Luminous'}</h1>
    <button class="settings-button" onclick="openSettings()">
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" height="20" width="20">
        <path fill="none" d="M0 0h24v24H0z"></path>
        <path d="M19.43 12.98c.04-.32.07-.64.07-.98s-.03-.66-.07-.98l2.11-1.65c.19-.15.24-.42.12-.64l-2-3.46c-.12-.22-.39-.3-.61-.22l-2.49 1c-.52-.4-1.08-.73-1.69-.98l-.38-2.65C14.46 2.18 14.25 2 14 2h-4c-.25 0-.46.18-.49.42l-.38 2.65c-.61.25-1.17.59-1.69.98l-2.49-1c-.23-.09-.49 0-.61.22l-2 3.46c-.13.22-.07.49.12.64l2.11 1.65c-.04.32-.07.65-.07.98s.03.66.07.98l-2.11 1.65c-.19.15-.24.42-.12.64l2 3.46c.12.22.39.3.61.22l2.49-1c.52.4 1.08.73 1.69.98l.38 2.65c.03.24.24.42.49.42h4c.25 0 .46-.18.49-.42l.38-2.65c.61-.25 1.17-.59 1.69-.98l2.49 1c.23.09.49 0 .61-.22l2-3.46c.12-.22.07-.49-.12-.64l-2.11-1.65zM12 15.5c-1.93 0-3.5-1.57-3.5-3.5s1.57-3.5 3.5-3.5 3.5 1.57 3.5 3.5-1.57 3.5-3.5 3.5z" fill="#fff"></path>
      </svg>
      Settings
    </button>
  </div>
  <div id="sections">
    ${
      isLoading 
      ? '<div class="loading-spinner"><div class="spinner"></div></div>' 
      : analysis.sections.length > 0 
        ? analysis.sections.map((section) => `
          <div class="section">
            <div class="section-header" onclick="toggleSection(event)">
              <button class="title-btn" onclick="jumpToLine(${section.lineNumber}, ${section.endLine}); event.stopPropagation();">
                ${section.title}
              </button>
              <button class="toggle-btn">–</button>
            </div>
            <div class="subsections">
              ${
                section.subsections && section.subsections.length > 0 
                ? section.subsections.map(subsection => `
                  <div class="subsection">
                    <button class="sub-title-btn" onclick="jumpToSubsection(${subsection.lineNumber}, ${subsection.endLine})">
                      ${subsection.title}
                    </button>
                  </div>
                `).join('') 
                : ''
              }
            </div>
          </div>
        `).join('') 
        : '<p class="no-file">Open a file to analyze code sections</p>'
    }
  </div>
  <script>
    const vscode = acquireVsCodeApi();

    function jumpToLine(line, endLine) {
      vscode.postMessage({
        command: 'jumpToLine',
        line: line,
        endLine: endLine
      });
    }

    function jumpToSubsection(line, endLine) {
      vscode.postMessage({
        command: 'jumpToSubsection',
        line: line,
        endLine: endLine
      });
    }

    function openSettings() {
      vscode.postMessage({
        command: 'openSettings'
      });
    }

    function toggleSection(event) {
      event.stopPropagation();
      const header = event.currentTarget;
      const sectionElement = header.parentElement;
      const subsections = sectionElement.querySelector('.subsections');
      const toggleBtn = header.querySelector('.toggle-btn');
      if (subsections.style.display === 'none') {
        subsections.style.display = 'block';
        toggleBtn.textContent = '–';
      } else {
        subsections.style.display = 'none';
        toggleBtn.textContent = '+';
      }
    }
  </script>
</body>
</html>
    `;
}

function deactivate() {
    clearHighlights();
    if (currentHighlightTimeout) {
        clearTimeout(currentHighlightTimeout);
    }
}

module.exports = {
    activate,
    deactivate
};
