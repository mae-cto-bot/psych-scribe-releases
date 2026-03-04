// ============================================================
// Psych Scribe v2 - Renderer
// ============================================================

// Fallback if sync.js didn't load
if (typeof psSync === 'undefined') {
  var psSync = { configure() {}, healthCheck() { return { ok: false }; }, syncNote() {} };
}

// DOM Elements
const setupModal = document.getElementById('setup-modal');
const apiKeyInput = document.getElementById('api-key-input');
const saveKeyBtn = document.getElementById('save-key-btn');

// OpenAI Modal Elements
const openaiModal = document.getElementById('openai-modal');
const openaiKeyInput = document.getElementById('openai-key-input');
const saveOpenAIKeyBtn = document.getElementById('save-openai-key-btn');
const skipOpenAIBtn = document.getElementById('skip-openai-btn');

// Recording Elements
const recordBtn = document.getElementById('record-btn');
const importAudioBtn = document.getElementById('import-audio-btn');
const transcribingIndicator = document.getElementById('transcribing-indicator');
const siteSelect = document.getElementById('site-select');
const typeSelect = document.getElementById('type-select');
const transcript = document.getElementById('transcript');
const generateBtn = document.getElementById('generate-btn');
const clearBtn = document.getElementById('clear-btn');
const unityOutput = document.getElementById('unity-output');
const voaNewOutput = document.getElementById('voa-new-output');
const soapOutput = document.getElementById('soap-output');
const outputHpi = document.getElementById('output-hpi');
const outputAssessment = document.getElementById('output-assessment');
const outputVoaNew = document.getElementById('output-voa-new');
const loading = document.getElementById('loading');
const loadingText = document.getElementById('loading-text');
const tabsContainer = document.getElementById('tabs-container');
const newTabBtn = document.getElementById('new-tab-btn');
const refinementSection = document.getElementById('refinement-section');
const refinementInput = document.getElementById('refinement-input');
const refineBtn = document.getElementById('refine-btn');
const charCountSingle = document.getElementById('char-count-single');

// PDF Attachment Elements
const attachPdfBtn = document.getElementById('attach-pdf-btn');
const attachPdfInputBtn = document.getElementById('attach-pdf-input-btn');
const pdfAttachments = document.getElementById('pdf-attachments');
const pdfAttachmentsInput = document.getElementById('pdf-attachments-input');
const pdfList = document.getElementById('pdf-list');
const pdfListInput = document.getElementById('pdf-list-input');

// Guidelines Library Elements
const guidelinesBtn = document.getElementById('guidelines-btn');
const guidelinesModal = document.getElementById('guidelines-modal');
const closeGuidelinesModal = document.getElementById('close-guidelines-modal');
const guidelinesList = document.getElementById('guidelines-list');
const guidelinesEmpty = document.getElementById('guidelines-empty');
const saveToLibraryToast = document.getElementById('save-to-library-toast');
const saveToLibraryBtn = document.getElementById('save-to-library-btn');
const dismissToastBtn = document.getElementById('dismiss-toast-btn');

// Version bars
const versionBarSingle = document.getElementById('version-bar-single');
const versionPillsSingle = document.getElementById('version-pills-single');
const versionBarSoap = document.getElementById('version-bar-soap');
const versionPillsSoap = document.getElementById('version-pills-soap');

// SOAP fields
const soapFields = {
  s: document.getElementById('soap-s'),
  o: document.getElementById('soap-o'),
  a: document.getElementById('soap-a'),
  p: document.getElementById('soap-p')
};

// ============================================================
// Session Management (Multi-tab)
// ============================================================

let sessions = [];
let activeSessionId = null;
let sessionCounter = 0;

// Recording state
let mediaRecorder = null;
let audioChunks = [];
let recordingStartTime = null;
let recordingTimer = null;
let hasOpenAIKey = false;

// Guidelines library state
let guidelines = [];
let lastAttachedPdf = null; // Track last attached PDF for "Save to Library" prompt

function createSession(label = null) {
  sessionCounter++;
  const session = {
    id: `session-${sessionCounter}`,
    label: label || `Session ${sessionCounter}`,
    site: 'unity',
    type: 'new',
    transcript: '',
    versions: [],         // Array of outputs (version history)
    currentVersion: -1,   // Index of currently viewed version
    soapVersions: [],     // For SOAP notes
    currentSoapVersion: -1,
    pdfAttachments: []    // Array of { fileName, text, numPages }
  };
  sessions.push(session);
  return session;
}

function getActiveSession() {
  return sessions.find(s => s.id === activeSessionId);
}

function saveSessionState() {
  const session = getActiveSession();
  if (!session) return;
  
  session.site = siteSelect.value;
  session.type = typeSelect.value;
  session.transcript = transcript.value;
}

function loadSessionState() {
  const session = getActiveSession();
  if (!session) return;
  
  siteSelect.value = session.site;
  typeSelect.value = session.type;
  transcript.value = session.transcript;
  
  updateOutputVisibility();
  renderVersions();
  updateRefinementVisibility();
  renderPdfAttachments();
}

function switchToSession(sessionId) {
  if (activeSessionId) {
    saveSessionState();
  }
  
  activeSessionId = sessionId;
  loadSessionState();
  renderTabs();
}

function closeSession(sessionId) {
  const idx = sessions.findIndex(s => s.id === sessionId);
  if (idx === -1) return;
  
  sessions.splice(idx, 1);
  
  if (sessions.length === 0) {
    // Create new session if we closed the last one
    const newSession = createSession();
    activeSessionId = newSession.id;
    loadSessionState();
  } else if (activeSessionId === sessionId) {
    // Switch to nearest session
    const newIdx = Math.min(idx, sessions.length - 1);
    activeSessionId = sessions[newIdx].id;
    loadSessionState();
  }
  
  renderTabs();
}

function renderTabs() {
  tabsContainer.innerHTML = '';
  
  sessions.forEach(session => {
    const tab = document.createElement('button');
    tab.className = `tab${session.id === activeSessionId ? ' active' : ''}`;
    tab.innerHTML = `
      <span class="tab-label">${session.label}</span>
      <span class="close-tab" title="Close">×</span>
    `;
    
    tab.querySelector('.tab-label').addEventListener('click', () => {
      switchToSession(session.id);
    });
    
    tab.querySelector('.close-tab').addEventListener('click', (e) => {
      e.stopPropagation();
      closeSession(session.id);
    });
    
    // Double-click to rename
    tab.querySelector('.tab-label').addEventListener('dblclick', () => {
      const newLabel = prompt('Rename session:', session.label);
      if (newLabel && newLabel.trim()) {
        session.label = newLabel.trim();
        renderTabs();
      }
    });
    
    tabsContainer.appendChild(tab);
  });
}

// ============================================================
// Version History
// ============================================================

function addVersion(content, outputType = 'single') {
  const session = getActiveSession();
  if (!session) return;
  
  if (outputType === 'soap') {
    session.soapVersions.push({ ...content });
    session.currentSoapVersion = session.soapVersions.length - 1;
  } else if (outputType === 'unity') {
    // Store Unity sections
    if (!session.unityVersions) session.unityVersions = [];
    session.unityVersions.push({ ...content });
    session.currentUnityVersion = session.unityVersions.length - 1;
  } else if (outputType === 'voa-new') {
    // Store VOA New (with char count)
    if (!session.voaNewVersions) session.voaNewVersions = [];
    session.voaNewVersions.push(content);
    session.currentVoaNewVersion = session.voaNewVersions.length - 1;
  } else {
    session.versions.push(content);
    session.currentVersion = session.versions.length - 1;
  }
  
  renderVersions();
}

function switchVersion(versionIndex, isSOAP = false) {
  const session = getActiveSession();
  if (!session) return;
  
  if (isSOAP) {
    if (versionIndex < 0 || versionIndex >= session.soapVersions.length) return;
    session.currentSoapVersion = versionIndex;
    const ver = session.soapVersions[versionIndex];
    soapFields.s.value = ver.s || '';
    soapFields.o.value = ver.o || '';
    soapFields.a.value = ver.a || '';
    soapFields.p.value = ver.p || '';
  } else {
    if (versionIndex < 0 || versionIndex >= session.versions.length) return;
    session.currentVersion = versionIndex;
    outputText.value = session.versions[versionIndex];
    updateCharCount();
  }
  
  renderVersionPills(isSOAP);
}

function renderVersions() {
  const session = getActiveSession();
  if (!session) return;
  
  const site = siteSelect.value;
  const type = typeSelect.value;
  const isSOAP = site === 'voa' && type === 'reassess';
  const isUnity = site === 'unity';
  const isVoaNew = site === 'voa' && type === 'new';
  
  // Hide all output sections first
  unityOutput.classList.add('hidden');
  voaNewOutput.classList.add('hidden');
  soapOutput.classList.add('hidden');
  
  // Unity output (HPI + Assessment separate)
  if (isUnity && session.unityVersions && session.unityVersions.length > 0) {
    unityOutput.classList.remove('hidden');
    const ver = session.unityVersions[session.currentUnityVersion];
    if (ver) {
      outputHpi.value = ver.hpi || '';
      outputAssessment.value = ver.assessment || '';
    }
  } else if (isUnity) {
    unityOutput.classList.remove('hidden');
    outputHpi.value = '';
    outputAssessment.value = '';
  }
  
  // VOA New output (single with char count)
  if (isVoaNew && session.voaNewVersions && session.voaNewVersions.length > 0) {
    voaNewOutput.classList.remove('hidden');
    outputVoaNew.value = session.voaNewVersions[session.currentVoaNewVersion] || '';
    updateCharCountVoaNew();
  } else if (isVoaNew) {
    voaNewOutput.classList.remove('hidden');
    outputVoaNew.value = '';
    updateCharCountVoaNew();
  }
  
  // SOAP output (VOA Reassess)
  if (isSOAP && session.soapVersions.length > 0) {
    soapOutput.classList.remove('hidden');
    versionBarSoap.classList.remove('hidden');
    renderVersionPills(true);
    const ver = session.soapVersions[session.currentSoapVersion];
    if (ver) {
      soapFields.s.value = ver.s || '';
      soapFields.o.value = ver.o || '';
      soapFields.a.value = ver.a || '';
      soapFields.p.value = ver.p || '';
    }
  } else if (isSOAP) {
    soapOutput.classList.remove('hidden');
    versionBarSoap.classList.add('hidden');
    Object.values(soapFields).forEach(f => f.value = '');
  }
}

function updateCharCountVoaNew() {
  const charCountEl = document.getElementById('char-count-voa-new');
  if (!charCountEl || !outputVoaNew) return;
  const len = outputVoaNew.value.length;
  const max = 3850;
  charCountEl.textContent = `${len} / ${max}`;
  charCountEl.classList.toggle('warning', len > max * 0.9);
  charCountEl.classList.toggle('over', len > max);
}

function renderVersionPills(isSOAP) {
  const session = getActiveSession();
  if (!session) return;
  
  const container = isSOAP ? versionPillsSoap : versionPillsSingle;
  const versions = isSOAP ? session.soapVersions : session.versions;
  const currentVersion = isSOAP ? session.currentSoapVersion : session.currentVersion;
  
  container.innerHTML = '';
  
  versions.forEach((_, idx) => {
    const pill = document.createElement('button');
    pill.className = `version-pill${idx === currentVersion ? ' active' : ''}`;
    pill.textContent = `v${idx + 1}`;
    pill.addEventListener('click', () => switchVersion(idx, isSOAP));
    container.appendChild(pill);
  });
}

// ============================================================
// Character Count
// ============================================================

function updateCharCount() {
  const count = outputText.value.length;
  const max = 3850;
  
  if (count > 0) {
    charCountSingle.textContent = `${count} / ${max} characters`;
    charCountSingle.classList.remove('warning', 'danger');
    if (count > max) {
      charCountSingle.classList.add('danger');
    } else if (count > max * 0.9) {
      charCountSingle.classList.add('warning');
    }
  } else {
    charCountSingle.textContent = '';
  }
}

// Add char count listener for VOA New
if (outputVoaNew) {
  outputVoaNew.addEventListener('input', updateCharCountVoaNew);
}

// ============================================================
// Output Visibility & Refinement
// ============================================================

function updateOutputVisibility() {
  const site = siteSelect.value;
  const type = typeSelect.value;
  
  // Hide all output sections
  unityOutput.classList.add('hidden');
  voaNewOutput.classList.add('hidden');
  soapOutput.classList.add('hidden');
  
  if (site === 'voa' && type === 'reassess') {
    soapOutput.classList.remove('hidden');
  } else if (site === 'unity') {
    unityOutput.classList.remove('hidden');
  } else if (site === 'voa' && type === 'new') {
    voaNewOutput.classList.remove('hidden');
  }
  
  renderVersions();
  updateRefinementVisibility();
}

function updateRefinementVisibility() {
  const session = getActiveSession();
  if (!session) return;
  
  const site = siteSelect.value;
  const type = typeSelect.value;
  const isSOAP = site === 'voa' && type === 'reassess';
  const isUnity = site === 'unity';
  const isVoaNew = site === 'voa' && type === 'new';
  
  let hasOutput = false;
  if (isSOAP) {
    hasOutput = session.soapVersions && session.soapVersions.length > 0;
  } else if (isUnity) {
    hasOutput = session.unityVersions && session.unityVersions.length > 0;
  } else if (isVoaNew) {
    hasOutput = session.voaNewVersions && session.voaNewVersions.length > 0;
  } else {
    hasOutput = session.versions && session.versions.length > 0;
  }
  
  if (hasOutput) {
    refinementSection.classList.remove('hidden');
  } else {
    refinementSection.classList.add('hidden');
  }
}

siteSelect.addEventListener('change', () => {
  saveSessionState();
  updateOutputVisibility();
});

typeSelect.addEventListener('change', () => {
  saveSessionState();
  updateOutputVisibility();
});

// ============================================================
// API Key Setup
// ============================================================

async function init() {
  const hasKey = await window.api.checkApiKey();
  if (!hasKey) {
    setupModal.classList.remove('hidden');
  }
  
  // Check for OpenAI key
  hasOpenAIKey = await window.api.checkOpenAIKey();
  updateRecordButtonState();
  
  // Load guidelines library
  await loadGuidelines();
  
  // Initialize sync
  try {
    const syncConfig = await window.api.getSyncConfig();
    if (syncConfig.enabled && syncConfig.serverUrl && syncConfig.authToken) {
      psSync.configure({ serverUrl: syncConfig.serverUrl, authToken: syncConfig.authToken });
      const health = await psSync.healthCheck();
      console.log('Sync server:', health.ok ? 'connected' : 'unreachable');
    }
  } catch (e) {
    console.warn('Sync init:', e.message);
  }
  
  // Set version from package.json
  try {
    const version = await window.api.getVersion();
    document.getElementById('app-version').textContent = `v${version}`;
  } catch (e) {
    document.getElementById('app-version').textContent = '';
  }

  // Create initial session
  const session = createSession();
  activeSessionId = session.id;
  renderTabs();
  loadSessionState();

  // Check for updates (non-blocking)
  checkForAppUpdate();
}

// ============================================================
// Auto-Update
// ============================================================

const updateBanner = document.getElementById('update-banner');
const updateMessage = document.getElementById('update-message');
const updateBtn = document.getElementById('update-btn');
let pendingUpdate = null;

async function checkForAppUpdate() {
  try {
    const update = await window.api.checkForUpdate();
    if (update) {
      pendingUpdate = update;
      updateMessage.textContent = `Update available: ${update.version}`;
      updateBanner.classList.remove('hidden');
    }
  } catch (e) {
    console.log('Update check skipped:', e.message);
  }
}

updateBtn.addEventListener('click', async () => {
  if (!pendingUpdate) return;

  updateBtn.disabled = true;
  updateMessage.textContent = 'Downloading update...';

  try {
    const result = await window.api.installUpdate({
      downloadUrl: pendingUpdate.downloadUrl,
      version: pendingUpdate.version
    });
    if (!result.success) {
      updateMessage.textContent = 'Update failed: ' + result.error;
      updateBtn.disabled = false;
      updateBtn.textContent = 'Retry';
    }
  } catch (e) {
    updateMessage.textContent = 'Update failed: ' + e.message;
    updateBtn.disabled = false;
    updateBtn.textContent = 'Retry';
  }
});

window.api.onUpdateProgress((status) => {
  const messages = {
    downloading: 'Downloading update...',
    installing: 'Installing...',
    relaunching: 'Relaunching...'
  };
  updateMessage.textContent = messages[status] || status;
  updateBtn.classList.add('hidden');
});

saveKeyBtn.addEventListener('click', async () => {
  const key = apiKeyInput.value.trim();
  if (!key) return;
  
  const result = await window.api.saveApiKey(key);
  if (result.success) {
    setupModal.classList.add('hidden');
    // Check if user has OpenAI key, if not show that modal
    hasOpenAIKey = await window.api.checkOpenAIKey();
    if (!hasOpenAIKey) {
      openaiModal.classList.remove('hidden');
    }
  } else {
    alert('Failed to save API key: ' + result.error);
  }
});

// OpenAI Key Setup
saveOpenAIKeyBtn.addEventListener('click', async () => {
  const key = openaiKeyInput.value.trim();
  if (!key) return;
  
  const result = await window.api.saveOpenAIKey(key);
  if (result.success) {
    hasOpenAIKey = true;
    openaiModal.classList.add('hidden');
    updateRecordButtonState();
  } else {
    alert('Failed to save OpenAI key: ' + result.error);
  }
});

skipOpenAIBtn.addEventListener('click', () => {
  openaiModal.classList.add('hidden');
});

function updateRecordButtonState() {
  if (hasOpenAIKey) {
    recordBtn.classList.remove('disabled');
    recordBtn.title = 'Record audio (Whisper transcription)';
    importAudioBtn.classList.remove('disabled');
    importAudioBtn.title = 'Import audio file';
  } else {
    recordBtn.title = 'Click to set up voice recording';
    importAudioBtn.classList.add('disabled');
    importAudioBtn.title = 'Set up OpenAI API key first';
  }
}

// ============================================================
// Audio Recording
// ============================================================

recordBtn.addEventListener('click', async () => {
  // If no OpenAI key, show the setup modal
  if (!hasOpenAIKey) {
    openaiModal.classList.remove('hidden');
    return;
  }

  // If already recording, stop
  if (mediaRecorder && mediaRecorder.state === 'recording') {
    stopRecording();
    return;
  }

  // Start recording
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    startRecording(stream);
  } catch (err) {
    console.error('Microphone access error:', err);
    if (err.name === 'NotAllowedError') {
      alert('Microphone access denied. Please allow microphone access in System Preferences > Security & Privacy > Privacy > Microphone.');
    } else {
      alert('Could not access microphone: ' + err.message);
    }
  }
});

importAudioBtn.addEventListener('click', async () => {
  // If no OpenAI key, show the setup modal
  if (!hasOpenAIKey) {
    openaiModal.classList.remove('hidden');
    return;
  }
  
  // Show transcribing indicator
  transcribingIndicator.classList.remove('hidden');
  
  try {
    const result = await window.api.importAudio();
    
    if (result.canceled) {
      // User canceled, just hide indicator
      transcribingIndicator.classList.add('hidden');
      return;
    }
    
    if (result.success) {
      // Check for gibberish/no intelligible voice
      const text = result.text.trim();
      const words = text.split(/\s+/);
      const uniqueWords = new Set(words.map(w => w.toLowerCase()));
      const isGibberish = (
        text.length < 10 ||
        (words.length > 3 && uniqueWords.size <= 2) ||
        /^(you\s*)+$/i.test(text) ||
        /^(the\s*)+$/i.test(text) ||
        /^(a\s*)+$/i.test(text)
      );
      
      if (isGibberish) {
        alert('⚠️ No clear voice detected in the audio file.\n\nThe file may not contain speech or may have poor audio quality.');
        return;
      }
      
      // Append transcribed text to transcript
      const currentText = transcript.value.trim();
      if (currentText) {
        transcript.value = currentText + '\n\n' + text;
      } else {
        transcript.value = text;
      }
      
      // Save to session state
      saveSessionState();
    } else if (result.needsKey) {
      hasOpenAIKey = false;
      openaiModal.classList.remove('hidden');
    } else {
      alert('Import failed: ' + result.error);
    }
  } catch (err) {
    console.error('Import error:', err);
    alert('Failed to import audio: ' + err.message);
  } finally {
    // Hide transcribing indicator
    transcribingIndicator.classList.add('hidden');
  }
});

function startRecording(stream) {
  audioChunks = [];
  
  // Use webm format (widely supported)
  const options = { mimeType: 'audio/webm;codecs=opus' };
  
  // Fallback if webm not supported
  if (!MediaRecorder.isTypeSupported(options.mimeType)) {
    options.mimeType = 'audio/webm';
  }
  if (!MediaRecorder.isTypeSupported(options.mimeType)) {
    options.mimeType = '';
  }
  
  mediaRecorder = new MediaRecorder(stream, options);
  
  mediaRecorder.ondataavailable = (e) => {
    if (e.data.size > 0) {
      audioChunks.push(e.data);
    }
  };
  
  mediaRecorder.onstop = async () => {
    // Stop all tracks
    stream.getTracks().forEach(track => track.stop());
    
    // Process the recording
    await processRecording();
  };
  
  // Start recording
  mediaRecorder.start(1000); // Collect data every second
  recordingStartTime = Date.now();
  
  // Update UI — button turns red, text changes
  recordBtn.classList.add('recording');
  recordBtn.querySelector('.record-text').textContent = 'Stop';
}

function stopRecording() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
  }

  // Reset UI — button back to normal
  recordBtn.classList.remove('recording');
  recordBtn.querySelector('.record-text').textContent = 'Record';
}

async function processRecording() {
  if (audioChunks.length === 0) {
    console.log('No audio recorded');
    return;
  }
  
  // Show transcribing indicator
  transcribingIndicator.classList.remove('hidden');
  
  try {
    // Create blob from chunks
    const audioBlob = new Blob(audioChunks, { type: 'audio/webm' });
    
    // Convert to base64
    const reader = new FileReader();
    const base64Promise = new Promise((resolve, reject) => {
      reader.onloadend = () => {
        // Remove data URL prefix to get just the base64 data
        const base64 = reader.result.split(',')[1];
        resolve(base64);
      };
      reader.onerror = reject;
    });
    reader.readAsDataURL(audioBlob);
    
    const base64Audio = await base64Promise;
    
    // Send to Whisper API via main process
    const result = await window.api.transcribeAudio(base64Audio);
    
    if (result.success) {
      // Check for gibberish/no intelligible voice
      const text = result.text.trim();
      const words = text.split(/\s+/);
      const uniqueWords = new Set(words.map(w => w.toLowerCase()));
      const isGibberish = (
        text.length < 10 ||
        (words.length > 3 && uniqueWords.size <= 2) ||
        /^(you\s*)+$/i.test(text) ||
        /^(the\s*)+$/i.test(text) ||
        /^(a\s*)+$/i.test(text)
      );
      
      if (isGibberish) {
        alert('⚠️ No clear voice detected.\n\nTry:\n• Speaking closer to the microphone\n• Recording for at least 10-15 seconds\n• Reducing background noise');
        return;
      }
      
      // Append transcribed text to transcript
      const currentText = transcript.value.trim();
      if (currentText) {
        transcript.value = currentText + '\n\n' + text;
      } else {
        transcript.value = text;
      }
      
      // Save to session state
      saveSessionState();
    } else if (result.needsKey) {
      hasOpenAIKey = false;
      openaiModal.classList.remove('hidden');
    } else {
      alert('Transcription failed: ' + result.error);
    }
  } catch (err) {
    console.error('Processing error:', err);
    alert('Failed to process recording: ' + err.message);
  } finally {
    // Hide transcribing indicator
    transcribingIndicator.classList.add('hidden');
  }
}

// ============================================================
// Generate Note
// ============================================================

generateBtn.addEventListener('click', async () => {
  const text = transcript.value.trim();
  const session = getActiveSession();
  const hasPdf = session && session.pdfAttachments && session.pdfAttachments.length > 0;
  if (!text && !hasPdf) {
    alert('Please enter a transcript or attach a PDF first.');
    return;
  }
  
  loading.classList.remove('hidden');
  loadingText.textContent = 'Generating...';
  generateBtn.disabled = true;
  
  try {
    // Include PDF context if available
    const pdfContext = (session && session.pdfAttachments && session.pdfAttachments.length > 0)
      ? session.pdfAttachments.map(p => ({ fileName: p.fileName, text: p.text }))
      : [];
    
    const result = await window.api.generateNote({
      site: siteSelect.value,
      type: typeSelect.value,
      transcript: text,
      pdfContext
    });
    
    if (result.success) {
      displayOutput(result);
      // Sync to Mac Mini (non-blocking, silent)
      try {
        const session = getActiveSession();
        psSync.syncNote({
          site: result.site,
          noteType: result.type,
          label: session?.label || null,
          inputText: text,
          outputText: result.content,
          model: 'claude-opus-4-6'
        });
      } catch (e) {
        console.log('Sync unavailable:', e.message);
      }
    } else {
      alert('Error: ' + result.error);
    }
  } catch (e) {
    alert('Error: ' + e.message);
  } finally {
    loading.classList.add('hidden');
    generateBtn.disabled = false;
  }
});

function displayOutput(result) {
  const { content, site, type } = result;
  const session = getActiveSession();
  
  if (site === 'voa' && type === 'reassess') {
    // SOAP format for VOA Reassess
    const sections = parseSOAP(content);
    addVersion(sections, 'soap');
  } else if (site === 'unity') {
    // Unity: parse HPI and Assessment from section break
    const sections = parseUnitySections(content);
    addVersion(sections, 'unity');
  } else if (site === 'voa' && type === 'new') {
    // VOA New: single field with character count
    addVersion(content, 'voa-new');
  } else {
    addVersion(content, 'single');
  }
  
  updateRefinementVisibility();
}

function parseUnitySections(content) {
  const sections = { hpi: '', assessment: '' };
  
  // Split by the section break marker
  const parts = content.split(/===\s*SECTION_BREAK\s*===/i);
  
  if (parts.length >= 2) {
    sections.hpi = parts[0].trim();
    sections.assessment = parts[1].trim();
  } else {
    // Fallback: try to find HPI and Assessment markers
    const hpiMatch = content.match(/(?:HPI|History of Present Illness)[:\s]*([\s\S]*?)(?=Assessment|$)/i);
    const assessMatch = content.match(/Assessment[:\s]*([\s\S]*?)$/i);
    
    if (hpiMatch) sections.hpi = hpiMatch[1].trim();
    if (assessMatch) sections.assessment = assessMatch[1].trim();
    
    // If still nothing, put everything in HPI
    if (!sections.hpi && !sections.assessment) {
      sections.hpi = content;
    }
  }
  
  // Clean up any remaining markdown/headers
  sections.hpi = cleanMarkdown(sections.hpi);
  sections.assessment = cleanMarkdown(sections.assessment);
  
  return sections;
}

function cleanMarkdown(text) {
  return text
    .replace(/\*\*([^*]+)\*\*/g, '$1')  // Remove bold
    .replace(/\*([^*]+)\*/g, '$1')       // Remove italic
    .replace(/^#+\s*/gm, '')             // Remove headers
    .replace(/^[-*]\s+/gm, '')           // Remove list markers
    .replace(/^(HPI|Assessment|Internal Subjective|History of Present Illness)[:\s]*/gim, '') // Remove labels
    .trim();
}

function parseSOAP(content) {
  const sections = { s: '', o: '', a: '', p: '' };
  
  const sMatch = content.match(/\*\*S:\*\*\s*([\s\S]*?)(?=\*\*O:\*\*|$)/i);
  const oMatch = content.match(/\*\*O:\*\*\s*([\s\S]*?)(?=\*\*A:\*\*|$)/i);
  const aMatch = content.match(/\*\*A:\*\*\s*([\s\S]*?)(?=\*\*P:\*\*|$)/i);
  const pMatch = content.match(/\*\*P:\*\*\s*([\s\S]*?)$/i);
  
  if (sMatch) sections.s = sMatch[1].trim();
  if (oMatch) sections.o = oMatch[1].trim();
  if (aMatch) sections.a = aMatch[1].trim();
  if (pMatch) sections.p = pMatch[1].trim();
  
  if (!sections.s && !sections.o && !sections.a && !sections.p) {
    sections.s = content;
  }
  
  return sections;
}

// ============================================================
// PDF Attachments
// ============================================================

function renderPdfAttachments() {
  const session = getActiveSession();
  if (!session) return;
  
  const isEmpty = session.pdfAttachments.length === 0;
  
  // Update both display areas (refinement + input)
  [pdfAttachments, pdfAttachmentsInput].forEach(container => {
    if (!container) return;
    if (isEmpty) { container.classList.add('hidden'); return; }
    container.classList.remove('hidden');
  });
  
  if (isEmpty) return;
  
  [pdfList, pdfListInput].forEach(list => {
    if (!list) return;
    list.innerHTML = '';
    session.pdfAttachments.forEach((pdf, idx) => {
      const item = document.createElement('div');
      item.className = 'pdf-item';
      item.innerHTML = `
        <span class="pdf-name" title="${pdf.numPages} page(s)">📄 ${pdf.fileName}</span>
        <button class="pdf-remove" title="Remove" data-idx="${idx}">×</button>
      `;
      item.querySelector('.pdf-remove').addEventListener('click', () => {
        removePdfAttachment(idx);
      });
      list.appendChild(item);
    });
  });
}

function removePdfAttachment(idx) {
  const session = getActiveSession();
  if (!session) return;
  
  session.pdfAttachments.splice(idx, 1);
  renderPdfAttachments();
}

async function handleAttachPdf() {
  const session = getActiveSession();
  if (!session) return;
  
  const result = await window.api.attachPdf();
  
  if (result.canceled) {
    return; // User canceled
  }
  
  if (!result.success) {
    alert('Failed to read PDF: ' + result.error);
    return;
  }
  
  // Check if already attached
  if (session.pdfAttachments.some(p => p.fileName === result.fileName)) {
    alert('This PDF is already attached.');
    return;
  }
  
  session.pdfAttachments.push({
    fileName: result.fileName,
    filePath: result.filePath,
    text: result.text,
    numPages: result.numPages
  });
  
  renderPdfAttachments();
  
  // Show "Save to Library" toast if not already in library
  const isInLibrary = guidelines.some(g => g.path === result.filePath);
  if (!isInLibrary) {
    lastAttachedPdf = {
      fileName: result.fileName,
      filePath: result.filePath
    };
    showSaveToLibraryToast();
  }
}

attachPdfBtn.addEventListener('click', handleAttachPdf);
attachPdfInputBtn.addEventListener('click', handleAttachPdf);

// ============================================================
// Guidelines Library
// ============================================================

async function loadGuidelines() {
  guidelines = await window.api.getGuidelines();
}

function renderGuidelinesModal() {
  guidelinesList.innerHTML = '';
  
  if (guidelines.length === 0) {
    guidelinesEmpty.classList.remove('hidden');
    guidelinesList.classList.add('hidden');
    return;
  }
  
  guidelinesEmpty.classList.add('hidden');
  guidelinesList.classList.remove('hidden');
  
  guidelines.forEach((guideline) => {
    const item = document.createElement('div');
    item.className = 'guideline-item';
    item.innerHTML = `
      <div class="guideline-info">
        <div class="guideline-name">${escapeHtml(guideline.name)}</div>
        <div class="guideline-path" title="${escapeHtml(guideline.path)}">${escapeHtml(guideline.path)}</div>
      </div>
      <div class="guideline-actions">
        <button class="guideline-action-btn attach" title="Attach to session" data-path="${escapeHtml(guideline.path)}">📎</button>
        <button class="guideline-action-btn rename" title="Rename" data-path="${escapeHtml(guideline.path)}" data-name="${escapeHtml(guideline.name)}">✏️</button>
        <button class="guideline-action-btn remove" title="Remove from library" data-path="${escapeHtml(guideline.path)}">🗑️</button>
      </div>
    `;
    
    // Attach button
    item.querySelector('.attach').addEventListener('click', async (e) => {
      e.stopPropagation();
      await attachGuidelineToSession(guideline.path);
    });
    
    // Rename button
    item.querySelector('.rename').addEventListener('click', (e) => {
      e.stopPropagation();
      renameGuideline(guideline.path, guideline.name);
    });
    
    // Remove button
    item.querySelector('.remove').addEventListener('click', async (e) => {
      e.stopPropagation();
      await removeGuideline(guideline.path);
    });
    
    guidelinesList.appendChild(item);
  });
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

async function attachGuidelineToSession(filePath) {
  const session = getActiveSession();
  if (!session) return;
  
  // Check if already attached
  if (session.pdfAttachments.some(p => p.filePath === filePath)) {
    alert('This guideline is already attached to the current session.');
    return;
  }
  
  // Load the PDF (re-extract text each time in case file was updated)
  const result = await window.api.loadGuidelinePdf(filePath);
  
  if (!result.success) {
    if (result.notFound) {
      // Mark guideline as having error in UI
      alert(`File not found: ${filePath}\n\nThe file may have been moved or deleted. Consider removing it from your library.`);
    } else {
      alert('Failed to load guideline: ' + result.error);
    }
    return;
  }
  
  session.pdfAttachments.push({
    fileName: result.fileName,
    filePath: result.filePath,
    text: result.text,
    numPages: result.numPages
  });
  
  renderPdfAttachments();
  guidelinesModal.classList.add('hidden');
}

async function removeGuideline(filePath) {
  if (!confirm('Remove this guideline from your library?')) return;
  
  const result = await window.api.removeGuideline(filePath);
  if (result.success) {
    guidelines = result.guidelines;
    renderGuidelinesModal();
  } else {
    alert('Failed to remove guideline: ' + result.error);
  }
}

function renameGuideline(filePath, currentName) {
  const newName = prompt('Rename guideline:', currentName);
  if (!newName || newName.trim() === '' || newName === currentName) return;
  
  window.api.renameGuideline({ filePath, newName: newName.trim() }).then(result => {
    if (result.success) {
      guidelines = result.guidelines;
      renderGuidelinesModal();
    } else {
      alert('Failed to rename guideline: ' + result.error);
    }
  });
}

// Guidelines modal handlers
guidelinesBtn.addEventListener('click', () => {
  renderGuidelinesModal();
  guidelinesModal.classList.remove('hidden');
});

closeGuidelinesModal.addEventListener('click', () => {
  guidelinesModal.classList.add('hidden');
});

guidelinesModal.addEventListener('click', (e) => {
  if (e.target === guidelinesModal) {
    guidelinesModal.classList.add('hidden');
  }
});

// Save to Library toast handlers
function showSaveToLibraryToast() {
  saveToLibraryToast.classList.remove('hidden');
  
  // Auto-dismiss after 8 seconds
  setTimeout(() => {
    hideSaveToLibraryToast();
  }, 8000);
}

function hideSaveToLibraryToast() {
  saveToLibraryToast.classList.add('hidden');
  lastAttachedPdf = null;
}

saveToLibraryBtn.addEventListener('click', async () => {
  if (!lastAttachedPdf) return;
  
  // Prompt for a name
  const suggestedName = lastAttachedPdf.fileName.replace(/\.pdf$/i, '');
  const name = prompt('Name for this guideline:', suggestedName);
  
  if (!name || name.trim() === '') {
    hideSaveToLibraryToast();
    return;
  }
  
  const result = await window.api.saveGuideline({
    name: name.trim(),
    filePath: lastAttachedPdf.filePath
  });
  
  if (result.success) {
    guidelines = result.guidelines;
  } else {
    alert('Failed to save guideline: ' + result.error);
  }
  
  hideSaveToLibraryToast();
});

dismissToastBtn.addEventListener('click', () => {
  hideSaveToLibraryToast();
});

// ============================================================
// Refinement
// ============================================================

async function refineOutput() {
  const session = getActiveSession();
  if (!session) return;
  
  const feedback = refinementInput.value.trim();
  if (!feedback) {
    alert('Please enter refinement instructions.');
    return;
  }
  
  const isSOAP = siteSelect.value === 'voa' && typeSelect.value === 'reassess';
  const isUnity = siteSelect.value === 'unity';
  const isVoaNew = siteSelect.value === 'voa' && typeSelect.value === 'new';
  let currentOutput;
  
  if (isSOAP) {
    if (!session.soapVersions || session.soapVersions.length === 0) return;
    const ver = session.soapVersions[session.currentSoapVersion];
    currentOutput = `**S:** ${ver.s}\n\n**O:** ${ver.o}\n\n**A:** ${ver.a}\n\n**P:** ${ver.p}`;
  } else if (isUnity && session.unityVersions && session.unityVersions.length > 0) {
    const ver = session.unityVersions[session.currentUnityVersion];
    currentOutput = `${ver.hpi}\n\n===SECTION_BREAK===\n\n${ver.assessment}`;
  } else if (isVoaNew && session.voaNewVersions && session.voaNewVersions.length > 0) {
    currentOutput = session.voaNewVersions[session.currentVoaNewVersion];
  } else {
    if (!session.versions || session.versions.length === 0) return;
    currentOutput = session.versions[session.currentVersion];
  }
  
  loading.classList.remove('hidden');
  loadingText.textContent = 'Refining...';
  refineBtn.disabled = true;
  
  // Prepare PDF context if any attached
  const pdfContext = session.pdfAttachments.map(pdf => ({
    fileName: pdf.fileName,
    text: pdf.text
  }));
  
  try {
    const result = await window.api.refineNote({
      site: siteSelect.value,
      type: typeSelect.value,
      transcript: session.transcript,
      currentOutput: currentOutput,
      feedback: feedback,
      pdfContext: pdfContext
    });
    
    if (result.success) {
      if (isSOAP) {
        const sections = parseSOAP(result.content);
        addVersion(sections, 'soap');
      } else if (isUnity) {
        const sections = parseUnitySections(result.content);
        addVersion(sections, 'unity');
      } else if (isVoaNew) {
        addVersion(result.content, 'voa-new');
      } else {
        addVersion(result.content, 'single');
      }
      refinementInput.value = '';
    } else {
      alert('Error: ' + result.error);
    }
  } catch (e) {
    alert('Error: ' + e.message);
  } finally {
    loading.classList.add('hidden');
    refineBtn.disabled = false;
  }
}

refineBtn.addEventListener('click', refineOutput);

refinementInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    refineOutput();
  }
});

// Suggestion chips
document.querySelectorAll('.suggestion-chip').forEach(chip => {
  chip.addEventListener('click', () => {
    refinementInput.value = chip.dataset.suggestion;
    refineOutput();
  });
});

// ============================================================
// Clear & Copy
// ============================================================

clearBtn.addEventListener('click', () => {
  const session = getActiveSession();
  if (!session) return;
  
  transcript.value = '';
  outputText.value = '';
  Object.values(soapFields).forEach(f => f.value = '');
  
  session.transcript = '';
  session.versions = [];
  session.currentVersion = -1;
  session.soapVersions = [];
  session.currentSoapVersion = -1;
  session.pdfAttachments = [];
  
  renderVersions();
  updateRefinementVisibility();
  renderPdfAttachments();
  charCountSingle.textContent = '';
});

document.querySelectorAll('.copy-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const targetId = btn.dataset.target;
    const target = document.getElementById(targetId);
    
    if (target && target.value) {
      navigator.clipboard.writeText(target.value).then(() => {
        btn.textContent = 'Copied!';
        btn.classList.add('copied');
        setTimeout(() => {
          btn.textContent = 'Copy';
          btn.classList.remove('copied');
        }, 1500);
      });
    }
  });
});

// ============================================================
// Tab Controls
// ============================================================

newTabBtn.addEventListener('click', () => {
  saveSessionState();
  const session = createSession();
  activeSessionId = session.id;
  loadSessionState();
  renderTabs();
  transcript.focus();
});

// ============================================================
// Initialize
// ============================================================

init();
