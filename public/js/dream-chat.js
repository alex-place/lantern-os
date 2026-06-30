const socket = io();

const messages = document.getElementById('messages');
const form = document.getElementById('form');
const input = document.getElementById('input');

form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (input.value) {
        socket.emit('chat message', input.value);
        input.value = '';
    }
});

let currentOuroMessageElement = null;

socket.on('chat message', (msg) => {
    if (msg.user === 'You') {
        const item = document.createElement('li');
        item.textContent = `${msg.user}: ${msg.text}`;
        messages.appendChild(item);
    } else if (msg.user === 'Ouro') {
        if (msg.isStreaming) {
            if (!currentOuroMessageElement || currentOuroMessageElement.dataset.streaming === 'false') {
                currentOuroMessageElement = document.createElement('li');
                currentOuroMessageElement.dataset.streaming = 'true';
                messages.appendChild(currentOuroMessageElement);
            }
            currentOuroMessageElement.textContent += msg.text;
            if (msg.isOllama) {
                currentOuroMessageElement.classList.add('ollama-response');
                currentOuroMessageElement.title = 'Response from local Ollama';
            }
        } else {
            if (currentOuroMessageElement && currentOuroMessageElement.dataset.streaming === 'true') {
                currentOuroMessageElement.dataset.streaming = 'false';
                // Final update for streaming message, if any
            } else {
                // Non-streaming message (e.g., error or disabled Ollama)
                const item = document.createElement('li');
                item.textContent = `${msg.user}: ${msg.text}`;
                if (msg.isOllama) {
                    item.classList.add('ollama-response');
                    item.title = 'Response from local Ollama';
                }
                messages.appendChild(item);
            }
            currentOuroMessageElement = null; // Reset for the next message
        }
    }
    messages.scrollTop = messages.scrollHeight;
});
