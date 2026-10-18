import React from 'react';
import { PARSER_VERSION } from '../pipeline/prompts';

interface State { hasError: boolean; message: string; errorName: string; copied: boolean }

function safeMessage(value: unknown): string {
  return String(value || 'Unexpected application error')
    .replace(/\b(api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|bearer|secret|credential|password)\s*(?:[:=]|is)\s*[^\s,;]+/gi, '$1=[redacted]')
    .replace(/\b(?:sk|rk|pk)-[A-Za-z0-9_-]{16,}\b/gi, '[REDACTED]')
    .replace(/AIza[0-9A-Za-z_-]{20,}/g, '[REDACTED]')
    .replace(/([?&](?:key|api[_-]?key|token)=)[^&\s]+/gi, '$1[REDACTED]')
    .replace(/https?:\/\/[^\s'"<>]+/gi, '[endpoint]')
    .replace(/[\r\n\t]+/g, ' ')
    .slice(0, 240);
}

export class AppErrorBoundary extends React.Component<React.PropsWithChildren, State> {
  state: State = { hasError: false, message: '', errorName: '', copied: false };

  static getDerivedStateFromError(error: unknown): Partial<State> {
    const err = error instanceof Error ? error : new Error(String(error));
    return { hasError: true, message: safeMessage(err.message), errorName: err.name.slice(0, 60) };
  }

  componentDidCatch(_error: Error, _info: React.ErrorInfo): void {
    // Deliberately do not log stack traces, props, source content, settings, or provider credentials.
    console.error('[ExamParse] UI error boundary caught a render failure. Diagnostic details are locally available.');
  }

  copyDiagnostics = async () => {
    const report = [
      'ExamParse UI diagnostic',
      `Parser: ${PARSER_VERSION}`,
      `Time: ${new Date().toISOString()}`,
      `Error: ${this.state.errorName}: ${this.state.message}`,
      'Source text, exam contents, API keys, and provider settings are not included.',
    ].join('\n');
    try { await navigator.clipboard.writeText(report); this.setState({ copied: true }); }
    catch { this.setState({ copied: false }); }
  };

  render() {
    if (!this.state.hasError) return this.props.children;
    return <main role="alert" className="mx-auto my-12 max-w-2xl rounded-2xl border border-red-300 bg-red-50 p-6 text-red-950 dark:border-red-900 dark:bg-red-950/30 dark:text-red-100">
      <h1 className="text-lg font-bold">ExamParse stopped safely</h1>
      <p className="mt-2 text-sm">The current screen failed to render. Saved exams remain in local storage; reload the app to continue.</p>
      <pre className="mt-3 whitespace-pre-wrap rounded bg-white/70 p-3 font-mono text-xs dark:bg-black/20">{this.state.errorName}: {this.state.message}</pre>
      <div className="mt-4 flex gap-2"><button onClick={this.copyDiagnostics} className="rounded-lg bg-red-800 px-3 py-2 text-xs font-semibold text-white">{this.state.copied ? 'Diagnostics copied' : 'Copy safe diagnostics'}</button><button onClick={() => window.location.reload()} className="rounded-lg border border-red-500 px-3 py-2 text-xs font-semibold">Reload</button></div>
    </main>;
  }
}
