import { useEffect, useRef, useState } from 'react';
import {
  rfpAutopopulate,
  rfpGenerate,
  getRfpJob,
  WORKDAY_TIERS,
  SCOPE_MODULES,
  DELIVERY_APPROACHES,
  BUDGET_RANGES,
  type WorkdayTier,
  type ScopeModule,
  type DeliveryApproach,
  type BudgetRange,
  type RfpAutopopulateResponse,
  type RfpDocuments,
} from '../lib/api';

const FONT = '-apple-system, BlinkMacSystemFont, "SF Pro Display", system-ui, sans-serif';

type Props = { clientName?: string; onBack: () => void };

const DOC_TABS: { key: keyof RfpDocuments; label: string }[] = [
  { key: 'rfp_response', label: 'RFP Response' },
  { key: 'cover_letter', label: 'Cover Letter' },
  { key: 'project_plan', label: 'Project Plan' },
  { key: 'resource_plan', label: 'Resource Plan' },
];

const CONFIDENCE_COLOR: Record<string, string> = {
  high: '#16a34a', medium: '#d97706', low: '#dc2626',
};

function SectionLabel({ children, first }: { children: string; first?: boolean }) {
  return (
    <p style={{ fontSize: 11, fontWeight: 700, color: '#8E8E93', textTransform: 'uppercase', letterSpacing: '0.06em', margin: first ? '0 0 12px' : '28px 0 12px' }}>
      {children}
    </p>
  );
}

function TagInput({ values, onChange, placeholder }: { values: string[]; onChange: (v: string[]) => void; placeholder: string }) {
  const [input, setInput] = useState('');
  function add() {
    const v = input.trim();
    if (v && !values.includes(v)) onChange([...values, v]);
    setInput('');
  }
  return (
    <div>
      {values.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 6 }}>
          {values.map(v => (
            <span key={v} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, background: '#F5F5F7', borderRadius: 999, padding: '4px 10px', fontSize: 12, color: '#3A3A3C' }}>
              {v}
              <button onClick={() => onChange(values.filter(x => x !== v))} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#8E8E93', fontSize: 13, padding: 0, lineHeight: 1 }}>×</button>
            </span>
          ))}
        </div>
      )}
      <input value={input} onChange={e => setInput(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); add(); } }}
        placeholder={placeholder}
        style={{ width: '100%', border: '1px solid #D2D2D7', borderRadius: 8, padding: '8px 12px', fontSize: 14, fontFamily: FONT, boxSizing: 'border-box' }} />
    </div>
  );
}

export default function RfpReimagine({ clientName, onBack }: Props) {
  const [companyName, setCompanyName] = useState(clientName ?? '');
  const [industry, setIndustry] = useState('');
  const [employeeCount, setEmployeeCount] = useState('');
  const [locations, setLocations] = useState<string[]>([]);
  const [autopopulateResult, setAutopopulateResult] = useState<RfpAutopopulateResponse | null>(null);
  const [autopopulating, setAutopopulating] = useState(false);
  const [autopopulateError, setAutopopulateError] = useState<string | null>(null);

  const [tier, setTier] = useState<WorkdayTier>('Full-scale');
  const [modules, setModules] = useState<ScopeModule[]>([]);
  const [delivery, setDelivery] = useState<DeliveryApproach>('Phased');

  // Additional context — all optional, sharpen the draft when given
  const [executiveSponsorName, setExecutiveSponsorName] = useState('');
  const [executiveSponsorTitle, setExecutiveSponsorTitle] = useState('');
  const [currentSystems, setCurrentSystems] = useState('');
  const [businessDrivers, setBusinessDrivers] = useState('');
  const [targetGoLive, setTargetGoLive] = useState('');
  const [keyIntegrations, setKeyIntegrations] = useState<string[]>([]);
  const [budgetRange, setBudgetRange] = useState<BudgetRange | ''>('');
  const [unionEnvironment, setUnionEnvironment] = useState(false);

  const [jobId, setJobId] = useState<string | null>(null);
  const [status, setStatus] = useState<'idle' | 'generating' | 'done' | 'error'>('idle');
  const [documents, setDocuments] = useState<RfpDocuments | null>(null);
  const [genError, setGenError] = useState<string | null>(null);
  const [activeDocTab, setActiveDocTab] = useState<keyof RfpDocuments>('rfp_response');

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current); }, []);

  async function handleAutopopulate() {
    if (!companyName.trim()) return;
    setAutopopulating(true);
    setAutopopulateError(null);
    try {
      const result = await rfpAutopopulate(companyName.trim());
      setAutopopulateResult(result);
      setIndustry(result.industry);
      setEmployeeCount(result.estimated_employee_count);
      setLocations(result.headquarters_location && result.headquarters_location !== 'Unknown'
        ? [result.headquarters_location, ...result.other_locations]
        : result.other_locations);
    } catch (err: any) {
      setAutopopulateError(err.message || 'Lookup failed — fill in the fields manually below.');
    } finally {
      setAutopopulating(false);
    }
  }

  function toggleModule(m: ScopeModule) {
    setModules(prev => prev.includes(m) ? prev.filter(x => x !== m) : [...prev, m]);
  }

  const canGenerate = companyName.trim() && industry.trim() && modules.length > 0 && !!tier && !!delivery;

  async function handleGenerate() {
    if (!canGenerate) return;
    setStatus('generating');
    setGenError(null);
    setDocuments(null);
    try {
      const resp = await rfpGenerate({
        client_name: companyName.trim(),
        industry: industry.trim(),
        estimated_employee_count: employeeCount.trim(),
        locations,
        workday_tier: tier,
        scope_modules: modules,
        delivery_approach: delivery,
        executive_sponsor_name: executiveSponsorName.trim(),
        executive_sponsor_title: executiveSponsorTitle.trim(),
        current_systems: currentSystems.trim(),
        business_drivers: businessDrivers.trim(),
        target_go_live: targetGoLive.trim(),
        key_integrations: keyIntegrations,
        budget_range: budgetRange,
        union_environment: unionEnvironment,
      });
      setJobId(resp.job_id);
      pollRef.current = setInterval(() => pollJob(resp.job_id), 3000);
    } catch (err: any) {
      setStatus('error');
      setGenError(err.message || 'Failed to start generation');
    }
  }

  async function pollJob(id: string) {
    try {
      const resp = await getRfpJob(id);
      if (resp.status === 'done' && resp.documents) {
        setStatus('done');
        setDocuments(resp.documents);
        if (pollRef.current) clearInterval(pollRef.current);
      } else if (resp.status === 'error') {
        setStatus('error');
        setGenError(resp.error || 'Generation failed');
        if (pollRef.current) clearInterval(pollRef.current);
      }
    } catch {
      // transient poll failure — keep trying, next interval tick will retry
    }
  }

  function startOver() {
    if (pollRef.current) clearInterval(pollRef.current);
    setJobId(null);
    setStatus('idle');
    setDocuments(null);
    setGenError(null);
  }

  return (
    <div style={{ height: '100%', overflow: 'auto', fontFamily: FONT, background: '#F5F5F7' }}>
      <div style={{ maxWidth: 860, margin: '0 auto', padding: '28px 24px 60px' }}>
        <button onClick={onBack} style={{ background: 'none', border: 'none', color: '#6E6E73', fontSize: 13, cursor: 'pointer', padding: 0, marginBottom: 16 }}>
          ← Back
        </button>
        <h1 style={{ fontSize: 22, fontWeight: 700, color: '#1D1D1F', margin: '0 0 4px' }}>RFP Reimagine</h1>
        <p style={{ fontSize: 13, color: '#6E6E73', margin: '0 0 24px' }}>
          Generate a first-draft RFP response package — grounded in Deloitte's own per-industry knowledge base.
        </p>

        {status === 'idle' && (
          <div style={{ background: '#FFFFFF', borderRadius: 14, border: '1px solid #E5E5EA', padding: 24 }}>
            <SectionLabel first>Client Profile</SectionLabel>
            <label style={{ fontSize: 12, fontWeight: 600, color: '#1D1D1F', display: 'block', marginBottom: 6 }}>Client name</label>
            <div style={{ display: 'flex', gap: 8, marginBottom: 4 }}>
              <input value={companyName} onChange={e => setCompanyName(e.target.value)} placeholder="e.g. Cleveland Clinic"
                style={{ flex: 1, border: '1px solid #D2D2D7', borderRadius: 8, padding: '8px 12px', fontSize: 14, fontFamily: FONT }} />
              <button onClick={handleAutopopulate} disabled={!companyName.trim() || autopopulating}
                style={{ padding: '8px 16px', borderRadius: 999, border: 'none', background: '#1D1D1F', color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer', opacity: (!companyName.trim() || autopopulating) ? 0.5 : 1, fontFamily: FONT }}>
                {autopopulating ? 'Looking up…' : 'Look up'}
              </button>
            </div>
            {autopopulateError && <p style={{ fontSize: 12, color: '#dc2626', margin: '4px 0 0' }}>{autopopulateError}</p>}
            {autopopulateResult && (
              <div style={{ marginTop: 8, padding: '8px 12px', borderRadius: 8, background: '#F5F5F7', fontSize: 12, color: '#3A3A3C' }}>
                <span style={{ fontWeight: 600, color: CONFIDENCE_COLOR[autopopulateResult.confidence] }}>
                  {autopopulateResult.confidence} confidence
                </span>
                {' — '}{autopopulateResult.notes}
                <div style={{ marginTop: 2, color: '#8E8E93' }}>Review the fields below and correct anything the lookup got wrong.</div>
              </div>
            )}

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginTop: 20 }}>
              <div>
                <label style={{ fontSize: 12, fontWeight: 600, color: '#1D1D1F', display: 'block', marginBottom: 6 }}>Industry</label>
                <input value={industry} onChange={e => setIndustry(e.target.value)} placeholder="e.g. Healthcare"
                  style={{ width: '100%', border: '1px solid #D2D2D7', borderRadius: 8, padding: '8px 12px', fontSize: 14, fontFamily: FONT, boxSizing: 'border-box' }} />
              </div>
              <div>
                <label style={{ fontSize: 12, fontWeight: 600, color: '#1D1D1F', display: 'block', marginBottom: 6 }}>Estimated employee count</label>
                <input value={employeeCount} onChange={e => setEmployeeCount(e.target.value)} placeholder="e.g. 10,000-25,000"
                  style={{ width: '100%', border: '1px solid #D2D2D7', borderRadius: 8, padding: '8px 12px', fontSize: 14, fontFamily: FONT, boxSizing: 'border-box' }} />
              </div>
            </div>

            <div style={{ marginTop: 16 }}>
              <label style={{ fontSize: 12, fontWeight: 600, color: '#1D1D1F', display: 'block', marginBottom: 6 }}>Locations</label>
              <TagInput values={locations} onChange={setLocations} placeholder="Add a location, press Enter" />
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginTop: 16 }}>
              <div>
                <label style={{ fontSize: 12, fontWeight: 600, color: '#1D1D1F', display: 'block', marginBottom: 6 }}>Executive sponsor <span style={{ fontWeight: 400, color: '#8E8E93' }}>(optional)</span></label>
                <input value={executiveSponsorName} onChange={e => setExecutiveSponsorName(e.target.value)} placeholder="e.g. Jane Smith"
                  style={{ width: '100%', border: '1px solid #D2D2D7', borderRadius: 8, padding: '8px 12px', fontSize: 14, fontFamily: FONT, boxSizing: 'border-box' }} />
              </div>
              <div>
                <label style={{ fontSize: 12, fontWeight: 600, color: '#1D1D1F', display: 'block', marginBottom: 6 }}>Their title <span style={{ fontWeight: 400, color: '#8E8E93' }}>(optional)</span></label>
                <input value={executiveSponsorTitle} onChange={e => setExecutiveSponsorTitle(e.target.value)} placeholder="e.g. CHRO"
                  style={{ width: '100%', border: '1px solid #D2D2D7', borderRadius: 8, padding: '8px 12px', fontSize: 14, fontFamily: FONT, boxSizing: 'border-box' }} />
              </div>
            </div>

            <SectionLabel>Proposed Engagement</SectionLabel>
            <div>
              <label style={{ fontSize: 12, fontWeight: 600, color: '#1D1D1F', display: 'block', marginBottom: 8 }}>What are we proposing?</label>
              <div style={{ display: 'flex', gap: 8 }}>
                {WORKDAY_TIERS.map(t => (
                  <button key={t} onClick={() => setTier(t)} style={{
                    flex: 1, padding: '10px 12px', borderRadius: 999, fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: FONT,
                    border: tier === t ? '1.5px solid #0C0D0D' : '1px solid #D2D2D7',
                    background: tier === t ? '#ECF4EE' : '#fff', color: tier === t ? '#0C0D0D' : '#3A3A3C',
                  }}>{t}</button>
                ))}
              </div>
            </div>

            <div style={{ marginTop: 16 }}>
              <label style={{ fontSize: 12, fontWeight: 600, color: '#1D1D1F', display: 'block', marginBottom: 8 }}>Scope (select all that apply)</label>
              <div style={{ display: 'flex', gap: 8 }}>
                {SCOPE_MODULES.map(m => (
                  <button key={m} onClick={() => toggleModule(m)} style={{
                    flex: 1, padding: '10px 12px', borderRadius: 999, fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: FONT,
                    border: modules.includes(m) ? '1.5px solid #16a34a' : '1px solid #D2D2D7',
                    background: modules.includes(m) ? '#F0FDF4' : '#fff', color: modules.includes(m) ? '#16a34a' : '#3A3A3C',
                  }}>{m}</button>
                ))}
              </div>
            </div>

            <div style={{ marginTop: 16 }}>
              <label style={{ fontSize: 12, fontWeight: 600, color: '#1D1D1F', display: 'block', marginBottom: 8 }}>Delivery approach</label>
              <div style={{ display: 'flex', gap: 8 }}>
                {DELIVERY_APPROACHES.map(d => (
                  <button key={d} onClick={() => setDelivery(d)} style={{
                    flex: 1, padding: '10px 12px', borderRadius: 999, fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: FONT,
                    border: delivery === d ? '1.5px solid #0C0D0D' : '1px solid #D2D2D7',
                    background: delivery === d ? '#ECF4EE' : '#fff', color: delivery === d ? '#0C0D0D' : '#3A3A3C',
                  }}>{d}</button>
                ))}
              </div>
            </div>

            <SectionLabel>Additional Context (optional — sharpens the draft)</SectionLabel>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
              <div>
                <label style={{ fontSize: 12, fontWeight: 600, color: '#1D1D1F', display: 'block', marginBottom: 6 }}>Current systems being replaced</label>
                <input value={currentSystems} onChange={e => setCurrentSystems(e.target.value)} placeholder="e.g. SAP SuccessFactors, ADP"
                  style={{ width: '100%', border: '1px solid #D2D2D7', borderRadius: 8, padding: '8px 12px', fontSize: 14, fontFamily: FONT, boxSizing: 'border-box' }} />
              </div>
              <div>
                <label style={{ fontSize: 12, fontWeight: 600, color: '#1D1D1F', display: 'block', marginBottom: 6 }}>Target go-live</label>
                <input value={targetGoLive} onChange={e => setTargetGoLive(e.target.value)} placeholder="e.g. Q3 2027"
                  style={{ width: '100%', border: '1px solid #D2D2D7', borderRadius: 8, padding: '8px 12px', fontSize: 14, fontFamily: FONT, boxSizing: 'border-box' }} />
              </div>
            </div>

            <div style={{ marginTop: 16 }}>
              <label style={{ fontSize: 12, fontWeight: 600, color: '#1D1D1F', display: 'block', marginBottom: 6 }}>Business drivers / pain points</label>
              <textarea value={businessDrivers} onChange={e => setBusinessDrivers(e.target.value)} rows={3}
                placeholder="What's motivating this initiative? e.g. fragmented legacy systems, upcoming M&A, compliance deadline…"
                style={{ width: '100%', border: '1px solid #D2D2D7', borderRadius: 8, padding: '8px 12px', fontSize: 14, fontFamily: FONT, boxSizing: 'border-box', resize: 'vertical' }} />
            </div>

            <div style={{ marginTop: 16 }}>
              <label style={{ fontSize: 12, fontWeight: 600, color: '#1D1D1F', display: 'block', marginBottom: 6 }}>Key integrations needed</label>
              <TagInput values={keyIntegrations} onChange={setKeyIntegrations} placeholder="e.g. benefits carrier, ATS — add and press Enter" />
            </div>

            <div style={{ marginTop: 16 }}>
              <label style={{ fontSize: 12, fontWeight: 600, color: '#1D1D1F', display: 'block', marginBottom: 8 }}>Estimated budget range</label>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                {BUDGET_RANGES.map(b => (
                  <button key={b} onClick={() => setBudgetRange(budgetRange === b ? '' : b)} style={{
                    padding: '8px 14px', borderRadius: 999, fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: FONT,
                    border: budgetRange === b ? '1.5px solid #0C0D0D' : '1px solid #D2D2D7',
                    background: budgetRange === b ? '#ECF4EE' : '#fff', color: budgetRange === b ? '#0C0D0D' : '#3A3A3C',
                  }}>{b}</button>
                ))}
              </div>
            </div>

            <div style={{ marginTop: 16 }}>
              <label style={{ fontSize: 12, fontWeight: 600, color: '#1D1D1F', display: 'block', marginBottom: 8 }}>Union / collective bargaining environment?</label>
              <div style={{ display: 'flex', gap: 8 }}>
                {([['Yes', true], ['No', false]] as const).map(([label, val]) => (
                  <button key={label} onClick={() => setUnionEnvironment(val)} style={{
                    padding: '8px 20px', borderRadius: 999, fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: FONT,
                    border: unionEnvironment === val ? '1.5px solid #0C0D0D' : '1px solid #D2D2D7',
                    background: unionEnvironment === val ? '#ECF4EE' : '#fff', color: unionEnvironment === val ? '#0C0D0D' : '#3A3A3C',
                  }}>{label}</button>
                ))}
              </div>
            </div>

            <button onClick={handleGenerate} disabled={!canGenerate} style={{
              marginTop: 24, width: '100%', padding: '12px 16px', borderRadius: 999, border: 'none',
              background: canGenerate ? '#1D1D1F' : '#D2D2D7', color: '#fff', fontSize: 14, fontWeight: 700,
              cursor: canGenerate ? 'pointer' : 'not-allowed', fontFamily: FONT,
            }}>
              Generate RFP Package
            </button>
          </div>
        )}

        {status === 'generating' && (
          <div style={{ background: '#FFFFFF', borderRadius: 14, border: '1px solid #E5E5EA', padding: 48, textAlign: 'center' }}>
            <div style={{ width: 28, height: 28, margin: '0 auto 16px', border: '3px solid #E5E5EA', borderTopColor: '#0C0D0D', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
            <style>{'@keyframes spin { to { transform: rotate(360deg); } }'}</style>
            <p style={{ fontSize: 14, fontWeight: 600, color: '#1D1D1F', margin: 0 }}>Generating your RFP package…</p>
            <p style={{ fontSize: 12, color: '#8E8E93', marginTop: 6 }}>Drafting 4 documents grounded in the {industry} knowledge base. This usually takes under a minute.</p>
          </div>
        )}

        {status === 'error' && (
          <div style={{ background: '#FFFFFF', borderRadius: 14, border: '1px solid #E5E5EA', padding: 32, textAlign: 'center' }}>
            <p style={{ fontSize: 14, fontWeight: 600, color: '#dc2626', margin: 0 }}>Generation failed</p>
            <p style={{ fontSize: 12, color: '#8E8E93', marginTop: 6 }}>{genError}</p>
            <button onClick={startOver} style={{ marginTop: 16, padding: '8px 16px', borderRadius: 999, border: '1px solid #D2D2D7', background: '#fff', color: '#3A3A3C', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: FONT }}>
              Try again
            </button>
          </div>
        )}

        {status === 'done' && documents && (
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <div style={{ display: 'flex', gap: 4, background: '#fff', borderRadius: 10, border: '1px solid #E5E5EA', padding: 4 }}>
                {DOC_TABS.map(t => (
                  <button key={t.key} onClick={() => setActiveDocTab(t.key)} style={{
                    padding: '7px 14px', borderRadius: 999, border: 'none', cursor: 'pointer', fontSize: 12.5, fontWeight: 600, fontFamily: FONT,
                    background: activeDocTab === t.key ? '#1D1D1F' : 'transparent', color: activeDocTab === t.key ? '#fff' : '#3A3A3C',
                  }}>{t.label}</button>
                ))}
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button onClick={() => navigator.clipboard.writeText(documents[activeDocTab])}
                  style={{ padding: '7px 14px', borderRadius: 999, border: '1px solid #D2D2D7', background: '#fff', color: '#3A3A3C', fontSize: 12.5, fontWeight: 600, cursor: 'pointer', fontFamily: FONT }}>
                  Copy
                </button>
                <button onClick={startOver}
                  style={{ padding: '7px 14px', borderRadius: 999, border: '1px solid #D2D2D7', background: '#fff', color: '#3A3A3C', fontSize: 12.5, fontWeight: 600, cursor: 'pointer', fontFamily: FONT }}>
                  New RFP
                </button>
              </div>
            </div>
            <div style={{ background: '#FFFFFF', borderRadius: 14, border: '1px solid #E5E5EA', padding: 28 }}>
              <MarkdownView text={documents[activeDocTab]} />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// Small, purpose-built renderer for exactly what these 4 prompts are instructed to produce
// (headers, bold, bullet lists, tables, horizontal rules) — not a general markdown library.
function MarkdownView({ text }: { text: string }) {
  const lines = text.split('\n');
  const blocks: React.ReactNode[] = [];
  let tableRows: string[][] = [];
  let listItems: string[] = [];

  function flushTable() {
    if (tableRows.length === 0) return;
    const [header, ...rows] = tableRows;
    blocks.push(
      <div key={`table-${blocks.length}`} style={{ overflowX: 'auto', margin: '12px 0' }}>
        <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 13 }}>
          <thead>
            <tr>{header.map((h, i) => <th key={i} style={{ textAlign: 'left', padding: '6px 10px', borderBottom: '2px solid #E5E5EA', color: '#1D1D1F' }}>{stripBold(h)}</th>)}</tr>
          </thead>
          <tbody>
            {rows.map((r, ri) => (
              <tr key={ri}>{r.map((c, ci) => <td key={ci} style={{ padding: '6px 10px', borderBottom: '1px solid #F0F0F0', color: '#3A3A3C' }}>{stripBold(c)}</td>)}</tr>
            ))}
          </tbody>
        </table>
      </div>
    );
    tableRows = [];
  }

  function flushList() {
    if (listItems.length === 0) return;
    blocks.push(
      <ul key={`list-${blocks.length}`} style={{ margin: '8px 0', paddingLeft: 20 }}>
        {listItems.map((item, i) => <li key={i} style={{ fontSize: 13.5, color: '#3A3A3C', marginBottom: 3, lineHeight: 1.5 }}>{stripBold(item)}</li>)}
      </ul>
    );
    listItems = [];
  }

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('|')) {
      flushList();
      const cells = trimmed.split('|').slice(1, -1).map(c => c.trim());
      if (!cells.every(c => /^-+$/.test(c))) tableRows.push(cells);
      continue;
    }
    flushTable();

    if (/^#{1,3}\s/.test(trimmed)) {
      flushList();
      const level = trimmed.match(/^#+/)![0].length;
      const content = trimmed.replace(/^#+\s*/, '');
      const size = level === 1 ? 19 : level === 2 ? 16 : 14;
      blocks.push(<div key={blocks.length} style={{ fontSize: size, fontWeight: 700, color: '#1D1D1F', margin: level === 1 ? '18px 0 8px' : '14px 0 6px' }}>{stripBold(content)}</div>);
    } else if (trimmed === '---') {
      flushList();
      blocks.push(<hr key={blocks.length} style={{ border: 'none', borderTop: '1px solid #E5E5EA', margin: '16px 0' }} />);
    } else if (/^[-*]\s/.test(trimmed)) {
      listItems.push(trimmed.replace(/^[-*]\s/, ''));
    } else if (trimmed === '') {
      flushList();
    } else {
      flushList();
      blocks.push(<p key={blocks.length} style={{ fontSize: 13.5, color: '#3A3A3C', lineHeight: 1.6, margin: '6px 0' }}>{stripBold(trimmed)}</p>);
    }
  }
  flushList();
  flushTable();

  return <div>{blocks}</div>;
}

function stripBold(s: string): string {
  return s.replace(/\*\*(.+?)\*\*/g, '$1').replace(/^\*(.+?)\*$/g, '$1');
}
