import { Routes } from '@angular/router';

export const routes: Routes = [
  { path: '', pathMatch: 'full', redirectTo: 'tracker' },
  {
    path: 'tracker',
    loadComponent: () => import('./pages/tracker.component').then((m) => m.TrackerComponent),
  },
  {
    path: 'history',
    loadComponent: () => import('./pages/history.component').then((m) => m.HistoryComponent),
  },
  {
    path: 'aggregates',
    loadComponent: () => import('./pages/aggregates.component').then((m) => m.AggregatesComponent),
  },
  {
    path: 'tools',
    loadComponent: () => import('./pages/tools.component').then((m) => m.ToolsComponent),
  },
  {
    path: 'settings',
    loadComponent: () => import('./pages/settings.component').then((m) => m.SettingsComponent),
  },
  {
    // Operator page (GLOBAL_ADMIN_ACCOUNT_IDS secret). Before 'admin' for clarity.
    path: 'admin/global',
    loadComponent: () =>
      import('./pages/global-admin.component').then((m) => m.GlobalAdminComponent),
  },
  {
    path: 'admin',
    loadComponent: () => import('./pages/admin.component').then((m) => m.AdminComponent),
  },
  {
    // Sprint risk board (feature-owned; delete with client/src/app/risk).
    path: 'risk',
    loadChildren: () => import('./risk/risk.routes').then((m) => m.RISK_ROUTES),
  },
  {
    path: 'privacy',
    loadComponent: () => import('./pages/privacy.component').then((m) => m.PrivacyComponent),
  },
  { path: '**', redirectTo: 'tracker' },
];
