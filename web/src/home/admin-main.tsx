// Phone admin for both interfaces (tabs: home, kids, pictures, account). Opened from the phone at http://<TV-IP>:8080/ (AdminServer on the TV).
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import Admin from './Admin';
import './index.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Admin />
  </StrictMode>,
);
