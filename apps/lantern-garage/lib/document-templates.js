"use strict";
/**
 * document-templates.js — Template library for document generation (#1097)
 *
 * Renders structured fields → HTML (printable as PDF from browser) and Markdown.
 * Pure Node, no external dependencies. Each template exposes:
 *   render(fields, format)  → string
 *   fields                  → [{name, label, required, description}] — input schema hint
 */

function esc(s) {
  return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ── Shared HTML shell ─────────────────────────────────────────────────────────
function htmlShell(title, body) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>
  body{font-family:Georgia,'Times New Roman',serif;font-size:12pt;line-height:1.5;
       max-width:720px;margin:40px auto;padding:0 24px;color:#111}
  h1{font-size:22pt;margin:0 0 4px}
  h2{font-size:13pt;text-transform:uppercase;letter-spacing:.08em;border-bottom:1px solid #555;
     margin:20px 0 6px;padding-bottom:2px}
  .contact{font-size:10pt;color:#333;margin-bottom:16px}
  .section-body{margin:0 0 8px}
  ul{margin:4px 0 8px 18px;padding:0}
  li{margin:2px 0}
  p{margin:4px 0 8px}
  @media print{body{margin:0;padding:0 16px}}
</style>
</head>
<body>
${body}
</body>
</html>`;
}

// ── Resume template ───────────────────────────────────────────────────────────
const resumeTemplate = {
  fields: [
    { name: "name",        label: "Full name",          required: true  },
    { name: "email",       label: "Email",               required: false },
    { name: "phone",       label: "Phone",               required: false },
    { name: "location",    label: "City, State",         required: false },
    { name: "linkedin",    label: "LinkedIn URL",        required: false },
    { name: "summary",     label: "Professional summary (1-3 sentences)", required: false },
    { name: "experience",  label: "Work experience (array of {title,company,dates,bullets[]})", required: false },
    { name: "education",   label: "Education (array of {degree,school,year})", required: false },
    { name: "skills",      label: "Skills (array of strings or comma-separated string)", required: false },
    { name: "projects",    label: "Projects (array of {name,description,url})", required: false },
  ],

  render(fields, format = "html") {
    const f = fields || {};
    const name = f.name || "Your Name";
    const contactParts = [f.email, f.phone, f.location, f.linkedin].filter(Boolean);

    if (format === "markdown") {
      let md = `# ${name}\n`;
      if (contactParts.length) md += `${contactParts.join(" · ")}\n`;
      md += "\n";

      if (f.summary) {
        md += `## Summary\n${f.summary}\n\n`;
      }
      if (Array.isArray(f.experience) && f.experience.length) {
        md += `## Experience\n`;
        for (const e of f.experience) {
          md += `**${e.title || "Title"}** — ${e.company || "Company"} *(${e.dates || "Dates"})*\n`;
          if (Array.isArray(e.bullets)) {
            for (const b of e.bullets) md += `- ${b}\n`;
          }
          md += "\n";
        }
      }
      if (Array.isArray(f.education) && f.education.length) {
        md += `## Education\n`;
        for (const e of f.education) {
          md += `**${e.degree || "Degree"}** — ${e.school || "School"} *(${e.year || "Year"})*\n`;
        }
        md += "\n";
      }
      const skills = Array.isArray(f.skills) ? f.skills : (f.skills ? String(f.skills).split(",").map(s => s.trim()) : []);
      if (skills.length) {
        md += `## Skills\n${skills.join(", ")}\n\n`;
      }
      if (Array.isArray(f.projects) && f.projects.length) {
        md += `## Projects\n`;
        for (const p of f.projects) {
          md += `**${p.name || "Project"}**: ${p.description || ""}${p.url ? ` ([link](${p.url}))` : ""}\n`;
        }
      }
      return md.trim();
    }

    // HTML render
    let body = `<h1>${esc(name)}</h1>\n`;
    if (contactParts.length) {
      body += `<div class="contact">${contactParts.map(esc).join(" · ")}</div>\n`;
    }
    if (f.summary) {
      body += `<h2>Summary</h2><p class="section-body">${esc(f.summary)}</p>\n`;
    }
    if (Array.isArray(f.experience) && f.experience.length) {
      body += `<h2>Experience</h2>\n`;
      for (const e of f.experience) {
        body += `<p><strong>${esc(e.title || "Title")}</strong> — ${esc(e.company || "Company")} <em>(${esc(e.dates || "")})</em></p>\n`;
        if (Array.isArray(e.bullets) && e.bullets.length) {
          body += `<ul>${e.bullets.map(b => `<li>${esc(b)}</li>`).join("")}</ul>\n`;
        }
      }
    }
    if (Array.isArray(f.education) && f.education.length) {
      body += `<h2>Education</h2>\n`;
      for (const e of f.education) {
        body += `<p><strong>${esc(e.degree || "Degree")}</strong> — ${esc(e.school || "School")} <em>(${esc(e.year || "")})</em></p>\n`;
      }
    }
    const skills = Array.isArray(f.skills) ? f.skills : (f.skills ? String(f.skills).split(",").map(s => s.trim()) : []);
    if (skills.length) {
      body += `<h2>Skills</h2><p>${skills.map(esc).join(", ")}</p>\n`;
    }
    if (Array.isArray(f.projects) && f.projects.length) {
      body += `<h2>Projects</h2><ul>\n`;
      for (const p of f.projects) {
        const link = p.url ? ` <a href="${esc(p.url)}">[link]</a>` : "";
        body += `<li><strong>${esc(p.name || "Project")}</strong>: ${esc(p.description || "")}${link}</li>\n`;
      }
      body += `</ul>\n`;
    }
    return htmlShell(name + " — Resume", body);
  },
};

// ── Cover letter template ─────────────────────────────────────────────────────
const coverLetterTemplate = {
  fields: [
    { name: "name",          label: "Applicant full name",     required: true  },
    { name: "email",         label: "Applicant email",         required: false },
    { name: "phone",         label: "Applicant phone",         required: false },
    { name: "date",          label: "Date (e.g. June 24, 2026)", required: false },
    { name: "hiring_manager",label: "Hiring manager name",     required: false },
    { name: "company",       label: "Company name",            required: true  },
    { name: "role",          label: "Job title / role",        required: true  },
    { name: "opening",       label: "Opening paragraph",       required: false },
    { name: "body",          label: "Body paragraphs (array or string)", required: false },
    { name: "closing",       label: "Closing paragraph",       required: false },
  ],

  render(fields, format = "html") {
    const f = fields || {};
    const name = f.name || "Your Name";
    const company = f.company || "Company";
    const role = f.role || "the role";
    const date = f.date || new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
    const salutation = f.hiring_manager
      ? `Dear ${f.hiring_manager},`
      : "Dear Hiring Team,";
    const opening = f.opening
      || `I am writing to express my strong interest in the ${role} position at ${company}.`;
    const bodyParas = Array.isArray(f.body) ? f.body : (f.body ? [f.body] : [
      `My background aligns well with the requirements for this role.`,
      `I am excited about the opportunity to contribute to ${company}'s mission.`,
    ]);
    const closing = f.closing
      || `Thank you for your time and consideration. I look forward to the opportunity to discuss how I can contribute to ${company}.`;

    if (format === "markdown") {
      let md = `${name}\n`;
      if (f.email) md += `${f.email}\n`;
      if (f.phone) md += `${f.phone}\n`;
      md += `${date}\n\n`;
      if (f.hiring_manager) md += `${f.hiring_manager}\n${company}\n\n`;
      md += `${salutation}\n\n`;
      md += `${opening}\n\n`;
      for (const p of bodyParas) md += `${p}\n\n`;
      md += `${closing}\n\n`;
      md += `Sincerely,\n${name}\n`;
      return md.trim();
    }

    let body = `<p>${esc(name)}`;
    if (f.email) body += `<br>${esc(f.email)}`;
    if (f.phone) body += `<br>${esc(f.phone)}`;
    body += `<br>${esc(date)}</p>\n`;
    if (f.hiring_manager) body += `<p>${esc(f.hiring_manager)}<br>${esc(company)}</p>\n`;
    body += `<p>${esc(salutation)}</p>\n`;
    body += `<p>${esc(opening)}</p>\n`;
    for (const p of bodyParas) body += `<p>${esc(p)}</p>\n`;
    body += `<p>${esc(closing)}</p>\n`;
    body += `<p>Sincerely,<br><strong>${esc(name)}</strong></p>\n`;

    return htmlShell(`${name} — Cover Letter for ${role} at ${company}`, body);
  },
};

// ── Registry ──────────────────────────────────────────────────────────────────
const TEMPLATES = {
  resume:       resumeTemplate,
  "cover-letter": coverLetterTemplate,
};

/**
 * render(templateName, fields, format)
 *   format: 'html' (default) | 'markdown'
 *   returns { content: string, extension: string } or throws
 */
function render(templateName, fields, format = "html") {
  const tpl = TEMPLATES[String(templateName || "").toLowerCase()];
  if (!tpl) {
    const names = Object.keys(TEMPLATES).join(", ");
    throw new Error(`Unknown template "${templateName}". Available: ${names}`);
  }
  const fmt = (format === "markdown") ? "markdown" : "html";
  const content = tpl.render(fields, fmt);
  const extension = fmt === "markdown" ? ".md" : ".html";
  return { content, extension };
}

function listTemplates() {
  return Object.entries(TEMPLATES).map(([name, tpl]) => ({
    name,
    fields: tpl.fields,
  }));
}

module.exports = { render, listTemplates, TEMPLATES };
