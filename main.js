const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const https = require('https');
const { execSync } = require('child_process');
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

// ============================================================
// Shared Transcription Helper
// ============================================================

async function transcribeAudioFile(audioBuffer, originalExtension, timestamp) {
  const tempDir = path.join(app.getPath('temp'), `psych-scribe-${timestamp}`);
  const backupDir = path.join(app.getPath('documents'), 'PsychScribe-Recordings');
  
  const fileSizeMB = audioBuffer.length / (1024 * 1024);
  console.log(`Audio file size: ${fileSizeMB.toFixed(1)} MB`);

  // Always save a backup copy first — never lose recordings
  if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
  const backupPath = path.join(backupDir, `recording-${timestamp}${originalExtension}`);
  fs.writeFileSync(backupPath, audioBuffer);
  console.log(`Backup saved: ${backupPath}`);

  // If under 24MB, transcribe directly (leave 1MB margin)
  if (audioBuffer.length < 24 * 1024 * 1024) {
    const tempPath = path.join(app.getPath('temp'), `psych-scribe-audio-${timestamp}${originalExtension}`);
    fs.writeFileSync(tempPath, audioBuffer);

    const transcription = await openai.audio.transcriptions.create({
      file: fs.createReadStream(tempPath),
      model: 'whisper-1',
      language: 'en'
    });

    fs.unlinkSync(tempPath);
    return { success: true, text: transcription.text };
  }

  // Large file — split into 10-minute chunks via ffmpeg
  console.log('Large recording detected, splitting into chunks...');
  if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

  const fullPath = path.join(tempDir, `full-${timestamp}${originalExtension}`);
  fs.writeFileSync(fullPath, audioBuffer);

  // Split into 10-minute segments (well under 25MB each)
  const { execSync } = require('child_process');
  try {
    execSync(`ffmpeg -i "${fullPath}" -f segment -segment_time 600 -c copy "${tempDir}/chunk-%03d${originalExtension}" 2>/dev/null`, { timeout: 30000 });
  } catch (ffmpegErr) {
    // If ffmpeg not found or fails, try converting to mp3 first (smaller) then send
    console.log('ffmpeg segment failed, trying mp3 conversion...');
    try {
      const mp3Path = path.join(tempDir, `full-${timestamp}.mp3`);
      execSync(`ffmpeg -i "${fullPath}" -b:a 32k -ac 1 -ar 16000 "${mp3Path}" 2>/dev/null`, { timeout: 60000 });
      
      const mp3Stats = fs.statSync(mp3Path);
      if (mp3Stats.size < 24 * 1024 * 1024) {
        const transcription = await openai.audio.transcriptions.create({
          file: fs.createReadStream(mp3Path),
          model: 'whisper-1',
          language: 'en'
        });
        // Cleanup
        fs.rmSync(tempDir, { recursive: true, force: true });
        return { success: true, text: transcription.text };
      }
      // If still too large, split the mp3
      execSync(`ffmpeg -i "${mp3Path}" -f segment -segment_time 600 -c copy "${tempDir}/chunk-%03d.mp3" 2>/dev/null`, { timeout: 30000 });
    } catch (e2) {
      fs.rmSync(tempDir, { recursive: true, force: true });
      return { success: false, error: `Recording too large (${fileSizeMB.toFixed(0)}MB) and ffmpeg is not available to split it. Your recording is saved at: ${backupPath}` };
    }
  }

  // Transcribe each chunk and concatenate
  const chunkFiles = fs.readdirSync(tempDir)
    .filter(f => f.startsWith('chunk-'))
    .sort();

  if (chunkFiles.length === 0) {
    fs.rmSync(tempDir, { recursive: true, force: true });
    return { success: false, error: `Could not split recording. Your recording is saved at: ${backupPath}` };
  }

  console.log(`Split into ${chunkFiles.length} chunks, transcribing...`);
  const transcripts = [];

  for (const chunkFile of chunkFiles) {
    const chunkPath = path.join(tempDir, chunkFile);
    console.log(`Transcribing ${chunkFile}...`);
    const transcription = await openai.audio.transcriptions.create({
      file: fs.createReadStream(chunkPath),
      model: 'whisper-1',
      language: 'en'
    });
    transcripts.push(transcription.text);
  }

  // Cleanup temp dir
  fs.rmSync(tempDir, { recursive: true, force: true });

  const fullText = transcripts.join(' ');
  return { success: true, text: fullText };
}

// ============================================================
// Whisper transcription handler
// ============================================================

ipcMain.handle('transcribe-audio', async (event, audioData) => {
  if (!openai) {
    return { success: false, error: 'OpenAI API key not configured', needsKey: true };
  }

  const timestamp = Date.now();

  try {
    // audioData is a base64 encoded webm audio
    const audioBuffer = Buffer.from(audioData, 'base64');
    return await transcribeAudioFile(audioBuffer, '.webm', timestamp);
  } catch (e) {
    console.error('Transcription error:', e);
    const backupDir = path.join(app.getPath('documents'), 'PsychScribe-Recordings');
    return { success: false, error: `${e.message}. Your recording is saved at: ${backupDir}/recording-${timestamp}.webm` };
  }
});

// ============================================================
// Import Audio handler
// ============================================================

ipcMain.handle('import-audio', async () => {
  if (!openai) {
    return { success: false, error: 'OpenAI API key not configured', needsKey: true };
  }

  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Import Audio File',
    filters: [
      { name: 'Audio Files', extensions: ['mp3', 'm4a', 'wav', 'webm', 'ogg', 'aac'] }
    ],
    properties: ['openFile']
  });

  if (result.canceled || result.filePaths.length === 0) {
    return { success: false, canceled: true };
  }

  const filePath = result.filePaths[0];
  const timestamp = Date.now();
  const extension = path.extname(filePath);

  try {
    // Read the audio file
    const audioBuffer = fs.readFileSync(filePath);
    
    // Use the shared transcription helper
    return await transcribeAudioFile(audioBuffer, extension, timestamp);
  } catch (e) {
    console.error('Import audio error:', e);
    const backupDir = path.join(app.getPath('documents'), 'PsychScribe-Recordings');
    return { success: false, error: `${e.message}. Your file is backed up at: ${backupDir}/recording-${timestamp}${extension}` };
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

ipcMain.handle('get-version', async () => {
  return app.getVersion();
});

ipcMain.handle('generate-note', async (event, { site, type, transcript, pdfContext }) => {
  if (!anthropic) {
    return { success: false, error: 'API key not configured' };
  }

  const prompt = getPrompt(site, type, transcript);
  
  // Append PDF context to user message if available
  let userMessage = prompt.user;
  if (pdfContext && pdfContext.length > 0) {
    const pdfTexts = pdfContext.map((pdf, idx) => 
      `--- Reference Document ${idx + 1}: ${pdf.fileName} ---\n${pdf.text}`
    ).join('\n\n');
    userMessage += `\n\nThe following reference documents are attached for context. Use this information to inform the note:\n\n${pdfTexts}`;
  }
  
  try {
    const response = await anthropic.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 4096,
      system: prompt.system,
      messages: [{ role: 'user', content: userMessage }]
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
      model: 'claude-opus-4-6',
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
  // Shared style rules for all note types (v2.6.1)
  const sharedRules = `
ABBREVIATION RULES (strict):
- ALWAYS abbreviate: mg (never "milligram"), MDD (never "major depressive disorder"), SUD (never "substance use disorder"), GAD (never "generalized anxiety disorder"), BPD (never "borderline personality disorder"), BPAD (never "bipolar affective disorder"), ASD (never "autism spectrum disorder"), OCD (never "obsessive-compulsive disorder"), PTSD (never "post-traumatic stress disorder"), sx (symptoms), dx (diagnosis), tx (treatment)
- Schizophrenia: OK to write out
- Standard ED/psych abbreviations: SI, HI, AVH, PES, Tx, Hx, Dx, Rx, Sx, Pt, c/o, r/o, s/p, w/, w/o, D/C, LOC, DTS/DTO, WNL, A&O, PRN, PO, IM

FORMATTING RULES:
- After the opening sentence (name, age, gender, dx, chief complaint), skip a line
- Begin the next paragraph with the client's NAME and state whether there are acute safety concerns. Example: "Bob denies SI, HI, or AVH."
- After that, begin the next sentence with the client's name + "says..." or "reports..." (topic sentence style)
- Output PLAIN TEXT ONLY — no bold, no headers, no markdown formatting
- NO bullet points or numbering
- Use brief paragraphs
- Maintain clinical objectivity — concise, natural, not robotic or overly polished
- Write like a busy ED clinician, not a polished AI. Short sentences. No filler. No hedging language ("it is worth noting", "importantly", "notably"). No over-summarizing. If the transcript says it simply, say it simply.
- NEVER spell out abbreviations that any ED clinician would know — use the short form always.
- Dr. Jacqui (not Jackie)`;

  const unityRules = `
UNITY-SPECIFIC RULES:
- Say "PES" — never write out "Psychiatric Emergency Services"
- Only use the word "admission" if the plan is to admit to an inpatient unit
- If staying on PES, say "for a period of crisis stabilization on PES" or "PES level of care" — never "admission"
- Do NOT include MSE (mental status exam) in the Assessment — MSE is a separate point-and-click section in Epic and would be redundant`;

  const voaRules = `
VOA-SPECIFIC RULES:
- Never say "presenting to the VOA residential treatment program" — the audience are VOA employees who already know this. Just say "presenting for an initial psych eval"
- Do NOT include MSE (mental status exam) in the Assessment — MSE is a separate section and would be redundant
- Adderall: per VOA policy, stimulants can technically be prescribed but only after 90 days of sobriety — in practice this is extremely rare (avoid recommending unless explicitly mentioned in transcript)`;

  const prompts = {
    'unity-new': {
      system: `You are a psychiatric documentation assistant for a PMHNP working at Unity Center for Behavioral Health (psychiatric emergency department). Generate clinical notes from session transcripts.

IMPORTANT: The transcript is dictated by the CLINICIAN (the PMHNP). The clinician is describing their encounter with a patient. Do NOT confuse the clinician with the patient. The clinician's name is Lorenzo — he is NEVER the patient.
${sharedRules}
${unityRules}

Do NOT include labels like "HPI:" or "Assessment:" — just the content.

Output TWO sections separated by ===SECTION_BREAK===

FIRST SECTION (HPI - History of Present Illness):
- Opening sentence format: "[Name] is a [age] [gender] with [diagnoses] reporting [chief concern]."
- ONLY include the patient's narrative and self-report
- What the patient says happened, their sx, their concerns, their history
- Do NOT include clinical observations, diagnostic impressions, or MSE findings here
- Simple narrative paragraphs — this is the patient's story in their words

===SECTION_BREAK===

SECOND SECTION (Assessment):
- Same opening sentence as HPI
- Diagnostic impression and clinical formulation
- Risk assessment (SI/HI, safety factors)
- "Plan of care to include..." — tx plan, disposition
- If medications discussed, use PARQ framework and note that options were provided to client
- This section is YOUR clinical analysis, not patient report`,
      user: transcript
        ? `Generate an HPI and Assessment from this transcript. Remember: plain text only, no headers or bold, separate the two sections with ===SECTION_BREAK===\n\n${transcript}`
        : `Generate an HPI and Assessment from the attached reference documents. Remember: plain text only, no headers or bold, separate the two sections with ===SECTION_BREAK===`
    },
    
    'unity-reassess': {
      system: `You are a psychiatric documentation assistant for a PMHNP working at Unity Center for Behavioral Health (psychiatric emergency department). Generate reassessment notes from session transcripts.

IMPORTANT: The transcript is dictated by the CLINICIAN (the PMHNP). The clinician is describing their encounter with a patient. Do NOT confuse the clinician with the patient. The clinician's name is Lorenzo — he is NEVER the patient.
${sharedRules}
${unityRules}

Do NOT include labels like "Internal Subjective:" or "Assessment:" — just the content.

Output TWO sections separated by ===SECTION_BREAK===

FIRST SECTION (Internal Subjective):
- Opening sentence format: "[Name] is a [age] [gender] with [diagnoses] reporting [chief concern/update]."
- Document interval changes, current status, patient's subjective report
- Simple narrative paragraphs

===SECTION_BREAK===

SECOND SECTION (Assessment):
- Same opening sentence
- Diagnostic impression (updated if applicable)
- Risk assessment (current)
- "Plan of care to include..." — updated tx plan, disposition
- If medications discussed, use PARQ framework and note that options were provided to client`,
      user: transcript
        ? `Generate an Internal Subjective and Assessment from this transcript. Remember: plain text only, no headers or bold, separate with ===SECTION_BREAK===\n\n${transcript}`
        : `Generate an Internal Subjective and Assessment from the attached reference documents. Remember: plain text only, no headers or bold, separate with ===SECTION_BREAK===`
    },
    
    'voa-new': {
      system: `You are a psychiatric documentation assistant for a PMHNP working at VOA (Volunteers of America) residential treatment programs. Generate assessment notes from session transcripts for CareLogic EHR.

IMPORTANT: The transcript is dictated by the CLINICIAN (the PMHNP). The clinician is describing their encounter with a patient. Do NOT confuse the clinician with the patient. The clinician's name is Lorenzo — he is NEVER the patient.
${sharedRules}
${voaRules}

Maximum 3850 characters total (hard limit for CareLogic).

Output ONE section (Assessment/Formulation):
- Opening sentence format: "[Name] is a [age] [gender] with [diagnoses] presenting for an initial psych eval."
- What the patient is reporting
- Diagnostic impression with clinical reasoning
- Risk assessment
- "Plan of care to include..." — tx plan, coordination efforts
- If medications discussed, use PARQ framework and note that options were provided to client`,
      user: transcript
        ? `Generate an Assessment/Formulation from this transcript. Plain text only, no headers or bold formatting:\n\n${transcript}`
        : `Generate an Assessment/Formulation from the attached reference documents. Plain text only, no headers or bold formatting.`
    },
    
    'voa-reassess': {
      system: `You are a psychiatric documentation assistant for a PMHNP working at VOA (Volunteers of America) residential treatment programs. Generate SOAP progress notes from session transcripts for CareLogic EHR.

IMPORTANT: The transcript is dictated by the CLINICIAN (the PMHNP). The clinician is describing their encounter with a patient. Do NOT confuse the clinician with the patient. The clinician's name is Lorenzo — he is NEVER the patient.
${sharedRules}
${voaRules}

Output FOUR separate sections with these exact labels (the labels will be stripped for copy/paste into CareLogic's separate fields):

**S:**
(~500-800 chars) Opening: "[Name] is a [age] [gender] with [diagnoses]..." Patient's subjective report, interval history, current concerns. What they tell you.

**O:**
(~300-500 chars) "On approach..." — observations, appearance, behavior, affect. Vitals or relevant objective data if available.

**A:**
(~500-800 chars) Diagnostic impression. Clinical reasoning. Risk assessment (current).

**P:**
(~400-600 chars) "Plan of care to include..." Tx adjustments, medication changes (use PARQ if applicable). Coordination efforts, follow-up. Note that medication options were provided to client if applicable.`,
      user: transcript
        ? `Generate a SOAP note (4 separate sections: S, O, A, P) from this transcript:\n\n${transcript}`
        : `Generate a SOAP note (4 separate sections: S, O, A, P) from the attached reference documents.`
    }
  };

  const key = `${site}-${type}`;
  return prompts[key] || prompts['unity-new'];
}

// ============================================================
// Auto-Update System (GitHub Releases)
// ============================================================

const UPDATE_REPO = 'mae-cto-bot/psych-scribe-releases';
const UPDATE_API = `https://api.github.com/repos/${UPDATE_REPO}/releases/latest`;

function compareVersions(current, latest) {
  const c = current.replace(/^v/, '').split('.').map(Number);
  const l = latest.replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((l[i] || 0) > (c[i] || 0)) return 1;
    if ((l[i] || 0) < (c[i] || 0)) return -1;
  }
  return 0;
}

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    const request = (reqUrl) => {
      https.get(reqUrl, { headers: { 'User-Agent': 'PsychScribe' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          request(res.headers.location);
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => resolve(Buffer.concat(chunks)));
        res.on('error', reject);
      }).on('error', reject);
    };
    request(url);
  });
}

async function checkForUpdate() {
  try {
    const data = JSON.parse(await httpsGet(UPDATE_API));
    const latestVersion = data.tag_name;
    const currentVersion = app.getVersion();

    if (compareVersions(currentVersion, latestVersion) > 0) {
      const dmgAsset = data.assets.find(a => a.name.endsWith('.dmg'));
      if (!dmgAsset) return null;
      return {
        version: latestVersion,
        currentVersion,
        downloadUrl: dmgAsset.browser_download_url,
        size: dmgAsset.size,
        notes: data.body || ''
      };
    }
    return null;
  } catch (e) {
    console.log('Update check failed:', e.message);
    return null;
  }
}

async function installUpdate(downloadUrl, version) {
  const tmpDir = os.tmpdir();
  const dmgPath = path.join(tmpDir, `PsychScribe-${version}.dmg`);
  const appName = 'Psych Scribe';
  const dest = '/Applications';

  // Download DMG
  mainWindow.webContents.send('update-progress', 'downloading');
  const dmgData = await httpsGet(downloadUrl);
  fs.writeFileSync(dmgPath, dmgData);

  // Mount DMG
  mainWindow.webContents.send('update-progress', 'installing');
  const mountOutput = execSync(`hdiutil attach "${dmgPath}" -nobrowse -quiet 2>&1 | grep "/Volumes" | awk -F'\\t' '{print $NF}' | head -1`, { encoding: 'utf8' }).trim();

  if (!mountOutput) {
    throw new Error('Failed to mount DMG');
  }

  try {
    // Remove old app
    const destApp = path.join(dest, `${appName}.app`);
    if (fs.existsSync(destApp)) {
      execSync(`rm -rf "${destApp}"`);
    }

    // Copy new app
    execSync(`cp -R "${mountOutput}/${appName}.app" "${dest}/"`);

    // Remove quarantine
    execSync(`xattr -cr "${destApp}"`);
  } finally {
    // Unmount
    try { execSync(`hdiutil detach "${mountOutput}" -quiet`); } catch (e) {}
    // Clean up temp
    try { fs.unlinkSync(dmgPath); } catch (e) {}
  }

  // Relaunch
  mainWindow.webContents.send('update-progress', 'relaunching');
  setTimeout(() => {
    app.relaunch();
    app.exit(0);
  }, 500);
}

ipcMain.handle('check-for-update', async () => {
  return await checkForUpdate();
});

ipcMain.handle('install-update', async (event, { downloadUrl, version }) => {
  try {
    await installUpdate(downloadUrl, version);
    return { success: true };
  } catch (e) {
    console.error('Update failed:', e);
    return { success: false, error: e.message };
  }
});
