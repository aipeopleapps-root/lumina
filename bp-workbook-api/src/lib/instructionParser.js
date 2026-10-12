'use strict';
// Parse free-form instruction lines and mutate visioData; returns overrides object + warnings array.

function parseInstructions(text, visioData) {
  const warnings = [];
  const ov = { sections: {}, stepOverrides: [], rowAdditions: {}, section10: {} };

  text.split('\n')
    .map(l => l.trim().replace(/^[•\-*]\s*/, ''))
    .filter(Boolean)
    .forEach(line => {
      let m;

      m = line.match(/^[Ss]ection\s+(\d+)\s+(.+?)\s+with:\s*(.+)$/);
      if (m) { (ov.sections[m[1]] ??= {})[m[2].trim()] = m[3].trim(); return; }

      m = line.match(/^[Mm]ark all\s+(.+?)\s+steps?\s+as\s+(.+?)\s*=\s*(.+)$/);
      if (m) { ov.stepOverrides.push({ typeFilter: m[1].trim(), column: m[2].trim(), value: m[3].trim() }); return; }

      m = line.match(/^[Aa]dd a row to [Ss]ection\s+(\d+)\s+[^:]+:\s*(.+)$/);
      if (m) { (ov.rowAdditions[m[1]] ??= []).push(m[2].trim()); return; }

      m = line.match(/^[Ss]ection\s+10:\s*set\s+(.+?)\s+to\s+(.+)$/);
      if (m) { ov.section10[m[1].trim()] = m[2].trim(); return; }

      warnings.push(`Could not parse instruction: "${line}"`);
    });

  const colIdx = {
    'description': 3, 'condition rules': 4, 'security group': 5,
    'routing restrictions': 6, 'optional': 7, 'optional?': 7,
    'due date': 8, 'step delay': 9, 'workday step': 10,
  };

  ov.stepOverrides.forEach(({ typeFilter, column, value }) => {
    const ci = colIdx[column.toLowerCase()];
    if (ci === undefined) { warnings.push(`Unknown column: "${column}"`); return; }
    visioData.steps.forEach(step => {
      if (typeFilter.toLowerCase() === 'all' || step[2].toLowerCase() === typeFilter.toLowerCase()) step[ci] = value;
    });
  });

  // Refresh filtered views
  visioData.bpSteps             = visioData.steps.filter(s => !['System Notification', 'Custom Notification', 'To Do'].includes(s[2]));
  visioData.systemNotifications = visioData.steps.filter(s => s[2] === 'System Notification');
  visioData.customNotifications = visioData.steps.filter(s => s[2] === 'Custom Notification');
  visioData.todos               = visioData.steps.filter(s => s[2] === 'To Do');

  return { ov, warnings };
}

module.exports = { parseInstructions };
