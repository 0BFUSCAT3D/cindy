export default {
  name: 'agent-adapters',
  entry: './fixture.tsx',
  viewport: { width: 900, height: 800 },
  real: 'AgentAdaptersPage, standard Button/Select/Textarea, resource projection rendering',
  notCovered:
    'Native process execution, authentication, two-machine transport and account switching',
  stubs: {
    'src/renderer/contexts/AuthContext': 'export const useAuth=()=>({dataOwnerGeneration:1});',
  },
  cases: {
    default: { about: 'Default-off state and explicit enable entry' },
    ready: { about: 'Installed native Agents and granted host working directories' },
    empty: { about: 'Native CLI installation and account/model setup guidance' },
    auth: { about: 'Native login, model configuration and account eligibility failure guidance' },
    permission: { about: 'Live transcript and an explicit native Agent permission request' },
  },
  async ready(page) {
    await page.locator('h1').waitFor();
    await page.locator('p').first().waitFor();
  },
};
