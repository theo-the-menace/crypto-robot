import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';
import './market-terminal.css';
import './chat-ui.css';

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
