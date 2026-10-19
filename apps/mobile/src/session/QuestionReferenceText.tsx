import { Fragment, useState } from 'react';
import { Linking } from 'react-native';
import { Text } from '@/components/AppText';
import { splitQuestionReferences } from '@cindy/maker-shared/interaction';
import { ChatPathChipSpan } from '@/session/ChatPathChipSpan';
import { classifyChatPathLinkTarget } from '@/session/chatPathCandidate';

/** Inline evidence inherits question typography; only verified links are underlined. */
export function QuestionReferenceText({ text }: { text: string }) {
  return <>{splitQuestionReferences(text).map((part, index) => {
    if (!part.href) return <Fragment key={index}>{part.text}</Fragment>;
    if (/^https?:\/\//i.test(part.href)) {
      const href = part.href;
      return <Text key={index} accessibilityRole="link" style={{ textDecorationLine: 'underline' }}
        onPress={(event) => {
          event.stopPropagation();
          void Linking.openURL(href).catch(() => undefined);
        }}>
        {part.text}
      </Text>;
    }
    return <ChatPathChipSpan key={index} candidate={classifyChatPathLinkTarget(part.href)}
      display={part.text} plainStyle={undefined} chipStyle={{ textDecorationLine: 'underline' }} SpanText={Text} usePathState={useState} />;
  })}</>;
}
