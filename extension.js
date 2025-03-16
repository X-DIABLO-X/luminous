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
    let settingsCommand = vscode.commands.registerCommand('luminous.settings', () => {
        showSettingsMenu();
    });
    context.subscriptions.push(settingsCommand);

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider('luminous.view', {
            resolveWebviewView(webviewView) {
                currentPanel = webviewView;
                webviewView.webview.options = { enableScripts: true };
                updateWebviewContent(webviewView, true);

                webviewView.webview.onDidReceiveMessage(
                    message => handleWebviewMessage(message, context),
                    undefined,
                    context.subscriptions
                );

                vscode.window.onDidChangeActiveTextEditor(() => updateWebviewContent(webviewView, true));
                vscode.workspace.onDidChangeTextDocument(() => updateWebviewContent(webviewView, true));
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
    updateWebviewContent(currentPanel);
}

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
    const analysis = await analyzeCode(code);
    console.log(analysis);
    webviewView.webview.html = getWebviewContent(analysis, false);
}

async function analyzeCode(code) {
    if (!code) return { title: '', sections: [] };

    const lines = code.split('\n');
    const BATCH_SIZE = 100; // adjust this value as needed for optimal batching
    let aggregatedSections = [];
    let overallTitle = "Code Analysis";
    let lastError = null;

    // Models to try for each batch
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

    // Process the code in batches
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
        ? analysis.sections.map((section, sIndex) => `
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
                    <!-- If you need toggle for further nested content, add similar button and container -->
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
      // Prevent the event if the button inside the header is clicked
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
