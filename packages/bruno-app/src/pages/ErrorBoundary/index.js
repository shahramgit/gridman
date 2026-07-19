import React from 'react';

import Bruno from 'components/Bruno/index';

class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);

    this.state = { hasError: false };
  }

  componentDidMount() {
    // Add a global error event listener to capture client-side errors
    window.onerror = (message, source, lineno, colno, error) => {
      this.logRendererError({
        type: 'window.onerror',
        message,
        source,
        lineno,
        colno,
        stack: error?.stack
      });
      this.setState({ hasError: true, error });
    };
  }

  logRendererError(payload) {
    const { ipcRenderer } = window;

    if (!ipcRenderer?.invoke) {
      return;
    }

    ipcRenderer
      .invoke('renderer:log-renderer-error', payload)
      .then((result) => {
        if (result?.logFile) {
          this.setState({ logFile: result.logFile });
        }
      })
      .catch(() => {});
  }

  componentDidCatch(error, errorInfo) {
    console.log({ error, errorInfo });
    this.logRendererError({
      type: 'componentDidCatch',
      message: error?.message,
      stack: error?.stack,
      componentStack: errorInfo?.componentStack
    });
    this.setState({ hasError: true, error, errorInfo });
  }

  returnToApp() {
    const { ipcRenderer } = window;
    ipcRenderer.invoke('open-file');

    this.setState({ hasError: false, error: null, errorInfo: null });
  }

  forceQuit() {
    const { ipcRenderer } = window;
    ipcRenderer.invoke('main:force-quit');
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex text-center justify-center p-20 h-full">
          <div className="bg-white rounded-lg p-10 w-full">
            <div className="m-auto" style={{ width: '256px' }}>
              <Bruno width={256} variant="3d" />
            </div>

            <h1 className="text-2xl font-medium text-red-600 mb-2">Oops! Something went wrong</h1>
            <p className="text-red-500 mb-2">
              If you are using an official production build: the above error is most likely a bug!
              <br />
              Please report this to your Gridman maintainers.
            </p>

            {this.state.error?.message ? (
              <div className="text-left m-auto mt-4" style={{ maxWidth: '720px' }}>
                <div className="text-red-600 font-medium break-words">{String(this.state.error.message)}</div>
                {(this.state.error?.stack || this.state.errorInfo?.componentStack) ? (
                  <details className="mt-2">
                    <summary className="cursor-pointer text-sm text-gray-500">Technical details (include these in your report)</summary>
                    <pre
                      className="text-xs text-gray-600 mt-2 p-3 rounded overflow-auto"
                      style={{ maxHeight: '220px', background: '#f5f5f5', whiteSpace: 'pre-wrap', userSelect: 'text' }}
                    >
                      {String(this.state.error?.stack || '')}
                      {this.state.errorInfo?.componentStack ? `\n\nComponent stack:${this.state.errorInfo.componentStack}` : ''}
                    </pre>
                  </details>
                ) : null}
                {this.state.logFile ? (
                  <div className="text-xs text-gray-500 mt-2 break-all">
                    Saved to: {this.state.logFile}
                  </div>
                ) : null}
              </div>
            ) : null}

            <button
              className="bg-red-500 text-white px-4 py-2 mt-4 rounded hover:bg-red-600 transition"
              onClick={() => this.returnToApp()}
            >
              Return to App
            </button>

            <div className="text-red-500 mt-3">
              <a href="" className="hover:underline cursor-pointer" onClick={this.forceQuit}>
                Force Quit
              </a>
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

export default ErrorBoundary;
