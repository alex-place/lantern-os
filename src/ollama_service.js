// src/ollama_service.js

class OllamaService {
    async generate(prompt, options = {}) {
        const defaultOptions = {
            model: 'llama2',
            stream: false,
            // ... other default options
        };

        let finalOptions = { ...defaultOptions, ...options };

        // Step 1: Ensure repeat_penalty is passed and adjusted
        if (finalOptions.repeat_penalty === undefined) {
            finalOptions.repeat_penalty = 1.2; // Add with initial value
        } else if (finalOptions.repeat_penalty < 1.3) { // Example: increase if less than 1.3
            finalOptions.repeat_penalty = 1.3; // Aggressively increase
        }

        const payload = {
            prompt: prompt,
            options: {
                repeat_penalty: finalOptions.repeat_penalty,
                // ... other Ollama specific options from finalOptions
            },
            model: finalOptions.model,
            stream: finalOptions.stream,
        };

        console.log('Ollama API call payload:', JSON.stringify(payload, null, 2));

        try {
            const response = await fetch('http://localhost:11434/api/generate', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });
            if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
            const data = await response.json();
            return data.response;
        } catch (error) {
            console.error('Error calling Ollama API:', error);
            throw error;
        }
    }
