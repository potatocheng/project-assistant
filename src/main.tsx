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

ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><UiProvider><App /></UiProvider></React.StrictMode>);
