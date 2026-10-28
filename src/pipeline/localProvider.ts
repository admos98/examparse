import type { AppSettings, ProviderConfig } from '../types';
export function isLocalEndpoint(baseURL?: string): boolean {
  try {
    const host = new URL(baseURL || '').hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (['localhost', '127.0.0.1', '::1', 'host.docker.internal'].includes(host) || host.endsWith('.local')) return true;
    if (/^10\./.test(host) || /^192\.168\./.test(host)) return true;
    const parts = host.split('.').map(Number);
    return parts.length === 4 && parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31;
  } catch { return false; }
}
export function localProviderFor(settings: AppSettings, role: 'read' | 'vision' | 'decide'): (ProviderConfig & { model: string }) | undefined {
  const selection = settings.roleMapping[role] || (role === 'read' ? settings.roleMapping.fast : undefined);
  if (!selection?.model) return undefined;
  const provider = settings.providers.find(p => p.id === selection.providerId);
  if (!provider || provider.kind !== 'openai-compatible' || !isLocalEndpoint(provider.baseURL)) return undefined;
  return { ...provider, model: selection.model };
}
