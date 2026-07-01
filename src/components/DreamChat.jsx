import React, { useState, useEffect } from 'react';

// Mock backend API for demonstration
const mockApi = {
  getModelsByProvider: (provider) => {
    // Simulate API call delay
    return new Promise(resolve => {
      setTimeout(() => {
        const models = {
          'google': ['gemini-pro', 'gemini-1.5-pro-latest'],
          'openai': ['gpt-3.5-turbo', 'gpt-4', 'gpt-4o'],
          'anthropic': ['cla
