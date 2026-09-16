import { useEffect } from 'react';

import {
  connect,
  routeOf,
  useNet,
  useTransportHolder,
  useUi,
  watchTheme,
} from './store';
import { roomCodeFromLocation } from './ui/lib/roomCode';
import { useNarration } from './ui/hooks/useNarration';
import { Announcer } from './ui/components/Announcer';
import { ToastStack } from './ui/components/ToastStack';
import { ConnectionBanner } from './ui/components/ConnectionBanner';
import { HomeScreen } from './ui/screens/HomeScreen';
import { LobbyScreen } from './ui/screens/LobbyScreen';
import { GameScreen } from './ui/screens/GameScreen';
import { Sheets } from './ui/screens/SettingsSheet';

import './ui/ui.css';

/**
 * The application shell.
 *
 * Routing is derived, not stored: which screen you are on is a function of the
 * authoritative room state (`routeOf`). That is what makes a reconnect
 * mid-game land you back on the board rather than on the home screen -- the
 * transport restores the room during its handshake and the route follows,
 * with no navigation logic to get out of step with the server.
 */
export function App() {
  const transport = useTransportHolder((s) => s.transport);
  const route = useNet(routeOf);
  const setPrefilledCode = useUi((s) => s.setPrefilledCode);


  useNarration();

  // Mirror the theme preference, which `src/hooks/useTheme.ts` owns. Subscribed
  // once for the life of the app: it also fires when the OS flips while on
  // "match device", and when another tab changes it.
  useEffect(() => watchTheme(), []);

  // A tapped invite link arrives as ?room=CODE. Pick it up once, then clean the
  // URL so a later reload does not try to re-join a room that has since ended.
  useEffect(() => {
    const code = roomCodeFromLocation(window.location.search, window.location.hash);
    if (!code) return;
    setPrefilledCode(code);
    window.history.replaceState({}, '', window.location.pathname);
  }, [setPrefilledCode]);

  // Open the link as soon as a transport exists. The handshake may restore a
  // held seat, which is why we do not wait for the player to press anything.
  useEffect(() => {
    if (transport) void connect();
  }, [transport]);

  return (
    <div className="o-app">
      {/*
        Live regions first in the DOM and never unmounted: assistive technology
        watches existing regions for changes, so one that appears at the same
        moment it gets its text is frequently missed.
      */}
      <Announcer />

      <a className="o-skip" href="#main">
        Skip to the game
      </a>

      <ConnectionBanner />

      <div className="o-app__body" id="main">
        {route === 'home' ? <HomeScreen /> : null}
        {route === 'lobby' ? <LobbyScreen /> : null}
        {route === 'game' ? <GameScreen /> : null}
      </div>

      <Sheets />
      <ToastStack />
    </div>
  );
}

export default App;
