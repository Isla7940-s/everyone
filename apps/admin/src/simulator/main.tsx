import React from 'react';
import ReactDOM from 'react-dom/client';
import { SimulatorApp } from './SimulatorApp';
import '../styles/tokens.css';
import '../styles/base.css';
import '../styles/ui.css';
import '../styles/app.css';
import '../styles/chat.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <SimulatorApp />
  </React.StrictMode>,
);
