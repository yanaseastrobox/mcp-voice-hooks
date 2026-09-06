// AudioPlayer: plays PCM16 audio chunks via AudioContext for WebSocket TTS streaming
class AudioPlayer {
    constructor() {
        this.playbackContext = null; // Created lazily on unlock
        this.nextStartTime = 0;
        this.scheduledSources = [];
        this.gainNode = null;
        this.ttsActive = false;
        this.currentAudioId = null;
        this.isFirstChunk = true;
    }

    // Must be called on user gesture (e.g., Start Listening tap)
    async unlock() {
        if (!this.playbackContext) {
            this.playbackContext = new AudioContext({ sampleRate: 22050 });
            this.gainNode = this.playbackContext.createGain();
            this.gainNode.connect(this.playbackContext.destination);
        }
        await this.playbackContext.resume();
        // Play silent buffer to warm up iOS audio pipeline
        const silence = this.playbackContext.createBuffer(1, 1, 22050);
        const source = this.playbackContext.createBufferSource();
        source.buffer = silence;
        source.connect(this.playbackContext.destination);
        source.start();
    }

    prepareForPlayback(sampleRate, audioId) {
        this.ttsActive = true;
        this.currentAudioId = audioId;
        this.isFirstChunk = true;
        // Only reset scheduling if no audio is queued — otherwise new audio
        // should play after the currently scheduled audio finishes
        if (this.playbackContext && this.nextStartTime < this.playbackContext.currentTime) {
            this.nextStartTime = this.playbackContext.currentTime;
        }
    }

    // Convert Int16 PCM buffer to Float32
    static int16ToFloat32(int16Array) {
        const float32 = new Float32Array(int16Array.length);
        for (let i = 0; i < int16Array.length; i++) {
            float32[i] = int16Array[i] / 32768;
        }
        return float32;
    }

    // Schedule a PCM16 chunk for gapless playback
    playPCMChunk(pcm16Buffer, sampleRate = 22050) {
        if (!this.playbackContext || this.playbackContext.state !== 'running') return;

        const int16 = new Int16Array(pcm16Buffer);
        const float32 = AudioPlayer.int16ToFloat32(int16);
        const audioBuffer = this.playbackContext.createBuffer(1, float32.length, sampleRate);
        audioBuffer.copyToChannel(float32, 0);

        const source = this.playbackContext.createBufferSource();
        source.buffer = audioBuffer;
        source.connect(this.gainNode || this.playbackContext.destination);

        const now = this.playbackContext.currentTime;
        const startTime = Math.max(now, this.nextStartTime);
        source.start(startTime);
        this.nextStartTime = startTime + audioBuffer.duration;
        this.scheduledSources.push(source);

        // Clean up finished sources
        source.onended = () => {
            const idx = this.scheduledSources.indexOf(source);
            if (idx !== -1) this.scheduledSources.splice(idx, 1);
        };
    }

    finishPlayback() {
        this.ttsActive = false;
        this.currentAudioId = null;
    }

    clear() {
        // Stop all scheduled sources
        for (const source of this.scheduledSources) {
            try { source.stop(); } catch (_e) { /* may already be stopped */ }
        }
        this.scheduledSources = [];
        this.nextStartTime = 0;
        this.ttsActive = false;
        this.currentAudioId = null;
    }

    isPlaying() {
        return this.ttsActive || this.scheduledSources.length > 0;
    }
}

class MessengerClient {
    constructor() {
        this.baseUrl = window.location.origin;

        // Session-switch serialization — see switchActiveSession()/_applySessionSwitch().
        this._sessionSwitchRequestId = 0;
        this._sessionSwitchChain = Promise.resolve();

        // Browser-side TTS (speakViaBrowser) state — see _processTtsQueue()/
        // _cancelBrowserTts() for details.
        this._ttsGeneration = 0;
        this._ttsRetryTimer = null;
        this._ttsQueue = [];
        this._ttsPlaying = false;

        // Mic-capture mute has two independent reasons that can both be active
        // at once — browser TTS (_ttsSpeaking, above) and WS/say-based audio
        // playback (_wsAudioMuted, set via _muteAudioCapture). The actual
        // _micMuted gate is the OR of both, kept in sync by _updateMicMuted() —
        // clearing one reason must never unmute while the other still holds.
        this._wsAudioMuted = false;
        this._micMuted = false;

        // Conversation elements
        this.conversationMessages = document.getElementById('conversationMessages');
        this.conversationContainer = document.getElementById('conversationContainer');

        // Text input elements
        this.messageInput = document.getElementById('messageInput');
        this.micBtn = document.getElementById('micBtn');

        // Recognition mode
        this.recognitionModeSelect = document.getElementById('recognitionModeSelect');

        // Settings
        this.settingsToggleHeader = document.getElementById('settingsToggleHeader');
        this.settingsContent = document.getElementById('settingsContent');
        this.speechRateSlider = document.getElementById('speechRate');
        this.speechRateInput = document.getElementById('speechRateInput');
        this.feedbackSoundModeSelect = document.getElementById('feedbackSoundMode');
        this.testTTSBtn = document.getElementById('testTTSBtn');

        // Session sidebar elements
        this.sessionSidebar = document.getElementById('sessionSidebar');
        this.sessionList = document.getElementById('sessionList');
        this.sidebarOpenBtn = document.getElementById('sidebarOpenBtn');
        this.sidebarCloseBtn = document.getElementById('sidebarCloseBtn');
        this.backgroundEnforcementToggle = document.getElementById('backgroundEnforcementToggle');

        // State
        this.recognitionMode = 'server'; // 'server' or 'browser'
        this.serverRecognitionAvailable = false; // set from server check
        this.isListening = false;
        this.isInterimText = false;
        this.debug = localStorage.getItem('voiceHooksDebug') === 'true';
        this._recognitionRestartAttempts = 0; // see _scheduleRecognitionRestart()
        this._recognitionRestartTimer = null; // single in-flight restart, never two racing timers
        this._recognitionSettleTimer = null; // see recognition.onstart
        // 'idle' | 'starting' | 'running'. 'starting' covers the gap between start()
        // returning and onstart firing, during which stop() and a second start() are
        // both unsafe. Maintained wherever recognition is started or ends.
        this._recognitionState = 'idle';
        this._recognitionStopFallbackTimer = null; // see _stopRecognition()
        this._voiceSessionGeneration = 0; // bumped by every mic on/off; see startVoiceDictation()
        this._recognitionAbortedForEcho = false; // see _discardEchoedRecognitionAudio()
        this._ttsBurstSpoke = false; // did anything actually play in this speaking burst
        this._echoDiscardUntil = 0; // fallback echo window when abort() failed
        this._recognitionLifecycleGeneration = 0; // see _armRecognitionStopFallback()

        // TTS state
        this.speechRate = 1.0;

        // WebSocket audio capture state
        this.audioWs = null;
        this.audioContext = null;
        this.audioWorkletNode = null;
        this.mediaStream = null;
        this.wsReconnectTimer = null;
        this.wsReconnectDelay = 1000; // exponential backoff start

        // WebSocket TTS audio player
        this.audioPlayer = new AudioPlayer();
        this.wsConnected = false;

        // Voice state (driven by server SSE events)
        this.currentVoiceState = 'inactive';

        // Session state
        this.sessions = [];
        this.activeSessionKey = null;       // Server's selected key (for backward compat with API responses)
        this.selectedSessionKey = null;     // User's UI selection — authoritative for all routing
        this._confirmedSessionKey = null;   // Last value the server actually confirmed via POST /api/active-session
        this.unreadCounts = {}; // key → count of messages since last viewed

        // Initialize
        this.initializeSpeechRecognition();
        this.initializeTTSEvents();
        this.initializeSessionSidebar();
        this.setupEventListeners();
        this.loadPreferences();
        this.checkServerRecognition();
        this.loadData();

        // Auto-refresh every 2 seconds
        setInterval(() => this.loadData(), 2000);
        // Refresh sessions every 3 seconds
        setInterval(() => this.loadSessions(), 3000);
    }

    debugLog(...args) {
        if (this.debug) {
            console.log(...args);
        }
    }


    initializeTTSEvents() {
        // Connect to SSE for TTS events
        this.eventSource = new EventSource(`${this.baseUrl}/api/tts-events`);

        this.eventSource.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);

                if (data.type === 'connected') {
                    // Connected (or reconnected) to server — sync voice state
                    // This handles both initial connect and reconnect after server restart
                    console.log('[SSE] Connected to server, syncing voice state');
                    this.syncVoiceStateToServer();
                } else if (data.type === 'voice-state') {
                    // Server is the single source of truth for voice state
                    this.currentVoiceState = data.state;
                    this.updateVoiceStateUI(data.state);
                } else if (data.type === 'tts-clear') {
                    this.audioPlayer.clear();
                    this._cancelBrowserTts();
                } else if (data.type === 'waitStatus') {
                    this.handleWaitStatus(data.isWaiting);
                } else if (data.type === 'session-reset') {
                    // New Claude session started — re-sync our voice state with the server
                    console.log('[SSE] New Claude session detected, re-syncing voice state');
                    this.syncVoiceStateToServer();
                } else if (data.type === 'speak') {
                    // Non-macOS fallback: the server already renders audio itself via
                    // `say` on macOS (browserTtsEnabled is false there), so only speak
                    // here when the server says nothing else will play this text —
                    // otherwise it plays twice.
                    this.debugLog('[VoiceDiag] SSE speak event received, browserTtsEnabled=%s textLength=%s', data.browserTtsEnabled, (data.text || '').length);
                    if (data.browserTtsEnabled) {
                        this.speakViaBrowser(data.text);
                    }
                }
            } catch (error) {
                console.error('Failed to parse TTS event:', error);
            }
        };

        this.eventSource.onerror = (error) => {
            console.error('SSE connection error:', error);
            // Reset voice state to prevent stale UI while disconnected
            this.currentVoiceState = 'inactive';
            this.updateVoiceStateUI('inactive');
            // Browser TTS is driven entirely by SSE `speak`/`tts-clear` events (see
            // above), which EventSource does not redeliver after a drop — stop any
            // in-flight/queued browser speech now rather than risk it playing on
            // regardless of a clear the disconnected client never received.
            this._cancelBrowserTts();
        };
    }

    handleWaitStatus(isWaiting) {
        // Fallback handler for waitStatus SSE events.
        // voice-state SSE events are now the primary driver for UI state.
        const waitingIndicator = document.getElementById('waitingIndicator');
        if (waitingIndicator) {
            const wasAtBottom = this.isUserNearBottom();
            waitingIndicator.style.display = isWaiting ? 'block' : 'none';
            if (isWaiting && wasAtBottom) {
                this.scrollToBottom();
            }
        }
    }

    updateVoiceStateUI(state) {
        const waitingIndicator = document.getElementById('waitingIndicator');
        if (!waitingIndicator) return;

        const wasAtBottom = this.isUserNearBottom();

        if (state === 'listening') {
            waitingIndicator.textContent = 'Claude is waiting...';
            waitingIndicator.style.display = 'block';
        } else if (state === 'processing') {
            waitingIndicator.textContent = 'Claude is processing...';
            waitingIndicator.style.display = 'block';
        } else if (state === 'speaking') {
            waitingIndicator.textContent = 'Claude is speaking...';
            waitingIndicator.style.display = 'block';
        } else if (state === 'stopped') {
            waitingIndicator.textContent = 'Claude\'s turn ended';
            waitingIndicator.style.display = 'block';
        } else {
            waitingIndicator.style.display = 'none';
        }

        if (state !== 'inactive' && wasAtBottom) {
            this.scrollToBottom();
        }
    }

    initializeSessionSidebar() {
        if (this.sidebarOpenBtn) {
            this.sidebarOpenBtn.addEventListener('click', () => this.toggleSidebar(true));
        }
        if (this.sidebarCloseBtn) {
            this.sidebarCloseBtn.addEventListener('click', () => this.toggleSidebar(false));
        }
        // Delegated click handler on sessionList — survives innerHTML replacement
        if (this.sessionList) {
            this.sessionList.addEventListener('click', (e) => {
                const item = e.target.closest('.session-item');
                if (!item) return;
                const key = item.dataset.sessionKey;
                if (key && key !== this.selectedSessionKey) {
                    this.switchActiveSession(key);
                }
            });
        }
        // Background enforcement toggle
        if (this.backgroundEnforcementToggle) {
            // Load saved preference from localStorage, then sync with server
            const saved = localStorage.getItem('backgroundVoiceEnforcement');
            if (saved !== null) {
                this.backgroundEnforcementToggle.checked = saved === 'true';
                this.updateBackgroundEnforcement(saved === 'true');
            } else {
                // Load from server on first visit
                this.loadBackgroundEnforcement();
            }
            this.backgroundEnforcementToggle.addEventListener('change', (e) => {
                const enabled = e.target.checked;
                this.updateBackgroundEnforcement(enabled);
            });
        }
        // Load sessions immediately
        this.loadSessions();
    }

    toggleSidebar(open) {
        if (this.sessionSidebar) {
            if (open) {
                this.sessionSidebar.classList.remove('collapsed');
                if (this.sidebarOpenBtn) this.sidebarOpenBtn.classList.add('hidden');
            } else {
                this.sessionSidebar.classList.add('collapsed');
                if (this.sidebarOpenBtn) this.sidebarOpenBtn.classList.remove('hidden');
            }
        }
    }

    async loadSessions() {
        try {
            const response = await fetch(`${this.baseUrl}/api/sessions`);
            if (!response.ok) return;
            const data = await response.json();
            this.sessions = data.sessions || [];
            this.activeSessionKey = data.activeKey;
            this._confirmedSessionKey = data.activeKey; // this reflects the server's actual state
            // Set initial selection to active key, but never override user's choice
            if (!this.selectedSessionKey) {
                this.selectedSessionKey = data.activeKey;
            }

            // Button is always visible via CSS; hidden class is only added when sidebar is open

            // Track unread counts for inactive sessions
            for (const session of this.sessions) {
                if (!session.isActive && session.pendingCount > 0) {
                    const key = session.key;
                    this.unreadCounts[key] = session.pendingCount;
                }
            }

            this.renderSessionList();
        } catch (error) {
            this.debugLog('Failed to load sessions:', error);
        }
    }

    renderSessionList() {
        if (!this.sessionList) return;

        if (this.sessions.length === 0) {
            this.sessionList.innerHTML = '<div style="padding: 16px; color: #999; font-size: 13px; text-align: center;">No sessions connected</div>';
            return;
        }

        // Hide default session when real sessions exist (unless it's active or has content)
        const hasRealSessions = this.sessions.some(s => s.sessionId !== 'default');
        const visibleSessions = hasRealSessions
            ? this.sessions.filter(s => {
                if (s.sessionId === 'default') {
                    return s.isActive || (s.messageCount || 0) > 0 || s.utteranceCount > 0;
                }
                return true;
            })
            : this.sessions;

        // Group sessions by sessionId
        const groups = {};
        for (const session of visibleSessions) {
            const sid = session.sessionId;
            if (!groups[sid]) groups[sid] = [];
            groups[sid].push(session);
        }

        let html = '';
        for (const [sessionId, members] of Object.entries(groups)) {
            html += '<div class="session-group">';
            // Sort: main agent first, then sub-agents
            members.sort((a, b) => {
                if (!a.agentId && b.agentId) return -1;
                if (a.agentId && !b.agentId) return 1;
                return 0;
            });

            for (const session of members) {
                const isActive = session.key === this.selectedSessionKey;
                const isSubAgent = !!session.agentId;
                const label = isSubAgent
                    ? (session.agentType || session.agentId || 'sub-agent')
                    : this.formatSessionLabel(sessionId);
                const unread = this.unreadCounts[session.key] || 0;

                const classes = ['session-item'];
                if (isActive) classes.push('active');
                if (isSubAgent) classes.push('sub-agent');

                html += `<div class="${classes.join(' ')}" data-session-key='${session.key.replace(/'/g, "&#39;")}' title="${this.escapeHtml(session.key)}">`;
                html += `<span class="session-label">${this.escapeHtml(label)}</span>`;
                if (unread > 0 && !isActive) {
                    html += `<span class="session-badge">${unread}</span>`;
                }
                html += '</div>';
            }
            html += '</div>';
        }

        this.sessionList.innerHTML = html;
    }

    formatSessionLabel(sessionId) {
        if (sessionId === 'default') {
            const hasReal = this.sessions.some(s => s.sessionId !== 'default');
            return hasReal ? 'Unattached' : 'Main Session';
        }
        // Truncate long session IDs
        if (sessionId.length > 16) return sessionId.substring(0, 8) + '...';
        return sessionId;
    }

    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    switchActiveSession(key) {
        this.selectedSessionKey = key;
        const requestId = ++this._sessionSwitchRequestId;
        // Update the WS-based recognizer's per-connection target immediately
        // (not after the POST below), so it never lags behind what the UI shows —
        // a slow or serialized-behind-other-switches POST would otherwise leave
        // final transcripts routed to the previous session for longer than the
        // Sessions panel visually suggests.
        if (this.audioWs && this.audioWs.readyState === WebSocket.OPEN) {
            this.audioWs.send(JSON.stringify({ type: 'select-session', sessionKey: key }));
        }
        this.renderSessionList();
        // Chain onto the previous switch so POSTs reach the server in click order
        // (a fetch only starts once the prior one has settled) — otherwise two
        // rapid clicks could have their POST responses (and so the server's final
        // selectedSessionKey) resolve out of order.
        this._sessionSwitchChain = this._sessionSwitchChain
            .then(() => this._applySessionSwitch(key, requestId))
            .catch((error) => console.error('Session switch failed:', error));
    }

    async _applySessionSwitch(key, requestId) {
        // Tell the server which session is selected — this is what actually gates
        // TTS/audio routing (see /api/active-session), and must happen regardless of
        // whether the WS audio connection below is open (e.g. before the mic has
        // ever been started, or in browser-recognition mode where it's never opened).
        let ok = false;
        try {
            const response = await fetch(`${this.baseUrl}/api/active-session`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ key })
            });
            ok = response.ok;
            if (!ok) {
                const error = await response.json().catch(() => ({}));
                console.error('Failed to select session:', error);
            }
        } catch (error) {
            console.error('Failed to select session:', error);
        }

        // Update the confirmed value regardless of whether a newer switch has
        // already superseded this one — otherwise, in X→A→B where A succeeds and
        // B later fails, B's rollback would use the stale X instead of A (the
        // server's actual current selection after A's POST completed).
        if (ok) {
            this._confirmedSessionKey = key;
        }

        if (requestId !== this._sessionSwitchRequestId) return; // superseded; a newer switch owns the UI now

        if (!ok) {
            // Roll back the optimistic UI selection so it doesn't diverge from
            // what the server actually has selected (resolveSessionForNewInput()
            // on the server still uses the last confirmed key, not this one).
            // _confirmedSessionKey can legitimately be null (no switch has ever
            // succeeded yet) — send it to WS as-is rather than skipping on falsy,
            // so the WS-side per-connection target actually clears too.
            this.selectedSessionKey = this._confirmedSessionKey;
            this.renderSessionList();
            if (this.audioWs && this.audioWs.readyState === WebSocket.OPEN) {
                this.audioWs.send(JSON.stringify({ type: 'select-session', sessionKey: this._confirmedSessionKey }));
            }
            alert('セッションの切り替えに失敗しました。もう一度お試しください。');
            return;
        }

        // Clear unread for this session
        delete this.unreadCounts[key];
        // Clear existing messages so the new session's messages replace them
        this.conversationMessages.querySelectorAll('.message-bubble').forEach(el => el.remove());
        // Reload conversation for selected session
        this.loadData();
        this.renderSessionList();
    }

    loadPreferences() {
        // Load speech rate
        const savedRate = localStorage.getItem('speechRate');
        if (savedRate) {
            this.speechRate = parseFloat(savedRate);
            if (this.speechRateSlider) this.speechRateSlider.value = this.speechRate.toString();
            if (this.speechRateInput) this.speechRateInput.value = this.speechRate.toFixed(1);
        }

        // Load recognition mode
        const savedRecognitionMode = localStorage.getItem('recognitionMode');
        if (savedRecognitionMode) {
            this.recognitionMode = savedRecognitionMode;
        }

        // Load feedback sound mode
        const VALID_FEEDBACK_MODES = ['continuous', 'once', 'off'];
        const savedFeedbackMode = localStorage.getItem('feedbackSoundMode');
        if (savedFeedbackMode && VALID_FEEDBACK_MODES.includes(savedFeedbackMode) && this.feedbackSoundModeSelect) {
            this.feedbackSoundModeSelect.value = savedFeedbackMode;
        } else if (savedFeedbackMode && !VALID_FEEDBACK_MODES.includes(savedFeedbackMode)) {
            // Invalid stored value — clear it so default ('continuous') is used
            localStorage.removeItem('feedbackSoundMode');
        }

    }

    async checkServerRecognition() {
        try {
            const response = await fetch(`${this.baseUrl}/api/speech-recognition-available`);
            if (response.ok) {
                const data = await response.json();
                this.serverRecognitionAvailable = data.available;
            }
        } catch (error) {
            this.debugLog('Failed to check server recognition:', error);
            this.serverRecognitionAvailable = false;
        }

        // If server recognition not available, fall back to browser
        if (!this.serverRecognitionAvailable && this.recognitionMode === 'server') {
            this.recognitionMode = 'browser';
        }

        // Update UI
        if (this.recognitionModeSelect) {
            this.recognitionModeSelect.value = this.recognitionMode;
            // Disable server option if not available
            const serverOption = this.recognitionModeSelect.querySelector('option[value="server"]');
            if (serverOption) {
                serverOption.disabled = !this.serverRecognitionAvailable;
                serverOption.textContent = this.serverRecognitionAvailable
                    ? 'Server Recognition'
                    : 'Server Recognition (unavailable)';
            }
        }
    }

    /** Whether the active recognition mode uses server-side transcription. */
    get useServerRecognition() {
        return this.recognitionMode === 'server' && this.serverRecognitionAvailable && this.wsConnected;
    }

    setupEventListeners() {
        window.addEventListener('beforeunload', () => {
            this.currentVoiceState = 'inactive';
        });

        // Text input events
        this.messageInput.addEventListener('keydown', (e) => this.handleTextInputKeydown(e));
        this.messageInput.addEventListener('input', () => this.autoGrowTextarea());

        // Microphone button
        this.micBtn.addEventListener('click', () => this.toggleVoiceDictation());

        // Recognition mode selector
        if (this.recognitionModeSelect) {
            this.recognitionModeSelect.addEventListener('change', (e) => {
                this.recognitionMode = e.target.value;
                localStorage.setItem('recognitionMode', this.recognitionMode);
            });
        }

        // Settings toggle (dropdown)
        this.settingsToggleHeader.addEventListener('click', (e) => {
            e.stopPropagation();
            this.settingsContent.classList.toggle('open');
        });
        // Close dropdown when clicking outside
        document.addEventListener('click', (e) => {
            if (!this.settingsContent.contains(e.target) && !this.settingsToggleHeader.contains(e.target)) {
                this.settingsContent.classList.remove('open');
            }
        });

        // Speech rate slider
        if (this.speechRateSlider) {
            this.speechRateSlider.addEventListener('input', (e) => {
                this.speechRate = parseFloat(e.target.value);
                this.speechRateInput.value = this.speechRate.toFixed(1);
                localStorage.setItem('speechRate', this.speechRate.toString());
                this.syncSelectedVoiceToServer();
            });
        }

        // Speech rate text input
        if (this.speechRateInput) {
            this.speechRateInput.addEventListener('input', (e) => {
                let value = parseFloat(e.target.value);
                if (!isNaN(value)) {
                    value = Math.max(0.5, Math.min(5, value));
                    this.speechRate = value;
                    this.speechRateSlider.value = value.toString();
                    this.speechRateInput.value = value.toFixed(1);
                    localStorage.setItem('speechRate', this.speechRate.toString());
                    this.syncSelectedVoiceToServer();
                }
            });
        }

        // Feedback sound mode select
        if (this.feedbackSoundModeSelect) {
            this.feedbackSoundModeSelect.addEventListener('change', (e) => {
                localStorage.setItem('feedbackSoundMode', e.target.value);
                this.syncSelectedVoiceToServer();
            });
        }

        // Test TTS button — triggers server-side TTS without side effects
        if (this.testTTSBtn) {
            this.testTTSBtn.addEventListener('click', async () => {
                try {
                    await fetch(`${this.baseUrl}/api/test-voice`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ text: 'This is Voice Mode for Claude Code. How can I help you today?' })
                    });
                } catch (error) {
                    console.error('Failed to test voice:', error);
                }
            });
        }
    }

    async loadData() {
        try {
            // Load full conversation
            const sessionParam = this.selectedSessionKey ? `&session=${encodeURIComponent(this.selectedSessionKey)}` : '';
            const conversationResponse = await fetch(`${this.baseUrl}/api/conversation?limit=50${sessionParam}`);
            if (conversationResponse.ok) {
                const data = await conversationResponse.json();
                this.updateConversation(data.messages);
            }
        } catch (error) {
            console.error('Failed to load data:', error);
        }
    }

    updateConversation(messages) {
        const container = this.conversationMessages;
        const emptyState = container.querySelector('.empty-state');

        if (messages.length === 0) {
            emptyState.style.display = 'flex';
            container.querySelectorAll('.message-bubble').forEach(el => el.remove());
            return;
        }

        emptyState.style.display = 'none';

        // Get existing message IDs to avoid duplicates
        const existingBubbles = container.querySelectorAll('.message-bubble');
        const existingIds = new Set();
        existingBubbles.forEach(bubble => {
            if (bubble.dataset.messageId) {
                existingIds.add(bubble.dataset.messageId);
            }
        });

        // Get waiting indicator to insert messages before it
        const waitingIndicator = container.querySelector('.waiting-indicator');

        // Check if user is near bottom before adding content
        const wasAtBottom = this.isUserNearBottom();

        // Only render new messages and update status for existing ones
        messages.forEach(message => {
            if (!existingIds.has(message.id)) {
                // New message - create bubble and insert before waiting indicator
                const bubble = this.createMessageBubble(message);
                if (waitingIndicator) {
                    container.insertBefore(bubble, waitingIndicator);
                } else {
                    container.appendChild(bubble);
                }
            } else {
                // Existing message - update status if it's a user message
                if (message.role === 'user' && message.status) {
                    const bubble = container.querySelector(`[data-message-id="${message.id}"]`);
                    if (bubble) {
                        const statusEl = bubble.querySelector('.message-status');
                        if (statusEl) {
                            // Check if status changed from pending to something else
                            const wasPending = statusEl.classList.contains('pending');
                            const isPending = message.status === 'pending';

                            if (wasPending && !isPending) {
                                // Status changed from pending - remove delete button
                                const deleteBtn = statusEl.querySelector('.delete-message-btn');
                                if (deleteBtn) {
                                    deleteBtn.remove();
                                }
                            }

                            // Update status class and text
                            statusEl.className = `message-status ${message.status}`;
                            const statusText = statusEl.querySelector('span:last-child');
                            if (statusText) {
                                statusText.textContent = message.status.toUpperCase();
                            }
                        }
                    }
                }
            }
        });

        // Only auto-scroll if user was already at the bottom
        if (wasAtBottom) {
            this.scrollToBottom();
        }
    }

    createMessageBubble(message) {
        const bubble = document.createElement('div');
        bubble.className = `message-bubble ${message.role}`;
        bubble.dataset.messageId = message.id;

        const messageText = document.createElement('div');
        messageText.className = 'message-text';
        messageText.textContent = message.text;

        const messageMeta = document.createElement('div');
        messageMeta.className = 'message-meta';

        const timestamp = document.createElement('span');
        timestamp.className = 'message-timestamp';
        timestamp.textContent = this.formatTimestamp(message.timestamp);
        messageMeta.appendChild(timestamp);

        // Only show status for user messages
        if (message.role === 'user' && message.status) {
            const statusContainer = document.createElement('div');
            statusContainer.className = `message-status ${message.status}`;

            // Add delete button for pending messages (shows on hover)
            if (message.status === 'pending') {
                const deleteBtn = document.createElement('span');
                deleteBtn.className = 'delete-message-btn';
                deleteBtn.innerHTML = `
                    <svg class="delete-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">
                        <path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/>
                    </svg>
                `;
                deleteBtn.onclick = (e) => {
                    e.stopPropagation();
                    this.deleteMessage(message.id);
                };
                statusContainer.appendChild(deleteBtn);
            }

            const statusText = document.createElement('span');
            statusText.textContent = message.status.toUpperCase();
            statusContainer.appendChild(statusText);

            messageMeta.appendChild(statusContainer);
        }

        bubble.appendChild(messageText);
        bubble.appendChild(messageMeta);

        return bubble;
    }

    isUserNearBottom() {
        const container = this.conversationContainer;
        return container.scrollHeight - container.scrollTop - container.clientHeight < 50;
    }

    scrollToBottom() {
        this.conversationContainer.scrollTo({
            top: this.conversationContainer.scrollHeight,
            behavior: 'smooth'
        });
    }

    formatTimestamp(timestamp) {
        const date = new Date(timestamp);
        return date.toLocaleTimeString();
    }

    // Text input handling
    handleTextInputKeydown(e) {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            this.sendTypedMessage();
        }
        // Shift+Enter allows new line
    }

    autoGrowTextarea() {
        const textarea = this.messageInput;
        textarea.style.height = 'auto';
        textarea.style.height = Math.min(textarea.scrollHeight, 120) + 'px';
    }

    async sendTypedMessage() {
        const text = this.messageInput.value.trim();
        if (!text || this.isInterimText) return;

        this.messageInput.value = '';
        this.messageInput.style.height = 'auto';

        await this.sendMessage(text);
    }

    // Returns true on success, false otherwise — callers use this to decide
    // whether it's safe to clear their own copy of the text (see
    // stopVoiceDictation(), which used to unconditionally clear the input
    // box right after calling this, wiping out the 409 restore below).
    async sendMessage(text) {
        if (!text || !text.trim()) return false; // the server rejects these with 400
        try {
            const response = await fetch(`${this.baseUrl}/api/potential-utterances`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text, timestamp: new Date().toISOString(), session: this.selectedSessionKey })
            });

            if (response.ok) {
                this.loadData();
                return true;
            } else if (response.status === 409) {
                // Multiple sessions exist and none is selected — the server
                // refuses to guess which one this belongs to (see resolveSessionForInput
                // on the server). Restore the text so it isn't silently lost.
                this.messageInput.value = text;
                alert('複数のセッションが起動中です。左のSessionsパネルから対象のセッションを選択してから送信してください。');
                return false;
            } else {
                const error = await response.json().catch(() => ({}));
                console.error('Failed to send message:', error);
                return false;
            }
        } catch (error) {
            console.error('Failed to send message:', error);
            return false;
        }
    }

    // Voice dictation
    toggleVoiceDictation() {
        if (this.isListening) {
            this.stopVoiceDictation();
        } else {
            this.startVoiceDictation();
        }
    }

    async startVoiceDictation() {
        try {
            if (this.isInterimText) {
                this.messageInput.value = '';
                this.isInterimText = false;
            }

            // Both toggles bump this. Checking isListening after an await isn't enough
            // on its own: an off-then-on double tap leaves it true again, so a stale
            // start would sail past and re-enable the WebSocket and server-side voice
            // behind the newer one.
            const generation = ++this._voiceSessionGeneration;

            this.isListening = true;
            this.micBtn.classList.add('listening');
            this._recognitionRestartAttempts = 0; // explicit new user intent — start clean
            this._cancelScheduledRecognitionRestart();

            // Unlock AudioPlayer on user gesture (iOS Safari requirement)
            await this.audioPlayer.unlock();
            if (generation !== this._voiceSessionGeneration) return; // superseded while awaiting

            // Open WebSocket; audio capture starts from the onopen callback
            this.connectAudioWebSocket();

            // Start browser speech recognition only if NOT using server recognition.
            // TTS may have started while the await above was pending — re-check
            // _ttsSpeaking rather than starting into it; the TTS-end resume path
            // (advance()/_cancelBrowserTts) picks this up once it's done, since
            // isListening is already true by then.
            if (!this.useServerRecognition && this.recognition && !this._ttsSpeaking && this._recognitionState === 'idle') {
                this._recognitionState = 'starting';
                try {
                    this.recognition.start();
                } catch (e) {
                    // Usually InvalidStateError from a recognizer that hasn't finished
                    // winding down. Hand it to the same backoff the error paths use
                    // rather than aborting the whole start and leaving the mic lit but
                    // deaf — the user asked to listen and nothing here says they can't.
                    this._recognitionState = 'idle';
                    console.error('Failed to start recognition:', e);
                    this._recognitionRestartAttempts++;
                    this._scheduleRecognitionRestart();
                }
            }

            if (generation !== this._voiceSessionGeneration) return; // superseded while awaiting
            // Activate voice input and voice responses when mic is on
            await this.updateVoiceActive(true);
        } catch (e) {
            console.error('Failed to start voice dictation:', e);
            alert('Failed to start speech recognition');
        }
    }

    async stopVoiceDictation() {
        const generation = ++this._voiceSessionGeneration;
        this.isListening = false;
        this._cancelScheduledRecognitionRestart();
        this._stopRecognition();
        this.micBtn.classList.remove('listening');

        // Send any accumulated text in the input (from browser recognition)
        const text = this.messageInput.value.trim();
        if (text && !this.isInterimText) {
            const sent = await this.sendMessage(text);
            if (sent) this.messageInput.value = '';
            // On failure, sendMessage already restored/left the text in place
            // (e.g. the 409 "select a session" case) — don't wipe it out here.
        }

        // The mic may have been switched back on while that send was in flight — in
        // which case neither the input box nor the connection belongs to this stop
        // any more, so touch nothing.
        if (generation !== this._voiceSessionGeneration) return;

        this.isInterimText = false;
        this.messageInput.style.height = 'auto';

        // Stop audio capture and disconnect WebSocket
        this.stopAudioCapture();
        this.disconnectAudioWebSocket();

        // Deactivate voice input and voice responses when mic is turned off
        await this.updateVoiceActive(false);
    }

    initializeSpeechRecognition() {
        const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

        if (!SpeechRecognition) {
            console.error('Speech recognition not supported');
            return;
        }

        this.recognition = new SpeechRecognition();
        this.recognition.continuous = true;
        this.recognition.interimResults = true;
        this.recognition.lang = 'ja-JP';

        this.recognition.onresult = (event) => {
            // A real result is the actual proof the recognizer is healthy — onstart
            // firing is not enough, since a persistently failing setup (e.g. a
            // network error right after every start) would still fire onstart each
            // time and never let the backoff in _scheduleRecognitionRestart grow.
            this._recognitionRestartAttempts = 0;
            // Skip browser recognition results when using server recognition
            if (this.useServerRecognition) return;
            // Skip results while Claude is speaking, to avoid picking up speaker echo
            if (this._ttsSpeaking) return;
            // Set only when the post-reply abort failed, so the recognizer is still
            // holding Claude's own voice (see _discardEchoedRecognitionAudio).
            if (this._echoDiscardUntil && Date.now() < this._echoDiscardUntil) return;

            // Collect finals and interims separately, then send once. Reading the
            // text back out of messageInput instead meant a final that arrived
            // without a preceding interim (or whose interims were dropped while
            // _ttsSpeaking) posted an empty string, which the server rejects with
            // 400 "Text is required"; several finals in one event also posted twice.
            let interimTranscript = '';
            let finalTranscript = '';

            for (let i = event.resultIndex; i < event.results.length; i++) {
                const transcript = event.results[i][0].transcript;

                if (event.results[i].isFinal) {
                    finalTranscript += transcript;
                } else {
                    interimTranscript += transcript;
                }
            }

            if (finalTranscript.trim()) {
                this.isInterimText = false;
                this.sendMessage(finalTranscript.trim());
                this.messageInput.value = '';
            }

            if (interimTranscript) {
                this.messageInput.value = interimTranscript;
                this.isInterimText = true;
                this.autoGrowTextarea();
            }
        };

        this.recognition.onstart = () => {
            this._recognitionState = 'running';
            this.debugLog('[VoiceDiag] recognition.onstart isListening=%s ttsSpeaking=%s', this.isListening, this._ttsSpeaking);
            if (!this.isListening) {
                // The mic was switched off while this session was still 'starting', so
                // the stop() issued back then may have thrown (nothing was running yet)
                // and left no live recognizer to stop. Now that one genuinely exists,
                // stop it for real instead of leaving it listening behind a dark button.
                this._stopRecognition();
                return;
            }
            // A session that merely *starts* isn't proof it's healthy — a persistent
            // failure can start and immediately error/end again. Arm a settle timer
            // instead: only forgive past failures once a session has actually run
            // for a while without incident (onresult below is the other, stronger
            // signal — an actual recognized result — and resets immediately).
            clearTimeout(this._recognitionSettleTimer);
            this._recognitionSettleTimer = setTimeout(() => {
                this._recognitionRestartAttempts = 0;
                this.debugLog('[VoiceDiag] recognition settled, resetting restart attempts');
            }, 3000);
        };

        this.recognition.onerror = (event) => {
            this.debugLog('[VoiceDiag] recognition.onerror error=%s isListening=%s ttsSpeaking=%s useServerRecognition=%s', event.error, this.isListening, this._ttsSpeaking, this.useServerRecognition);
            clearTimeout(this._recognitionSettleTimer); // this session didn't survive long enough to count as healthy
            if (event.error === 'no-speech') return;
            console.error('Speech error:', event.error);
            // stopVoiceDictation() also disables voiceActive server-wide (see
            // updateVoiceActive), which makes the `speak` MCP tool fail outright —
            // so a transient recognition error here was silencing Claude's TTS too,
            // not just dropping mic input. Errors that won't resolve on their own
            // (permission denied, no working input device, an unsupported language)
            // still hard-stop immediately; genuinely transient ones (network blips,
            // an aborted recognition cycle) are left to onend's capped-backoff restart
            // below, which keeps retrying for as long as the mic is on.
            const FATAL_ERRORS = ['not-allowed', 'service-not-allowed', 'audio-capture', 'language-not-supported', 'bad-grammar'];
            if (FATAL_ERRORS.includes(event.error)) {
                this.stopVoiceDictation();
            }
        };

        this.recognition.onend = () => {
            this._recognitionState = 'idle';
            this._cancelRecognitionStopFallback();
            this.debugLog('[VoiceDiag] recognition.onend isListening=%s ttsSpeaking=%s useServerRecognition=%s attempts=%s', this.isListening, this._ttsSpeaking, this.useServerRecognition, this._recognitionRestartAttempts);
            clearTimeout(this._recognitionSettleTimer); // ending (outside a deliberate stop) means it didn't settle either
            // Only restart browser recognition if listening, not using server, and Claude isn't speaking.
            // Recognition is no longer stopped for TTS, so reaching here during TTS means it ended on
            // its own; the post-TTS resume in _processTtsQueue's advance() picks it back up.
            const wasEchoAbort = this._recognitionAbortedForEcho;
            this._recognitionAbortedForEcho = false;
            if (!this.isListening || this.useServerRecognition || this._ttsSpeaking) return;
            // Each onend that requires a restart counts as one failed cycle, whether
            // or not the restart attempt itself then throws synchronously — a
            // recognizer that starts fine but errors/ends again moments later
            // (e.g. a persistent network problem) must still count toward the cap.
            // A deliberate echo abort isn't a failure, though: counting those would
            // grow the backoff with every reply until the mic took 30s to come back.
            if (!wasEchoAbort) this._recognitionRestartAttempts++;
            this._scheduleRecognitionRestart();
        };
    }

    // Stops browser recognition and makes sure _recognitionState gets back to 'idle'
    // whatever the API does. stop() on an already-stopped recognizer can throw, and
    // callers must not have that escape (stopVoiceDictation would skip the rest of
    // its teardown); onend can also simply never arrive, which would pin the state at
    // 'running' and make every later start() — including the user switching the mic
    // back on — fall foul of the idle guards.
    _stopRecognition() {
        // Drop any fallback still pending from an earlier stop or echo abort before
        // taking any early return, so it can't fire against a later session.
        this._cancelRecognitionStopFallback();
        if (!this.recognition || this._recognitionState === 'idle') return;
        const generation = ++this._recognitionLifecycleGeneration;
        try {
            this.recognition.stop();
            this._armRecognitionStopFallback(generation, 'stop');
        } catch (e) {
            console.error('Failed to stop recognition:', e);
            this._recognitionState = 'idle';
            this._recognitionAbortedForEcho = false;
        }
    }

    _cancelRecognitionStopFallback() {
        clearTimeout(this._recognitionStopFallbackTimer);
        this._recognitionStopFallbackTimer = null;
    }

    // stop()/abort() should both deliver onend promptly. When one doesn't, the state
    // would stay non-idle and every later start() — including the user simply switching
    // the mic back on — would be refused by the idle guards. The generation check keeps
    // a timer armed for one lifecycle from touching the next one.
    _armRecognitionStopFallback(generation, label) {
        // onend can arrive synchronously from stop()/abort(), in which case there's
        // nothing left to guard against.
        if (this._recognitionState === 'idle') return;
        const timer = setTimeout(() => {
            // Own both the handle and the lifecycle, or do nothing: a callback that was
            // already queued when its timer got cleared must not clear a newer timer's
            // handle or touch a session it no longer belongs to.
            if (this._recognitionStopFallbackTimer !== timer) return;
            if (generation !== this._recognitionLifecycleGeneration) return;
            this._recognitionStopFallbackTimer = null;
            if (this._recognitionState === 'idle') return;
            console.warn(`[Recognition] No onend after ${label}(); forcing state back to idle`);
            this._recognitionState = 'idle';
            this._recognitionAbortedForEcho = false;
            if (this.isListening) this._scheduleRecognitionRestart();
        }, 3000);
        this._recognitionStopFallbackTimer = timer;
    }

    // Recognition deliberately keeps listening through a reply (see _processTtsQueue),
    // so by the time a reply finishes the recognizer is holding a buffer of Claude's
    // own voice off the speakers, which it would deliver as a final result the moment
    // it settles — Claude answering itself. abort() drops that buffer without emitting
    // it; onend then brings recognition straight back.
    //
    // This runs when a reply *ends*, which is what keeps it safe: a wedged synthesiser
    // never gets here, so it can never strand the mic the way stopping at reply start did.
    _discardEchoedRecognitionAudio() {
        if (this.useServerRecognition || !this.recognition) return;
        if (this._recognitionState === 'idle') return;
        // Nothing was ever audible in this burst (a synthesiser that never started —
        // see the onstart watchdog), so there is no echo to drop, and aborting would
        // throw away whatever the user actually said during the silence.
        if (!this._ttsBurstSpoke) return;
        this._cancelRecognitionStopFallback();
        this._recognitionAbortedForEcho = true;
        const generation = ++this._recognitionLifecycleGeneration;
        try {
            this.recognition.abort();
            this._armRecognitionStopFallback(generation, 'abort');
        } catch (e) {
            this._recognitionAbortedForEcho = false;
            console.error('Failed to abort recognition after TTS:', e);
            // The buffer wasn't discarded after all, so the reply is still going to
            // come back as a result. Drop results briefly rather than answering it.
            this._echoDiscardUntil = Date.now() + 1500;
        }
    }

    // Cancels a pending restart without running it. Called when the user turns the mic
    // off or explicitly starts a fresh session, so a stale timer can't fire start() on
    // top of a state that moved on.
    _cancelScheduledRecognitionRestart() {
        if (this._recognitionRestartTimer) {
            clearTimeout(this._recognitionRestartTimer);
            this._recognitionRestartTimer = null;
        }
        clearTimeout(this._recognitionSettleTimer);
    }

    // Exponential backoff restart, capped at the same 30s ceiling scheduleWsReconnect
    // uses, and — like that reconnect loop — it keeps trying for as long as the mic
    // is on rather than giving up after a fixed number of attempts.
    //
    // Giving up used to call stopVoiceDictation(), which also disables voiceActive
    // server-side, so a run of transient `network` errors from Chrome's speech
    // backend took out Claude's *replies* as well as the mic, leaving the mic button
    // dark and the session mute with no way to explain itself. The user pressing the
    // mic button is a standing "I want to be listening" instruction: honour it until
    // they press it again. Errors that genuinely can't recover (permission denied, no
    // input device, unsupported language) still stop everything from onerror above.
    //
    // _recognitionRestartTimer makes this a single in-flight sequence: the three
    // call sites (recognition.onend, post-TTS resume, _cancelBrowserTts) can all
    // ask for a restart, but only one timer is ever pending, so two independent
    // backoff series can never both call start() on the same recognizer.
    // _recognitionRestartAttempts is intentionally NOT reset immediately here or
    // on recognition.onstart — only a genuine onresult, 3s of settled runtime
    // (see the onstart settle timer above), or an explicit new startVoiceDictation()
    // proves the recognizer actually recovered.
    _scheduleRecognitionRestart() {
        if (this._recognitionRestartTimer) return; // already have one in flight
        if (this._recognitionState !== 'idle') return; // start() on a live recognizer throws InvalidStateError
        if (!this.isListening || this.useServerRecognition || this._ttsSpeaking) return;
        const delay = Math.min(30000, 250 * Math.pow(2, this._recognitionRestartAttempts));
        this._recognitionRestartTimer = setTimeout(() => {
            this._recognitionRestartTimer = null;
            if (this._recognitionState !== 'idle') return;
            if (!this.isListening || this.useServerRecognition || this._ttsSpeaking) return;
            this._recognitionState = 'starting';
            try {
                this.recognition.start();
                this.debugLog('[VoiceDiag] recognition restart succeeded after %sms (attempt %s)', delay, this._recognitionRestartAttempts);
            } catch (e) {
                this._recognitionState = 'idle';
                this._recognitionRestartAttempts++;
                this.debugLog('[VoiceDiag] recognition restart threw (attempt %s):', this._recognitionRestartAttempts, e && e.name, e && e.message);
                console.error('Failed to restart recognition:', e);
                this._scheduleRecognitionRestart();
            }
        }, delay);
    }

    async deleteMessage(messageId) {
        try {
            const response = await fetch(`${this.baseUrl}/api/utterances/${messageId}`, {
                method: 'DELETE'
            });

            if (response.ok) {
                // Remove the message bubble from DOM immediately
                const bubble = this.conversationMessages.querySelector(`[data-message-id="${messageId}"]`);
                if (bubble) {
                    bubble.remove();
                }
                // Refresh to sync with server
                this.loadData();
            } else {
                const error = await response.json();
                console.error('Failed to delete message:', error);
                alert(`Failed to delete: ${error.error || 'Unknown error'}`);
            }
        } catch (error) {
            console.error('Failed to delete message:', error);
        }
    }

    _cancelBrowserTts() {
        // Mirrors the server's TTS queue clear (tts-clear) for the browser
        // SpeechSynthesis fallback path, which the server has no visibility into
        // and therefore can't stop on its own.
        if (!window.speechSynthesis) return;
        if (this._ttsRetryTimer) {
            clearTimeout(this._ttsRetryTimer);
            this._ttsRetryTimer = null;
        }
        this._ttsQueue = [];
        this._ttsGeneration++; // invalidate any in-flight/queued utterance's callbacks
        // Only cancel when there is actually something to cancel. This is called on
        // every SSE error (see eventSource.onerror), so a flapping SSE connection
        // fired a long run of no-op cancel() calls. Chrome's speech synthesis service
        // has been observed wedging in this session — speak() silently does nothing
        // and fires no start/end/error events at all, and since the service is per
        // browser process rather than per tab, reloading the page does not clear it.
        // Whether the no-op cancels caused that is unproven, but they buy nothing, so
        // don't issue them.
        if (window.speechSynthesis.speaking || window.speechSynthesis.pending) {
            window.speechSynthesis.cancel();
        }
        this._ttsPlaying = false;
        if (!this._ttsSpeaking) return; // browser TTS wasn't actually muting anything right now
        this._ttsSpeaking = false;
        this._updateMicMuted(); // still respects _wsAudioMuted if that's separately active
        this._discardEchoedRecognitionAudio(); // speech did play before this clear, so it was heard
        if (this.isListening) {
            if (this.micBtn) this.micBtn.classList.add('listening');
            if (!this.useServerRecognition && this.recognition) {
                this._scheduleRecognitionRestart();
            }
        }
    }

    // Queues text for browser TTS instead of interrupting whatever is currently
    // speaking — SpeechSynthesis.speak() would naturally queue back-to-back calls
    // on its own, but earlier code called cancel() before every utterance (to keep
    // stale retries/utterances from firing), which also cut off in-progress speech
    // whenever two `speak` events arrived close together. This queue keeps that
    // cancel() scoped to explicit clears (_cancelBrowserTts) only.
    speakViaBrowser(text) {
        this.debugLog('[VoiceDiag] speakViaBrowser called, hasSpeechSynthesis=%s textLength=%s', !!window.speechSynthesis, (text || '').length);
        if (!window.speechSynthesis || !text) return;
        this._ttsQueue.push({ text, generation: this._ttsGeneration });
        this._processTtsQueue();
    }

    _processTtsQueue(retryCount = 0) {
        if (this._ttsPlaying) return; // an utterance is already in flight; its onend/onerror re-enters this

        const item = this._ttsQueue[0];
        if (!item) return; // nothing queued

        if (item.generation !== this._ttsGeneration) {
            // Cleared (tts-clear) since this was queued — drop it and check the next one.
            this._ttsQueue.shift();
            this._processTtsQueue();
            return;
        }

        // Voice list can still be empty on the very first call even after the
        // DOMContentLoaded warmup; retry briefly rather than silently falling
        // back to whatever default voice the browser picks. Capped so a browser
        // that never installs a Japanese voice doesn't retry forever — it speaks
        // with the default voice instead of staying silent. _voiceWaitExhausted
        // remembers that this cap was already hit once, so a browser with no
        // Japanese voice at all doesn't re-pay the ~3s wait for every queued
        // item — retryCount alone resets to 0 per item and can't track this
        // across calls (reset if the voice list changes; see DOMContentLoaded).
        const MAX_VOICE_WAIT_RETRIES = 20; // ~3s at 150ms
        const voicesNow = window.speechSynthesis.getVoices();
        const hasJaVoice = voicesNow.some((v) => v.lang && v.lang.startsWith('ja'));
        if (!hasJaVoice && !this._voiceWaitExhausted && retryCount < MAX_VOICE_WAIT_RETRIES) {
            // A retry is already scheduled (e.g. from an earlier, still-queued item) —
            // don't stack a second timer on top of it; it will re-check the queue head.
            if (!this._ttsRetryTimer) {
                this._ttsRetryTimer = setTimeout(() => {
                    this._ttsRetryTimer = null;
                    this._processTtsQueue(retryCount + 1);
                }, 150);
            }
            return;
        }
        if (!hasJaVoice) {
            this._voiceWaitExhausted = true;
        }
        this._ttsRetryTimer = null;

        this._ttsQueue.shift();
        this._ttsPlaying = true;
        const generation = item.generation;

        if (!this._ttsSpeaking) {
            // First utterance of this speaking burst — mute the mic once for the
            // whole queue, not per-utterance, so back-to-back speech doesn't
            // flicker the mic on/off between items.
            //
            // Echo suppression is _micMuted (which stops the WS audio stream) plus
            // the _ttsSpeaking guard in recognition.onresult, which is what the
            // design docs assign that job to. Recognition itself is deliberately
            // NOT stopped here: stopping and restarting it around every reply made
            // the mic depend on TTS completing cleanly, so a wedged speech
            // synthesis engine — which never fires onend or onerror — stranded the
            // mic off with no way back short of a page reload.
            this._ttsSpeaking = true;
            this._ttsBurstSpoke = false; // set by utterance.onstart; see _discardEchoedRecognitionAudio
            this._updateMicMuted();
        }

        const utterance = new SpeechSynthesisUtterance(item.text);
        utterance.lang = 'ja-JP';
        // this.speechRate is already a "1.0 = normal" multiplier (see the
        // speech rate slider and its use for the say-based rate above), which
        // is the same scale SpeechSynthesisUtterance.rate expects — this was
        // previously hardcoded to 1.15 and silently ignored the UI's setting
        // on any platform where browser TTS is the only playback path.
        utterance.rate = Math.min(10, Math.max(0.1, this.speechRate || 1.0));
        utterance.pitch = 1.0;
        const voices = window.speechSynthesis.getVoices();
        const jaVoices = voices.filter((v) => v.lang && v.lang.startsWith('ja'));
        // Prefer a voice the machine renders itself. "Google 日本語" sounds better but
        // is synthesised on Google's servers, so on a machine whose Chrome can't reach
        // them it produces silence with no error and no events at all — indistinguishable
        // from a wedged synthesiser, and the reason this only ever worked in Brave
        // (which ships no Google voices and so fell through to a local one).
        const localJaVoices = jaVoices.filter((v) => v.localService);
        const pool = localJaVoices.length ? localJaVoices : jaVoices;
        const priorityNames = ['Haruka', 'Nanami', 'Ayumi', 'Google 日本語'];
        let preferred = null;
        for (const name of priorityNames) {
            preferred = pool.find((v) => v.name.includes(name));
            if (preferred) break;
        }
        if (!preferred) preferred = pool[0];
        if (preferred) utterance.voice = preferred;

        this.debugLog('[VoiceDiag] speaking utterance, jaVoiceCount=%s chosenVoice=%s speaking=%s pending=%s paused=%s', jaVoices.length, preferred && preferred.name, window.speechSynthesis.speaking, window.speechSynthesis.pending, window.speechSynthesis.paused);

        let settled = false;
        const advance = (evt) => {
            // onend/onerror and the watchdog below race each other; whichever lands
            // first owns this utterance's completion.
            if (settled) return;
            settled = true;
            clearTimeout(watchdog);
            this.debugLog('[VoiceDiag] utterance %s fired, error=%s generation=%s currentGeneration=%s', evt && evt.type, evt && evt.error, generation, this._ttsGeneration);
            // Check generation BEFORE touching _ttsPlaying: cancel() delivers this
            // utterance's onend/onerror asynchronously, so a stale callback can still
            // arrive after a newer utterance has already started (and is genuinely
            // in flight). Mutating _ttsPlaying unconditionally would let a second
            // queue item start on top of that still-playing newer utterance.
            if (generation !== this._ttsGeneration) return; // superseded; _cancelBrowserTts already reset state
            this._ttsPlaying = false;
            if (this._ttsQueue.length === 0 || this._ttsQueue[0].generation !== this._ttsGeneration) {
                // Nothing left to speak in this generation — resume the mic
                this._ttsSpeaking = false;
                this._updateMicMuted();
                this._discardEchoedRecognitionAudio();
                this.debugLog('[VoiceDiag] queue drained, resuming mic: isListening=%s recognitionState=%s', this.isListening, this._recognitionState);
                // The desired state comes from isListening alone — the user's standing
                // "I want to be listening". Gating on a snapshot taken when this burst
                // started meant turning the mic on *during* a reply left it stuck off.
                if (this.isListening) {
                    if (this.micBtn) this.micBtn.classList.add('listening');
                    // Recognition normally kept running through the reply; only restart
                    // it if it actually ended (e.g. a network error) while we spoke.
                    if (!this.useServerRecognition && this.recognition && this._recognitionState === 'idle') {
                        this._scheduleRecognitionRestart();
                    }
                }
            }
            this._processTtsQueue();
        };
        utterance.onend = advance;
        utterance.onerror = advance;

        // Chrome's speech synthesis service can wedge (see _cancelBrowserTts): speak()
        // returns normally but the utterance never starts and NO event ever fires —
        // not even onerror. Two separate timers, because "never started" and "started
        // but never finished" need very different budgets: a healthy engine begins an
        // utterance almost immediately once the queue is empty, so a few seconds of
        // silence from onstart is already conclusive, whereas a real utterance
        // legitimately takes as long as its text is long.
        const START_TIMEOUT_MS = 3000;
        let watchdog = setTimeout(() => {
            console.warn(`[TTS] onstart never fired within ${START_TIMEOUT_MS}ms — speech synthesis appears wedged; dropping queued speech and resuming mic`);
            // Nothing is going to come out of this engine right now, so drop the whole
            // queue rather than feeding each remaining item into the same stall (which
            // would hold the mic through one timeout per item).
            this._cancelBrowserTts();
        }, START_TIMEOUT_MS);

        utterance.onstart = () => {
            clearTimeout(watchdog);
            this._ttsBurstSpoke = true; // something really came out of the speakers
            // A cancel (or the start timeout above) may have already retired this
            // utterance; don't arm a completion timer for it in that case.
            if (settled || generation !== this._ttsGeneration) return;
            // Measured from actual start. Only the per-character part scales with
            // rate — dividing the fixed grace too would leave barely a second at the
            // slider's top setting. The divisor is also capped at 2 because engines
            // flatten out well before the requested rate, so a "5x" utterance still
            // takes far longer than a fifth of the time.
            const effectiveRate = Math.min(2, Math.max(0.1, utterance.rate || 1));
            const completionMs = 5000 + (item.text.length * 300) / effectiveRate;
            watchdog = setTimeout(() => {
                console.warn(`[TTS] Started but no end/error event after ${Math.round(completionMs)}ms — dropping queued speech and resuming mic`);
                // Route through the same full reset as the start timeout: advance()
                // alone would unmute the mic while speech may still be playing, and
                // would queue the next utterance behind it.
                this._cancelBrowserTts();
            }, completionMs);
        };

        window.speechSynthesis.speak(utterance);
    }

    // Serialized: two of these in flight at once (a quick mic off/on) could otherwise
    // complete out of order and leave the server holding the older intent, with voice
    // silently disabled behind a lit mic button. Chaining keeps them in call order, so
    // the last toggle the user made is the last one the server sees.
    updateVoiceActive(active) {
        this._voiceActiveChain = (this._voiceActiveChain || Promise.resolve()).then(async () => {
            try {
                await fetch(`${this.baseUrl}/api/voice-active`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ active })
                });
            } catch (error) {
                console.error('Failed to update voice active state:', error);
            }
        });
        return this._voiceActiveChain;
    }

    async syncSelectedVoiceToServer() {
        try {
            await fetch(`${this.baseUrl}/api/selected-voice`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ selectedVoice: 'system', speechRate: Math.round(this.speechRate * 200), feedbackSoundMode: this.feedbackSoundModeSelect ? this.feedbackSoundModeSelect.value : 'continuous' })
            });
        } catch (error) {
            this.debugLog('Failed to sync selected voice to server:', error);
        }
    }

    async syncVoiceStateToServer() {
        // Re-send current browser voice state to the server after a session reset
        await this.updateVoiceActive(this.isListening);
        await this.syncSelectedVoiceToServer();
    }

    async loadBackgroundEnforcement() {
        try {
            const response = await fetch(`${this.baseUrl}/api/background-voice-enforcement`);
            if (response.ok) {
                const data = await response.json();
                if (this.backgroundEnforcementToggle) {
                    this.backgroundEnforcementToggle.checked = data.enabled;
                }
                localStorage.setItem('backgroundVoiceEnforcement', data.enabled.toString());
            }
        } catch (error) {
            this.debugLog('Failed to load background enforcement:', error);
        }
    }

    async updateBackgroundEnforcement(enabled) {
        try {
            localStorage.setItem('backgroundVoiceEnforcement', enabled.toString());
            await fetch(`${this.baseUrl}/api/background-voice-enforcement`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ enabled })
            });
        } catch (error) {
            console.error('Failed to update background enforcement:', error);
        }
    }

    // ── WebSocket audio capture ──────────────────────────────────────

    connectAudioWebSocket() {
        if (this.audioWs && (this.audioWs.readyState === WebSocket.OPEN || this.audioWs.readyState === WebSocket.CONNECTING)) {
            return; // Already connected or connecting
        }

        const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsUrl = `${protocol}//${location.host}/ws/audio`;
        console.log('[WS] Connecting to', wsUrl);

        this.audioWs = new WebSocket(wsUrl);
        this.audioWs.binaryType = 'arraybuffer';

        this.audioWs.onopen = () => {
            console.log('[WS] Connected');
            this.wsConnected = true;
            this.wsReconnectDelay = 1000; // Reset backoff on successful connect
            // Sync browser's selected session to server on WS connect/reconnect
            if (this.selectedSessionKey) {
                this.audioWs.send(JSON.stringify({ type: 'select-session', sessionKey: this.selectedSessionKey }));
            }
            // Start audio capture now that the WS connection is ready
            this.startAudioCapture();
        };

        this.audioWs.onmessage = (event) => {
            if (typeof event.data === 'string') {
                try {
                    const msg = JSON.parse(event.data);
                    this.handleWsMessage(msg);
                } catch (e) {
                    console.error('[WS] Failed to parse message:', e);
                }
            } else if (event.data instanceof ArrayBuffer) {
                // Binary frame = TTS audio PCM data
                if (this.audioPlayer.ttsActive) {
                    this.audioPlayer.playPCMChunk(event.data);
                }
            }
        };

        this.audioWs.onclose = () => {
            console.log('[WS] Disconnected');
            this.wsConnected = false;
            this.audioWs = null;
            // Reset TTS playback state and clear the WS-side mute reason on
            // disconnect (still respects browser TTS's own mute, if active).
            this.audioPlayer.clear();
            this._wsAudioMuted = false;
            this._updateMicMuted();
            // Reconnect if still listening
            if (this.isListening) {
                this.scheduleWsReconnect();
            }
        };

        this.audioWs.onerror = (err) => {
            console.error('[WS] Error:', err);
        };
    }

    handleWsMessage(msg) {
        switch (msg.type) {
            case 'transcript-interim':
                // Display interim transcript in the message input (display only)
                if (this.useServerRecognition) {
                    this.messageInput.value = msg.text;
                    this.isInterimText = true;
                    this.autoGrowTextarea();
                }
                break;
            case 'transcript-final':
                // Server already created the utterance — just display it
                if (this.useServerRecognition) {
                    this.messageInput.value = '';
                    this.isInterimText = false;
                    this.messageInput.style.height = 'auto';
                    // Refresh conversation to show the new message
                    this.loadData();
                }
                break;
            case 'tts-start': {
                const isSfx = msg.kind === 'sfx';
                console.log('[WS] TTS start:', msg.audioId, 'sampleRate:', msg.sampleRate, 'kind:', msg.kind || 'tts');
                this.audioPlayer.prepareForPlayback(msg.sampleRate, msg.audioId);
                if (!isSfx) {
                    // Echo suppression: mute mic audio streaming during TTS playback
                    this._muteAudioCapture(true);
                }
                break;
            }
            case 'tts-end': {
                const isSfx = msg.kind === 'sfx';
                this.debugLog('[WS] TTS end:', msg.audioId, 'kind:', msg.kind || 'tts');
                this.audioPlayer.finishPlayback();
                if (!isSfx) {
                    // Wait for actual audio playback to finish, then ack and unmute
                    // (streaming finishes faster than playback)
                    this._waitForPlaybackThenAck(msg.audioId);
                }
                break;
            }
            case 'tts-clear':
                // Browser TTS (SpeechSynthesis) is driven entirely by the SSE `speak`
                // event, so it's cleared there (see the SSE tts-clear handler above).
                // The server broadcasts tts-clear on both SSE and this WS channel for
                // the same event; calling _cancelBrowserTts() from both risks a
                // duplicate/out-of-order clear cancelling a legitimate new utterance
                // that started in the gap between the two deliveries.
                this.debugLog('[WS] TTS clear');
                this.audioPlayer.clear();
                this._muteAudioCapture(false);
                break;
            case 'pong':
                this.debugLog('[WS] Received pong');
                break;
            case 'error':
                console.error('[WS] Server error:', msg.message);
                if (msg.code === 'no_session_selected' && msg.text) {
                    // The server dropped this speech instead of guessing which
                    // session it belongs to (see resolveSessionForNewInput on the
                    // server) — restore it into the input box so it isn't silently
                    // lost, matching sendMessage()'s 409 handling for typed text.
                    this.messageInput.value = msg.text;
                    this.isInterimText = false;
                    this.autoGrowTextarea();
                    alert('複数のセッションが起動中です。左のSessionsパネルから対象のセッションを選択してから送信してください。');
                }
                break;
            default:
                this.debugLog('[WS] Unknown message type:', msg.type);
        }
    }

    // Recomputes the actual mic-capture gate from both independent mute
    // reasons — see the constructor comment on _wsAudioMuted/_ttsSpeaking.
    _updateMicMuted() {
        this._micMuted = this._wsAudioMuted || this._ttsSpeaking;
    }

    // Echo suppression: mute/unmute mic audio streaming for the WS/say-based
    // playback path specifically. Does not by itself unmute if browser TTS
    // (_ttsSpeaking) is still separately holding the mute.
    _muteAudioCapture(mute) {
        this._wsAudioMuted = mute;
        this._updateMicMuted();
    }

    _waitForPlaybackThenAck(audioId) {
        // Poll until AudioPlayer finishes all scheduled playback, then:
        // 1. Send tts-ack to server (so it knows playback is truly done)
        // 2. Unmute mic
        const checkDone = () => {
            if (!this.audioPlayer.isPlaying()) {
                if (this.audioWs && this.audioWs.readyState === WebSocket.OPEN) {
                    this.audioWs.send(JSON.stringify({ type: 'tts-ack', audioId }));
                }
                this._muteAudioCapture(false);
            } else {
                setTimeout(checkDone, 100);
            }
        };
        setTimeout(checkDone, 100);
    }

    scheduleWsReconnect() {
        if (this.wsReconnectTimer) return; // Already scheduled
        this.debugLog(`[WS] Reconnecting in ${this.wsReconnectDelay}ms`);
        this.wsReconnectTimer = setTimeout(() => {
            this.wsReconnectTimer = null;
            if (this.isListening) {
                this.connectAudioWebSocket();
            }
        }, this.wsReconnectDelay);
        // Exponential backoff: 1s, 2s, 4s, 8s, max 30s
        this.wsReconnectDelay = Math.min(this.wsReconnectDelay * 2, 30000);
    }

    disconnectAudioWebSocket() {
        if (this.wsReconnectTimer) {
            clearTimeout(this.wsReconnectTimer);
            this.wsReconnectTimer = null;
        }
        if (this.audioWs) {
            this.audioWs.close();
            this.audioWs = null;
        }
    }

    async startAudioCapture() {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    channelCount: 1,
                    echoCancellation: true,
                    autoGainControl: true,
                    noiseSuppression: true,
                }
            });
            this.mediaStream = stream;

            // Create AudioContext at native rate — worklet handles downsampling
            this.audioContext = new AudioContext();
            await this.audioContext.resume(); // Required on iOS after user gesture

            const source = this.audioContext.createMediaStreamSource(stream);
            await this.audioContext.audioWorklet.addModule('/audio-capture-worklet.js');

            this.audioWorkletNode = new AudioWorkletNode(this.audioContext, 'audio-capture-processor');
            this.audioWorkletNode.port.onmessage = (e) => {
                if (e.data.type === 'audio-frame' && this.audioWs && this.audioWs.readyState === WebSocket.OPEN && !this._micMuted) {
                    // Convert Float32 [-1,1] to Int16 PCM
                    const float32 = e.data.frame;
                    const pcm16 = new Int16Array(float32.length);
                    for (let i = 0; i < float32.length; i++) {
                        const s = Math.max(-1, Math.min(1, float32[i]));
                        pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
                    }
                    this.audioWs.send(pcm16.buffer);
                }
            };

            source.connect(this.audioWorkletNode);
            // Connect through a silent GainNode to keep the worklet processing
            // without playing captured audio through speakers (avoids feedback)
            const silentGain = this.audioContext.createGain();
            silentGain.gain.value = 0;
            this.audioWorkletNode.connect(silentGain);
            silentGain.connect(this.audioContext.destination);

            // Send audio-start control message
            if (this.audioWs && this.audioWs.readyState === WebSocket.OPEN) {
                this.audioWs.send(JSON.stringify({
                    type: 'audio-start',
                    sampleRate: 16000,
                    channels: 1,
                    encoding: 'pcm16',
                }));
            }

            this.debugLog('[Audio] Capture started, native rate:', this.audioContext.sampleRate);
        } catch (err) {
            console.error('[Audio] Failed to start capture:', err);
        }
    }

    stopAudioCapture() {
        // Send audio-stop control message
        if (this.audioWs && this.audioWs.readyState === WebSocket.OPEN) {
            this.audioWs.send(JSON.stringify({ type: 'audio-stop' }));
        }

        // Clean up AudioWorklet and context
        if (this.audioWorkletNode) {
            this.audioWorkletNode.disconnect();
            this.audioWorkletNode = null;
        }
        if (this.audioContext) {
            this.audioContext.close().catch(() => {});
            this.audioContext = null;
        }
        if (this.mediaStream) {
            this.mediaStream.getTracks().forEach(track => track.stop());
            this.mediaStream = null;
        }

        this.debugLog('[Audio] Capture stopped');
    }
}

// Initialize when page loads
document.addEventListener('DOMContentLoaded', () => {
    // Warm up the speech synthesis voice list early, since getVoices() can
    // return an empty array on the very first call in some browsers.
    if (window.speechSynthesis) {
        window.speechSynthesis.getVoices();
        window.speechSynthesis.onvoiceschanged = () => window.speechSynthesis.getVoices();
    }
    new MessengerClient();
});
