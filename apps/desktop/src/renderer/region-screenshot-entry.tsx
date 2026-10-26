import { createRoot } from 'react-dom/client';

import '@fontsource-variable/inter';
import 'harmonyos-sans-sc-webfont-splitted';

import '@/i18n';
import './themes/colors';
import './styles/globals.css';

import { ScreenshotErrorBoundary } from './features/region-screenshot/ScreenshotErrorBoundary';
import { RegionScreenshotOverlay } from './features/region-screenshot/RegionScreenshotOverlay';
import { applyFontSettings, getInitialFontSettings } from './hooks/useFontSettings';
import { getInitialThemeVariant } from './hooks/useTheme';
import { bootstrapLocalThemesSync } from './themes/local-themes';
import { themeService } from './themes/theme-service';

/** 全局框选截图浮层入口 (隐藏预热, 每次截图由 main 推送会话)。 */
document.documentElement.dataset.platform = window.electronAPI.platform;
// Scrolling leaves the source region transparent while the original overlay
// owns only its outline, thumbnail and actions.
document.documentElement.style.background = 'transparent';
document.body.style.background = 'transparent';
bootstrapLocalThemesSync();
themeService.applyTheme(getInitialThemeVariant().theme);
applyFontSettings(getInitialFontSettings());

const rootElement = document.getElementById('root');
const bridge = window.regionScreenshot;
if (!rootElement || !bridge) throw new Error('Missing region screenshot root or bridge');

createRoot(rootElement).render(
  <ScreenshotErrorBoundary onFailure={() => bridge.abandon()}>
    <RegionScreenshotOverlay bridge={bridge} />
  </ScreenshotErrorBoundary>,
);
