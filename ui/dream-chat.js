// ui/dream-chat.js
document.addEventListener('DOMContentLoaded', () => {
    const chatContainer = document.getElementById('dream-chat-container');
    if (!chatContainer) {
        console.warn('Dream chat container not found. UI elements will not be initialized.');
        return;
    }

    // Inject UI elements for provider and model selection
    chatContainer.innerHTML = `
        <div class="chat-controls">
            <label for="provider-select">Provider:</label>

