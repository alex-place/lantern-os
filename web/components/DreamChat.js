import React, { useState, useEffect } from 'react';

const providerModels = {
  openai: ['gpt-4o', 'gpt-4-turbo', 'gpt-3.5-turbo'],
  claude: ['claude-3-opus-20240229', 'claude-3-sonnet-20240229', 'claude-3-haiku-20240307'],
  gemini: ['gemini-1.5-pro-latest', 'gemini-1.0-pro'],
  grok: ['grok-1'],
  'ollama/ouro': ['ouro-sigma0-fc-adapters', 'llama3', 'mistral'],
};

const DreamChat = () => {
  const [selectedProvider, setSelectedProvider] = useState('openai');
  const [selectedModel, setSelectedModel] = useState('');
  const [currentModels, setCurrentModels] = useState([]);
  const [input, setInput] = useState('');
  const [messages, setMessages] = useState([]);

  useEffect(() => {
    const modelsForProvider = providerModels[selectedProvider] || [];
    setCurrentModels(modelsForProvider);
    if (modelsForProvider.length > 0) {
      setSelectedModel(modelsForProvider[0]);
    } else {
      setSelectedModel('');
    }
  }, [selectedProvider]);

  const handleProviderChange = (e) => {
    setSelectedProvider(e.target.value);
  };

  const handleModelChange = (e) => {
    setSelectedModel(e.target.value);
  };

  const handleInputChange = (e) => {
    setInput(e.target.value);
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    if (input.trim()) {
      setMessages([...messages, { sender: 'user', text: input }]);
      // In a real application, you would send this to a backend API
      // and get a response. For this example, we'll just clear the input.
      setInput('');
      // Simulate a response
      setTimeout(() => {
        setMessages((prevMessages) => [
          ...prevMessages,
          {
            sender: 'ai',
            text: `AI response for "${input}" using ${selectedProvider}/${selectedModel}`,
          },
        ]);
      }, 500);
    }
  };

  return (
    <div style={{ fontFamily: 'Arial, sans-serif', maxWidth: '800px', margin: '20px auto', border: '1px solid #ccc', borderRadius: '8px', display: 'flex', flexDirection: 'column', height: 'calc(100vh - 40px)' }}>
      <h2 style={{ padding: '10px', borderBottom: '1px solid #eee', margin: 0, backgroundColor: '#f9f9f9' }}>DreamChat</h2>
      <div style={{ padding: '10px', borderBottom: '1px solid #eee', display: 'flex', gap: '10px', backgroundColor: '#f9f9f9' }}>
        <label htmlFor="provider-select">Provider:</label>
        <select id="provider-select" value={selectedProvider} onChange={handleProviderChange} style={{ padding: '5px', borderRadius: '4px', border: '1px solid #ddd' }}>
          {Object.keys(providerModels).map((provider) => (
            <option key={provider} value={provider}>
              {provider}
            </option>
          ))}
        </select>

        <label htmlFor="model-select">Model:</label>
        <select id="model-select" value={selectedModel} onChange={handleModelChange} disabled={currentModels.length === 0} style={{ padding: '5px', borderRadius: '4px', border: '1px solid #ddd' }}>
          {currentModels.length > 0 ? (
            currentModels.map((model) => (
              <option key={model} value={model}>
                {model}
              </option>
            ))
          ) : (
            <option value="">No models available</option>
          )}
        </select>
      </div>
      <div style={{ flexGrow: 1, overflowY: 'auto', padding: '10px', backgroundColor: '#fff' }}>
        {messages.map((msg, index) => (
          <div key={index} style={{ marginBottom: '10px', textAlign: msg.sender === 'user' ? 'right' : 'left' }}>
            <span style={{ display: 'inline-block', padding: '8px 12px', borderRadius: '15px', backgroundColor: msg.sender === 'user' ? '#e0f7fa' : '#f1f1f1', color: '#333' }}>
              {msg.text}
            </span>
          </div>
        ))}
      </div>
      <form onSubmit={handleSubmit} style={{ padding: '10px', borderTop: '1px solid #eee', display: 'flex', backgroundColor: '#f9f9f9' }}>
        <input
          type="text"
          value={input}
          onChange={handleInputChange}
          placeholder="Type your message..."
          style={{ flexGrow: 1, padding: '10px', borderRadius: '4px', border: '1px solid #ddd', marginRight: '10px' }}
        />
        <button type="submit" style={{ padding: '10px 15px', borderRadius: '4px', border: 'none', backgroundColor: '#007bff', color: 'white', cursor: 'pointer' }}>Send</button>
      </form>
    </div>
  );
};

export default DreamChat;
