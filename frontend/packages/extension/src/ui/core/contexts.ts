import { createContext } from '@lit/context';
import type { UiBridge } from '../services/UiBridge';
import type { Router } from './Router';

// Custom elements cannot take constructor arguments, so the bridge and router are provided
// once by the app shell and consumed by every Screen.
export const bridgeContext = createContext<UiBridge>(Symbol('sqw-bridge'));
export const routerContext = createContext<Router>(Symbol('sqw-router'));
