import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { UiProvider } from './design/UiProvider';
import './design/astryx.css';
import './design/tokens.css';
import './styles.css';
import './design/components.css';
import './interactions.css';
import './design/shell.css';

interface ErrorBoundaryState {
  error: Error | null;
}

class AppErrorBoundary extends React.Component<{ children: React.ReactNode }, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('[AppErrorBoundary]', error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div
        role="alert"
        style={{
          minHeight: '100vh',
          display: 'grid',
          placeItems: 'center',
          padding: 24,
          background: 'var(--bg-canvas, #f8f9fb)',
          color: 'var(--text, #0f1115)',
          fontFamily: 'system-ui, -apple-system, sans-serif',
        }}
      >
        <div
          style={{
            maxWidth: 460,
            width: '100%',
            padding: 24,
            borderRadius: 12,
            border: '1px solid var(--border, #e2e5ec)',
            background: 'var(--bg-surface, #ffffff)',
          }}
        >
          <h2 style={{ margin: '0 0 8px', fontSize: 18 }}>界面发生意外错误</h2>
          <p style={{ margin: '0 0 12px', fontSize: 14, color: 'var(--text-muted, #5b6474)' }}>
            本机工作区数据未受影响，请重新加载界面。
          </p>
          <pre
            style={{
              margin: '0 0 16px',
              padding: 10,
              borderRadius: 8,
              background: 'var(--bg-subtle, #f3f4f7)',
              fontSize: 12,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
            }}
          >
            {this.state.error.message || '未知渲染错误'}
          </pre>
          <button
            type="button"
            onClick={() => window.location.reload()}
            style={{
              padding: '8px 16px',
              borderRadius: 8,
              border: 'none',
              background: 'var(--accent, #4f46e5)',
              color: '#ffffff',
              fontSize: 14,
              cursor: 'pointer',
            }}
          >
            重新加载界面
          </button>
        </div>
      </div>
    );
  }
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <AppErrorBoundary>
      <UiProvider>
        <App />
      </UiProvider>
    </AppErrorBoundary>
  </React.StrictMode>,
);
