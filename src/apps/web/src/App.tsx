import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import { createBrowserRouter, Navigate, RouterProvider, useSearchParams } from 'react-router';
import { mondayOf, todayIn } from '@lifeos/shared';
import { api, NetworkError } from './lib/api';
import { prefetch, reopenEvents, startSync } from './lib/store';
import { AppShell, type ScreenKey } from './shell/AppShell';
import { AuthScreen } from './screens/Auth';
import { SettingsScreen } from './screens/Settings';
import { TaskLink } from './screens/TaskLink';
import { TodayScreen } from './screens/today/Today';
import { CalendarScreen } from './screens/calendar/Calendar';
import { GoalsScreen } from './screens/Goals';
import { HabitsScreen } from './screens/Habits';
import { ListsScreen } from './screens/Lists';

/** The first-run step (ADR-76): its own chunk with the city list, loaded only when it is due. */
const SetupScreen = lazy(() => import('./screens/Setup').then((m) => ({ default: m.SetupScreen })));

/**
 * The top-level screens. The shell keeps each in its own pane once shown (UI brief 3, ADR-37): the
 * routes below only match addresses (their params reach the screens through the pane), and the
 * one route with an element of its own (a task opened from a reminder) renders in the route pane.
 */
const SCREENS: Record<ScreenKey, React.ReactNode> = {
  today: <TodayScreen />,
  calendar: <CalendarScreen />,
  goals: <GoalsScreen />,
  habits: <HabitsScreen />,
  lists: <ListsScreen />,
  settings: <SettingsScreen />,
};
/** Mounted ahead of their first visit, in this order, while the app is idle. */
const WARM: ScreenKey[] = ['today', 'calendar', 'goals', 'habits', 'lists'];

const router = createBrowserRouter(
  [
    {
      path: '/',
      element: <AppShell screens={SCREENS} warm={WARM} />,
      children: [
        { index: true, element: <Navigate to="/today" replace /> },
        { path: 'today', element: null },
        { path: 'calendar', element: null },
        // Week became Calendar (round-2 brief §3): old addresses land on its Week view
        { path: 'week', element: <WeekRedirect /> },
        { path: 'goals', element: null },
        { path: 'goals/:slug', element: null },
        { path: 'habits', element: null },
        { path: 'lists', element: null },
        { path: 'lists/:tab', element: null },
        { path: 'settings', element: null },
        { path: 't/:id', element: <TaskLink /> },
        { path: '*', element: <Navigate to="/today" replace /> },
      ],
    },
  ],
  { basename: '/lifeos' },
);

/**
 * Every tab's first data, fetched from the index as the app opens (tens of notes: small), so a
 * screen mounted in a hidden pane renders complete at once. The paths are the screens' own.
 */
function prefetchScreens(): void {
  const today = todayIn(Intl.DateTimeFormat().resolvedOptions().timeZone);
  void prefetch([
    'api/today',
    `api/week?start=${mondayOf(today)}`,
    `api/calendar/day?d=${today}`,
    `api/calendar/month?m=${today.slice(0, 7)}`,
    ...(window.matchMedia?.('(min-width: 700px)').matches ? ['api/week?from=today'] : []),
    'api/goals',
    'api/habits',
    'api/library/daily',
    'api/lists/tasks?status=open&q=',
    // the other Lists segments are mounted while the app is idle: their data is here first
    'api/lists/notes?q=&ring=',
    'api/lists/links',
    'api/lists/shopping',
    'api/lists/wishlist',
    'api/settings',
  ]);
}

/** `/week?d=…` (an old link) → the Calendar's Week view on that date. */
function WeekRedirect() {
  const [params] = useSearchParams();
  const d = params.get('d');
  return <Navigate to={`/calendar?view=week${d ? `&d=${d}` : ''}`} replace />;
}

type AuthState = 'checking' | 'setup' | 'login' | 'first-run' | 'in' | 'offline-in';

export function App() {
  const [state, setState] = useState<AuthState>('checking');
  // the port is open to the network (LIFEOS_BIND=0.0.0.0): the plain-http banner may be due
  const [exposed, setExposed] = useState(false);
  const check = useCallback(async () => {
    try {
      const s = await api<{ setup: boolean; signedIn: boolean; exposed?: boolean; firstRun?: boolean }>('api/auth/state');
      setExposed(!!s.exposed);
      setState(s.setup ? 'setup' : !s.signedIn ? 'login' : s.firstRun ? 'first-run' : 'in');
    } catch (e) {
      // offline: open with what this device has cached (the session is checked again when back)
      setState(e instanceof NetworkError ? 'offline-in' : 'login');
    }
  }, []);
  useEffect(() => {
    void check();
    const out = () => setState('login');
    window.addEventListener('lifeos:signed-out', out);
    return () => window.removeEventListener('lifeos:signed-out', out);
  }, [check]);
  useEffect(() => {
    if (state === 'in' || state === 'offline-in') {
      startSync();
      prefetchScreens();
    }
  }, [state]);
  if (state === 'checking') return null;
  if (state === 'setup' || state === 'login')
    return (
      <AuthScreen
        setup={state === 'setup'}
        exposed={exposed}
        onDone={() => {
          reopenEvents();
          // a new passphrase is followed by the first-run step; an unlock goes straight in
          void check();
        }}
      />
    );
  if (state === 'first-run')
    return (
      <Suspense fallback={null}>
        <SetupScreen onDone={() => setState('in')} />
      </Suspense>
    );
  return <RouterProvider router={router} />;
}
