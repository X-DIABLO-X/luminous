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

    try {
        const numberedCode = code.split('\n')
            .map((line, index) => `${index + 1}: ${line}`)
            .join('\n');

        const prompt = `Analyze this code and return JSON with format {"title": string, "sections": [{title: string, lineNumber: number, endLine: number, subsections: [{title: string, lineNumber: number, endLine: number}]}]}. The title should describe the main purpose of the code:\n\n${numberedCode}. Return only the JSON result. Don't give the code in backticks and also don't give anything extra except from the json result.`;

        const chatCompletion = await groq.chat.completions.create({
            messages: [{ role: "user", content: prompt }],
            model: "llama-3.3-70b-versatile",
            temperature: 0.1,
            max_tokens: 4096,
            top_p: 1,
            stream: false,
            stop: null
        });
        let content = chatCompletion.choices[0].message.content;
        console.log(content);
        return JSON.parse(content);
    } catch (error) {
        vscode.window.showErrorMessage(`Analysis error: ${error.message}`);
        return { title: '', sections: [] };
    }
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
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Luminous</title>
            <style>
                :root {
                    --transition-duration: 0.3s;
                    --border-radius: 6px;
                    --spacing-unit: 8px;
                    --section-color: ${currentSettings.sectionColor};
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
                    margin-bottom: var(--spacing-unit);
                    padding: calc(var(--spacing-unit) * 2);
                    background: var(--vscode-editor-background);
                    border-radius: var(--border-radius);
                    border: 1px solid var(--vscode-widget-border);
                }

                .title {
                    font-size: 16px;
                    font-weight: bold;
                    margin: 0;
                }

                .settings-button {
                    padding: calc(var(--spacing-unit) * 1.5);
                    background: transparent;
                    border: 1px solid var(--vscode-button-border);
                    border-radius: var(--border-radius);
                    color: var(--vscode-button-foreground);
                    cursor: pointer;
                    margin-left: var(--spacing-unit);
                    display: flex;
                    align-items: center;
                }
                .icon{
                    transition: transform .7s ease-in-out;
                    transition-duration: 1s;
                }
                .icon:hover {
                    transform: rotate(3.142rad);
                }

                #sections {
                    display: flex;
                    flex-direction: column;
                    gap: var(--spacing-unit);
                }

                .section-button {
                    width: 100%;
                    text-align: left;
                    padding: calc(var(--spacing-unit) * 1.5) calc(var(--spacing-unit) * 2);
                    background: var(--section-color);
                    color: var(--vscode-button-foreground);
                    border: 1px solid var(--vscode-button-border, transparent);
                    border-radius: var(--border-radius);
                    cursor: pointer;
                    transition: all var(--transition-duration);
                    position: relative;
                    overflow: hidden;
                    font-size: 13px;
                    line-height: 1.4;
                    box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
                }

                .section-button:hover {
                    background: var(--vscode-button-hoverBackground);
                    transform: translateX(var(--spacing-unit)) scale(1.01);
                    box-shadow: 0 4px 8px rgba(0, 0, 0, 0.15);
                }

                .section-button:active {
                    transform: translateX(var(--spacing-unit)) scale(0.98);
                }

                .subsection-button {
                    width: 90%;
                    margin-left: 10%;
                    text-align: left;
                    padding: calc(var(--spacing-unit) * 1) calc(var(--spacing-unit) * 2);
                    background: var(--vscode-editor-background);
                    color: var(--vscode-foreground);
                    border: 1px solid var(--vscode-button-border, transparent);
                    border-radius: var(--border-radius);
                    cursor: pointer;
                    transition: all var(--transition-duration);
                    position: relative;
                    overflow: hidden;
                    font-size: 12px;
                    line-height: 1.4;
                    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.1);
                }

                .subsection-button:hover {
                    background: var(--vscode-button-hoverBackground);
                    transform: translateX(var(--spacing-unit)) scale(1.01);
                    box-shadow: 0 2px 4px rgba(0, 0, 0, 0.15);
                }

                .subsection-button:active {
                    transform: translateX(var(--spacing-unit)) scale(0.98);
                }

                .no-file {
                    color: var(--vscode-descriptionForeground);
                    font-style: italic;
                    text-align: center;
                    padding: calc(var(--spacing-unit) * 2);
                    background: var(--vscode-editor-background);
                    border-radius: var(--border-radius);
                    animation: fadeIn 0.5s;
                    border: 1px dashed var(--vscode-widget-border);
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

                @keyframes fadeIn {
                    from { opacity: 0; transform: translateY(10px); }
                    to { opacity: 1; transform: translateY(0); }
                }
            </style>
        </head>
        <body>
            <div class="header">
                <h1 class="title">${analysis.title || 'Luminous'}</h1>
                <button class="settings-button" onclick="openSettings()">
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" id="settings" class="icon" height="20px" width="20px">
  <path fill="none" d="M0 0h24v24H0V0z"></path>
  <path d="M19.43 12.98c.04-.32.07-.64.07-.98s-.03-.66-.07-.98l2.11-1.65c.19-.15.24-.42.12-.64l-2-3.46c-.12-.22-.39-.3-.61-.22l-2.49 1c-.52-.4-1.08-.73-1.69-.98l-.38-2.65C14.46 2.18 14.25 2 14 2h-4c-.25 0-.46.18-.49.42l-.38 2.65c-.61.25-1.17.59-1.69.98l-2.49-1c-.23-.09-.49 0-.61.22l-2 3.46c-.13.22-.07.49.12.64l2.11 1.65c-.04.32-.07.65-.07.98s.03.66.07.98l-2.11 1.65c-.19.15-.24.42-.12.64l2 3.46c.12.22.39.3.61.22l2.49-1c.52.4 1.08.73 1.69.98l.38 2.65c.03.24.24.42.49.42h4c.25 0 .46-.18.49-.42l.38-2.65c.61-.25 1.17-.59 1.69-.98l2.49 1c.23.09.49 0 .61-.22l2-3.46c.12-.22.07-.49-.12-.64l-2.11-1.65zM12 15.5c-1.93 0-3.5-1.57-3.5-3.5s1.57-3.5 3.5-3.5 3.5 1.57 3.5 3.5-1.57 3.5-3.5 3.5z" fill="#ffffff" class="color000000 svgShape"></path>
</svg> Settings
                </button>
            </div>
            <div id="sections">
                ${isLoading 
                    ? '<div class="loading-spinner"><div class="spinner"></div></div>'
                    : analysis.sections.length > 0 
                        ? analysis.sections.map(section => `
                            <button 
                                class="section-button" 
                                onclick="jumpToLine(${section.lineNumber}, ${section.endLine})"
                            >
                                ${section.title}
                            </button>
                            ${section.subsections.map(subsection => `
                                <button 
                                    class="subsection-button" 
                                    onclick="jumpToSubsection(${subsection.lineNumber}, ${subsection.endLine})"
                                >
                                    ${subsection.title}
                                </button>
                            `).join('')}
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
            </script>
        </body>
        </html>
    `;
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