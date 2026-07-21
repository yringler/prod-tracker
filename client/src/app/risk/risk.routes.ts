import { Routes } from '@angular/router';

// Feature sub-routes, lazily loaded from app.routes.ts (`/risk`). The admin page
// re-checks auth.isAdmin() for the UI's sake; the server is what actually enforces
// it (requireAdmin on /api/admin/risk/*), matching the repo's no-route-guard
// convention.
export const RISK_ROUTES: Routes = [
  {
    path: '',
    loadComponent: () => import('./risk-board.component').then((m) => m.RiskBoardComponent),
  },
  {
    path: 'admin',
    loadComponent: () => import('./risk-admin.component').then((m) => m.RiskAdminComponent),
  },
];
