import type { AppSettings, ProviderConfig } from '../types';

/** Treat loopback, private/LAN IPs, .local hosts and explicitly named local/Ollama providers as local. */
export function isLocalReadProvider(provider?: ProviderConfig): boolean {
  if (!provider) return false;
  const name = `${provider.name || ''} ${provider.id || ''}`;
  if (/ollama|local endpoint|local model/i.test(name)) return true;
  let hostname = '';
  try { hostname = new URL(provider.baseURL).hostname.toLowerCase().replace(/^\[|\]$/g, ''); }
  catch { return false; }
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local') || hostname.endsWith('.lan') || hostname === 'host.docker.internal' || hostname === 'ollama' || hostname === '::1' || /^(?:fc|fd|fe80:)/i.test(hostname)) return true;
  const octets = hostname.split('.').map(Number);
  if (octets.length === 4 && octets.every(n => Number.isInteger(n) && n >= 0 && n <= 255)) {
    return (octets[0] === 0 && octets[1] === 0 && octets[2] === 0 && octets[3] === 0) || octets[0] === 10 || octets[0] === 127 ||
      (octets[0] === 192 && octets[1] === 168) ||
      (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
      (octets[0] === 169 && octets[1] === 254);
  }
  return false;
}

export function effectiveReadFormat(settings: Pick<AppSettings, 'readFormat' | 'roleMapping' | 'providers'>): 'compact' | 'verbose' {
  const selected = settings.roleMapping.read || settings.roleMapping.fast;
  const provider = settings.providers.find(item => item.id === selected.providerId);
  if (settings.readFormat === 'verbose' || settings.readFormat === 'compact') return settings.readFormat;
  return isLocalReadProvider(provider) ? 'verbose' : 'compact';
}

export function readFormatDescription(settings: Pick<AppSettings, 'readFormat' | 'roleMapping' | 'providers'>): string {
  const resolved = effectiveReadFormat(settings);
  if (settings.readFormat && settings.readFormat !== 'auto') return `${resolved === 'verbose' ? 'Verbose' : 'Compact'} (selected)`;
  return `Auto → ${resolved === 'verbose' ? 'Verbose (local endpoint)' : 'Compact (cloud endpoint)'}`;
}
