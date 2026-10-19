import { Route, Routes } from 'react-router-dom';
import { AppFrame, mountPage } from '../../ui-page/harness';
import { TeammatesSection } from '../../../src/renderer/features/bots/TeammatesSection';

mountPage({
  route: '/bots/mate-6',
  render: () => <Routes><Route path="/bots/:botId" element={
    <AppFrame header={false} sidebar={<TeammatesSection />} />
  } /></Routes>,
});
