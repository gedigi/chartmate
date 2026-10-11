import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

// The real klinecharts needs a canvas, which jsdom lacks. Tests that inspect chart calls mock it themselves.
vi.mock('klinecharts', () => import('./klinechartsStub'));

afterEach(() => cleanup());
