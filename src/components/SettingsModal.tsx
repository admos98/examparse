import React, { useState } from 'react';
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
import { LLMAdapter } from '../providers/adapter';
import { clearAllCachesAndData } from '../store';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  settings: AppSettings;
  onSaveSettings: (settings: AppSettings) => void;
  onOpenExplainer: () => void;
}

type TabType = 'providers' | 'roles' | 'costs' | 'thrift' | 'budget' | 'document' | 'privacy';

export const SettingsModal: React.FC<Props> = ({
  isOpen,
  onClose,
  settings,
  onSaveSettings,
  onOpenExplainer,
}) => {
  const [activeTab, setActiveTab] = useState<TabType>('providers');
  const [current, setCurrent] = useState<AppSettings>(settings);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, { ok: boolean; msg: string }>>({});
  const [availableModels, setAvailableModels] = useState<Record<string, string[]>>({});
  const [clearSuccess, setClearSuccess] = useState(false);

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

  const handleClearCache = async () => {
    await clearAllCachesAndData();
    setClearSuccess(true);
    setTimeout(() => setClearSuccess(false), 2500);
  };

  const handleExportSettings = () => {
    const jsonStr = JSON.stringify(current, null, 2);
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
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const imported = JSON.parse(reader.result as string);
        setCurrent(imported);
        onSaveSettings(imported);
      } catch (err) {
        alert('Invalid settings JSON file');
      }
    };
    reader.readAsText(file);
  };

  const handleSaveAndClose = () => {
    onSaveSettings(current);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs p-4">
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl max-w-4xl w-full h-[85vh] flex flex-col shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between p-5 border-b border-slate-200 dark:border-slate-800">
          <div>
            <h2 className="text-lg font-bold text-slate-900 dark:text-white">Settings & Provider Configuration</h2>
            <p className="text-xs text-slate-500">Configure AI endpoints, token budgets, role models, and privacy</p>
          </div>
          <button
            onClick={onClose}
            className="p-2 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content Layout */}
        <div className="flex flex-1 overflow-hidden">
          {/* Side Tabs */}
          <div className="w-48 bg-slate-50 dark:bg-slate-950/40 border-r border-slate-200 dark:border-slate-800 p-2 space-y-1">
            <button
              onClick={() => setActiveTab('providers')}
              className={`w-full flex items-center gap-2 px-3 py-2 rounded-xl text-xs font-medium text-left transition ${
                activeTab === 'providers'
                  ? 'bg-blue-600 text-white'
                  : 'text-slate-600 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-800'
              }`}
            >
              <Cpu className="w-3.5 h-3.5" /> Providers
            </button>
            <button
              onClick={() => setActiveTab('roles')}
              className={`w-full flex items-center gap-2 px-3 py-2 rounded-xl text-xs font-medium text-left transition ${
                activeTab === 'roles'
                  ? 'bg-blue-600 text-white'
                  : 'text-slate-600 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-800'
              }`}
            >
              <Cpu className="w-3.5 h-3.5" /> Role Mapping
            </button>
            <button
              onClick={() => setActiveTab('costs')}
              className={`w-full flex items-center gap-2 px-3 py-2 rounded-xl text-xs font-medium text-left transition ${
                activeTab === 'costs'
                  ? 'bg-blue-600 text-white'
                  : 'text-slate-600 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-800'
              }`}
            >
              <Coins className="w-3.5 h-3.5" /> Cost Table
            </button>
            <button
              onClick={() => setActiveTab('thrift')}
              className={`w-full flex items-center gap-2 px-3 py-2 rounded-xl text-xs font-medium text-left transition ${
                activeTab === 'thrift'
                  ? 'bg-blue-600 text-white'
                  : 'text-slate-600 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-800'
              }`}
            >
              <Shield className="w-3.5 h-3.5" /> Token Thrift
            </button>
            <button
              onClick={() => setActiveTab('budget')}
              className={`w-full flex items-center gap-2 px-3 py-2 rounded-xl text-xs font-medium text-left transition ${
                activeTab === 'budget'
                  ? 'bg-blue-600 text-white'
                  : 'text-slate-600 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-800'
              }`}
            >
              <Lock className="w-3.5 h-3.5" /> Budget Cap
            </button>
            <button
              onClick={() => setActiveTab('document')}
              className={`w-full flex items-center gap-2 px-3 py-2 rounded-xl text-xs font-medium text-left transition ${
                activeTab === 'document'
                  ? 'bg-blue-600 text-white'
                  : 'text-slate-600 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-800'
              }`}
            >
              <FileCheck className="w-3.5 h-3.5" /> Document & Print
            </button>
            <button
              onClick={() => setActiveTab('privacy')}
              className={`w-full flex items-center gap-2 px-3 py-2 rounded-xl text-xs font-medium text-left transition ${
                activeTab === 'privacy'
                  ? 'bg-blue-600 text-white'
                  : 'text-slate-600 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-800'
              }`}
            >
              <Database className="w-3.5 h-3.5" /> Privacy & Data
            </button>
          </div>

          {/* Tab Content Panel */}
          <div className="flex-1 p-6 overflow-y-auto">
            {/* PROVIDERS TAB */}
            {activeTab === 'providers' && (
              <div className="space-y-6">
                <div className="flex justify-between items-center">
                  <div>
                    <h3 className="font-semibold text-slate-900 dark:text-white text-sm">Configured AI Providers</h3>
                    <p className="text-xs text-slate-500">Google Gemini (native) or any OpenAI-compatible endpoint (9Router, LM Studio, etc.)</p>
                  </div>
                  <button
                    onClick={handleAddProvider}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-blue-600 text-white text-xs font-medium hover:bg-blue-700 transition"
                  >
                    <Plus className="w-3.5 h-3.5" /> Add Provider
                  </button>
                </div>

                <div className="space-y-4">
                  {current.providers.map(p => {
                    const test = testResults[p.id];
                    const models = availableModels[p.id];

                    return (
                      <div
                        key={p.id}
                        className="p-4 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-900/50 space-y-3"
                      >
                        <div className="flex justify-between items-center">
                          <input
                            type="text"
                            value={p.name}
                            onChange={e => handleUpdateProvider(p.id, { name: e.target.value })}
                            className="font-medium text-xs text-slate-900 dark:text-white bg-transparent border-b border-transparent hover:border-slate-300 focus:border-blue-500 outline-hidden"
                          />
                          <div className="flex items-center gap-2">
                            <span className="text-[10px] px-2 py-0.5 rounded bg-slate-200 dark:bg-slate-800 text-slate-600 dark:text-slate-400 font-mono">
                              {p.kind}
                            </span>
                            {p.id !== 'google-gemini' && (
                              <button
                                onClick={() => handleDeleteProvider(p.id)}
                                className="text-slate-400 hover:text-red-500 transition p-1"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            )}
                          </div>
                        </div>

                        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
                          <div>
                            <label className="block text-[11px] text-slate-500 mb-1">Base URL</label>
                            <input
                              type="text"
                              value={p.baseURL}
                              onChange={e => handleUpdateProvider(p.id, { baseURL: e.target.value })}
                              className="w-full px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-200 font-mono text-[11px]"
                            />
                          </div>
                          <div>
                            <label className="block text-[11px] text-slate-500 mb-1">
                              API Key {p.id === 'google-gemini' && '(Optional — defaults to server platform key)'}
                            </label>
                            <input
                              type="password"
                              value={p.apiKey}
                              placeholder={p.id === 'google-gemini' ? 'Leave empty to use platform default' : 'sk-...'}
                              onChange={e => handleUpdateProvider(p.id, { apiKey: e.target.value })}
                              className="w-full px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-200 font-mono text-[11px]"
                            />
                          </div>
                        </div>

                        <div className="space-y-3">
                          <div className="flex items-center justify-between">
                            <div>
                              <div className="font-medium text-[11px] text-slate-900 dark:text-white">Disable Reasoning / Thinking</div>
                              <div className="text-[11px] text-slate-500">Send reasoning-off fields on parse/transcribe calls (low for the solver). Turn off to send nothing extra.</div>
                            </div>
                            <input
                              type="checkbox"
                              checked={p.disableReasoning !== false}
                              onChange={e => handleUpdateProvider(p.id, { disableReasoning: e.target.checked })}
                              className="w-4 h-4 rounded text-blue-600"
                            />
                          </div>
                          <div className="flex items-center justify-between">
                            <div>
                              <div className="font-medium text-[11px] text-slate-900 dark:text-white">Structured JSON mode (response_format)</div>
                              <div className="text-[11px] text-slate-500">Turn off for models that reject JSON mode (e.g. some experimental/free models). Prompts still require JSON.</div>
                            </div>
                            <input type="checkbox" checked={p.structuredOutputs !== false} onChange={e => handleUpdateProvider(p.id, { structuredOutputs: e.target.checked })} className="w-4 h-4 rounded text-blue-600" />
                          </div>
                          <div>
                            <label className="block text-[11px] text-slate-500 mb-1">Extra body JSON</label>
                            <textarea
                              value={p.extraBodyJson || ''}
                              onChange={e => handleUpdateProvider(p.id, { extraBodyJson: e.target.value })}
                              placeholder='{"enable_thinking": false}'
                              rows={2}
                              className="w-full px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-200 font-mono text-[11px]"
                            />
                            <p className="text-[11px] text-slate-500 mt-1">
                              e.g. {'{"enable_thinking": false}'} or {'{"chat_template_kwargs": {"enable_thinking": false}}'} or {'{"thinking": {"type": "disabled"}}'} — provider-specific overrides.
                            </p>
                          </div>
                        </div>

                        {/* Test & Fetch Models */}
                        <div className="flex items-center justify-between pt-2 border-t border-slate-200/60 dark:border-slate-800/60 text-xs">
                          <div className="flex items-center gap-2">
                            <button
                              disabled={testingId === p.id}
                              onClick={() => handleTestConnection(p)}
                              className="px-2.5 py-1 rounded-lg border border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 text-[11px] font-medium"
                            >
                              {testingId === p.id ? 'Pinging...' : 'Test Connection'}
                            </button>
                            <button
                              onClick={() => handleFetchModels(p)}
                              className="px-2.5 py-1 rounded-lg border border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 text-[11px] font-medium"
                            >
                              Fetch Models
                            </button>
                          </div>

                          {test && (
                            <div className={`flex items-center gap-1 text-[11px] ${test.ok ? 'text-emerald-600' : 'text-red-500'}`}>
                              {test.ok ? <CheckCircle className="w-3.5 h-3.5" /> : <AlertCircle className="w-3.5 h-3.5" />}
                              <span>{test.msg}</span>
                            </div>
                          )}
                        </div>

                        {models && models.length > 0 && (
                          <div className="pt-2 text-[11px] text-slate-500">
                            Available models ({models.length}): <span className="font-mono text-slate-700 dark:text-slate-300">{models.slice(0, 6).join(', ')}{models.length > 6 ? '...' : ''}</span>
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
                  <h3 className="font-semibold text-slate-900 dark:text-white text-sm">Pipeline Role Mapping</h3>
                  <p className="text-xs text-slate-500">Assign specific models to fast structure parsing, vision, and escalation repairs</p>
                </div>

                <div className="space-y-4">
                  {(['fast', 'standard', 'escalation', 'vision'] as const).map(role => {
                    const sel = current.roleMapping[role];
                    const labelMap: Record<string, string> = {
                      fast: 'Fast (Structure Pass — Span references)',
                      standard: 'Standard (General questions)',
                      escalation: 'Escalation (Repair failing items & ambiguity)',
                      vision: 'Vision (Image manifest labeling & OCR)',
                    };

                    return (
                      <div key={role} className="p-3.5 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-900/50 space-y-2">
                        <div className="font-medium text-xs text-slate-900 dark:text-white">
                          {labelMap[role]}
                        </div>
                        <div className="grid grid-cols-2 gap-3 text-xs">
                          <div>
                            <label className="block text-[11px] text-slate-500 mb-1">Provider</label>
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
                              className="w-full px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-200"
                            >
                              {current.providers.map(p => (
                                <option key={p.id} value={p.id}>
                                  {p.name}
                                </option>
                              ))}
                            </select>
                          </div>
                          <div>
                            <label className="block text-[11px] text-slate-500 mb-1">Model Name</label>
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
                              className="w-full px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-950 font-mono text-[11px] text-slate-900 dark:text-slate-200"
                            />
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* COST TABLE TAB */}
            {activeTab === 'costs' && (
              <div className="space-y-6">
                <div>
                  <h3 className="font-semibold text-slate-900 dark:text-white text-sm">Model Cost Rates ($/1M tokens)</h3>
                  <p className="text-xs text-slate-500">Used by the live usage meter and pre-flight budget calculation</p>
                </div>

                <div className="space-y-3">
                  {Object.entries(current.costTable).map(([model, rates]) => (
                    <div
                      key={model}
                      className="grid grid-cols-3 gap-3 items-center p-3 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-900/50 text-xs"
                    >
                      <div className="font-mono font-medium text-slate-900 dark:text-slate-200 truncate">
                        {model}
                      </div>
                      <div>
                        <label className="block text-[10px] text-slate-500">Input ($/1M tokens)</label>
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
                          className="w-full px-2 py-1 rounded border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-950 font-mono text-xs"
                        />
                      </div>
                      <div>
                        <label className="block text-[10px] text-slate-500">Output ($/1M tokens)</label>
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
                          className="w-full px-2 py-1 rounded border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-950 font-mono text-xs"
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
                    <h3 className="font-semibold text-slate-900 dark:text-white text-sm">Token-Thrift Controls</h3>
                    <p className="text-xs text-slate-500">Fine-tune compression, cache, and token saving heuristics</p>
                  </div>
                  <button
                    onClick={onOpenExplainer}
                    className="text-xs text-blue-600 dark:text-blue-400 hover:underline flex items-center gap-1 font-medium"
                  >
                    Explain token savings
                  </button>
                </div>

                <div className="space-y-4 text-xs">
                  <div className="flex items-center justify-between p-3.5 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-900/50">
                    <div>
                      <div className="font-medium text-slate-900 dark:text-white">Content-Hash Cache</div>
                      <div className="text-[11px] text-slate-500">0 API calls on re-analyzing identical files</div>
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
                      className="w-4 h-4 rounded text-blue-600"
                    />
                  </div>

                  <div className="flex items-center justify-between p-3.5 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-900/50">
                    <div>
                      <div className="font-medium text-slate-900 dark:text-white">LaTeX Math Normalization</div>
                      <div className="text-[11px] text-slate-500">When off, keeps mathematical formulas as raw text (saves tokens)</div>
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
                      className="w-4 h-4 rounded text-blue-600"
                    />
                  </div>

                  <div className="p-3.5 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-900/50 space-y-3">
                    <div className="font-medium text-slate-900 dark:text-white">Image Downscaling for Vision Calls</div>
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="block text-[11px] text-slate-500 mb-1">Max Long Edge (px)</label>
                        <input
                          type="number"
                          value={current.thrift.imageMaxLongEdge}
                          onChange={e =>
                            setCurrent(prev => ({
                              ...prev,
                              thrift: { ...prev.thrift, imageMaxLongEdge: parseInt(e.target.value, 10) || 1024 },
                            }))
                          }
                          className="w-full px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-950 text-xs font-mono"
                        />
                      </div>
                      <div>
                        <label className="block text-[11px] text-slate-500 mb-1">JPEG Quality (%)</label>
                        <input
                          type="number"
                          value={current.thrift.jpegQuality}
                          onChange={e =>
                            setCurrent(prev => ({
                              ...prev,
                              thrift: { ...prev.thrift, jpegQuality: parseInt(e.target.value, 10) || 80 },
                            }))
                          }
                          className="w-full px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-950 text-xs font-mono"
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
                  <h3 className="font-semibold text-slate-900 dark:text-white text-sm">Budget & Stop-Loss Protection</h3>
                  <p className="text-xs text-slate-500">Prevent accidental runaway API spend</p>
                </div>

                <div className="space-y-4 text-xs">
                  <div className="p-4 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-900/50 space-y-2">
                    <label className="block font-medium text-slate-900 dark:text-white">
                      Hard Budget Cap per Document Run ($ USD)
                    </label>
                    <p className="text-[11px] text-slate-500">
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
                      className="w-48 px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-950 font-mono text-sm"
                    />
                  </div>

                  <div className="p-4 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-900/50 space-y-2">
                    <label className="block font-medium text-slate-900 dark:text-white">
                      Max Output Tokens Limit
                    </label>
                    <p className="text-xs text-slate-500">Ceiling only — you pay for tokens generated. Large or question-dense exams may need 16384–32768.</p>
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
                      className="w-48 px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-950 font-mono text-sm"
                    />
                  </div>
                </div>
              </div>
            )}

            {/* DOCUMENT TAB */}
            {activeTab === 'document' && (
              <div className="space-y-6">
                <div>
                  <h3 className="font-semibold text-slate-900 dark:text-white text-sm">Document & Print Settings</h3>
                  <p className="text-xs text-slate-500">Configure page size, language direction, and typography</p>
                </div>

                <div className="grid grid-cols-2 gap-4 text-xs">
                  <div className="p-3.5 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-900/50">
                    <label className="block font-medium text-slate-900 dark:text-white mb-1">Paper Size</label>
                    <select
                      value={current.document.paperSize}
                      onChange={e =>
                        setCurrent(prev => ({
                          ...prev,
                          document: { ...prev.document, paperSize: e.target.value as any },
                        }))
                      }
                      className="w-full px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-950 text-xs"
                    >
                      <option value="A4">A4 (Standard 210 × 297 mm)</option>
                      <option value="Letter">US Letter (8.5 × 11 in)</option>
                    </select>
                  </div>

                  <div className="p-3.5 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-900/50">
                    <label className="block font-medium text-slate-900 dark:text-white mb-1">Language Direction</label>
                    <select
                      value={current.document.defaultLanguage}
                      onChange={e =>
                        setCurrent(prev => ({
                          ...prev,
                          document: { ...prev.document, defaultLanguage: e.target.value as any },
                        }))
                      }
                      className="w-full px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-950 text-xs"
                    >
                      <option value="auto">Auto-detect from codepoints</option>
                      <option value="ltr">LTR (English, Latin)</option>
                      <option value="rtl">RTL (Persian, Arabic)</option>
                    </select>
                  </div>
                </div>
              </div>
            )}

            {/* PRIVACY & DATA TAB */}
            {activeTab === 'privacy' && (
              <div className="space-y-6">
                <div>
                  <h3 className="font-semibold text-slate-900 dark:text-white text-sm">Local-First Privacy & Data</h3>
                  <p className="text-xs text-slate-500">Data ownership, caching, and export</p>
                </div>

                <div className="p-4 rounded-xl border border-emerald-500/20 bg-emerald-500/5 text-emerald-800 dark:text-emerald-300 text-xs space-y-1">
                  <div className="font-semibold flex items-center gap-1.5">
                    <Shield className="w-4 h-4" /> Local-First Guarantee
                  </div>
                  <p className="leading-relaxed text-[11px]">
                    Files are parsed locally in the browser and stored in your device&apos;s IndexedDB. They are never uploaded anywhere except as parts of explicit LLM requests to your chosen provider. No telemetry, no third-party tracking.
                  </p>
                </div>

                <div className="p-4 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-900/50 space-y-3 text-xs">
                  <div className="font-medium text-slate-900 dark:text-white">Cache & Data Actions</div>
                  <div className="flex flex-wrap gap-2">
                    <button
                      onClick={handleClearCache}
                      className="px-3 py-1.5 rounded-lg border border-red-300 dark:border-red-900/50 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/30 transition text-xs font-medium"
                    >
                      {clearSuccess ? 'Cache Cleared!' : 'Clear All Caches & Stored Docs'}
                    </button>
                    <button
                      onClick={handleExportSettings}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 transition text-xs font-medium"
                    >
                      <Download className="w-3.5 h-3.5" /> Export Settings
                    </button>
                    <label className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 transition text-xs font-medium cursor-pointer">
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
        <div className="p-4 bg-slate-50 dark:bg-slate-950/60 border-t border-slate-200 dark:border-slate-800 flex justify-end gap-2">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-xl text-xs font-medium text-slate-600 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-800 transition"
          >
            Cancel
          </button>
          <button
            onClick={handleSaveAndClose}
            className="px-5 py-2 rounded-xl text-xs font-medium bg-blue-600 hover:bg-blue-700 text-white transition shadow-xs"
          >
            Save Settings
          </button>
        </div>
      </div>
    </div>
  );
};
