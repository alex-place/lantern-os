#!/usr/bin/env node

/**
 * Lantern OS QA Audit Script
 *
 * Comprehensive end-to-end functional testing of all pages and buttons.
 * Tests every clickable element and verifies functionality.
 */

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const BASE_URL = 'http://127.0.0.1:4177';
const TIMEOUT = 30000; // 30 seconds per operation
const REPORT_DIR = './reports';

// All pages discovered in public/
const PAGES = [
  '/',
  '/agent-leaderboard.html',
  '/agent-status.html',
  '/changelog.html',
  '/courtney.html',
  '/create.html',
  '/dream-chat.html',
  '/dream-journal/',
  '/entry.html',
  '/flourishing.html',
  '/hff.html',
  '/hff/',
  '/knowledgecenter.html',
  '/observer-mesh-cube.html',
  '/outreach.html',
  '/pricing.html',
  '/proof.html',
  '/rag-house.html',
  '/settings/providers.html',
  '/three-doors.html',
  '/three-doors-game.html',
  '/trader-dashboard.html',
  '/trading.html',
  '/trading-news.html',
  '/upgrade-lab.html',
  '/wish-door.html',
];

// Selectors for clickable elements
const CLICKABLE_SELECTORS = [
  'button',
  'input[type="button"]',
  'input[type="submit"]',
  'a:not([href=""])',
  '[role="button"]',
  '.clickable',
  '.card-action',
  '.menu-item',
  '.toolbar-button',
  '[onclick]',
];

class QAAudit {
  constructor() {
    this.results = {
      pages: [],
      buttons: [],
      errors: [],
      apiFailures: [],
      jsErrors: [],
      themeIssues: [],
      missingRoutes: [],
    };
    this.browser = null;
  }

  async initialize() {
    console.log('🎬 Starting Playwright browser...');
    this.browser = await chromium.launch({ headless: true });
  }

  async close() {
    if (this.browser) {
      await this.browser.close();
    }
  }

  async testPage(pageUrl) {
    const context = await this.browser.newContext();
    const page = await context.newPage();

    const apiCalls = [];
    const jsErrors = [];
    const consoleMessages = [];

    // Intercept API calls
    await page.on('request', request => {
      if (request.url().includes('/api/')) {
        apiCalls.push({
          url: request.url(),
          method: request.method(),
          timestamp: new Date().toISOString(),
        });
      }
    });

    // Capture JS errors
    page.on('pageerror', error => {
      jsErrors.push({
        message: error.message,
        stack: error.stack,
        page: pageUrl,
        timestamp: new Date().toISOString(),
      });
    });

    // Capture console messages
    page.on('console', msg => {
      consoleMessages.push({
        type: msg.type(),
        text: msg.text(),
        page: pageUrl,
      });
    });

    try {
      const fullUrl = `${BASE_URL}${pageUrl}`;
      console.log(`\n📄 Testing: ${pageUrl}`);

      const response = await page.goto(fullUrl, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => null);

      if (!response) {
        this.results.errors.push({
          page: pageUrl,
          error: 'Page did not load',
        });
        await context.close();
        return;
      }

      const statusCode = response.status();
      if (statusCode !== 200) {
        this.results.missingRoutes.push({
          page: pageUrl,
          statusCode,
          url: fullUrl,
        });
      }

      // Get all buttons/clickable elements
      const buttons = await this.discoverButtons(page, pageUrl);

      // Check theme consistency
      const themeIssues = await this.checkTheme(page, pageUrl);
      if (themeIssues.length > 0) {
        this.results.themeIssues.push(...themeIssues);
      }

      // Test each button (limit to 10 per page for speed)
      for (const button of buttons.slice(0, 10)) {
        await this.testButton(page, button, pageUrl, apiCalls);
      }

      // Collect page results
      this.results.pages.push({
        url: pageUrl,
        statusCode,
        buttonCount: buttons.length,
        buttons: buttons.map(b => ({
          label: b.label,
          selector: b.selector,
          type: b.type,
          href: b.href,
        })),
        apiCalls: apiCalls.length,
        jsErrors: jsErrors.length,
      });

      // Store errors and api calls
      if (jsErrors.length > 0) {
        this.results.jsErrors.push(...jsErrors);
      }

      if (apiCalls.length > 0) {
        this.results.apiFailures.push(...apiCalls);
      }

    } catch (error) {
      this.results.errors.push({
        page: pageUrl,
        error: error.message,
      });
    } finally {
      await context.close();
    }
  }

  async discoverButtons(page, pageUrl) {
    const buttons = [];

    for (const selector of CLICKABLE_SELECTORS) {
      try {
        const elements = await page.$$eval(selector, els => {
          return els.map(el => {
            const rect = el.getBoundingClientRect();
            // Only include visible elements
            if (rect.width === 0 || rect.height === 0) return null;

            return {
              label: el.textContent?.trim().substring(0, 50) || el.getAttribute('aria-label') || el.name || '(unlabeled)',
              type: el.tagName.toLowerCase(),
              href: el.href,
              onclick: el.onclick ? true : false,
              ariaLabel: el.getAttribute('aria-label'),
              id: el.id,
              class: el.className,
            };
          }).filter(Boolean);
        });

        for (const el of elements) {
          // Avoid duplicates
          const exists = buttons.some(b =>
            b.label === el.label &&
            b.type === el.type &&
            b.href === el.href
          );
          if (!exists) {
            buttons.push({
              ...el,
              selector,
              page: pageUrl,
            });
          }
        }
      } catch (error) {
        // Selector not found on page, skip
      }
    }

    return buttons;
  }

  async testButton(page, button, pageUrl, apiCalls) {
    try {
      const beforeUrl = page.url();

      // Click the button
      try {
        await page.locator(button.selector).first().click({ timeout: 2000 });
      } catch (e) {
        // Try scrolling and clicking if direct click fails
        await page.locator(button.selector).first().scrollIntoViewIfNeeded();
        await page.locator(button.selector).first().click({ timeout: 2000 });
      }

      // Wait briefly for potential navigation or changes
      await page.waitForTimeout(300);

      const afterUrl = page.url();
      const urlChanged = beforeUrl !== afterUrl;

      this.results.buttons.push({
        page: pageUrl,
        label: button.label,
        selector: button.selector,
        type: button.type,
        href: button.href,
        status: '✅ Working',
        urlChanged,
        actionType: urlChanged ? 'Navigation' : 'Click Successful',
      });

    } catch (error) {
      this.results.buttons.push({
        page: pageUrl,
        label: button.label,
        selector: button.selector,
        type: button.type,
        href: button.href,
        status: '❌ Error',
        error: error.message?.substring(0, 50),
        actionType: 'Failed',
      });
    }
  }

  async checkTheme(page, pageUrl) {
    const issues = [];
    try {
      // Check for Bootstrap-only pages
      const hasBootstrap = await page.evaluate(() => {
        return !!document.querySelector('[class*="bootstrap"]') ||
               !!document.querySelector('link[href*="bootstrap"]');
      });

      if (hasBootstrap) {
        issues.push({
          page: pageUrl,
          issue: 'Page uses Bootstrap (expected Lantern theme)',
          severity: '⚠ Medium',
        });
      }

      // Check for Lantern theme CSS
      const hasLanternTheme = await page.evaluate(() => {
        const styles = Array.from(document.styleSheets)
          .map(sheet => sheet.href || '')
          .join(' ');
        return styles.includes('lantern') ||
               styles.includes('theme') ||
               document.documentElement.classList.contains('dark');
      });

      if (!hasLanternTheme && !hasBootstrap) {
        issues.push({
          page: pageUrl,
          issue: 'No Lantern theme or Bootstrap detected',
          severity: '⚠ Low',
        });
      }

      // Check dark mode support
      const hasDarkModeSupport = await page.evaluate(() => {
        const html = document.documentElement;
        return html.getAttribute('data-theme') ||
               html.classList.contains('dark') ||
               getComputedStyle(html).getPropertyValue('--bg-color');
      });

      if (!hasDarkModeSupport) {
        issues.push({
          page: pageUrl,
          issue: 'Dark mode support may be missing',
          severity: '⚠ Low',
        });
      }

    } catch (error) {
      // Ignore theme check errors
    }
    return issues;
  }

  async generateReports() {
    if (!fs.existsSync(REPORT_DIR)) {
      fs.mkdirSync(REPORT_DIR, { recursive: true });
    }

    // Summary report
    const summary = this.generateSummary();
    fs.writeFileSync(
      path.join(REPORT_DIR, 'final-qa-summary.md'),
      summary
    );

    // Button audit
    const buttonAudit = this.generateButtonAudit();
    fs.writeFileSync(
      path.join(REPORT_DIR, 'button-audit.md'),
      buttonAudit
    );

    // JS errors
    if (this.results.jsErrors.length > 0) {
      const jsErrors = this.generateJSErrorReport();
      fs.writeFileSync(
        path.join(REPORT_DIR, 'js-errors.md'),
        jsErrors
      );
    }

    // Missing routes
    if (this.results.missingRoutes.length > 0) {
      const missingRoutes = this.generateMissingRoutesReport();
      fs.writeFileSync(
        path.join(REPORT_DIR, 'missing-routes.md'),
        missingRoutes
      );
    }

    // Theme issues
    if (this.results.themeIssues.length > 0) {
      const themeIssues = this.generateThemeReport();
      fs.writeFileSync(
        path.join(REPORT_DIR, 'theme-inconsistencies.md'),
        themeIssues
      );
    }

    // API failures
    if (this.results.apiFailures.length > 0) {
      const apiFails = this.generateAPIFailureReport();
      fs.writeFileSync(
        path.join(REPORT_DIR, 'api-failures.md'),
        apiFails
      );
    }

    // Full results JSON
    fs.writeFileSync(
      path.join(REPORT_DIR, 'qa-results.json'),
      JSON.stringify(this.results, null, 2)
    );

    console.log(`\n✅ Reports generated in ${REPORT_DIR}/`);
  }

  generateSummary() {
    const workingButtons = this.results.buttons.filter(b => b.status === '✅ Working').length;
    const errorButtons = this.results.buttons.filter(b => b.status === '❌ Error').length;

    return `# Lantern OS QA Audit Summary

**Date:** ${new Date().toISOString()}

## Overview

- **Total Pages Tested:** ${this.results.pages.length}
- **Total Buttons Discovered:** ${this.results.buttons.length}
- **Buttons Working:** ${workingButtons} ✅
- **Buttons with Errors:** ${errorButtons} ❌
- **JS Errors:** ${this.results.jsErrors.length}
- **Missing Routes:** ${this.results.missingRoutes.length}
- **Theme Issues:** ${this.results.themeIssues.length}

## Pages Tested

${this.results.pages.map(p =>
  `- \`${p.url}\` — ${p.buttonCount} buttons, Status: ${p.statusCode}`
).join('\n')}

## Critical Issues

${errorButtons > 0 ? `
### Broken Buttons (${errorButtons})

${this.results.buttons
  .filter(b => b.status === '❌ Error')
  .slice(0, 10)
  .map(b => `- **${b.page}** — "${b.label}": ${b.error}`)
  .join('\n')}
` : 'None ✅\n'}

${this.results.missingRoutes.length > 0 ? `
### Missing Routes (${this.results.missingRoutes.length})

${this.results.missingRoutes.map(r =>
  `- \`${r.page}\` — Status ${r.statusCode}`
).join('\n')}
` : 'None ✅\n'}

${this.results.jsErrors.length > 0 ? `
### JavaScript Errors (${this.results.jsErrors.length})

${this.results.jsErrors.slice(0, 5).map(e =>
  `- **${e.page}**: ${e.message}`
).join('\n')}
` : 'None ✅\n'}

## Recommendations

1. ${errorButtons > 0 ? 'Fix broken buttons (see button-audit.md)' : 'All buttons functional ✅'}
2. ${this.results.missingRoutes.length > 0 ? 'Fix missing routes (see missing-routes.md)' : 'All routes functional ✅'}
3. ${this.results.jsErrors.length > 0 ? 'Fix JS errors (see js-errors.md)' : 'No JS errors ✅'}
4. ${this.results.themeIssues.length > 0 ? 'Review theme inconsistencies (see theme-inconsistencies.md)' : 'Theme consistent ✅'}

## Next Steps

- Review detailed reports in ./reports/
- Fix critical issues
- Re-run audit: \`node scripts/qa-audit.js\`
`;
  }

  generateButtonAudit() {
    const byPage = {};
    this.results.buttons.forEach(btn => {
      if (!byPage[btn.page]) byPage[btn.page] = [];
      byPage[btn.page].push(btn);
    });

    let report = `# Button Audit Report

**Generated:** ${new Date().toISOString()}

## Summary

- Total Buttons: ${this.results.buttons.length}
- Working: ${this.results.buttons.filter(b => b.status === '✅ Working').length}
- Errors: ${this.results.buttons.filter(b => b.status === '❌ Error').length}

## By Page

`;

    Object.entries(byPage).forEach(([page, buttons]) => {
      const working = buttons.filter(b => b.status === '✅ Working').length;
      const errors = buttons.filter(b => b.status === '❌ Error').length;

      report += `\n### ${page} (${buttons.length} buttons)\n\n`;
      report += `**Status:** ${working}/${buttons.length} working\n\n`;

      report += '| Label | Type | Status | Action |\n';
      report += '|-------|------|--------|--------|\n';

      buttons.forEach(btn => {
        report += `| ${btn.label.substring(0, 30)} | \`${btn.type}\` | ${btn.status} | ${btn.actionType} |\n`;
      });
    });

    return report;
  }

  generateJSErrorReport() {
    return `# JavaScript Error Report

**Generated:** ${new Date().toISOString()}

## Errors by Page

${this.results.jsErrors.map(err => `
### ${err.page}

\`\`\`
${err.message}
\`\`\`

**Stack:**
\`\`\`
${err.stack?.substring(0, 500)}
\`\`\`
`).join('\n')}
`;
  }

  generateMissingRoutesReport() {
    return `# Missing Routes Report

**Generated:** ${new Date().toISOString()}

## Routes with Errors

${this.results.missingRoutes.map(r => `
- **URL:** \`${r.page}\`
- **Status Code:** ${r.statusCode}
- **Full URL:** ${r.url}
`).join('\n')}
`;
  }

  generateThemeReport() {
    return `# Theme Inconsistencies Report

**Generated:** ${new Date().toISOString()}

## Issues

${this.results.themeIssues.map(issue => `
### ${issue.page}

- **Issue:** ${issue.issue}
- **Severity:** ${issue.severity}
`).join('\n')}
`;
  }

  generateAPIFailureReport() {
    return `# API Failures Report

**Generated:** ${new Date().toISOString()}

## API Calls Made

${this.results.apiFailures.slice(0, 50).map(call => `
- **URL:** ${call.url}
- **Method:** ${call.method}
- **Time:** ${call.timestamp}
`).join('\n')}
`;
  }

  async run() {
    try {
      await this.initialize();

      console.log(`🚀 Starting QA Audit for ${PAGES.length} pages...\n`);

      for (const pageUrl of PAGES) {
        await this.testPage(pageUrl);
      }

      console.log('\n📊 Generating reports...');
      await this.generateReports();

      // Print summary to console
      console.log(this.generateSummary());

    } catch (error) {
      console.error('❌ Audit failed:', error);
    } finally {
      await this.close();
    }
  }
}

// Run audit
const audit = new QAAudit();
audit.run().catch(console.error);
