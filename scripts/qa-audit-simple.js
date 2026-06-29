#!/usr/bin/env node

/**
 * Lantern OS QA Audit - Simplified Version
 * Tests critical pages and buttons
 */

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const BASE_URL = 'http://127.0.0.1:4177';
const REPORT_DIR = './reports';

// Critical pages to test first
const CRITICAL_PAGES = [
  '/',
  '/create.html',
  '/dream-chat.html',
  '/entry.html',
  '/settings/providers.html',
];

const CLICKABLE_SELECTORS = [
  'button',
  'a',
  'input[type="button"]',
  'input[type="submit"]',
  '[role="button"]',
];

class SimpleQAAudit {
  constructor() {
    this.results = {
      pages: [],
      allButtons: [],
      errors: [],
      summary: {},
    };
    this.browser = null;
  }

  async init() {
    console.log('🎬 Starting Playwright browser...');
    this.browser = await chromium.launch({ headless: true });
  }

  async close() {
    if (this.browser) {
      try {
        await this.browser.close();
      } catch (e) {
        // ignore
      }
    }
  }

  async testPage(pageUrl) {
    const page = await this.browser.newPage().catch(async () => {
      // Browser crashed, restart
      await this.close();
      await this.init();
      return this.browser.newPage();
    });

    const buttons = [];

    try {
      const fullUrl = `${BASE_URL}${pageUrl}`;
      console.log(`\n📄 ${pageUrl}`);

      const response = await page.goto(fullUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 10000
      }).catch(() => null);

      const statusCode = response?.status() || 0;

      if (statusCode === 404 || statusCode === 500) {
        this.results.errors.push({
          page: pageUrl,
          statusCode,
        });
        return { url: pageUrl, statusCode, buttonCount: 0, buttons: [] };
      }

      // Discover buttons
      for (const selector of CLICKABLE_SELECTORS) {
        try {
          const elements = await page.$$(selector);

          for (const el of elements) {
            const text = await el.textContent().catch(() => '');
            const href = await el.getAttribute('href').catch(() => '');
            const onclick = await el.getAttribute('onclick').catch(() => '');

            const label = (text?.trim() || href || onclick || 'unlabeled').substring(0, 50);

            // Avoid duplicates
            if (!buttons.some(b => b.label === label)) {
              buttons.push({
                label,
                selector,
                href: href || null,
                hasAction: !!onclick || !!href,
              });
            }
          }
        } catch (e) {
          // selector not found
        }
      }

      console.log(`   ✅ Found ${buttons.length} buttons`);

      return {
        url: pageUrl,
        statusCode: 200,
        buttonCount: buttons.length,
        buttons,
      };

    } catch (error) {
      console.log(`   ❌ Error: ${error.message.substring(0, 50)}`);
      this.results.errors.push({
        page: pageUrl,
        error: error.message,
      });
      return {
        url: pageUrl,
        statusCode: 0,
        buttonCount: 0,
        buttons: [],
        error: error.message,
      };
    } finally {
      try {
        await page.close();
      } catch (e) {
        // ignore
      }
    }
  }

  async generateReports() {
    if (!fs.existsSync(REPORT_DIR)) {
      fs.mkdirSync(REPORT_DIR, { recursive: true });
    }

    // Summary
    const totalButtons = this.results.allButtons.length;
    const workingPages = this.results.pages.filter(p => p.statusCode === 200).length;
    const errorCount = this.results.errors.length;

    const summary = `# Lantern OS QA Audit Report

**Date:** ${new Date().toISOString()}

## Executive Summary

- **Pages Tested:** ${this.results.pages.length}
- **Pages Working:** ${workingPages}
- **Total Buttons Found:** ${totalButtons}
- **Errors:** ${errorCount}

## Pages Tested

${this.results.pages.map(p => `
### ${p.url}
- **Status:** ${p.statusCode === 200 ? '✅ Working' : `❌ ${p.statusCode}`}
- **Buttons:** ${p.buttonCount}
${p.buttons?.slice(0, 5).map(b => `  - \`${b.label}\` ${b.hasAction ? '(has action)' : '(no action)'}`).join('\n') || ''}
${p.buttons && p.buttons.length > 5 ? `  - ... and ${p.buttons.length - 5} more` : ''}
`).join('\n')}

## Issues Found

${errorCount > 0 ? this.results.errors.map(e => `
- **${e.page}**: ${e.statusCode ? `HTTP ${e.statusCode}` : e.error || 'Unknown error'}
`).join('\n') : 'None ✅'}

## Button Summary

${this.results.allButtons
  .filter(b => !b.hasAction)
  .slice(0, 10)
  .map(b => `- **${b.page}** — "${b.label}" — ⚠️  No action detected`)
  .join('\n') || 'All buttons have actions ✅'}

## Next Steps

1. Review pages with errors
2. Test interactive features in browser
3. Verify Creator Dashboard upload/analysis flows
`;

    fs.writeFileSync(
      path.join(REPORT_DIR, 'qa-summary.md'),
      summary
    );

    // Detailed JSON
    fs.writeFileSync(
      path.join(REPORT_DIR, 'qa-audit-results.json'),
      JSON.stringify(this.results, null, 2)
    );

    console.log(`\n✅ Reports saved to ${REPORT_DIR}/`);
  }

  async run() {
    try {
      await this.init();
      console.log(`\n🚀 Testing ${CRITICAL_PAGES.length} critical pages...\n`);

      for (const pageUrl of CRITICAL_PAGES) {
        const result = await this.testPage(pageUrl);
        this.results.pages.push(result);

        // Collect all buttons
        if (result.buttons) {
          result.buttons.forEach(b => {
            this.results.allButtons.push({
              page: pageUrl,
              ...b,
            });
          });
        }
      }

      console.log(`\n📊 Generating reports...`);
      await this.generateReports();

      // Print summary
      const working = this.results.pages.filter(p => p.statusCode === 200).length;
      console.log(`\n✅ Audit complete: ${working}/${this.results.pages.length} pages working`);

    } catch (error) {
      console.error('❌ Audit error:', error.message);
    } finally {
      await this.close();
    }
  }
}

const audit = new SimpleQAAudit();
audit.run();
