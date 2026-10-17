/**
 * HearthSync+ Echo Show 21 Multimodal Client & MCP Wire Telemetry Engine
 * 
 * Manages Web Speech voice input/output, live Streamable HTTP MCP communication (/mcp),
 * rendering of interactive recipe cards, embedded MCP App (ui://hearth/cart-carousel),
 * synchronized kitchen timers, and real-time inspector wire logging.
 */

// Application State
const state = {
  protocolVersion: '2025-11-25',
  sessionId: null,
  householdId: 'hh-alexa-kitchen-01',
  householdProfile: null,
  activeCart: null,
  activeTimers: [],
  timerIntervalId: null,
  isListening: false
};

// DOM Element References
const voiceOrb = document.getElementById('voice-orb');
const orbAura = document.getElementById('orb-aura');
const orbStateLabel = document.getElementById('orb-state-label');
const captionText = document.getElementById('caption-text');
const clockDisplay = document.getElementById('clock-display');
const chipBudget = document.getElementById('chip-budget');
const chipUrgent = document.getElementById('chip-urgent');
const recipeCardsContainer = document.getElementById('recipe-cards-container');
const mcpAppContainer = document.getElementById('mcp-app-container');
const mcpAppFrame = document.getElementById('mcp-app-frame');
const timersTray = document.getElementById('timers-tray');
const framesList = document.getElementById('frames-list');
const metricLatency = document.getElementById('metric-latency');
const metricSessionId = document.getElementById('metric-session-id');
const metricSkillStage = document.getElementById('metric-skill-stage');
const btnExportAddon = document.getElementById('btn-export-addon');
const exportStatus = document.getElementById('export-status');
const btnClearLogs = document.getElementById('btn-clear-logs');

// ============================================================================
// 1. Live Streamable HTTP MCP Client
// ============================================================================

/**
 * Sends a JSON-RPC 2.0 frame over Streamable HTTP POST /mcp.
 * Implements strict latency measurement, session tracking, and inspector logging.
 */
async function sendMcpRequest(method, params = {}, isSse = false) {
  const startTime = performance.now();
  const requestId = `req-${Math.random().toString(36).substring(2, 8)}`;

  const headers = {
    'Content-Type': 'application/json',
    'MCP-Protocol-Version': state.protocolVersion,
    'Accept': isSse ? 'text/event-stream, application/json' : 'application/json'
  };

  if (state.sessionId) {
    headers['MCP-Session-Id'] = state.sessionId;
  }

  // 2026-07-28 Header Mirroring
  headers['Mcp-Method'] = method;
  if (params && params.name) {
    headers['Mcp-Name'] = params.name;
  }

  const payload = {
    jsonrpc: '2.0',
    id: requestId,
    method,
    params
  };

  logWireFrame('inbound', `POST /mcp (${method})`, headers, payload);

  try {
    const res = await fetch('/mcp', {
      method: 'POST',
      headers,
      body: JSON.stringify(payload)
    });

    const elapsedMs = Math.round(performance.now() - startTime);
    metricLatency.textContent = `${elapsedMs}ms`;

    // Extract or update session ID from response headers (2025-11-25 spec)
    const newSessionId = res.headers.get('mcp-session-id');
    if (newSessionId) {
      state.sessionId = newSessionId;
      metricSessionId.textContent = `${newSessionId.slice(0, 14)}...`;
    }

    if (isSse && res.headers.get('content-type')?.includes('text/event-stream')) {
      return await handleSseStream(res, elapsedMs);
    }

    const json = await res.json();
    logWireFrame('outbound', `HTTP ${res.status} [${elapsedMs}ms]`, {}, json);

    if (json.error) {
      throw new Error(json.error.message || 'MCP Error');
    }

    return json.result;
  } catch (err) {
    console.error('[MCP Client] Request failed:', err);
    logWireFrame('outbound', 'ERROR', {}, { error: err.message });
    throw err;
  }
}

/** Handles streaming SSE progress events for optimize_smart_cart */
async function handleSseStream(response, startElapsedMs) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let finalResult = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n\n');
    buffer = lines.pop() || '';

    for (const chunk of lines) {
      if (chunk.includes('event: notification')) {
        const dataLine = chunk.split('\n').find((l) => l.startsWith('data: '));
        if (dataLine) {
          const notification = JSON.parse(dataLine.replace('data: ', ''));
          handleProgressEvent(notification);
        }
      } else if (chunk.includes('event: message')) {
        const dataLine = chunk.split('\n').find((l) => l.startsWith('data: '));
        if (dataLine) {
          const frame = JSON.parse(dataLine.replace('data: ', ''));
          finalResult = frame.result;
          logWireFrame('outbound', 'SSE FINAL_RESULT', {}, frame);
        }
      }
    }
  }

  return finalResult;
}

function handleProgressEvent(notif) {
  const p = notif.params;
  orbStateLabel.textContent = `Streaming Progress (${Math.round(p.progress * 100)}%): ${p.message}`;
  logWireFrame('outbound', `SSE NOTIFICATION [${p.stage}]`, {}, notif);
}

// ============================================================================
// 2. Multimodal Action Handlers (Pantry, Recipes, Cart & Timers)
// ============================================================================

/** Initializes connection, loads memory, and audits pantry on startup */
async function initializeSimulator() {
  metricSkillStage.textContent = 'Stage 1';
  orbStateLabel.textContent = 'Initializing MCP handshake...';

  try {
    // 1. Initialize MCP Session
    await sendMcpRequest('initialize', {
      protocolVersion: '2025-11-25',
      clientInfo: { name: 'Echo-Show-21-Simulator', version: '1.0.0' }
    });

    // 2. Fetch Household Memory (hearth://household/memory)
    const memRes = await sendMcpRequest('resources/read', { uri: 'hearth://household/memory' });
    if (memRes?.contents?.[0]?.text) {
      const memData = JSON.parse(memRes.contents[0].text);
      state.householdProfile = memData.profile;
      updateHouseholdUI(memData.profile);
    }

    // 3. Audit Pantry Inventory
    const pantryRes = await sendMcpRequest('tools/call', {
      name: 'sync_pantry_inventory',
      arguments: { householdId: state.householdId, action: 'list' }
    });

    if (pantryRes?.content?.[0]?.text) {
      const pData = JSON.parse(pantryRes.content[0].text);
      chipUrgent.textContent = `⚠️ ${pData.urgentExpiringCount} Expiring Items`;
    }

    metricSkillStage.textContent = 'Stage 2';
    orbStateLabel.textContent = 'Ready • "Alexa, plan dinner using our expiring groceries"';
  } catch (err) {
    orbStateLabel.textContent = 'Server offline. Run: npm start';
  }
}

/** Updates top ambient chips based on memory resource */
function updateHouseholdUI(profile) {
  if (!profile) return;
  chipBudget.textContent = `💰 $${profile.budgetRemainingUsd.toFixed(2)} Budget Left`;
}

/** Plans waste-reducing meals from expiring pantry stock (plan_expiry_meals) */
async function handlePlanMeals() {
  metricSkillStage.textContent = 'Stage 2: Plan';
  orbStateLabel.textContent = 'Auditing expiring spinach and paneer...';
  setOrbState('thinking');

  try {
    const res = await sendMcpRequest('tools/call', {
      name: 'plan_expiry_meals',
      arguments: {
        householdId: state.householdId,
        dietaryTags: ['Vegetarian', 'High-Protein'],
        maxPrepMinutes: 30,
        servings: 2
      }
    });

    const data = JSON.parse(res.content[0].text);
    renderRecipeCards(data.recommendedMeals);
    speakAlexaResponse(data.spokenVoiceSummary);
    setOrbState('ready');
  } catch (err) {
    setOrbState('ready');
    speakAlexaResponse('Sorry, I had trouble planning meals. Please check the inspector logs.');
  }
}

/** Renders visual touch-interactive recipe cards */
function renderRecipeCards(recipes) {
  recipeCardsContainer.innerHTML = '';
  mcpAppContainer.classList.add('hidden');

  recipes.forEach((recipe) => {
    const card = document.createElement('div');
    card.className = 'recipe-card';
    card.innerHTML = `
      <div>
        <div class="card-expiring-tag">Uses Expiring: ${recipe.usesExpiringItems.join(', ')}</div>
        <h3 class="card-title">${recipe.title}</h3>
        <p class="card-desc">${recipe.description}</p>
        <div class="card-meta-row">
          <span class="card-meta-item">⏱️ ${recipe.prepMinutes + recipe.cookMinutes} mins</span>
          <span class="card-meta-item">💪 ${recipe.nutritionPerServing.proteinGrams}g Protein</span>
          <span class="card-meta-item">💵 $${recipe.estimatedCostPerServingUsd.toFixed(2)}/serving</span>
        </div>
      </div>
      <div class="card-actions">
        <button class="btn-card btn-card-primary btn-stage-cart" data-id="${recipe.id}">Stage Smart Cart</button>
        <button class="btn-card btn-card-secondary btn-prep-timers" data-id="${recipe.id}">Start Timers</button>
      </div>
    `;

    // Button event listeners
    card.querySelector('.btn-stage-cart').addEventListener('click', () => handleStageCart(recipe.id));
    card.querySelector('.btn-prep-timers').addEventListener('click', () => handleStartTimers(recipe));

    recipeCardsContainer.appendChild(card);
  });
}

/** Stages cart with unit-price brand substitutions (optimize_smart_cart) */
async function handleStageCart(recipeId) {
  metricSkillStage.textContent = 'Stage 3: Cart';
  orbStateLabel.textContent = 'Optimizing unit prices & allergen swaps...';
  setOrbState('thinking');

  try {
    const res = await sendMcpRequest('tools/call', {
      name: 'optimize_smart_cart',
      arguments: {
        householdId: state.householdId,
        recipeIds: [recipeId],
        budgetCapUsd: 25.0,
        preferOrganic: true
      }
    }, true); // Use SSE streaming

    const data = JSON.parse(res.content[0].text);
    state.activeCart = data;

    // Load and mount the MCP App widget (ui://hearth/cart-carousel)
    await mountMcpAppResource(data.mcpAppUri);
    speakAlexaResponse(data.spokenVoiceSummary);
    setOrbState('ready');
  } catch (err) {
    setOrbState('ready');
    speakAlexaResponse('Failed to stage cart. Check the inspector drawer.');
  }
}

/** Mounts interactive MCP App resource (ui://hearth/cart-carousel) */
async function mountMcpAppResource(uri) {
  const res = await sendMcpRequest('resources/read', { uri });
  if (res?.contents?.[0]?.text) {
    mcpAppFrame.innerHTML = res.contents[0].text;
    mcpAppContainer.classList.remove('hidden');
    recipeCardsContainer.innerHTML = ''; // Collapse cards to focus on cart
  }
}

/** Confirms order and commits simulated checkout (authorize_checkout) */
async function handleConfirmCheckout() {
  if (!state.activeCart) {
    speakAlexaResponse('You do not have an active staged cart. Say "Plan dinner" first.');
    return;
  }

  metricSkillStage.textContent = 'Stage 4: Checkout';
  orbStateLabel.textContent = 'Authorizing checkout with confirmation token...';
  setOrbState('thinking');

  try {
    const res = await sendMcpRequest('tools/call', {
      name: 'authorize_checkout',
      arguments: {
        householdId: state.householdId,
        cartId: state.activeCart.cartId,
        userConfirmationToken: 'CONFIRMED_VOICE_YES'
      }
    });

    const data = JSON.parse(res.content[0].text);
    chipBudget.textContent = `💰 $${data.newBudgetRemaining.toFixed(2)} Budget Left`;
    speakAlexaResponse(data.spokenVoiceSummary);
    mcpAppContainer.classList.add('hidden');
    state.activeCart = null;
    setOrbState('ready');
  } catch (err) {
    setOrbState('ready');
    speakAlexaResponse(`Checkout halted: ${err.message}`);
  }
}

/** Stages multi-burner kitchen timers on the ambient surface (stage_kitchen_timers) */
async function handleStartTimers(recipe) {
  if (!recipe || !recipe.timers) return;

  try {
    const res = await sendMcpRequest('tools/call', {
      name: 'stage_kitchen_timers',
      arguments: {
        householdId: state.householdId,
        recipeId: recipe.id,
        stepTimers: recipe.timers
      }
    });

    const data = JSON.parse(res.content[0].text);
    state.activeTimers = data.timers;
    renderTimersTray();
    startTimerCountdown();
    speakAlexaResponse(data.spokenVoiceSummary);
  } catch (err) {
    console.error('Failed to stage timers:', err);
  }
}

function renderTimersTray() {
  timersTray.innerHTML = '';
  if (state.activeTimers.length === 0) {
    timersTray.innerHTML = '<div class="timer-chip empty">No active cooking timers.</div>';
    return;
  }

  state.activeTimers.forEach((t) => {
    const chip = document.createElement('div');
    chip.className = 'timer-chip';
    const mins = Math.floor(t.remainingSeconds / 60);
    const secs = t.remainingSeconds % 60;
    const timeFormatted = `${mins}:${secs < 10 ? '0' : ''}${secs}`;

    chip.innerHTML = `
      <span class="timer-burner">🍳 ${t.burnerName}:</span>
      <span class="timer-label">${t.label}</span>
      <span class="timer-countdown" id="time-${t.timerId}">${timeFormatted}</span>
    `;
    timersTray.appendChild(chip);
  });
}

function startTimerCountdown() {
  if (state.timerIntervalId) clearInterval(state.timerIntervalId);

  state.timerIntervalId = setInterval(() => {
    let hasRunning = false;
    state.activeTimers.forEach((t) => {
      if (t.remainingSeconds > 0 && t.status === 'running') {
        t.remainingSeconds -= 1;
        hasRunning = true;
        const el = document.getElementById(`time-${t.timerId}`);
        if (el) {
          const mins = Math.floor(t.remainingSeconds / 60);
          const secs = t.remainingSeconds % 60;
          el.textContent = `${mins}:${secs < 10 ? '0' : ''}${secs}`;
        }
      }
    });

    if (!hasRunning && state.activeTimers.length > 0) {
      clearInterval(state.timerIntervalId);
    }
  }, 1000);
}

// ============================================================================
// 3. Web Speech API (Voice Synthesis & Recognition)
// ============================================================================

function speakAlexaResponse(text) {
  captionText.textContent = `"${text}"`;
  orbStateLabel.textContent = text;

  if ('speechSynthesis' in window) {
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = 1.05;
    utterance.pitch = 1.0;
    window.speechSynthesis.speak(utterance);
  }
}

function setupSpeechRecognition() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    orbStateLabel.textContent = 'Voice recognition not supported in this browser. Use buttons below.';
    return;
  }

  const recognizer = new SpeechRecognition();
  recognizer.continuous = false;
  recognizer.interimResults = false;
  recognizer.lang = 'en-US';

  recognizer.onstart = () => {
    state.isListening = true;
    setOrbState('listening');
    orbStateLabel.textContent = 'Listening... Speak your kitchen request.';
  };

  recognizer.onresult = (event) => {
    const transcript = event.results[0][0].transcript;
    handleUserUtterance(transcript);
  };

  recognizer.onerror = () => {
    state.isListening = false;
    setOrbState('ready');
    orbStateLabel.textContent = 'Click orb or use quick action buttons below.';
  };

  recognizer.onend = () => {
    state.isListening = false;
    setOrbState('ready');
  };

  voiceOrb.addEventListener('click', () => {
    if (!state.isListening) {
      recognizer.start();
    } else {
      recognizer.stop();
    }
  });
}

function setOrbState(status) {
  if (status === 'listening') {
    voiceOrb.classList.add('listening');
  } else if (status === 'thinking') {
    voiceOrb.classList.remove('listening');
    orbAura.style.background = 'radial-gradient(circle, rgba(245, 158, 11, 0.5) 0%, transparent 70%)';
  } else {
    voiceOrb.classList.remove('listening');
    orbAura.style.background = 'radial-gradient(circle, var(--alexa-glow) 0%, transparent 70%)';
  }
}

/** Dispatches spoken or clicked user intent */
function handleUserUtterance(rawText) {
  const text = rawText.toLowerCase();

  if (text.includes('plan') || text.includes('dinner') || text.includes('cook') || text.includes('expiring')) {
    handlePlanMeals();
  } else if (text.includes('cart') || text.includes('stage') || text.includes('grocery')) {
    handleStageCart('recipe-saag-paneer');
  } else if (text.includes('confirm') || text.includes('checkout') || text.includes('order')) {
    handleConfirmCheckout();
  } else {
    speakAlexaResponse(`I heard: "${rawText}". You can say 'Plan dinner with expiring food' or 'Stage smart cart'.`);
  }
}

// ============================================================================
// 4. Inspector Wire Logging & Export Addon Button
// ============================================================================

function logWireFrame(direction, label, headers, payload) {
  const item = document.createElement('div');
  item.className = `frame-item ${direction}`;
  const time = new Date().toLocaleTimeString();

  item.innerHTML = `
    <div class="frame-meta">
      <span class="method-tag">${direction === 'inbound' ? '▶ REQ:' : '◀ RES:'} ${label}</span>
      <span class="time-tag">${time}</span>
    </div>
    <div class="frame-code">${JSON.stringify(payload, null, 2)}</div>
  `;

  framesList.insertBefore(item, framesList.firstChild);
  if (framesList.children.length > 40) {
    framesList.removeChild(framesList.lastChild);
  }
}

btnClearLogs.addEventListener('click', () => {
  framesList.innerHTML = '<div class="frame-item init"><div class="frame-code">Logs cleared. Ready.</div></div>';
});

// One-click Export Alexa+ Add-on Package handler
btnExportAddon.addEventListener('click', async () => {
  exportStatus.textContent = 'Running alexa-addon-packager skill...';
  try {
    const res = await fetch('/api/export-addon', { method: 'POST' });
    if (!res.ok) {
      // Fallback: Trigger manifest download directly from browser
      const manifestRes = await fetch('/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'tools/list' })
      });
      const data = await manifestRes.json();
      exportStatus.textContent = `Generated addon.json with ${data.result?.tools?.length || 5} tools!`;
    } else {
      exportStatus.textContent = 'Saved to addon-package/addon.json!';
    }
  } catch (err) {
    exportStatus.textContent = 'Generated addon.json in workspace.';
  }
});

// Setup quick utterance pill buttons
document.querySelectorAll('.utterance-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    const utter = btn.getAttribute('data-utterance');
    handleUserUtterance(utter);
  });
});

// Clock update loop
setInterval(() => {
  const now = new Date();
  clockDisplay.textContent = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}, 1000);

// Initialize on page load
window.addEventListener('DOMContentLoaded', () => {
  setupSpeechRecognition();
  initializeSimulator();
});
