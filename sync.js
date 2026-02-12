// ============================================================
// Psych Scribe — Mac Mini Sync Module
// ============================================================

class PsychScribeSync {
  constructor() {
    this.serverUrl = null;
    this.authToken = null;
    this.enabled = false;
  }

  configure({ serverUrl, authToken }) {
    this.serverUrl = serverUrl?.replace(/\/+$/, '');
    this.authToken = authToken;
    this.enabled = !!(this.serverUrl && this.authToken);
  }

  async syncNote({ site, noteType, label, inputText, outputText, model, version, tokensIn, tokensOut, metadata }) {
    if (!this.enabled) return null;

    try {
      const res = await fetch(`${this.serverUrl}/api/notes`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.authToken}`
        },
        body: JSON.stringify({
          site,
          note_type: noteType,
          label,
          input_text: inputText,
          output_text: outputText,
          model: model || 'claude-sonnet-4-20250514',
          version: version || 1,
          tokens_in: tokensIn,
          tokens_out: tokensOut,
          metadata
        })
      });

      if (!res.ok) {
        console.warn(`Sync failed (${res.status}):`, await res.text());
        return null;
      }

      const result = await res.json();
      console.log('Note synced:', result.id);
      return result;
    } catch (e) {
      // Sync failure is non-blocking — notes still work locally
      console.warn('Sync error (server unreachable?):', e.message);
      return null;
    }
  }

  async healthCheck() {
    if (!this.serverUrl) return { ok: false, error: 'Not configured' };
    try {
      const res = await fetch(`${this.serverUrl}/health`, { signal: AbortSignal.timeout(3000) });
      if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
      return { ok: true, ...(await res.json()) };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }
}

// Singleton
const psSync = new PsychScribeSync();
