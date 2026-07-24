import { bootstrapApplication } from '@angular/platform-browser';
import { AppComponent } from './app/app.component';
import { appConfig } from './app/app.config';
// Register every Web Awesome custom element used across the app, once
import './webawesome';

bootstrapApplication(AppComponent, appConfig).catch((err) => console.error(err));
