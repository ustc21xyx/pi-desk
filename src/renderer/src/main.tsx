import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './styles.css'
import type { DeskAPI } from '../../shared/contracts'
declare global { interface Window { desk: DeskAPI } }
createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>)
