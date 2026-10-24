import { StyleSheet, View } from 'react-native';
import { useAuth } from '@/auth/AuthContext';
import { HomeRosterProvider } from '@/session/HomeRosterContext';
import { MobileHome } from '@/session/HomeSurface';
import { SessionHeaderNativeBlur } from '@/session/SessionHeaderNativeControls';
import { useHomeMode } from '@/session/useHomeMode';
import { useOptionalHeaderHeight } from '@/session/useOptionalHeaderHeight';

/** One home, as on desktop: teammates are the section at the top of the task list. */
export default function HomeScreen() {
  const { accountGeneration } = useAuth();
  const navigation = useHomeMode();
  const headerHeight = useOptionalHeaderHeight();
  // The teammate section's stored fold is part of the first frame.
  if (!navigation.hydrated) return null;
  return <HomeRosterProvider key={accountGeneration}><View style={styles.home}>
    <MobileHome />
    <SessionHeaderNativeBlur height={headerHeight} />
  </View></HomeRosterProvider>;
}

const styles = StyleSheet.create({ home: { flex: 1 } });
