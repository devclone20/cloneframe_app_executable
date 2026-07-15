/* Privy login island — the ONLY React in the app, isolated behind window.PrivyIsland.
   The vanilla HUB (index.html) lazy-loads the built bundle and talks to it through
   this tiny contract: init({appId, accent, onAuth, onLogout}) · open() · logout().
   Only the PUBLIC app id ever reaches this code — the Privy app secret is a server
   credential and must never appear here or anywhere in the repo. */
import React, { useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { PrivyProvider, usePrivy, useWallets } from '@privy-io/react-auth';
import { base, mainnet } from 'viem/chains';

const cb = { onAuth: null, onLogout: null };
const api = {};

function Bridge() {
  const { ready, authenticated, user, login, logout } = usePrivy();
  const { wallets } = useWallets();

  useEffect(() => {
    api.open = () => { if (!authenticated) login(); };
    api.logout = () => logout();
  }, [authenticated, login, logout]);

  useEffect(() => {
    if (!ready) return;
    if (authenticated && user) {
      (async () => {
        let address = null, provider = null, walletName = null;
        const w = wallets && wallets[0];
        if (w) {
          address = w.address;
          walletName = w.walletClientType || w.connectorType || 'wallet';
          try { provider = await w.getEthereumProvider(); } catch (_) {}
        } else {
          const la = (user.linkedAccounts || []).find(a => a.type === 'wallet');
          if (la) address = la.address;
        }
        cb.onAuth && cb.onAuth({ user, address, provider, walletName });
      })();
    } else if (!authenticated) {
      cb.onLogout && cb.onLogout();
    }
  }, [ready, authenticated, user, wallets]);

  return null;
}

window.PrivyIsland = {
  _mounted: false,
  init(cfg) {
    if (this._mounted) return;
    this._mounted = true;
    cb.onAuth = cfg.onAuth; cb.onLogout = cfg.onLogout;
    const el = document.createElement('div');
    el.id = 'privy-island';
    document.body.appendChild(el);
    createRoot(el).render(
      <PrivyProvider
        appId={cfg.appId}
        config={{
          appearance: { theme: 'dark', accentColor: cfg.accent || '#FF4D2E' },
          // Auto-provision an extension-free Privy embedded wallet so the isolated
          // Chrome-for-Testing profile (bundled runtime, no MetaMask) can still sign
          // (the Robinhood launcher). v3 nested shape — the old flat `createOnLogin` is
          // ignored in @privy-io/react-auth 3.x. WalletAuth.provider() already prefers
          // the Privy provider, so index.html needs no change.
          embeddedWallets: { ethereum: { createOnLogin: 'users-without-wallets' } },
          defaultChain: base,
          supportedChains: [base, mainnet],
        }}
      >
        <Bridge />
      </PrivyProvider>
    );
  },
  open() { api.open ? api.open() : setTimeout(() => api.open && api.open(), 500); },
  logout() { api.logout && api.logout(); },
};
