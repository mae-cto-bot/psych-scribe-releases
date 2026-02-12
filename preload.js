const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  checkApiKey: () => ipcRenderer.invoke('check-api-key'),
  saveApiKey: (key) => ipcRenderer.invoke('save-api-key', key),
  generateNote: (data) => ipcRenderer.invoke('generate-note', data),
  refineNote: (data) => ipcRenderer.invoke('refine-note', data),
  // OpenAI/Whisper methods
  checkOpenAIKey: () => ipcRenderer.invoke('check-openai-key'),
  saveOpenAIKey: (key) => ipcRenderer.invoke('save-openai-key', key),
  transcribeAudio: (audioData) => ipcRenderer.invoke('transcribe-audio', audioData),
  // PDF attachment
  attachPdf: () => ipcRenderer.invoke('attach-pdf'),
  // Guidelines Library
  getGuidelines: () => ipcRenderer.invoke('get-guidelines'),
  saveGuideline: (data) => ipcRenderer.invoke('save-guideline', data),
  removeGuideline: (filePath) => ipcRenderer.invoke('remove-guideline', filePath),
  renameGuideline: (data) => ipcRenderer.invoke('rename-guideline', data),
  loadGuidelinePdf: (filePath) => ipcRenderer.invoke('load-guideline-pdf', filePath),

  // Sync
  getSyncConfig: () => ipcRenderer.invoke('get-sync-config'),
  saveSyncConfig: (data) => ipcRenderer.invoke('save-sync-config', data)
});
