const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const Anthropic = require('@anthropic-ai/sdk');
const OpenAI = require('openai');

// Polyfill for pdf-parse compatibility with Electron
global.DOMMatrix = class DOMMatrix {
  constructor() { this.a = 1; this.b = 0; this.c = 0; this.d = 1; this.e = 0; this.f = 0; }
};
global.Path2D = class Path2D { constructor() {} };

const { PDFParse } = require('pdf-parse');

// Config path
const CONFIG_DIR = path.join(os.homedir(), '.psych-scribe');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');

let mainWindow;
let anthropic = null;
let openai = null;

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    }
  } catch (e) {
    console.error('Failed to load config:', e);
  }
  return {};
}

function saveConfig(config) {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }
  // Merge with existing config to preserve other keys
  const existing = loadConfig();
  const merged = { ...existing, ...config };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2));
  return merged;
}

function initAnthropic(apiKey) {
  anthropic = new Anthropic({ apiKey });
}

function initOpenAI(apiKey) {
  openai = new OpenAI({ apiKey });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1000,
    height: 850,
    minWidth: 700,
    minHeight: 600,
    title: 'Psych Scribe',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 15, y: 15 },
    backgroundColor: '#f5f5f7',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadFile('index.html');
  
  // Hide menu bar for cleaner look (non-macOS)
  mainWindow.setMenuBarVisibility(false);
}

app.whenReady().then(() => {
  const config = loadConfig();
  if (config.apiKey) {
    initAnthropic(config.apiKey);
  }
  if (config.openaiApiKey) {
    initOpenAI(config.openaiApiKey);
  }
  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

// IPC Handlers
ipcMain.handle('check-api-key', () => {
  return anthropic !== null;
});

ipcMain.handle('save-api-key', (event, apiKey) => {
  try {
    saveConfig({ apiKey });
    initAnthropic(apiKey);
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// OpenAI API key handlers
ipcMain.handle('check-openai-key', () => {
  return openai !== null;
});

ipcMain.handle('save-openai-key', (event, apiKey) => {
  try {
    saveConfig({ openaiApiKey: apiKey });
    initOpenAI(apiKey);
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// Whisper transcription handler
ipcMain.handle('transcribe-audio', async (event, audioData) => {
  if (!openai) {
    return { success: false, error: 'OpenAI API key not configured', needsKey: true };
  }

  try {
    // audioData is a base64 encoded webm audio
    const audioBuffer = Buffer.from(audioData, 'base64');
    
    // Write to temp file (File API doesn't exist in Node.js)
    const tempPath = path.join(app.getPath('temp'), `psych-scribe-audio-${Date.now()}.webm`);
    fs.writeFileSync(tempPath, audioBuffer);
    
    // Use OpenAI SDK for transcription with file stream
    const transcription = await openai.audio.transcriptions.create({
      file: fs.createReadStream(tempPath),
      model: 'whisper-1',
      language: 'en'
    });
    
    // Clean up temp file
    fs.unlinkSync(tempPath);
    
    return { success: true, text: transcription.text };
  } catch (e) {
    console.error('Transcription error:', e);
    return { success: false, error: e.message };
  }
});

// Sync config handlers
ipcMain.handle('get-sync-config', async () => {
  const config = loadConfig();
  return {
    serverUrl: config.syncServerUrl || '',
    authToken: config.syncAuthToken || '',
    enabled: config.syncEnabled || false
  };
});

ipcMain.handle('save-sync-config', async (event, { serverUrl, authToken, enabled }) => {
  try {
    saveConfig({ syncServerUrl: serverUrl, syncAuthToken: authToken, syncEnabled: enabled });
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('generate-note', async (event, { site, type, transcript }) => {
  if (!anthropic) {
    return { success: false, error: 'API key not configured' };
  }

  const prompt = getPrompt(site, type, transcript);
  
  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4096,
      system: prompt.system,
      messages: [{ role: 'user', content: prompt.user }]
    });
    
    const content = response.content[0].text;
    return { success: true, content, site, type };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// PDF attachment handler
ipcMain.handle('attach-pdf', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Attach PDF Document',
    filters: [{ name: 'PDF Files', extensions: ['pdf'] }],
    properties: ['openFile']
  });
  
  if (result.canceled || result.filePaths.length === 0) {
    return { success: false, canceled: true };
  }
  
  const filePath = result.filePaths[0];
  const fileName = path.basename(filePath);
  
  try {
    const dataBuffer = fs.readFileSync(filePath);
    const parser = new PDFParse({ data: new Uint8Array(dataBuffer) });
    const doc = await parser.load();
    const textResult = await parser.getText();
    const text = textResult.pages ? textResult.pages.map(p => p.text).join('\n\n') : String(textResult);
    
    return {
      success: true,
      fileName: fileName,
      filePath: filePath,
      text: text,
      numPages: doc.numPages
    };
  } catch (e) {
    console.error('PDF parse error:', e);
    return { success: false, error: e.message };
  }
});

// ============================================================
// Guidelines Library Handlers
// ============================================================

ipcMain.handle('get-guidelines', () => {
  const config = loadConfig();
  return config.guidelines || [];
});

ipcMain.handle('save-guideline', (event, { name, filePath }) => {
  try {
    const config = loadConfig();
    const guidelines = config.guidelines || [];
    
    // Check if already exists (by path)
    if (guidelines.some(g => g.path === filePath)) {
      return { success: false, error: 'This guideline is already in your library.' };
    }
    
    guidelines.push({ name, path: filePath });
    saveConfig({ guidelines });
    return { success: true, guidelines };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('remove-guideline', (event, filePath) => {
  try {
    const config = loadConfig();
    const guidelines = (config.guidelines || []).filter(g => g.path !== filePath);
    saveConfig({ guidelines });
    return { success: true, guidelines };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('rename-guideline', (event, { filePath, newName }) => {
  try {
    const config = loadConfig();
    const guidelines = config.guidelines || [];
    const guideline = guidelines.find(g => g.path === filePath);
    if (guideline) {
      guideline.name = newName;
      saveConfig({ guidelines });
      return { success: true, guidelines };
    }
    return { success: false, error: 'Guideline not found.' };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('load-guideline-pdf', async (event, filePath) => {
  try {
    // Check if file exists
    if (!fs.existsSync(filePath)) {
      return { success: false, error: 'File not found. It may have been moved or deleted.', notFound: true };
    }
    
    const dataBuffer = fs.readFileSync(filePath);
    const parser = new PDFParse({ data: new Uint8Array(dataBuffer) });
    const doc = await parser.load();
    const textResult = await parser.getText();
    const text = textResult.pages ? textResult.pages.map(p => p.text).join('\n\n') : String(textResult);
    const fileName = path.basename(filePath);
    
    return {
      success: true,
      fileName: fileName,
      filePath: filePath,
      text: text,
      numPages: doc.numPages
    };
  } catch (e) {
    console.error('PDF parse error:', e);
    return { success: false, error: e.message };
  }
});

// Refinement handler for iterative editing
ipcMain.handle('refine-note', async (event, { site, type, transcript, currentOutput, feedback, pdfContext }) => {
  if (!anthropic) {
    return { success: false, error: 'API key not configured' };
  }

  const prompt = getPrompt(site, type, transcript);
  
  // Build context string with PDF content if attached
  let pdfContextSection = '';
  if (pdfContext && pdfContext.length > 0) {
    const pdfTexts = pdfContext.map((pdf, idx) => 
      `--- Reference Document ${idx + 1}: ${pdf.fileName} ---\n${pdf.text}`
    ).join('\n\n');
    pdfContextSection = `

REFERENCE DOCUMENTS ATTACHED:
The user has attached the following reference documents for context. Use this information to inform the note revision when relevant:

${pdfTexts}

---`;
  }
  
  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4096,
      system: prompt.system + `

IMPORTANT: The user has already generated a note and wants to refine it. They will provide the current output and their feedback. Apply their feedback while maintaining the same format and style. Keep the same structure and section labels.${pdfContextSection}`,
      messages: [
        { role: 'user', content: prompt.user },
        { role: 'assistant', content: currentOutput },
        { role: 'user', content: `Please revise the note based on this feedback: ${feedback}` }
      ]
    });
    
    const content = response.content[0].text;
    return { success: true, content, site, type };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

function getPrompt(site, type, transcript) {
  const prompts = {
    'unity-new': {
      system: `You are a psychiatric documentation assistant for a PMHNP working at Unity Center for Behavioral Health (psychiatric emergency department). Generate clinical notes from session transcripts.

Rules:
- Write in conversational narrative that is simple, straightforward, and concise
- NO bullet points, numbering, or informal shortcuts
- Use brief paragraphs
- Maintain therapeutic, neutral language with clinical objectivity
- Dr. Jacqui (not Jackie)
- Output PLAIN TEXT ONLY — no bold, no headers, no markdown formatting
- Do NOT include labels like "HPI:" or "Assessment:" — just the content

Output TWO sections separated by ===SECTION_BREAK===

FIRST SECTION (HPI - History of Present Illness):
- Opening sentence format: "[Name] is a [age] [gender] with [diagnoses] reporting [chief concern]."
- ONLY include the patient's narrative and self-report
- What the patient says happened, their symptoms, their concerns, their history
- Do NOT include clinical observations, diagnostic impressions, or MSE findings here
- Simple narrative paragraphs — this is the patient's story in their words

===SECTION_BREAK===

SECOND SECTION (Assessment):
- Same opening sentence as HPI
- "On approach..." — describe YOUR observations (appearance, behavior, affect, MSE)
- Diagnostic impression and clinical formulation
- Risk assessment (SI/HI, safety factors)
- "Plan of care to include..." — treatment plan, disposition
- If medications discussed, use PARQ framework and note that options were provided to client
- This section is YOUR clinical analysis, not patient report`,
      user: `Generate an HPI and Assessment from this transcript. Remember: plain text only, no headers or bold, separate the two sections with ===SECTION_BREAK===\n\n${transcript}`
    },
    
    'unity-reassess': {
      system: `You are a psychiatric documentation assistant for a PMHNP working at Unity Center for Behavioral Health (psychiatric emergency department). Generate reassessment notes from session transcripts.

Rules:
- Write in conversational narrative that is simple, straightforward, and concise
- NO bullet points, numbering, or informal shortcuts
- Use brief paragraphs
- Maintain therapeutic, neutral language with clinical objectivity
- Dr. Jacqui (not Jackie)
- Output PLAIN TEXT ONLY — no bold, no headers, no markdown formatting
- Do NOT include labels like "Internal Subjective:" or "Assessment:" — just the content

Output TWO sections separated by ===SECTION_BREAK===

FIRST SECTION (Internal Subjective):
- Opening sentence format: "[Name] is a [age] [gender] with [diagnoses] reporting [chief concern/update]."
- Document interval changes, current status, patient's subjective report
- Simple narrative paragraphs

===SECTION_BREAK===

SECOND SECTION (Assessment):
- Same opening sentence
- "On approach..." — describe observations (appearance, behavior, affect)
- What the patient is reporting
- Diagnostic impression (updated if applicable)
- Risk assessment (current)
- "Plan of care to include..." — updated treatment plan, disposition
- If medications discussed, use PARQ framework and note that options were provided to client`,
      user: `Generate an Internal Subjective and Assessment from this transcript. Remember: plain text only, no headers or bold, separate with ===SECTION_BREAK===\n\n${transcript}`
    },
    
    'voa-new': {
      system: `You are a psychiatric documentation assistant for a PMHNP working at VOA (Volunteers of America) residential treatment programs. Generate assessment notes from session transcripts for CareLogic EHR.

Rules:
- Write in conversational narrative that is simple, straightforward, and concise
- Maximum 3850 characters total (this is a hard limit for CareLogic)
- NO bullet points, numbering, or informal shortcuts
- Use brief paragraphs
- Maintain therapeutic, neutral language with clinical objectivity
- Dr. Jacqui (not Jackie)
- Output PLAIN TEXT ONLY — no bold, no headers, no markdown formatting

Output ONE section (Assessment/Formulation):
- Opening sentence format: "[Name] is a [age] [gender] with [diagnoses] reporting [chief concern]."
- "On approach..." — describe observations (appearance, behavior, affect)
- What the patient is reporting
- Diagnostic impression with clinical reasoning
- Risk assessment
- "Plan of care to include..." — treatment plan, coordination efforts
- If medications discussed, use PARQ framework and note that options were provided to client`,
      user: `Generate an Assessment/Formulation from this transcript. Plain text only, no headers or bold formatting:\n\n${transcript}`
    },
    
    'voa-reassess': {
      system: `You are a psychiatric documentation assistant for a PMHNP working at VOA (Volunteers of America) residential treatment programs. Generate SOAP progress notes from session transcripts for CareLogic EHR.

Rules:
- Write in conversational narrative that is simple, straightforward, and concise
- NO bullet points, numbering, or informal shortcuts
- Use brief paragraphs
- Maintain therapeutic, neutral language with clinical objectivity
- Dr. Jacqui (not Jackie)

Output FOUR separate sections with these exact labels (the labels will be stripped for copy/paste into CareLogic's separate fields):

**S:**
(~500-800 chars) Opening: "[Name] is a [age] [gender] with [diagnoses]..." Patient's subjective report, interval history, current concerns. What they tell you.

**O:**
(~300-500 chars) "On approach..." — observations, appearance, behavior, affect. Mental status elements. Vitals or relevant objective data if available.

**A:**
(~500-800 chars) Diagnostic impression. Clinical reasoning. Risk assessment (current).

**P:**
(~400-600 chars) "Plan of care to include..." Treatment adjustments, medication changes (use PARQ if applicable). Coordination efforts, follow-up. Note that medication options were provided to client if applicable.`,
      user: `Generate a SOAP note (4 separate sections: S, O, A, P) from this transcript:\n\n${transcript}`
    }
  };

  const key = `${site}-${type}`;
  return prompts[key] || prompts['unity-new'];
}
