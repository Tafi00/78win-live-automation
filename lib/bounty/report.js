// Findings store — mỗi finding 1 record JSONL + file markdown theo format doc §6.
// Một lỗ hổng = một finding = một ticket (§6).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { REPORTS_DIR } = require('./http');

const FINDINGS_FILE = path.join(REPORTS_DIR, 'findings.jsonl');
const FINDINGS_DIR = path.join(REPORTS_DIR, 'findings');
const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'];

function ensureDirs() {
  fs.mkdirSync(FINDINGS_DIR, { recursive: true });
}

function listFindings() {
  try {
    return fs.readFileSync(FINDINGS_FILE, 'utf8')
      .split('\n').filter(Boolean)
      .map(l => JSON.parse(l));
  } catch (e) {
    return [];
  }
}

// finding: { title, severity, siteId, asset, description, steps[], evidence, impact, remediation?, probe? }
function createFinding(f) {
  if (!f.title || !f.asset) throw new Error('finding cần title + asset');
  const severity = SEVERITIES.includes(String(f.severity).toLowerCase()) ? String(f.severity).toLowerCase() : 'info';
  const finding = {
    id: `BBP-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`,
    createdAt: new Date().toISOString(),
    status: 'open',
    severity,
    title: f.title,
    siteId: f.siteId || null,
    asset: f.asset,
    description: f.description || '',
    steps: f.steps || [],
    evidence: f.evidence || '',
    impact: f.impact || '',
    remediation: f.remediation || '',
    probe: f.probe || null
  };
  ensureDirs();
  fs.appendFileSync(FINDINGS_FILE, JSON.stringify(finding) + '\n');
  return finding;
}

// Render finding ra markdown theo mục bắt buộc §6: mô tả, bước tái hiện, request/response, ảnh hưởng, PoC.
function renderFindingMarkdown(f) {
  const steps = (f.steps.length ? f.steps : ['(chưa mô tả)']).map((s, i) => `${i + 1}. ${s}`).join('\n');
  return `# ${f.id} — ${f.title}

| Trường | Giá trị |
|---|---|
| Severity | ${f.severity} |
| Status | ${f.status} |
| Site | ${f.siteId || 'n/a'} |
| Asset | ${f.asset} |
| Ngày tạo | ${f.createdAt} |
| Probe | ${f.probe || 'manual'} |

## Mô tả
${f.description || '(chưa mô tả)'}

## Bước tái hiện
${steps}

## Request/Response (PoC)
\`\`\`
${f.evidence || '(đính kèm audit log)'}
\`\`\`

## Mức độ ảnh hưởng
${f.impact || '(chưa đánh giá)'}

## Khuyến nghị khắc phục
${f.remediation || '(chưa có)'}
`;
}

function writeFindingMarkdown(f) {
  ensureDirs();
  const file = path.join(FINDINGS_DIR, `${f.id}.md`);
  fs.writeFileSync(file, renderFindingMarkdown(f));
  return file;
}

function updateFinding(id, patch) {
  const findings = listFindings();
  const idx = findings.findIndex(f => f.id === id);
  if (idx === -1) return null;
  const allowed = ['status', 'severity', 'title', 'description', 'impact', 'remediation', 'steps', 'evidence'];
  for (const k of allowed) if (k in patch) findings[idx][k] = patch[k];
  fs.writeFileSync(FINDINGS_FILE, findings.map(f => JSON.stringify(f)).join('\n') + '\n');
  return findings[idx];
}

module.exports = { listFindings, createFinding, updateFinding, renderFindingMarkdown, writeFindingMarkdown, SEVERITIES, FINDINGS_DIR, FINDINGS_FILE };
