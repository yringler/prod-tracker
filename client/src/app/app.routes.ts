import { Routes } from '@angular/router';

export const routes: Routes = [
  { path: '', pathMatch: 'full', redirectTo: 'tracker' },
  {
    path: 'tracker',
    loadComponent: () => import('./pages/tracker.component').then((m) => m.TrackerComponent),
  },
  {
    path: 'aggregates',
    loadComponent: () => import('./pages/aggregates.component').then((m) => m.AggregatesComponent),
  },
  {
    path: 'admin',
    loadComponent: () => import('./pages/admin.component').then((m) => m.AdminComponent),
  },
  {
    path: 'privacy',
    loadComponent: () => import('./pages/privacy.component').then((m) => m.PrivacyComponent),
  },
  { path: '**', redirectTo: 'tracker' },
];
