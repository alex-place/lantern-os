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

// ── Field-shape lenience (Postel's law for tool inputs) ───────────────────────
// The chat model passes fields in whatever shape is natural for the content it
// extracted — grouped skills objects, experience with description/years instead
// of bullets/dates, education with institution/years. Rendering must accept all
// of them: live finding on PR #1968, a generated resume printed a literal
// "[object Object]" skills section and dropped every experience bullet.
function _skillList(s) {
  if (!s) return [];
  if (Array.isArray(s)) return s.flat().map((x) => String(x).trim()).filter(Boolean);
  if (typeof s === "object") {
    return Object.values(s)
      .flatMap((v) => (Array.isArray(v) ? v : String(v).split(",")))
      .map((x) => String(x).trim()).filter(Boolean);
  }
  return String(s).split(",").map((x) => x.trim()).filter(Boolean);
}
function _expNorm(e) {
  const o = e || {};
  let bullets = o.bullets != null ? o.bullets : (o.description != null ? o.description : o.details);
  bullets = bullets == null ? [] : (Array.isArray(bullets) ? bullets : [bullets]);
  return {
    title: o.title || o.role || "",
    company: o.company || o.employer || "",
    dates: o.dates || o.years || o.period || "",
    bullets: bullets.map((b) => String(b).trim()).filter(Boolean),
  };
}
function _eduNorm(e) {
  const o = e || {};
  return {
    degree: o.degree || o.program || "",
    school: o.school || o.institution || "",
    year: o.year || o.years || o.dates || "",
    description: o.description || "",
  };
}
// "**Title** — Company (dates)" with every part optional — no literal
// "Title"/"Company"/"Year" placeholder defaults leaking into the document.
function _headline(title, company, dates, bold) {
  const main = [title, company].filter(Boolean).join(" — ") || "Experience";
  const b = bold ? `**${main}**` : main;
  return dates ? `${b} *(${dates})*` : b;
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
        for (const raw of f.experience) {
          const e = _expNorm(raw);
          md += `${_headline(e.title, e.company, e.dates, true)}\n`;
          for (const b of e.bullets) md += `- ${b}\n`;
          md += "\n";
        }
      }
      if (Array.isArray(f.education) && f.education.length) {
        md += `## Education\n`;
        for (const raw of f.education) {
          const e = _eduNorm(raw);
          md += `${_headline(e.degree, e.school, e.year, true)}\n`;
          if (e.description) md += `- ${e.description}\n`;
        }
        md += "\n";
      }
      const skills = _skillList(f.skills);
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
      for (const raw of f.experience) {
        const e = _expNorm(raw);
        body += `<p><strong>${esc([e.title, e.company].filter(Boolean).join(" — ") || "Experience")}</strong>${e.dates ? ` <em>(${esc(e.dates)})</em>` : ""}</p>\n`;
        if (e.bullets.length) {
          body += `<ul>${e.bullets.map(b => `<li>${esc(b)}</li>`).join("")}</ul>\n`;
        }
      }
    }
    if (Array.isArray(f.education) && f.education.length) {
      body += `<h2>Education</h2>\n`;
      for (const raw of f.education) {
        const e = _eduNorm(raw);
        body += `<p><strong>${esc([e.degree, e.school].filter(Boolean).join(" — ") || "Education")}</strong>${e.year ? ` <em>(${esc(e.year)})</em>` : ""}${e.description ? `<br>${esc(e.description)}` : ""}</p>\n`;
      }
    }
    const skills = _skillList(f.skills);
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
    // Models pass the addressee under several natural names — accept them all.
    const hiringManager = f.hiring_manager || f.recipient_name || f.recipient || "";
    const salutation = hiringManager && !/^hiring (manager|team)$/i.test(hiringManager)
      ? `Dear ${hiringManager},`
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
      if (hiringManager) md += `${hiringManager}\n${company}\n\n`;
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
    if (hiringManager) body += `<p>${esc(hiringManager)}<br>${esc(company)}</p>\n`;
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
