import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { Ollama } from 'ollama';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);
const ollama = new Ollama({ host: process.env.OLLAMA_HOST || 'http://localhost:11434' });

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

app.use(express.static(join(__dirname, 'public')));

console.log(`OURO_CANARY: ${process.env.OURO_CANARY}`);
console.log(`OURO_ADAPT: ${process.env.OURO_ADAPT}`);

io.on('connection', (socket) => {
    console.log('a user connected');

    socket.on('chat message', async (msg) => {
        console.log('message: ' + msg);
        io.emit('chat message', { user: 'You', text: msg });

        try {
            let fullResponse = '';
            let isOllamaFallback = false;

            // Attempt to use Ollama if enabled
            if (process.env.USE_OLLAMA === 'true') {
                isOllamaFallback = true;
                console.log('Using Ollama for response.');

                // Canary mechanism for repetition detection
                if (process.env.OURO_ADAPT === '1' && process.env.OURO_CANARY === '1') {
                    console.log('Canary mechanism active.');
                    // Simple repetition check for demonstration.
                    // In a real scenario, this would be more sophisticated.
                    const lastFewWords = msg.split(/\s+/).slice(-5).join(' ');
                    if (fullResponse.includes(lastFewWords) && lastFewWords.length > 0) {
                        console.warn('Canary detected potential repetition. Blocking response.');
                        io.emit('chat message', { user: 'Ouro', text: 'Canary detected repetition. Please rephrase.' });
                        return;
                    }
                }

                const response = await ollama.chat({
                    model: 'llama2', // Or your preferred local model
                    messages: [{ role: 'user', content: msg }],
                    stream: true,
                    options: {
                        temperature: 0.7,
                        top_k: 40,
                        top_p: 0.9,
                        num_predict: 100,
                        repetition_penalty: 1.1, // Adjusted for less repetition
                        no_repeat_ngram: 3, // Prevents repeating n-grams of this size
                    },
                });

                for await (const chunk of response) {
                    fullResponse += chunk.content;
                    io.emit('chat message', { user: 'Ouro', text: chunk.content, isStreaming: true, isOllama: isOllamaFallback });
                }
                io.emit('chat message', { user: 'Ouro', text: '', isStreaming: false, isOllama: isOllamaFallback }); // Signal end of stream
            } else {
                // Fallback to a simple echo or predefined response if Ollama is not used
                fullResponse = `You said: "${msg}". (Ollama is disabled)`;
                io.emit('chat message', { user: 'Ouro', text: fullResponse, isOllama: isOllamaFallback });
            }

            console.log('Ouro response: ' + fullResponse);

        } catch (error) {
            console.error('Error processing message with Ollama:', error);
            if (error.message.includes('connect ECONNREFUSED')) {
                io.emit('chat message', { user: 'Ouro', text: 'Error: Could not connect to Ollama. Please ensure Ollama is running and accessible.', isError: true });
            } else {
                io.emit('chat message', { user: 'Ouro', text: 'Error: Something went wrong with the AI response.', isError: true });
            }
        }
    });

    socket.on('disconnect', () => {
        console.log('user disconnected');
    });
});

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Ollama host: ${process.env.OLLAMA_HOST || 'http://localhost:11434'}`);
    if (process.env.USE_OLLAMA === 'true') {
        console.log('Ollama integration is ENABLED.');
    } else {
        console.log('Ollama integration is DISABLED. Using fallback responses.');
    }
});
