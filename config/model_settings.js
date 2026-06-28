// config/model_settings.js

const modelSettings = {
    antiCollapse: {
        DecodeCanary: {
            enabled: true,
            observeOnly: false, // Changed from true to false
            threshold: 0.8,
            // ... other settings
        },
        sigma0_proximity: {
            enabled: true,
            observeOnly: false, // Changed from true to false
            proximityThreshold: 0.05,
            // ... other settings
        },
    },
    // ... other model configurations
};

module.exports = modelSettings;
