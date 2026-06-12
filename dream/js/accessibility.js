// ── Accessibility Mode Functions ──
console.log('[accessibility.js] Loading accessibility functions');

window.simpleMode = false;
window.voiceMode = false;
window.recognition = null;

window.toggleSimpleMode = function() {
  console.log('[toggleSimpleMode] Called');
  window.simpleMode = !window.simpleMode;
  const btn = document.getElementById('simple-mode-btn');
  if (btn) {
    btn.style.opacity = window.simpleMode ? '1' : '0.5';
    btn.style.background = window.simpleMode ? 'rgba(52,211,153,0.2)' : 'transparent';
    btn.style.border = window.simpleMode ? '2px solid #34d399' : 'none';
  }
  
  const mandala = document.querySelector('.nav-brand img');
  if (mandala) {
    mandala.style.animation = window.simpleMode ? 'heartbeat 1.5s ease-in-out infinite' : '';
  }
};

window.toggleVoice = function() {
  console.log('[toggleVoice] Called');
  window.voiceMode = !window.voiceMode;
  const btn = document.getElementById('voice-btn');
  const voiceInputBtn = document.getElementById('voice-input-btn');
  if (btn) {
    btn.style.opacity = window.voiceMode ? '1' : '0.5';
    btn.style.background = window.voiceMode ? 'rgba(161,139,250,0.2)' : 'transparent';
    btn.style.border = window.voiceMode ? '2px solid #a78bfa' : 'none';
  }
  
  if (voiceInputBtn) {
    voiceInputBtn.style.display = window.voiceMode ? 'block' : 'none';
  }
};

// Attach event listeners immediately (not waiting for DOMContentLoaded)
// Try immediately, then retry if DOM not ready
function attachListeners() {
  console.log('[accessibility.js] Attempting to attach listeners');
  
  const simpleModeBtn = document.getElementById('simple-mode-btn');
  if (simpleModeBtn) {
    simpleModeBtn.addEventListener('click', window.toggleSimpleMode);
    console.log('[accessibility.js] Attached listener to simple-mode-btn');
  } else {
    console.error('[accessibility.js] simple-mode-btn not found');
  }
  
  const voiceBtn = document.getElementById('voice-btn');
  if (voiceBtn) {
    voiceBtn.addEventListener('click', window.toggleVoice);
    console.log('[accessibility.js] Attached listener to voice-btn');
  } else {
    console.error('[accessibility.js] voice-btn not found');
  }
  
  console.log('[accessibility.js] toggleSimpleMode defined:', typeof window.toggleSimpleMode);
  console.log('[accessibility.js] toggleVoice defined:', typeof window.toggleVoice);
}

// Try immediately
attachListeners();

// Also try on DOMContentLoaded as fallback
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', attachListeners);
} else {
  // DOM already loaded
  setTimeout(attachListeners, 100);
}
