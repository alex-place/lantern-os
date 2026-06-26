import { execa } from 'execa';
import path from 'path';
import fs from 'fs/promises';
import { v4 as uuidv4 } from 'uuid';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

class OpenHandsBackend {
  constructor({ apiEndpoint, apiKey, worktreeBasePath }) {
    if (!
