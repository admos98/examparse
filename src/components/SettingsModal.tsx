import React, { useState, useEffect } from 'react';
import {
  X,
  Plus,
  Trash2,
  CheckCircle,
  AlertCircle,
  Database,
  Lock,
  Download,
  Upload,
  Cpu,
  Coins,
  Shield,
  FileCheck,
} from 'lucide-react';
import { AppSettings, ProviderConfig, ProviderKind } from '../types';
import { applyTheme } from '../pipeline/agentTheme';
import { StoragePanel } from './StoragePanel';
import { MemoryPanel } from './MemoryPanel';
import { LLMAdapter } from '../providers/adapter';
import { clearAllCachesAndData, loadUsageLog } from '../store';
import { buildDiagnostics, exportDiagnostics, diagnosticsFromUsage } from '../utils/diagnostics';
import { CapabilityRecord, getProbeRecord, ProbeProviderConfig, runProbe, saveProbeRecord, probeCostEstimate } from '../pipeline/probe';
import { MAX_SETTINGS_JSON_BYTES, redactSettingsForExport, validateAppSettings, validateProviderBaseUrl, validateHeaders } from '../utils/validation';
import { buildScoreboard, leaderFor, docTraitBucket, bucketKey } from '../pipeline/scoreboard';
import { estimateLiveBench, liveBenchGate, diffScorecards } from '../pipeline/liveBench';
import { ConfirmCard, Modal } from '../design/primitives';
import { uiText } from '../design/i18n';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  settings: AppSettings;
  onSaveSettings: (settings: AppSettings) => void;
  onOpenExplainer: () => void;
  initialTab?: TabType;
}

type TabType = 'providers' | 'roles' | 'costs' | 'thrift' | 'budget' | 'document' | 'assistant' | 'privacy' | 'diagnostics';
type ProbeResult = CapabilityRecord | { error: string };

function probeModelForProvider(provider: ProviderConfig, settings: AppSettings, discoveredModels?: string[]): string {
  const roleModels = [
    settings.roleMapping.fast,
    settings.roleMapping.standard,
    settings.roleMapping.escalation,
    settings.roleMapping.vision,
    settings.roleMapping.agent,
  ];
  const configured = roleModels.find(selection => selection?.providerId === provider.id);
  return configured?.model || discoveredModels?.[0] || 'default-model';
}

function probeProviderConfig(provider: ProviderConfig, settings: AppSettings, discoveredModels?: string[]): ProbeProviderConfig {
  return { ...provider, model: probeModelForProvider(provider, settings, discoveredModels) };
}

const BackupPanel: React.FC = () => {
  const [msg, setMsg] = useState<string|null>(null);
  const handleBackup = async () => {
    try {
      const { createBackup } = await import('../utils/backup');
      const { listExamSummaries: lis, loadExamDoc: ld } = await import('../store');
      const summaries = await lis();
      const exams: Record<string,any> = {};
      for (const s of summaries) { const d = await ld(s.id); if(d) exams[s.id]=d; }
      const safeSettings = (()=>{ try { return JSON.parse(localStorage.getItem('examparse_settings')||'{}'); } catch { return {}; } })();
      // B5 — learned memory rides in the same zip (playbook, run journal, skills, config).
      const memory = await (async () => {
        const get = async (url:string) => { try { const res = await fetch(url); return res.ok ? await res.json() : null; } catch { return null; } };
        const [playbook, runs, skills, config] = await Promise.all([
          get('/api/memory/playbook'), get('/api/memory/runs'), get('/api/memory/skills'), get('/api/memory/config'),
        ]);
        const activityData = await get('/api/memory/activity');
        return { playbook: playbook || undefined, runs: Array.isArray(runs) ? runs : [], skills: Array.isArray(skills) ? skills : [], config: config || undefined, activity: Array.isArray(activityData?.activity) ? activityData.activity : [] };
      })();
      const buf = await createBackup({ exams, images:{}, dossiers:{}, settings: safeSettings, memory });
      const blob = new Blob([buf as any], {type:'application/zip'});
      const url = URL.createObjectURL(blob); const a=document.createElement('a'); a.href=url; a.download='examparse-backup.zip'; a.click(); URL.revokeObjectURL(url);
      setMsg('Backup downloaded');
    } catch(e:any){ setMsg('Backup failed: '+(e?.message||'')); }
  };
  const handleRestore = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file=e.target.files?.[0]; if(!file) return;
    try {
      const buf = new Uint8Array(await file.arrayBuffer());
      const { restoreBackup } = await import('../utils/backup');
      const res = await restoreBackup(buf);
      const { saveExamDoc } = await import('../store');
      for (const [id, doc] of Object.entries(res.exams)) await saveExamDoc(doc as any);
      // Restore learned memory (B5). Invalid skill files are rejected by the server linter.
      const put = async (url:string, body:any) => { try { await fetch(url, { method:'PUT', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) }); } catch {} };
      if (res.memory?.playbook) await put('/api/memory/playbook', res.memory.playbook);
      if (res.memory?.config) await put('/api/memory/config', res.memory.config);
      let skillsRestored = 0;
      for (const skill of res.memory?.skills || []) {
        const response = await fetch(`/api/memory/skills/${encodeURIComponent(skill.slug)}`, { method:'PUT', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ content: skill.content }) });
        if (response.ok) skillsRestored++;
      }
      for (const run of res.memory?.runs || []) { try { await fetch('/api/memory/runs', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(run) }); } catch {} }
      setMsg(`Restored ${res.counts.exams} exams, ${res.counts.playbookEntries} lessons, ${skillsRestored} skills, ${res.counts.memoryRuns} run lines`);
    } catch(err:any){ setMsg('Restore failed: '+(err?.message||'')); }
    e.target.value='';
  };
  return <div className="p-3 rounded-[10px] border bg-[var(--paper-raised)]  flex flex-wrap items-center gap-2 text-xs">
    <button onClick={handleBackup} className="px-3 py-1.5 rounded-[6px] border text-xs">Create backup (.zip)</button>
    <label className="px-3 py-1.5 rounded-[6px] border text-xs cursor-pointer">Restore backup <input type="file" accept=".zip" onChange={handleRestore} className="hidden" /></label>
    {msg && <span className="text-[var(--ink-2)]">{msg}</span>}
  </div>;
};

const DiagnosticsPanel: React.FC = () => {
  const [diag, setDiag] = useState<any>(null);
  useEffect(()=> {
    const usage = loadUsageLog();
    const runs = diagnosticsFromUsage(usage as any);
    const d = buildDiagnostics(runs, {});
    setDiag(d);
  }, []);
  if (!diag) return <div className="text-xs text-[var(--ink-2)]">Loading diagnostics…</div>;
  const handleExport = () => {
    const json = exportDiagnostics(diag);
    const blob = new Blob([json], {type:'application/json'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href=url; a.download='examparse-diagnostics.json'; a.click(); URL.revokeObjectURL(url);
  };
  return <div className="space-y-3">
    <div className="text-[length:var(--type-12)] text-[var(--ink-2)]">Generated: {diag.generatedAt} · {diag.runs.length} run(s)</div>
    <div className="overflow-auto max-h-72 border rounded-[10px]">
      <table className="w-full text-xs">
        <thead className="bg-[var(--paper)]  sticky top-0"><tr><th className="p-1.5 text-start">Exam</th><th className="p-1.5">Calls</th><th className="p-1.5">Tokens</th><th className="p-1.5">Cost</th><th className="p-1.5">Outcome</th></tr></thead>
        <tbody>{diag.runs.map((r:any, i:number)=> <tr key={i} className="border-t"><td className="p-1.5 truncate max-w-[160px]">{r.examName}</td><td className="p-1.5 text-center">{r.calls}</td><td className="p-1.5 text-center">{r.tokens}</td><td className="p-1.5 text-center">${Number(r.cost).toFixed(4)}</td><td className="p-1.5 text-center">{r.outcome}</td></tr>)}
        {diag.runs.length===0 && <tr><td colSpan={5} className="p-4 text-center text-[var(--ink-2)]">No runs yet</td></tr>}</tbody>
      </table>
    </div>
    {Object.keys(diag.providerErrorTaxonomy||{}).length>0 && (
      <div className="p-2 rounded-[6px] border bg-[var(--warn-soft)]  text-xs">
        <div className="font-semibold">Provider error taxonomy</div>
        <div className="font-mono text-[length:var(--type-12)]">{Object.entries(diag.providerErrorTaxonomy).map(([k,v])=> `${k}: ${v}`).join(' · ')}</div>
      </div>
    )}
    <button onClick={handleExport} className="px-3 py-1.5 rounded-[6px] border border-[var(--rule-strong)]  text-xs flex items-center gap-1.5"><Download className="w-3.5 h-3.5" /> Export Diagnostics (JSON)</button>
  </div>;
};

export const SettingsModal: React.FC<Props> = ({
  isOpen,
  onClose,
  settings,
  onSaveSettings,
  onOpenExplainer,
  initialTab = 'providers',
}) => {
  const [activeTab, setActiveTab] = useState<TabType>(initialTab);
  const [sbRows, setSbRows] = useState<any[]>([]);
  const [sbBucket, setSbBucket] = useState('');
  const [benchMsg, setBenchMsg] = useState('');
  const [benchConfirmOpen, setBenchConfirmOpen] = useState(false);
  const [uiError, setUiError] = useState('');
  useEffect(() => {
    if (!isOpen) return;
    setActiveTab(initialTab);
    (async () => {
      try {
        const res = await fetch('/api/memory/runs');
        const runs = res.ok ? await res.json() : [];
        if (Array.isArray(runs) && runs.length) {
          setSbRows(buildScoreboard(runs));
          setSbBucket(bucketKey(docTraitBucket(runs[runs.length - 1].docTraits || {})));
        }
      } catch { /* offline — no leader hints */ }
    })();
  }, [isOpen, initialTab]);

  const estimateLiveBenchCost = () => {
    const fastRate = (current.costTable as any)?.[current.roleMapping.fast.model];
    const rate = { input: Number(fastRate?.inputCostPerMillion) || 1, output: Number(fastRate?.outputCostPerMillion) || 2 };
    return estimateLiveBench([
      { id: 'english-mcq', structureCalls: 1, estInputTokens: 4000, estOutputTokens: 1200 },
      { id: 'scanned-noisy', structureCalls: 1, estInputTokens: 3000, estOutputTokens: 900 },
    ], rate);
  };
  const runLiveBench = () => setBenchConfirmOpen(true);
  const confirmLiveBench = async () => {
    const est = estimateLiveBenchCost();
    const model = current.roleMapping.fast.model;
    setBenchConfirmOpen(false);
    // Explicit in-product consent still gates every provider call; cancel makes zero calls.
    if (!liveBenchGate(true).allowed) { setBenchMsg('Live bench declined — 0 calls made.'); return; }
    setBenchMsg('Live bench running against the configured provider…');
    try {
      const { fixture: english } = await import('../../test/fixtures/golden/english-mcq');
      const { fixture: scanned } = await import('../../test/fixtures/golden/scanned-noisy');
      const { runFullPipeline } = await import('../pipeline/index');
      const { getExamHealth } = await import('../pipeline/quality');
      const results: any[] = [];
      for (const fx of [english, scanned] as any[]) {
        const text = (fx.sourceLines || []).map((l: any) => l.text).join('\n');
        const file = new File([text], `${fx.id}.txt`, { type: 'text/plain' });
        const doc: any = await runFullPipeline(file, current, { onStageUpdate: () => undefined });
        const h = getExamHealth(doc);
        results.push({ id: fx.id, coveragePercent: h.coveragePercent, quality: h.coveragePercent, calls: (doc.usage || []).filter((u: any) => !u.isCachedHit).length });
      }
      const prevRes = await fetch('/api/memory/livebench');
      const prevAll = prevRes.ok ? await prevRes.json() : [];
      const prev = Array.isArray(prevAll) ? prevAll[prevAll.length - 1] : null;
      const card = { ts: new Date().toISOString(), role: 'fast', modelId: model, fixtures: results, meanCoverage: Math.round(results.reduce((a, r) => a + r.coveragePercent, 0) / Math.max(1, results.length)), meanQuality: Math.round(results.reduce((a, r) => a + r.quality, 0) / Math.max(1, results.length)), totalCalls: results.reduce((a, r) => a + r.calls, 0), costUsd: est.estCostUsd };
      await fetch('/api/memory/livebench', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(card) });
      const deltas = diffScorecards(prev, card as any).map(d => `${d.fixture}: coverage ${d.coverageDelta >= 0 ? '+' : ''}${d.coverageDelta}pts`).join(' · ');
      setBenchMsg(`Live bench stored for ${model}. ${prev ? `Old-vs-new — ${deltas}` : 'First scorecard (no previous run to diff).'}`);
    } catch (err: any) {
      setBenchMsg(`Live bench failed (no scorecard stored): ${String(err?.message || err).slice(0, 160)}`);
    }
  };

  const [current, setCurrent] = useState<AppSettings>(settings);
  const t = (en: string, fa: string) => uiText(current.uiLanguage, en, fa);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, { ok: boolean; msg: string }>>({});
  const [availableModels, setAvailableModels] = useState<Record<string, string[]>>({});
  const [probeResults, setProbeResults] = useState<Record<string, ProbeResult>>({});
  const [clearSuccess, setClearSuccess] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    setCurrent(settings);
    let cancelled = false;
    void Promise.all(settings.providers.map(async provider => {
      const record = await getProbeRecord(provider.id, probeModelForProvider(provider, settings));
      if (record && !cancelled) setProbeResults(previous => ({ ...previous, [provider.id]: record }));
    }));
    return () => { cancelled = true; };
  }, [isOpen, settings]);
  if (!isOpen) return null;

  const handleUpdateProvider = (id: string, updates: Partial<ProviderConfig>) => {
    setCurrent(prev => ({
      ...prev,
      providers: prev.providers.map(p => (p.id === id ? { ...p, ...updates } : p)),
    }));
  };

  const handleAddProvider = () => {
    const newId = `custom_${Date.now()}`;
    const newProvider: ProviderConfig = {
      id: newId,
      name: 'Custom OpenAI Provider',
      kind: 'openai-compatible',
      baseURL: 'http://localhost:1234/v1',
      apiKey: '',
      disableReasoning: true,
      structuredOutputs: true,
      extraBodyJson: '',
    };
    setCurrent(prev => ({ ...prev, providers: [...prev.providers, newProvider] }));
  };

  const handleDeleteProvider = (id: string) => {
    setCurrent(prev => ({
      ...prev,
      providers: prev.providers.filter(p => p.id !== id),
    }));
  };

  const handleTestConnection = async (provider: ProviderConfig) => {
    if (provider.kind === 'openai-compatible' && !validateProviderBaseUrl(provider.baseURL)) {
      setTestResults(prev => ({ ...prev, [provider.id]: { ok: false, msg: 'Rejected: base URL must be http(s) without credentials, query, or fragment.' } }));
      return;
    }
    if (!validateHeaders(provider.defaultHeaders)) {
      setTestResults(prev => ({ ...prev, [provider.id]: { ok: false, msg: 'Rejected: invalid HTTP header name/value.' } }));
      return;
    }
    setTestingId(provider.id);
    const res = await LLMAdapter.testConnection(provider);
    setTestingId(null);
    setTestResults(prev => ({
      ...prev,
      [provider.id]: {
        ok: res.ok,
        msg: res.ok
          ? `Connected successfully (${res.latencyMs}ms)`
          : `Failed: ${res.error || 'Unknown error'}`,
      },
    }));
  };

  const handleFetchModels = async (provider: ProviderConfig) => {
    const models = await LLMAdapter.fetchModels(provider);
    setAvailableModels(prev => ({ ...prev, [provider.id]: models }));
  };
  const handleProbe = async (provider: ProviderConfig) => {
    setTestingId(`probe-${provider.id}`);
    try {
      const configuredProvider = probeProviderConfig(provider, current, availableModels[provider.id]);
      // Use the adapter's normal one-shot execution path, exactly like pipeline calls.
      const record = await runProbe(configuredProvider, request => LLMAdapter.execute(request));
      await saveProbeRecord(record);
      setProbeResults(previous => ({ ...previous, [provider.id]: record }));
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Probe failed';
      setProbeResults(previous => ({ ...previous, [provider.id]: { error: message } }));
    } finally {
      setTestingId(null);
    }
  };

  const handleClearCache = async () => {
    await clearAllCachesAndData();
    setClearSuccess(true);
    setTimeout(() => setClearSuccess(false), 2500);
  };

  const handleExportSettings = () => {
    const jsonStr = JSON.stringify(redactSettingsForExport(current), null, 2);
    const blob = new Blob([jsonStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'examparse-settings.json';
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleImportSettings = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > MAX_SETTINGS_JSON_BYTES) { setUiError(current.uiLanguage === 'fa' ? 'حجم فایل تنظیمات از سقف ۱ مگابایت بیشتر است.' : 'Settings JSON exceeds the 1 MiB import limit.'); e.target.value = ''; return; }
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const imported = validateAppSettings(JSON.parse(String(reader.result || '')));
        setCurrent(imported);
        onSaveSettings(imported);
      } catch (error: any) {
        setUiError(current.uiLanguage === 'fa' ? `وارد کردن تنظیمات رد شد: ${error?.issues?.slice?.(0, 3).map((issue: any) => issue.message).join('؛ ') || 'فایل تنظیمات معتبر یا ایمن نیست'}` : `Settings import rejected: ${error?.issues?.slice?.(0, 3).map((issue: any) => issue.message).join('; ') || 'invalid or unsafe settings JSON'}`);
      } finally { e.target.value = ''; }
    };
    reader.onerror = () => { setUiError(current.uiLanguage === 'fa' ? 'خواندن فایل تنظیمات ممکن نشد.' : 'Could not read the settings file.'); e.target.value = ''; };
    reader.readAsText(file);
  };

  const handleSaveAndClose = () => {
    try { const validated = validateAppSettings(current); onSaveSettings(validated); onClose(); }
    catch (error: any) { setUiError(current.uiLanguage === 'fa' ? `تنظیمات ذخیره نشد: ${error?.issues?.slice?.(0, 3).map((issue: any) => issue.message).join('؛ ') || 'نشانی ارائه‌دهنده، سرآیندها یا مقدار تنظیمات معتبر نیست'}` : `Settings rejected: ${error?.issues?.slice?.(0, 3).map((issue: any) => issue.message).join('; ') || 'invalid provider URL, headers, or settings value'}`); }
  };

  return (
    <Modal open={isOpen} onClose={onClose} title="Settings & Provider Configuration" labelledBy="settings-modal-title" className="ep-settings-window">
      <div className="h-[85vh] w-full flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between p-5 border-b border-[var(--rule)] ">
          <div>
            <h2 id="settings-modal-title" className="text-lg font-bold text-[var(--ink)] ">Settings & Provider Configuration</h2>
            <p className="text-xs text-[var(--ink-2)]">Configure AI endpoints, token budgets, role models, and privacy</p>
          </div>
          <button
            type="button"
            aria-label={uiText(settings.uiLanguage, 'Close settings', 'بستن تنظیمات')}
            onClick={onClose}
            className="p-2 text-[var(--ink-2)] hover:text-[var(--ink-2)]  rounded-[6px] hover:bg-[var(--paper)] "
          >
            <X className="w-5 h-5" />
          </button>
        </div>
        {uiError && <p className="px-5 pt-2 text-[length:var(--type-12)] text-[var(--danger)]" role="status" aria-live="polite">{uiError}</p>}

        {/* Content Layout */}
        <div className="ep-settings-layout flex flex-1 overflow-hidden">
          {/* Side Tabs */}
          <div className="ep-settings-tabs w-48 bg-[var(--paper)]  border-e border-[var(--rule)]  p-2 space-y-1">
            <button
              onClick={() => setActiveTab('providers')}
              className={`w-full flex items-center gap-2 px-3 py-2 rounded-[6px] text-xs font-medium text-start transition ${
                activeTab === 'providers'
                  ? 'bg-[var(--accent)] text-[var(--on-accent)]'
                  : 'text-[var(--ink-2)]  hover:bg-[var(--paper)] '
              }`}
            >
              <Cpu className="w-3.5 h-3.5" /> Providers
            </button>
            <button
              onClick={() => setActiveTab('roles')}
              className={`w-full flex items-center gap-2 px-3 py-2 rounded-[6px] text-xs font-medium text-start transition ${
                activeTab === 'roles'
                  ? 'bg-[var(--accent)] text-[var(--on-accent)]'
                  : 'text-[var(--ink-2)]  hover:bg-[var(--paper)] '
              }`}
            >
              <Cpu className="w-3.5 h-3.5" /> Role Mapping
            </button>
            <button
              onClick={() => setActiveTab('costs')}
              className={`w-full flex items-center gap-2 px-3 py-2 rounded-[6px] text-xs font-medium text-start transition ${
                activeTab === 'costs'
                  ? 'bg-[var(--accent)] text-[var(--on-accent)]'
                  : 'text-[var(--ink-2)]  hover:bg-[var(--paper)] '
              }`}
            >
              <Coins className="w-3.5 h-3.5" /> Cost Table
            </button>
            <button
              onClick={() => setActiveTab('thrift')}
              className={`w-full flex items-center gap-2 px-3 py-2 rounded-[6px] text-xs font-medium text-start transition ${
                activeTab === 'thrift'
                  ? 'bg-[var(--accent)] text-[var(--on-accent)]'
                  : 'text-[var(--ink-2)]  hover:bg-[var(--paper)] '
              }`}
            >
              <Shield className="w-3.5 h-3.5" /> Token Thrift
            </button>
            <button
              onClick={() => setActiveTab('budget')}
              className={`w-full flex items-center gap-2 px-3 py-2 rounded-[6px] text-xs font-medium text-start transition ${
                activeTab === 'budget'
                  ? 'bg-[var(--accent)] text-[var(--on-accent)]'
                  : 'text-[var(--ink-2)]  hover:bg-[var(--paper)] '
              }`}
            >
              <Lock className="w-3.5 h-3.5" /> Budget Cap
            </button>
            <button
              onClick={() => setActiveTab('document')}
              className={`w-full flex items-center gap-2 px-3 py-2 rounded-[6px] text-xs font-medium text-start transition ${
                activeTab === 'document'
                  ? 'bg-[var(--accent)] text-[var(--on-accent)]'
                  : 'text-[var(--ink-2)]  hover:bg-[var(--paper)] '
              }`}
            >
              <FileCheck className="w-3.5 h-3.5" /> Document & Print
            </button>
            <button
              onClick={() => setActiveTab('assistant')}
              className={`w-full flex items-center gap-2 px-3 py-2 rounded-[6px] text-xs font-medium text-start transition ${
                activeTab === 'assistant'
                  ? 'bg-[var(--accent)] text-[var(--on-accent)]'
                  : 'text-[var(--ink-2)]  hover:bg-[var(--paper)] '
              }`}
            >
              <Database className="w-3.5 h-3.5" /> Assistant Memory
            </button>
            <button
              onClick={() => setActiveTab('privacy')}
              className={`w-full flex items-center gap-2 px-3 py-2 rounded-[6px] text-xs font-medium text-start transition ${
                activeTab === 'privacy'
                  ? 'bg-[var(--accent)] text-[var(--on-accent)]'
                  : 'text-[var(--ink-2)]  hover:bg-[var(--paper)] '
              }`}
            >
              <Database className="w-3.5 h-3.5" /> Storage & Privacy
            </button>
            <button
              onClick={() => setActiveTab('diagnostics')}
              className={`w-full flex items-center gap-2 px-3 py-2 rounded-[6px] text-xs font-medium text-start transition ${
                activeTab === 'diagnostics'
                  ? 'bg-[var(--accent)] text-[var(--on-accent)]'
                  : 'text-[var(--ink-2)]  hover:bg-[var(--paper)] '
              }`}
            >
              <FileCheck className="w-3.5 h-3.5" /> Diagnostics
            </button>
          </div>

          {/* Tab Content Panel */}
          <div className="ep-settings-content min-h-0 flex-1 p-6 overflow-y-auto">
            {/* PROVIDERS TAB */}
            {activeTab === 'providers' && (
              <div className="space-y-6">
                <div className="flex justify-between items-center">
                  <div>
                    <h3 className="font-semibold text-[var(--ink)]  text-sm">Configured AI Providers</h3>
                    <p className="text-xs text-[var(--ink-2)]">Google Gemini (native) or any OpenAI-compatible endpoint (9Router, LM Studio, etc.)</p>
                  </div>
                  <button
                    onClick={handleAddProvider}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-[6px] bg-[var(--accent)] text-[var(--on-accent)] text-xs font-medium hover:bg-[var(--accent)] transition"
                  >
                    <Plus className="w-3.5 h-3.5" /> Add Provider
                  </button>
                </div>

                <div className="space-y-4">
                  {current.providers.map(p => {
                    const test = testResults[p.id];
                    const models = availableModels[p.id];
                    const probeModel = probeModelForProvider(p, current, models);
                    const probeEstimate = probeCostEstimate(probeModel, current.costTable);
                    const probe = probeResults[p.id];

                    return (
                      <div
                        key={p.id}
                        className="p-4 rounded-[10px] border border-[var(--rule)]  bg-[var(--paper)]  space-y-3"
                      >
                        <div className="flex justify-between items-center">
                          <input
                            type="text"
                            value={p.name}
                            onChange={e => handleUpdateProvider(p.id, { name: e.target.value })}
                            className="font-medium text-xs text-[var(--ink)]  bg-[var(--surface-transparent)] border-b border-[var(--surface-transparent)] hover:border-[var(--rule-strong)] focus:border-[var(--accent)] outline-hidden"
                          />
                          <div className="flex items-center gap-2">
                            <span className="text-[length:var(--type-12)] px-2 py-0.5 rounded-[6px] bg-[var(--paper)]  text-[var(--ink-2)]  font-mono">
                              {p.kind}
                            </span>
                            {p.id !== 'google-gemini' && (
                              <button
                                onClick={() => handleDeleteProvider(p.id)}
                                className="text-[var(--ink-2)] hover:text-[var(--danger)] transition p-1"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            )}
                          </div>
                        </div>

                        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
                          <div>
                            <label className="block text-[length:var(--type-12)] text-[var(--ink-2)] mb-1">Base URL</label>
                            <input
                              type="text"
                              value={p.baseURL}
                              onChange={e => handleUpdateProvider(p.id, { baseURL: e.target.value })}
                              className="w-full px-2.5 py-1.5 rounded-[6px] border border-[var(--rule)]  bg-[var(--paper-raised)]  text-[var(--ink)]  font-mono text-[length:var(--type-12)]"
                            />
                          </div>
                          <div>
                            <label className="block text-[length:var(--type-12)] text-[var(--ink-2)] mb-1">
                              API Key {p.id === 'google-gemini' && '(Optional — defaults to server platform key)'}
                            </label>
                            <input
                              type="password"
                              value={p.apiKey}
                              placeholder={p.id === 'google-gemini' ? 'Leave empty to use platform default' : 'sk-...'}
                              onChange={e => handleUpdateProvider(p.id, { apiKey: e.target.value })}
                              className="w-full px-2.5 py-1.5 rounded-[6px] border border-[var(--rule)]  bg-[var(--paper-raised)]  text-[var(--ink)]  font-mono text-[length:var(--type-12)]"
                            />
                          </div>
                        </div>

                        <div className="space-y-3">
                          <div className="flex items-center justify-between">
                            <div>
                              <div className="font-medium text-[length:var(--type-12)] text-[var(--ink)] ">Disable Reasoning / Thinking</div>
                              <div className="text-[length:var(--type-12)] text-[var(--ink-2)]">Send reasoning-off fields on parse/transcribe calls (low for the solver). Turn off to send nothing extra.</div>
                            </div>
                            <input
                              type="checkbox"
                              checked={p.disableReasoning !== false}
                              onChange={e => handleUpdateProvider(p.id, { disableReasoning: e.target.checked })}
                              className="w-4 h-4 rounded-[6px] text-[var(--accent-ink)]"
                            />
                          </div>
                          <div className="flex items-center justify-between">
                            <div>
                              <div className="font-medium text-[length:var(--type-12)] text-[var(--ink)] ">Structured JSON mode (response_format)</div>
                              <div className="text-[length:var(--type-12)] text-[var(--ink-2)]">Turn off for models that reject JSON mode (e.g. some experimental/free models). Prompts still require JSON.</div>
                            </div>
                            <input type="checkbox" checked={p.structuredOutputs !== false} onChange={e => handleUpdateProvider(p.id, { structuredOutputs: e.target.checked })} className="w-4 h-4 rounded-[6px] text-[var(--accent-ink)]" />
                          </div>
                          <div>
                            <label className="block text-[length:var(--type-12)] text-[var(--ink-2)] mb-1">Extra body JSON</label>
                            <textarea
                              value={p.extraBodyJson || ''}
                              onChange={e => handleUpdateProvider(p.id, { extraBodyJson: e.target.value })}
                              placeholder='{"enable_thinking": false}'
                              rows={2}
                              className="w-full px-2.5 py-1.5 rounded-[6px] border border-[var(--rule)]  bg-[var(--paper-raised)]  text-[var(--ink)]  font-mono text-[length:var(--type-12)]"
                            />
                            <p className="text-[length:var(--type-12)] text-[var(--ink-2)] mt-1">
                              e.g. {'{"enable_thinking": false}'} or {'{"chat_template_kwargs": {"enable_thinking": false}}'} or {'{"thinking": {"type": "disabled"}}'} — provider-specific overrides.
                            </p>
                          </div>
                        </div>

                        {/* Test & Fetch Models */}
                        <div className="flex items-center justify-between pt-2 border-t border-[var(--rule)]  text-xs">
                          <div className="flex items-center gap-2">
                            <button
                              disabled={testingId === p.id}
                              onClick={() => handleTestConnection(p)}
                              className="px-2.5 py-1 rounded-[6px] border border-[var(--rule-strong)]  hover:bg-[var(--paper)]  text-[length:var(--type-12)] font-medium"
                            >
                              {testingId === p.id ? 'Pinging...' : 'Test Connection'}
                            </button>
                            <button
                              onClick={() => handleFetchModels(p)}
                              className="px-2.5 py-1 rounded-[6px] border border-[var(--rule-strong)]  hover:bg-[var(--paper)]  text-[length:var(--type-12)] font-medium"
                            >
                              Fetch Models
                            </button>
                            <button
                              onClick={() => handleProbe(p)}
                              disabled={testingId === `probe-${p.id}`}
                              className="px-2.5 py-1 rounded-[6px] border text-[length:var(--type-12)]"
                            >
                              {testingId === `probe-${p.id}` ? 'Probing…' : `Probe ${probeEstimate}`}
                            </button>
                            <span className="text-[length:var(--type-12)] text-[var(--ink-2)]" title={`Model: ${probeModel}`}>
                              Estimated before run: {probeEstimate}
                            </span>
                            {probe && (
                              <span className="text-[length:var(--type-12)] text-[var(--ink-2)]">
                                {'error' in probe
                                  ? `Probe: ${probe.error}`
                                  : `SSE ${probe.sse ? 'yes' : 'no'} · reasoning ${probe.reasoningChannel ? 'yes' : 'no'} · wire v2 ${probe.wireV2Ok ? 'yes' : 'no'} · tool calls ${probe.toolCalls ? 'yes' : 'no'} · max out ≈${probe.approxMaxOut}`}
                              </span>
                            )}
                          </div>

                          {test && (
                            <div className={`flex items-center gap-1 text-[length:var(--type-12)] ${test.ok ? 'text-[var(--ok)]' : 'text-[var(--danger)]'}`}>
                              {test.ok ? <CheckCircle className="w-3.5 h-3.5" /> : <AlertCircle className="w-3.5 h-3.5" />}
                              <span>{test.msg}</span>
                            </div>
                          )}
                        </div>

                        {models && models.length > 0 && (
                          <div className="pt-2 text-[length:var(--type-12)] text-[var(--ink-2)]">
                            Available models ({models.length}): <span className="font-mono text-[var(--ink)] ">{models.slice(0, 6).join(', ')}{models.length > 6 ? '...' : ''}</span>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* ROLE MAPPING TAB */}
            {activeTab === 'roles' && (
              <div className="space-y-6">
                <div>
                  <h3 className="font-semibold text-[var(--ink)]  text-sm">Pipeline Role Mapping</h3>
                  <p className="text-xs text-[var(--ink-2)]">Assign specific models to fast structure parsing, vision, and escalation repairs</p>
                </div>

                <div className="space-y-4">
                  {(['read', 'meta', 'repair', 'cloud', 'vision', 'standard', 'agent', 'critic', 'consensus'] as const).map(role => {
                    const sel = current.roleMapping[role] || (role === 'cloud' ? current.roleMapping.escalation : current.roleMapping.fast);
                    const labelMap: Record<string, string> = {
                      read: 'Read (one whole-paper proposal · reasoning always off)',
                      meta: 'Meta (two tiny header reads · defaults to Read)',
                      repair: 'Repair (local fixes from a closed operation list)',
                      cloud: 'Cloud (one surviving defect and its evidence only)',
                      standard: 'Standard (General questions)',
                      vision: 'Vision (image captions, OCR, and metadata tie-break)',
                      agent: 'Assistant (defaults to Read until configured)',
                      critic: 'Critic (optional report only · off by default)',
                      consensus: 'Consensus (optional report only · off by default)',
                    };

                    return (
                      <div key={role} className="p-3.5 rounded-[10px] border border-[var(--rule)]  bg-[var(--paper)]  space-y-2">
                        <div className="font-medium text-xs text-[var(--ink)] ">
                          {labelMap[role]}
                        </div>
                        {(() => {
                          const sbRole = role === 'agent' ? 'fast' : role;
                          const leader = sbBucket ? leaderFor(sbRows as any, sbRole, sbBucket) : null;
                          const row = sbRows.find(r => r.role === sbRole && r.bucket === sbBucket);
                          if (!sbRows.length) return null;
                          if (!leader) return <div className="text-[length:var(--type-12)] text-[var(--ink-2)]">Scoreboard ({sbBucket}): insufficient data (n&lt;3) — no leader claimed.</div>;
                          return (
                            <div className="flex flex-wrap items-center gap-2 text-[length:var(--type-12)] text-[var(--ink-2)] ">
                              <span>Bucket leader for the latest doc ({sbBucket}): <b>{leader.modelId}</b> — clean-rate {(leader.cleanCoverageRate * 100).toFixed(0)}%, {leader.meanDefectsPerExam} defects/exam, ${leader.meanCostPerCleanQuestion}/clean Q (n={leader.jobs})</span>
                              <button className="px-2 py-0.5 rounded-[6px] border" onClick={() => setCurrent(prev => ({ ...prev, roleMapping: { ...prev.roleMapping, [role]: { providerId: prev.providers.find(p => p.name) ? (prev.providers.find(p => (Object.values(prev.roleMapping) as any[]).some((m: any) => m?.model === leader.modelId))?.id || prev.providers[0]?.id || sel.providerId) : sel.providerId, model: leader.modelId } } }))}>Use</button>
                            </div>
                          );
                        })()}
                        <div className="grid grid-cols-2 gap-3 text-xs">
                          <div>
                            <label className="block text-[length:var(--type-12)] text-[var(--ink-2)] mb-1">Provider</label>
                            <select
                              value={sel.providerId}
                              onChange={e =>
                                setCurrent(prev => ({
                                  ...prev,
                                  roleMapping: {
                                    ...prev.roleMapping,
                                    [role]: { ...sel, providerId: e.target.value },
                                  },
                                }))
                              }
                              className="w-full px-2.5 py-1.5 rounded-[6px] border border-[var(--rule)]  bg-[var(--paper-raised)]  text-[var(--ink)] "
                            >
                              {current.providers.map(p => (
                                <option key={p.id} value={p.id}>
                                  {p.name}
                                </option>
                              ))}
                            </select>
                          </div>
                          <div>
                            <label className="block text-[length:var(--type-12)] text-[var(--ink-2)] mb-1">Model Name</label>
                            <input
                              type="text"
                              value={sel.model}
                              onChange={e =>
                                setCurrent(prev => ({
                                  ...prev,
                                  roleMapping: {
                                    ...prev.roleMapping,
                                    [role]: { ...sel, model: e.target.value },
                                  },
                                }))
                              }
                              className="w-full px-2.5 py-1.5 rounded-[6px] border border-[var(--rule)]  bg-[var(--paper-raised)]  font-mono text-[length:var(--type-12)] text-[var(--ink)] "
                            />
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>

                {/* 2E/2C pipeline controls + 2G live bench */}
                <div className="p-3.5 rounded-[10px] border border-[var(--rule)]  bg-[var(--paper)]  space-y-3 text-xs">
                  <div className="font-medium text-[var(--ink)] ">Pipeline concurrency & consensus</div>
                  <label className="flex items-center gap-2">Parallel sections (1–6)
                    <input type="number" min={1} max={6} value={current.parallelSections ?? 3} onChange={e => setCurrent(prev => ({ ...prev, parallelSections: Math.max(1, Math.min(6, Number(e.target.value) || 3)) }))} className="w-16 px-2 py-1 rounded-[6px] border bg-[var(--paper-raised)] " />
                  </label>
                  <label className="flex items-center gap-2">
                    <input type="checkbox" checked={current.consensusEnabled !== false} onChange={e => setCurrent(prev => ({ ...prev, consensusEnabled: e.target.checked }))} />
                    Consensus on hard sections (default ON only when a distinct consensus model exists — never surprise spend)
                  </label>
                  <div className="flex flex-wrap items-center gap-2">
                    <button onClick={runLiveBench} className="px-3 py-1.5 rounded-[6px] bg-[var(--accent)] text-[var(--on-accent)]">Benchmark this change</button>
                    <span className="text-[var(--ink-2)]">Runs golden sources through the real configured provider after you confirm the estimate. Never auto-runs.</span>
                  </div>
                  {benchConfirmOpen && <ConfirmCard
                    title={current.uiLanguage === 'fa' ? 'اجرای بنچ زنده؟' : 'Run live benchmark?'}
                    description={current.uiLanguage === 'fa' ? `آزمون‌های منبع english-mcq و scanned-noisy با ارائه‌دهنده واقعی برای مدل ${current.roleMapping.fast.model} اجرا می‌شوند؛ حدود ${estimateLiveBenchCost().calls} فراخوانی و هزینهٔ برآوردی $${estimateLiveBenchCost().estCostUsd.toFixed(4)}. لغو هیچ فراخوانی‌ای انجام نمی‌دهد.` : `Run golden SOURCE docs (english-mcq, scanned-noisy) through the configured provider for ${current.roleMapping.fast.model}; about ${estimateLiveBenchCost().calls} calls and $${estimateLiveBenchCost().estCostUsd.toFixed(4)} estimated. Cancel makes 0 calls.`}
                    confirmLabel={current.uiLanguage === 'fa' ? 'اجرای بنچ' : 'Run benchmark'}
                    cancelLabel={current.uiLanguage === 'fa' ? 'لغو' : 'Cancel'}
                    onConfirm={() => void confirmLiveBench()}
                    onCancel={() => { setBenchConfirmOpen(false); setBenchMsg(current.uiLanguage === 'fa' ? 'بنچ زنده لغو شد؛ ۰ فراخوانی انجام شد.' : 'Live bench declined — 0 calls made.'); }}
                  />}
                  {benchMsg && <div role="status" className="p-2 rounded-[6px] bg-[var(--paper-raised)]  border">{benchMsg}</div>}
                </div>
              </div>
            )}

            {/* COST TABLE TAB */}
            {activeTab === 'costs' && (
              <div className="space-y-6">
                <div>
                  <h3 className="font-semibold text-[var(--ink)]  text-sm">Model Cost Rates ($/1M tokens)</h3>
                  <p className="text-xs text-[var(--ink-2)]">Used by the live usage meter and pre-flight budget calculation</p>
                </div>

                <div className="space-y-3">
                  {Object.entries(current.costTable).map(([model, rates]) => (
                    <div
                      key={model}
                      className="grid grid-cols-3 gap-3 items-center p-3 rounded-[10px] border border-[var(--rule)]  bg-[var(--paper)]  text-xs"
                    >
                      <div className="font-mono font-medium text-[var(--ink)]  truncate">
                        {model}
                      </div>
                      <div>
                        <label className="block text-[length:var(--type-12)] text-[var(--ink-2)]">Input ($/1M tokens)</label>
                        <input
                          type="number"
                          step="0.01"
                          value={rates.inputCostPerMillion}
                          onChange={e => {
                            const val = parseFloat(e.target.value) || 0;
                            setCurrent(prev => ({
                              ...prev,
                              costTable: {
                                ...prev.costTable,
                                [model]: { ...rates, inputCostPerMillion: val },
                              },
                            }));
                          }}
                          className="w-full px-2 py-1 rounded-[6px] border border-[var(--rule)]  bg-[var(--paper-raised)]  font-mono text-xs"
                        />
                      </div>
                      <div>
                        <label className="block text-[length:var(--type-12)] text-[var(--ink-2)]">Output ($/1M tokens)</label>
                        <input
                          type="number"
                          step="0.01"
                          value={rates.outputCostPerMillion}
                          onChange={e => {
                            const val = parseFloat(e.target.value) || 0;
                            setCurrent(prev => ({
                              ...prev,
                              costTable: {
                                ...prev.costTable,
                                [model]: { ...rates, outputCostPerMillion: val },
                              },
                            }));
                          }}
                          className="w-full px-2 py-1 rounded-[6px] border border-[var(--rule)]  bg-[var(--paper-raised)]  font-mono text-xs"
                        />
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* TOKEN THRIFT TAB */}
            {activeTab === 'thrift' && (
              <div className="space-y-6">
                <div className="flex justify-between items-center">
                  <div>
                    <h3 className="font-semibold text-[var(--ink)]  text-sm">Token-Thrift Controls</h3>
                    <p className="text-xs text-[var(--ink-2)]">Fine-tune compression, cache, and token saving heuristics</p>
                  </div>
                  <button
                    onClick={onOpenExplainer}
                    className="text-xs text-[var(--accent-ink)]  hover:underline flex items-center gap-1 font-medium"
                  >
                    Explain token savings
                  </button>
                </div>

                <div className="space-y-4 text-xs">
                  <div className="flex items-center justify-between p-3.5 rounded-[10px] border border-[var(--rule)]  bg-[var(--paper)] ">
                    <div>
                      <div className="font-medium text-[var(--ink)] ">Content-Hash Cache</div>
                      <div className="text-[length:var(--type-12)] text-[var(--ink-2)]">0 API calls on re-analyzing identical files</div>
                    </div>
                    <input
                      type="checkbox"
                      checked={current.thrift.cacheEnabled}
                      onChange={e =>
                        setCurrent(prev => ({
                          ...prev,
                          thrift: { ...prev.thrift, cacheEnabled: e.target.checked },
                        }))
                      }
                      className="w-4 h-4 rounded-[6px] text-[var(--accent-ink)]"
                    />
                  </div>

                  <div className="flex items-center justify-between p-3.5 rounded-[10px] border border-[var(--rule)]  bg-[var(--paper)] ">
                    <div>
                      <div className="font-medium text-[var(--ink)] ">Cleanup Judgment (Stage 2.5)</div>
                      <div className="text-[length:var(--type-12)] text-[var(--ink-2)]">One cheap AI call tags junk/header lines before structure (fewer prompt tokens). Off = local regex tags only; never deletes or edits lines.</div>
                    </div>
                    <input
                      type="checkbox"
                      checked={current.cleanupEnabled !== false}
                      onChange={e => setCurrent(prev => ({ ...prev, cleanupEnabled: e.target.checked }))}
                      className="w-4 h-4 rounded-[6px] text-[var(--accent-ink)]"
                    />
                  </div>

                  <div className="flex items-center justify-between p-3.5 rounded-[10px] border border-[var(--rule)]  bg-[var(--paper)] ">
                    <div>
                      <div className="font-medium text-[var(--ink)] ">Text Repair Overlay (Stage 2.75, optional)</div>
                      <div className="text-[length:var(--type-12)] text-[var(--ink-2)]">One batched call for suspicious non-key lines. Conservative fences preserve digits, Latin islands and printed numbers; original extracted lines remain untouched. Off by default.</div>
                    </div>
                    <input
                      type="checkbox"
                      checked={current.textRepairEnabled === true}
                      onChange={e => setCurrent(prev => ({ ...prev, textRepairEnabled: e.target.checked }))}
                      className="w-4 h-4 rounded-[6px] text-[var(--accent-ink)]"
                    />
                  </div>

                  <div className="flex items-center justify-between p-3.5 rounded-[10px] border border-[var(--rule)]  bg-[var(--paper)] ">
                    <div>
                      <div className="font-medium text-[var(--ink)] ">LaTeX Math Normalization</div>
                      <div className="text-[length:var(--type-12)] text-[var(--ink-2)]">When off, keeps mathematical formulas as raw text (saves tokens)</div>
                    </div>
                    <input
                      type="checkbox"
                      checked={current.thrift.latexNormalization}
                      onChange={e =>
                        setCurrent(prev => ({
                          ...prev,
                          thrift: { ...prev.thrift, latexNormalization: e.target.checked },
                        }))
                      }
                      className="w-4 h-4 rounded-[6px] text-[var(--accent-ink)]"
                    />
                  </div>

                  <div className="p-3.5 rounded-[10px] border border-[var(--rule)]  bg-[var(--paper)]  space-y-3">
                    <div className="font-medium text-[var(--ink)] ">Image Downscaling for Vision Calls</div>
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="block text-[length:var(--type-12)] text-[var(--ink-2)] mb-1">Max Long Edge (px)</label>
                        <input
                          type="number"
                          value={current.thrift.imageMaxLongEdge}
                          onChange={e =>
                            setCurrent(prev => ({
                              ...prev,
                              thrift: { ...prev.thrift, imageMaxLongEdge: parseInt(e.target.value, 10) || 1024 },
                            }))
                          }
                          className="w-full px-2.5 py-1.5 rounded-[6px] border border-[var(--rule)]  bg-[var(--paper-raised)]  text-xs font-mono"
                        />
                      </div>
                      <div>
                        <label className="block text-[length:var(--type-12)] text-[var(--ink-2)] mb-1">JPEG Quality (%)</label>
                        <input
                          type="number"
                          value={current.thrift.jpegQuality}
                          onChange={e =>
                            setCurrent(prev => ({
                              ...prev,
                              thrift: { ...prev.thrift, jpegQuality: parseInt(e.target.value, 10) || 80 },
                            }))
                          }
                          className="w-full px-2.5 py-1.5 rounded-[6px] border border-[var(--rule)]  bg-[var(--paper-raised)]  text-xs font-mono"
                        />
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* BUDGET TAB */}
            {activeTab === 'budget' && (
              <div className="space-y-6">
                <div>
                  <h3 className="font-semibold text-[var(--ink)]  text-sm">Budget & Stop-Loss Protection</h3>
                  <p className="text-xs text-[var(--ink-2)]">Prevent accidental runaway API spend</p>
                </div>

                <div className="space-y-4 text-xs">
                  <div className="p-4 rounded-[10px] border border-[var(--rule)]  bg-[var(--paper)]  space-y-2">
                    <label className="block font-medium text-[var(--ink)] ">
                      Hard Budget Cap per Document Run ($ USD)
                    </label>
                    <p className="text-[length:var(--type-12)] text-[var(--ink-2)]">
                      If pre-flight estimated cost exceeds this cap, analysis will be hard-stopped before making any API call.
                    </p>
                    <input
                      type="number"
                      step="0.01"
                      value={current.budget.maxUsdPerRun}
                      onChange={e =>
                        setCurrent(prev => ({
                          ...prev,
                          budget: { ...prev.budget, maxUsdPerRun: parseFloat(e.target.value) || 0.25 },
                        }))
                      }
                      className="w-48 px-3 py-1.5 rounded-[6px] border border-[var(--rule)]  bg-[var(--paper-raised)]  font-mono text-sm"
                    />
                  </div>

                  <div className="p-4 rounded-[10px] border border-[var(--rule)]  bg-[var(--paper)]  space-y-2">
                    <label className="block font-medium text-[var(--ink)] ">
                      Max Output Tokens Limit
                    </label>
                    <p className="text-xs text-[var(--ink-2)]">Ceiling only — you pay for tokens generated. Large or question-dense exams may need 16384–32768.</p>
                    <input
                      type="number"
                      step="1024"
                      value={current.budget.maxOutputTokens}
                      onChange={e =>
                        setCurrent(prev => ({
                          ...prev,
                          budget: { ...prev.budget, maxOutputTokens: parseInt(e.target.value, 10) || 8192 },
                        }))
                      }
                      className="w-48 px-3 py-1.5 rounded-[6px] border border-[var(--rule)]  bg-[var(--paper-raised)]  font-mono text-sm"
                    />
                  </div>
                </div>
              </div>
            )}

            {/* DOCUMENT TAB */}
            {activeTab === 'document' && (
              <div className="space-y-6">
                <div>
                  <h3 className="font-semibold text-[var(--ink)]  text-sm">Document & Print Settings</h3>
                  <p className="text-xs text-[var(--ink-2)]">Configure page size, language direction, and typography</p>
                </div>

                <div className="grid grid-cols-2 gap-4 text-xs">
                  <div className="p-3.5 rounded-[10px] border border-[var(--rule)]  bg-[var(--paper)] ">
                    <label className="block font-medium text-[var(--ink)]  mb-1">Paper Size</label>
                    <select
                      value={current.document.paperSize}
                      onChange={e =>
                        setCurrent(prev => ({
                          ...prev,
                          document: { ...prev.document, paperSize: e.target.value as any },
                        }))
                      }
                      className="w-full px-2.5 py-1.5 rounded-[6px] border border-[var(--rule)]  bg-[var(--paper-raised)]  text-xs"
                    >
                      <option value="A4">A4 (Standard 210 × 297 mm)</option>
                      <option value="Letter">US Letter (8.5 × 11 in)</option>
                    </select>
                  </div>

                  <div className="p-3.5 rounded-[10px] border border-[var(--rule)]  bg-[var(--paper)] ">
                    <label className="block font-medium text-[var(--ink)]  mb-1">Language Direction</label>
                    <select
                      value={current.document.defaultLanguage}
                      onChange={e =>
                        setCurrent(prev => ({
                          ...prev,
                          document: { ...prev.document, defaultLanguage: e.target.value as any },
                        }))
                      }
                      className="w-full px-2.5 py-1.5 rounded-[6px] border border-[var(--rule)]  bg-[var(--paper-raised)]  text-xs"
                    >
                      <option value="auto">Auto-detect from codepoints</option>
                      <option value="ltr">LTR (English, Latin)</option>
                      <option value="rtl">RTL (Persian, Arabic)</option>
                    </select>
                  </div>
                </div>
              </div>
            )}

            {/* ASSISTANT MEMORY TAB (B4/B5/C5) */}
            {activeTab === 'assistant' && (
              <div className="space-y-4">
                <div>
                  <h3 className="font-semibold text-[var(--ink)]  text-sm">Assistant → Memory</h3>
                  <p className="text-xs text-[var(--ink-2)]">Playbook (what the app learned), Skills (how it does things), Activity (raw evidence). All files live in your data folder under <span className="font-mono">memory/</span> as plain JSON/Markdown.</p>
                </div>
                <MemoryPanel fa={current.uiLanguage === 'fa'} />
              </div>
            )}

            {/* DIAGNOSTICS TAB (E2) */}
            {activeTab === 'diagnostics' && (
              <div className="space-y-4">
                <div>
                  <h3 className="font-semibold text-[var(--ink)]  text-sm">Diagnostics (last 50 runs)</h3>
                  <p className="text-xs text-[var(--ink-2)]">Local-only observability — no keys or source text. Use <b>Export Diagnostics</b> to share with support.</p>
                </div>
                <DiagnosticsPanel />
              </div>
            )}
            {/* PRIVACY & DATA TAB */}
            {activeTab === 'privacy' && (
              <div className="space-y-6"><StoragePanel />
                <BackupPanel />
                <label className="block text-xs">Assistant monthly soft cap (USD)
                  <input type="number" min="0" step="0.1" placeholder="No soft cap" className="border rounded-[6px] p-2 ms-2" value={current.assistantMonthlySoftCapUsd ?? ''} onChange={e => setCurrent(s => ({ ...s, assistantMonthlySoftCapUsd: e.target.value === '' ? undefined : Number(e.target.value) }))} />
                </label>
                <section className="p-4 rounded-[10px] border border-[var(--rule)] bg-[var(--paper-raised)] space-y-2">
                  <h3 className="font-semibold text-[var(--ink)] text-sm">{t('Appearance', 'نمایش')}</h3>
                  <label className="block text-[length:var(--type-12)]">{t('Color theme', 'پوسته رنگی')}
                    <select className="ep-select mt-1 max-w-sm" value={current.themeMode || 'system'} onChange={event => setCurrent(previous => ({ ...previous, themeMode: event.target.value as NonNullable<AppSettings['themeMode']> }))}>
                      <option value="system">{t('System preference', 'هماهنگ با دستگاه')}</option>
                      <option value="light">{t('Light', 'روشن')}</option>
                      <option value="dark">{t('Dark', 'تیره')}</option>
                    </select>
                  </label>
                  <p className="ep-caption m-0">{t('System mode follows your operating-system appearance setting.', 'حالت دستگاه از تنظیمات روشنایی سیستم‌عامل پیروی می‌کند.')}</p>
                </section>
                <button className="border rounded-[6px] p-2 text-xs" onClick={() => { const reset = { ...current, themeTokens: {}, themeMode: 'system' as const }; setCurrent(reset); onSaveSettings(reset); applyTheme(reset); }}>{t('Reset theme', 'بازنشانی پوسته')}</button>
                <div>
                  <h3 className="font-semibold text-[var(--ink)]  text-sm">Local-First Storage & Privacy</h3>
                  <p className="text-xs text-[var(--ink-2)]">Data ownership, caching, and export</p>
                </div>

                <div className="p-4 rounded-[10px] border border-[var(--ok)] bg-[var(--ok-soft)] text-[var(--ok)]  text-xs space-y-1">
                  <div className="font-semibold flex items-center gap-1.5">
                    <Shield className="w-4 h-4" /> Local-First Guarantee
                  </div>
                  <p className="leading-relaxed text-[length:var(--type-12)]">
                    Files are extracted locally and saved in your chosen server-side local folder. They are never uploaded anywhere except as parts of explicit LLM requests to your chosen provider. No telemetry, no third-party tracking.
                  </p>
                </div>

                <div className="p-4 rounded-[10px] border border-[var(--rule)]  bg-[var(--paper)]  space-y-3 text-xs">
                  <div className="font-medium text-[var(--ink)] ">Cache & Data Actions</div>
                  <div className="flex flex-wrap gap-2">
                    <button
                      onClick={handleClearCache}
                      className="px-3 py-1.5 rounded-[6px] border border-[var(--danger)]  text-[var(--danger)]  hover:bg-[var(--danger-soft)]  transition text-xs font-medium"
                    >
                      {clearSuccess ? 'Cache Cleared!' : 'Clear All Caches & Stored Docs'}
                    </button>
                    <button
                      onClick={handleExportSettings}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-[6px] border border-[var(--rule-strong)]  hover:bg-[var(--paper)]  transition text-xs font-medium"
                    >
                      <Download className="w-3.5 h-3.5" /> Export Settings
                    </button>
                    <label className="flex items-center gap-1.5 px-3 py-1.5 rounded-[6px] border border-[var(--rule-strong)]  hover:bg-[var(--paper)]  transition text-xs font-medium cursor-pointer">
                      <Upload className="w-3.5 h-3.5" /> Import Settings
                      <input type="file" accept=".json" onChange={handleImportSettings} className="hidden" />
                    </label>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="p-4 bg-[var(--paper)]  border-t border-[var(--rule)]  flex justify-end gap-2">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-[6px] text-xs font-medium text-[var(--ink-2)]  hover:bg-[var(--paper)]  transition"
          >
            Cancel
          </button>
          <button
            onClick={handleSaveAndClose}
            className="px-5 py-2 rounded-[6px] text-xs font-medium bg-[var(--accent)] hover:bg-[var(--accent)] text-[var(--on-accent)] transition "
          >
            Save Settings
          </button>
        </div>
      </div>
    </Modal>
  );
};
