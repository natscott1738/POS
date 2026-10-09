import { useEffect } from 'react';
import { NavLink, Navigate, Route, Routes } from 'react-router-dom';
import type { Permission } from '@pos/shared';
import { useAuth, useNetwork } from './lib/store.js';
import { startSync, stopSync, runSync } from './lib/sync.js';
import { pendingCount } from './lib/db.js';
import { Toasts } from './components/Toasts.js';
import { UpdatePrompt } from './components/UpdatePrompt.js';
import Login from './screens/Login.js';
import Checkout from './screens/Checkout.js';
import Dashboard from './screens/Dashboard.js';
import Sales from './screens/Sales.js';
import Products from './screens/Products.js';
import Inventory from './screens/Inventory.js';
import Customers from './screens/Customers.js';
import Reports from './screens/Reports.js';
import QuickBooks from './screens/QuickBooks.js';
import Admin from './screens/Admin.js';
import Settings from './screens/Settings.js';

export default function App() {
  const { user, ready, restore, signOut, can } = useAuth();

  useEffect(() => {
    void restore();
  }, [restore]);

  useEffect(() => {
    if (!user) {
      stopSync();
      return;
    }
    startSync();
    void pendingCount().then((n) => useNetwork.getState().setPending(n));
    return () => stopSync();
  }, [user]);

  if (!ready) {
    return (
      <div className="login-shell">
        <p className="muted">Starting…</p>
      </div>
    );
  }

  if (!user) {
    return (
      <>
        <Login />
        <Toasts />
      </>
    );
  }

  return (
    <div className="app">
      <Sidebar email={user.email} role={user.role} can={can} onSignOut={() => void signOut()} />

      <main className="main">
        <header className="topbar">
          <ConnectionBadge />
          <div className="spacer" />
          <span className="muted" style={{ fontSize: 13 }}>{user.role}</span>
        </header>
        <div className="content">
          <Routes>
            <Route path="/" element={<Checkout />} />
            <Route path="/today" element={can('report:sales') ? <Dashboard /> : <Navigate to="/" replace />} />
            <Route path="/sales" element={can('sale:read') ? <Sales /> : <Navigate to="/" replace />} />
            <Route path="/products" element={can('product:read') ? <Products /> : <Navigate to="/" replace />} />
            <Route path="/inventory" element={can('inventory:read') ? <Inventory /> : <Navigate to="/" replace />} />
            <Route path="/customers" element={can('customer:read') ? <Customers /> : <Navigate to="/" replace />} />
            <Route path="/reports" element={can('report:sales') ? <Reports /> : <Navigate to="/" replace />} />
            <Route path="/quickbooks" element={can('quickbooks:sync') ? <QuickBooks /> : <Navigate to="/" replace />} />
            <Route
              path="/admin"
              element={can('user:read') || can('store:read') || can('audit:read') ? <Admin /> : <Navigate to="/" replace />}
            />
            <Route path="/settings" element={<Settings />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </div>
      </main>

      <Toasts />
      <UpdatePrompt />
    </div>
  );
}

/**
 * Navigation, scaled to the person using it.
 *
 * A cashier gets one destination — the till — because that is the entire job and
 * ten links is ten chances to get lost mid-queue. Managers get the day's figures
 * and the things they actually act on; everything administrative is collapsed
 * behind one heading so it is available without being in the way.
 */
function Sidebar({
  email,
  role,
  can,
  onSignOut,
}: {
  email: string;
  role: string;
  can: (permission: Permission) => boolean;
  onSignOut: () => void;
}) {
  const manage = [
    can('product:read') && { to: '/products', label: 'Products' },
    can('inventory:read') && { to: '/inventory', label: 'Stock' },
    can('customer:read') && { to: '/customers', label: 'Customers' },
    can('report:sales') && { to: '/reports', label: 'Reports' },
  ].filter(Boolean) as Array<{ to: string; label: string }>;

  const setup = [
    (can('user:read') || can('store:read') || can('audit:read')) && { to: '/admin', label: 'Administration' },
    can('quickbooks:sync') && { to: '/quickbooks', label: 'QuickBooks' },
    { to: '/settings', label: 'This till' },
  ].filter(Boolean) as Array<{ to: string; label: string }>;

  return (
    <aside className="sidebar">
      <div className="brand">
        <span className="brand-mark">◉</span>
        <span className="brand-text">Point of Sale</span>
      </div>

      <nav className="nav">
        <NavLink to="/" end className="nav-primary">
          <span className="nav-icon">▦</span>
          <span>Till</span>
        </NavLink>

        {can('report:sales') && (
          <NavLink to="/today">
            <span className="nav-icon">◷</span>
            <span>Today</span>
          </NavLink>
        )}
        {can('sale:read') && (
          <NavLink to="/sales">
            <span className="nav-icon">≡</span>
            <span>Receipts</span>
          </NavLink>
        )}

        {manage.length > 0 && (
          <>
            <div className="nav-heading">Manage</div>
            {manage.map((item) => (
              <NavLink key={item.to} to={item.to}>
                <span className="nav-icon">·</span>
                <span>{item.label}</span>
              </NavLink>
            ))}
          </>
        )}

        <div className="nav-heading">Setup</div>
        {setup.map((item) => (
          <NavLink key={item.to} to={item.to}>
            <span className="nav-icon">·</span>
            <span>{item.label}</span>
          </NavLink>
        ))}
      </nav>

      <div className="sidebar-footer">
        <div className="sidebar-user" title={email}>{email}</div>
        <div className="sidebar-role">{role.toLowerCase()}</div>
        <button className="btn ghost block" onClick={onSignOut}>Sign out</button>
      </div>
    </aside>
  );
}

function ConnectionBadge() {
  const { serverReachable, pending, syncing } = useNetwork();

  if (!serverReachable) {
    return (
      <span className="pill offline" title="Working offline; sales are queued">
        <span className="dot" />
        Offline{pending > 0 ? ` · ${pending} queued` : ''}
      </span>
    );
  }
  if (syncing) {
    return <span className="pill"><span className="dot" />Syncing…</span>;
  }
  return (
    <span className="pill online" onClick={() => void runSync()} style={{ cursor: 'pointer' }}>
      <span className="dot" />
      Online{pending > 0 ? ` · ${pending} queued` : ''}
    </span>
  );
}
