import React from 'react';
import { Routes, Route } from 'react-router-dom';
import Dashboard from './Dashboard';
import Admin from './Admin';

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Dashboard />} />
      <Route path="/admin" element={<Admin />} />
      <Route path="/admin.html" element={<Admin />} />
      <Route path="*" element={<Dashboard />} />
    </Routes>
  );
}
