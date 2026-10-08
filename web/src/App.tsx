import { NavLink, Route, Routes } from 'react-router-dom';
import Dashboard from './pages/Dashboard';
import Settings from './pages/Settings';
import Bedside from './pages/Bedside';
import Connect from './pages/Connect';

export default function App() {
  return (
    <div className="app">
      <nav className="nav">
        <span className="brand">🌙 SmartWake</span>
        <NavLink to="/">Dashboard</NavLink>
        <NavLink to="/bedside">Bedside</NavLink>
        <NavLink to="/settings">Settings</NavLink>
        <NavLink to="/connect">Device</NavLink>
      </nav>
      <main className="main">
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/bedside" element={<Bedside />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/connect" element={<Connect />} />
        </Routes>
      </main>
    </div>
  );
}
